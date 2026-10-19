import { HARNESS_MODEL_SEED, HarnessModel, harnessModelCatalog } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPTIONS,
  isRememberedOptions,
  keptAfter,
  openFlow,
  PROMPT_MAX_BYTES,
  promptIssue,
  render,
  step,
  type CheckoutFact,
  type FlowEffect,
  type FlowEvent,
  type FlowFacts,
  type FlowState,
  type JoinTarget,
  type SessionOptions,
} from "./new-session.js";
import type { Project } from "./types.js";

const project = (id: string, name: string): Project => ({
  id,
  name,
  originUrl: `git@github.com:sealant-sh/${name}.git`,
  storePath: `/store/${name}`,
  defaultBranch: "main",
});

const newsroom = project("p1", "newsroom-api");
const mend = project("p2", "mend");

const SHA = "3f9c2a1b7e4d5c6f8091a2b3c4d5e6f708192a3b";

/** `fix/login`, pushed to origin under its own name. */
const PUSHED: CheckoutFact = {
  kind: "pushed",
  branch: "fix/login",
  upstream: "refs/remotes/origin/fix/login",
  commit: SHA,
};

const seeded = (harness: string) =>
  harnessModelCatalog(
    harness,
    (HARNESS_MODEL_SEED[harness] ?? []).map(
      (row) =>
        new HarnessModel({
          id: row.id,
          label: row.label,
          isDefault: row.isDefault,
          efforts: row.efforts ?? null,
        }),
    ),
  );

const facts = (overrides: Partial<FlowFacts> = {}): FlowFacts => ({
  projects: [newsroom, mend],
  adoptable: null,
  candidates: [],
  checkout: { kind: "elsewhere" },
  catalogs: [seeded("claude"), seeded("codex"), seeded("opencode")],
  remembered: {},
  kept: new Map(),
  joinLine: null,
  ...overrides,
});

const opened = (
  options: {
    readonly project?: Project | null;
    readonly join?: JoinTarget | null;
    readonly checkout?: CheckoutFact;
    readonly offline?: boolean;
  } = {},
  given: FlowFacts = facts(),
): FlowState =>
  openFlow(
    {
      project: options.project === undefined ? newsroom : options.project,
      join: options.join ?? null,
      checkout: options.checkout ?? { kind: "elsewhere" },
      offline: options.offline ?? false,
    },
    given,
  );

/** Every event in turn, and every effect they raised; remembered picks fold into the facts. */
const run = (
  state: FlowState,
  events: ReadonlyArray<FlowEvent>,
  given: FlowFacts = facts(),
): {
  readonly state: FlowState;
  readonly effects: ReadonlyArray<FlowEffect>;
  readonly facts: FlowFacts;
} => {
  let current = state;
  let known = given;
  const effects: Array<FlowEffect> = [];
  for (const event of events) {
    const next = step(current, event, known);
    current = next.state;
    if (next.effect.kind !== "none") effects.push(next.effect);
    if (next.effect.kind === "remember")
      known = {
        ...known,
        remembered: { ...known.remembered, [next.effect.projectId]: next.effect.options },
      };
  }
  return { state: current, effects, facts: known };
};

const dim = (state: FlowState, given: FlowFacts = facts()): string =>
  render(state, given).items[0]?.description ?? "";

const starts = (effects: ReadonlyArray<FlowEffect>) =>
  effects.flatMap((effect) => (effect.kind === "start" ? [effect] : []));

const ENTER: FlowEvent = { kind: "accept", item: "start" };

describe("Enter on the prompt", () => {
  it("starts exactly one terminal agent on the typed prompt, and a second Enter starts none", () => {
    const { effects } = run(opened(), [
      { kind: "typed", value: "add rate limiting to the login route" },
      ENTER,
      ENTER,
    ]);
    const started = starts(effects);
    expect(started).toHaveLength(1);
    expect(started[0]?.create).toEqual({
      harness: "claude",
      mode: "pty",
      label: null,
      name: null,
      base: "main",
    });
    expect(started[0]?.launch).toEqual({
      mode: "pty",
      prompt: "add rate limiting to the login route",
    });
  });

  it("sends a shell's typed text as its label and no prompt", () => {
    const shell: SessionOptions = { ...DEFAULT_OPTIONS, harness: "shell" };
    const given = facts({ remembered: { [newsroom.id]: shell } });
    const { effects } = run(
      opened({}, given),
      [{ kind: "typed", value: "poke at it" }, ENTER],
      given,
    );
    expect(starts(effects)[0]?.create.label).toBe("poke at it");
    expect(starts(effects)[0]?.launch).toEqual({ mode: "pty" });
    expect(render(opened({}, given), given).placeholder).toBe("A name for this shell (optional)");
  });

  it("sends the chosen model, thinking and permission, and only those", () => {
    const chosen: SessionOptions = {
      ...DEFAULT_OPTIONS,
      harness: "codex",
      model: "gpt-6-astra",
      effort: "high",
      permission: "ask",
    };
    const given = facts({ remembered: { [newsroom.id]: chosen } });
    const { effects } = run(opened({}, given), [{ kind: "typed", value: "go" }, ENTER], given);
    expect(starts(effects)[0]?.launch).toEqual({
      mode: "pty",
      prompt: "go",
      model: "gpt-6-astra",
      effort: "high",
      permissionMode: "ask",
    });
    expect(dim(opened({}, given), given)).toBe(
      "codex · GPT-6 Astra · high thinking · asks before acting · from main",
    );
  });

  it("refuses a prompt the harness would read as a flag", () => {
    const { effects, state } = run(opened(), [{ kind: "typed", value: "--help" }, ENTER]);
    expect(starts(effects)).toHaveLength(0);
    expect(dim(state)).toBe("claude would read a prompt that starts with - as a flag");
  });

  it("refuses a prompt with a NUL, which no argument can carry", () => {
    const { effects, state } = run(opened(), [{ kind: "typed", value: "fix\0this" }, ENTER]);
    expect(starts(effects)).toHaveLength(0);
    expect(dim(state)).toBe("the prompt has a NUL character, which no argument can carry");
    expect(render(state, facts()).items[0]?.label).toBe("$(warning)");
  });

  it("takes a prompt of 120,000 UTF-8 bytes and refuses one byte more, counting bytes not characters", () => {
    const most = "é".repeat(PROMPT_MAX_BYTES / 2);
    expect(starts(run(opened(), [{ kind: "typed", value: most }, ENTER]).effects)).toHaveLength(1);
    const over = run(opened(), [{ kind: "typed", value: `${most}a` }, ENTER]);
    expect(starts(over.effects)).toHaveLength(0);
    expect(dim(over.state)).toBe("the prompt is 120,001 bytes · claude takes at most 120,000");
    expect(promptIssue(`${most}a`, "codex")).toBe(
      "the prompt is 120,001 bytes · codex takes at most 120,000",
    );
  });
});

describe("the project", () => {
  it("is the window's, matched by origin: the prompt step comes first", () => {
    const view = render(opened(), facts());
    expect(view.title).toBe("New session · newsroom-api");
    expect(view.placeholder).toBe("What should claude do?");
    expect(view.back).toBe(false);
    expect(view.items).toEqual([
      {
        id: "start",
        label: "",
        description: "claude · default model · from main",
        change: true,
        alwaysShow: true,
      },
    ]);
  });

  it("is asked for when nothing matched, with Adopt this repository on top only when adoptable", () => {
    const origin = "git@github.com:sealant-sh/newsroom-web.git";
    const adoptable = facts({ adoptable: { origin, name: "newsroom-web" } });
    const asked = render(opened({ project: null }, adoptable), adoptable);
    expect(asked.title).toBe("New session");
    expect(asked.placeholder).toBe("Choose a project");
    expect(asked.items.map((item) => item.label)).toEqual([
      "$(repo-clone) Adopt this repository",
      "newsroom-api",
      "mend",
    ]);
    expect(asked.items[0]?.description).toBe(origin);
    expect(render(opened({ project: null }), facts()).items.map((item) => item.label)).toEqual([
      "newsroom-api",
      "mend",
    ]);
  });

  it("adopted continues to its prompt step with the window's checkout", () => {
    const origin = "git@github.com:sealant-sh/newsroom-web.git";
    const web = project("p3", "newsroom-web");
    const given = facts({
      adoptable: { origin, name: "newsroom-web" },
      checkout: PUSHED,
    });
    const adopting = run(
      opened({ project: null }, given),
      [{ kind: "accept", item: "adopt" }],
      given,
    );
    expect(adopting.effects).toEqual([{ kind: "adopt", origin, name: "newsroom-web" }]);
    expect(render(adopting.state, given).busy).toBe(true);
    const { state } = run(adopting.state, [{ kind: "adopted", project: web }], given);
    const view = render(state, given);
    expect(view.title).toBe("New session · newsroom-web");
    expect(view.items[0]?.description).toBe("claude · default model · from fix/login");
    expect(view.back).toBe(true);
  });

  it("picked from the list goes to its prompt step, and Back returns to the list", () => {
    const picked = run(opened({ project: null }), [{ kind: "accept", item: "project:p2" }]);
    expect(render(picked.state, facts()).title).toBe("New session · mend");
    const back = run(picked.state, [{ kind: "back" }]);
    expect(render(back.state, facts()).placeholder).toBe("Choose a project");
  });

  it("shows Adopt's origin without its userinfo, and adopts the origin as git has it", () => {
    const origin = "https://dana:ghp_secret@github.com/sealant-sh/newsroom-web.git";
    const given = facts({ adoptable: { origin, name: "newsroom-web" } });
    const asked = render(opened({ project: null }, given), given);
    expect(asked.items[0]?.description).toBe("https://github.com/sealant-sh/newsroom-web.git");
    expect(JSON.stringify(asked)).not.toContain("ghp_secret");
    const { effects } = run(
      opened({ project: null }, given),
      [{ kind: "accept", item: "adopt" }],
      given,
    );
    expect(effects).toEqual([{ kind: "adopt", origin, name: "newsroom-web" }]);
  });

  it("asks among the projects one origin names, without Adopt, and the pick keeps the window's checkout", () => {
    const twin = project("p3", "newsroom-api-2");
    const given = facts({
      projects: [newsroom, mend, twin],
      adoptable: null,
      candidates: [newsroom, twin],
      checkout: PUSHED,
    });
    const asked = render(opened({ project: null }, given), given);
    expect(asked.items.map((item) => item.label)).toEqual(["newsroom-api", "newsroom-api-2"]);
    expect(asked.placeholder).toBe("Several projects have this repository's origin: choose one");
    expect(
      run(opened({ project: null }, given), [{ kind: "accept", item: "project:p2" }], given).state
        .step,
    ).toEqual({ kind: "project" });
    const { state } = run(
      opened({ project: null }, given),
      [{ kind: "accept", item: "project:p3" }],
      given,
    );
    expect(render(state, given).title).toBe("New session · newsroom-api-2");
    expect(state.draft?.checkout).toEqual(given.checkout);
  });
});

const counter = (state: FlowState, given: FlowFacts) => render(state, given).step;

describe("Change…", () => {
  it("remembers each pick for its project at once, and the dim line then reads them", () => {
    const {
      state,
      effects,
      facts: after,
    } = run(opened(), [
      { kind: "typed", value: "fix the flaky test" },
      { kind: "change" },
      { kind: "accept", item: "harness:codex" },
      { kind: "accept", item: "model:gpt-6-luna" },
      { kind: "accept", item: "effort:high" },
      { kind: "accept", item: "permission:ask" },
      { kind: "accept", item: "base:default" },
    ]);
    const remembered = effects.flatMap((effect) => (effect.kind === "remember" ? [effect] : []));
    expect(remembered).toHaveLength(5);
    expect(remembered.every((effect) => effect.projectId === newsroom.id)).toBe(true);
    expect(after.remembered[newsroom.id]).toEqual({
      harness: "codex",
      model: "gpt-6-luna",
      effort: "high",
      permission: "ask",
      base: { kind: "default" },
    });
    expect(after.remembered[mend.id]).toBeUndefined();
    expect(state.step).toEqual({ kind: "prompt" });
    expect(render(state, after).value).toBe("fix the flaky test");
    expect(dim(state, after)).toBe(
      "codex · GPT-6 Luna · high thinking · asks before acting · from main",
    );
    expect(dim(opened({ project: mend }, after), after)).toBe("claude · default model · from main");
  });

  it("shows the current choice checked, remembered once picked", () => {
    const { state, facts: after } = run(opened(), [
      { kind: "change" },
      { kind: "accept", item: "harness:claude" },
      { kind: "back" },
    ]);
    const harness = render(state, after);
    expect(harness.placeholder).toBe("Harness");
    expect(harness.items.find((item) => item.current)).toMatchObject({
      label: "$(check) claude",
      description: "remembered for newsroom-api",
    });
  });

  it("goes back one step at a time, and from the first to the prompt", () => {
    const atThinking = run(opened(), [
      { kind: "change" },
      { kind: "accept", item: "harness:claude" },
      { kind: "accept", item: "model:opus" },
    ]);
    expect(render(atThinking.state, atThinking.facts).placeholder).toBe(
      "Thinking for Opus · latest",
    );
    const once = run(atThinking.state, [{ kind: "back" }], atThinking.facts);
    expect(render(once.state, once.facts).placeholder).toBe("Model for claude");
    const twice = run(once.state, [{ kind: "back" }, { kind: "back" }], once.facts);
    expect(twice.state.step).toEqual({ kind: "prompt" });
  });

  it("counts only the steps that apply: five for claude, two for a shell, none for a join's base", () => {
    const harness = run(opened(), [{ kind: "change" }]);
    expect(counter(harness.state, harness.facts)).toEqual({ n: 1, total: 5 });
    const shell = run(harness.state, [{ kind: "accept", item: "harness:shell" }], harness.facts);
    expect(counter(shell.state, shell.facts)).toEqual({ n: 2, total: 2 });
    expect(render(shell.state, shell.facts).placeholder).toBe("Base: a branch or commit");
    const join = run(
      opened({ join: { worktree: "add-rate-limit", worktreeId: "wt-1", shown: "add-rate-limit" } }),
      [{ kind: "change" }],
    );
    expect(counter(join.state, join.facts)).toEqual({ n: 1, total: 4 });
    const pi = run(join.state, [{ kind: "accept", item: "harness:pi" }], join.facts);
    expect(render(pi.state, pi.facts).placeholder).toBe("Model for pi");
    expect(render(pi.state, pi.facts).items.map((item) => item.label)).toEqual([
      "$(check) default model",
    ]);
    expect(counter(pi.state, pi.facts)).toEqual({ n: 2, total: 4 });
  });

  it("keeps the model step before the catalog is read, with default model and the remembered one", () => {
    const remembered: SessionOptions = { ...DEFAULT_OPTIONS, model: "claude-retired" };
    const given = facts({ catalogs: null, remembered: { [newsroom.id]: remembered } });
    const { state } = run(
      opened({}, given),
      [{ kind: "change" }, { kind: "accept", item: "harness:claude" }],
      given,
    );
    const view = render(state, given);
    expect(view.placeholder).toBe("Model for claude · the server's models aren't read yet");
    expect(view.items.map((item) => item.label)).toEqual([
      "default model",
      "$(check) claude-retired",
    ]);
  });
});

describe("a remembered model the catalog no longer lists", () => {
  const remembered: SessionOptions = { ...DEFAULT_OPTIONS, model: "claude-retired" };
  const unread = facts({ catalogs: null, remembered: { [newsroom.id]: remembered } });
  const read = { ...unread, catalogs: facts().catalogs };

  it("is dropped once the catalog is read, said once on the dim line, and remembered dropped", () => {
    const opening = opened({}, unread);
    expect(dim(opening, unread)).toBe("claude · claude-retired · from main");
    const checked = run(opening, [{ kind: "catalogsRead" }], read);
    expect(checked.effects).toEqual([
      { kind: "remember", projectId: newsroom.id, options: DEFAULT_OPTIONS },
    ]);
    expect(dim(checked.state, checked.facts)).toBe(
      "claude · default model · from main · the server no longer lists claude-retired",
    );
    const started = run(checked.state, [{ kind: "typed", value: "go" }, ENTER], checked.facts);
    expect(starts(started.effects)[0]?.launch).toEqual({ mode: "pty", prompt: "go" });
  });

  it("is dropped for a project picked after the catalog is read", () => {
    const given = { ...read, remembered: { [mend.id]: remembered } };
    const picked = run(
      opened({ project: null }, given),
      [{ kind: "accept", item: "project:p2" }],
      given,
    );
    expect(picked.effects).toEqual([
      { kind: "remember", projectId: mend.id, options: DEFAULT_OPTIONS },
    ]);
    expect(picked.state.draft?.options.model).toBeNull();
  });

  it("leaves a model the catalog lists alone", () => {
    const listed: SessionOptions = { ...DEFAULT_OPTIONS, model: "opus" };
    const given = { ...read, remembered: { [newsroom.id]: listed } };
    expect(run(opened({}, given), [{ kind: "catalogsRead" }], given).effects).toEqual([]);
  });

  it("takes a typed branch or commit as the base", () => {
    const {
      state,
      effects,
      facts: after,
    } = run(opened(), [
      { kind: "change" },
      { kind: "accept", item: "harness:shell" },
      { kind: "typed", value: "release/0.36" },
      { kind: "accept", item: "base:ref:release/0.36" },
      ENTER,
    ]);
    expect(dim(state, after)).toBe("shell · from release/0.36");
    expect(starts(effects)[0]?.create.base).toBe("release/0.36");
  });
});

describe("the base", () => {
  const prompted = (checkout: CheckoutFact) =>
    run(opened({ checkout }), [{ kind: "typed", value: "go" }, ENTER]);

  it("is the default branch when her branch isn't pushed, and the dim line says so first", () => {
    const unpushed: CheckoutFact = { kind: "unpushed", branch: "fix/login" };
    const view = render(opened({ checkout: unpushed }), facts());
    expect(view.items[0]?.description).toBe(
      "claude · default model · from main · your branch fix/login isn't pushed",
    );
    expect(view.items[0]?.label).toBe("$(warning)");
    expect(starts(prompted(unpushed).effects)[0]?.create.base).toBe("main");
  });

  it("says her commits on main aren't pushed when she is on the default branch", () => {
    expect(dim(opened({ checkout: { kind: "unpushed", branch: "main" } }))).toBe(
      "claude · default model · from main · your commits on main aren't pushed",
    );
  });

  it("is her branch on origin when it is pushed", () => {
    expect(dim(opened({ checkout: PUSHED }))).toBe("claude · default model · from fix/login");
    expect(starts(prompted(PUSHED).effects)[0]?.create.base).toBe("fix/login");
  });

  it("is the upstream that proved it, not her local branch's name", () => {
    const tracksMain: CheckoutFact = {
      kind: "pushed",
      branch: "fix/login",
      upstream: "refs/remotes/origin/main",
      commit: SHA,
    };
    expect(dim(opened({ checkout: tracksMain }))).toBe("claude · default model · from main");
    expect(starts(prompted(tracksMain).effects)[0]?.create.base).toBe("main");
  });

  it("is the commit an upstream on another remote pointed at", () => {
    const fork: CheckoutFact = {
      kind: "pushed",
      branch: "fix/login",
      upstream: "refs/remotes/upstream/main",
      commit: SHA,
    };
    expect(dim(opened({ checkout: fork }))).toBe("claude · default model · from upstream/main");
    expect(starts(prompted(fork).effects)[0]?.create.base).toBe(SHA);
  });

  it("is the default, said apart from not pushed, when git did not answer", () => {
    const unknown: CheckoutFact = { kind: "unknown", branch: null };
    expect(dim(opened({ checkout: unknown }))).toBe(
      "claude · default model · from main · couldn't read your branch",
    );
    expect(starts(prompted(unknown).effects)[0]?.create.base).toBe("main");
  });

  it("moves to the default when the store refuses the upstream, said before the next Enter", () => {
    const sent = prompted(PUSHED);
    expect(render(sent.state, sent.facts).busy).toBe(true);
    const refused = run(sent.state, [{ kind: "baseRefused" }], sent.facts);
    expect(refused.state.step).toEqual({ kind: "prompt" });
    expect(dim(refused.state, refused.facts)).toBe(
      "claude · default model · from main · Mend's store couldn't find fix/login",
    );
    expect(render(refused.state, refused.facts).value).toBe("go");
    const again = run(refused.state, [ENTER], refused.facts);
    expect(starts(again.effects)[0]?.create.base).toBe("main");
    expect(run(again.state, [{ kind: "baseRefused" }], again.facts).state.step).toEqual({
      kind: "started",
    });
  });

  it("is the worktree's own for a join, which sends no base and names the worktree", () => {
    const join: JoinTarget = {
      worktree: "add-rate-limit",
      worktreeId: "wt-1",
      shown: "add-rate-limit",
    };
    const given = facts({ joinLine: "Ana's session runs here" });
    const state = opened({ join }, given);
    expect(render(state, given).title).toBe("New session · newsroom-api · in add-rate-limit");
    expect(dim(state, given)).toBe(
      "claude · default model · in add-rate-limit · Ana's session runs here",
    );
    const { effects } = run(state, [ENTER], given);
    expect(starts(effects)[0]?.create).toMatchObject({ base: null, name: "add-rate-limit" });
  });
});

describe("offline", () => {
  it("keeps the input open on Enter with her prompt, and the kept prompt comes back on reopen", () => {
    const typed = run(opened(), [
      { kind: "typed", value: "add rate limiting" },
      { kind: "connection", offline: true },
      ENTER,
    ]);
    expect(starts(typed.effects)).toHaveLength(0);
    expect(dim(typed.state)).toBe("Mend is offline · retrying");
    expect(render(typed.state, facts()).value).toBe("add rate limiting");
    const kept = keptAfter(new Map(), typed.state, { kind: "none" });
    const reopened = opened({}, facts({ kept }));
    expect(render(reopened, facts({ kept })).value).toBe("add rate limiting");
    expect(render(opened({ project: mend }, facts({ kept })), facts({ kept })).value).toBe("");
  });

  it("forgets the kept prompt once a session starts", () => {
    const typed = run(opened(), [{ kind: "typed", value: "add rate limiting" }]);
    const kept = keptAfter(new Map(), typed.state, { kind: "none" });
    const started = step(typed.state, ENTER, facts({ kept }));
    expect(keptAfter(kept, started.state, started.effect).size).toBe(0);
  });
});

describe("what globalState keeps", () => {
  it("reads written options back", () => {
    expect(isRememberedOptions({ "https://mend.box": { p1: DEFAULT_OPTIONS } })).toBe(true);
    expect(
      isRememberedOptions({
        "https://mend.box": {
          p1: { ...DEFAULT_OPTIONS, base: { kind: "ref", ref: "fix/login" }, effort: "max" },
        },
      }),
    ).toBe(true);
  });

  it.each([
    ["not an object", "claude"],
    ["a project that is not options", { "https://mend.box": { p1: "claude" } }],
    ["an unknown harness", { "https://mend.box": { p1: { ...DEFAULT_OPTIONS, harness: "vim" } } }],
    ["an unknown effort", { "https://mend.box": { p1: { ...DEFAULT_OPTIONS, effort: "huge" } } }],
    [
      "a base without its ref",
      { "https://mend.box": { p1: { ...DEFAULT_OPTIONS, base: { kind: "ref" } } } },
    ],
    [
      "a permission it never wrote",
      { "https://mend.box": { p1: { ...DEFAULT_OPTIONS, permission: "bypass" } } },
    ],
  ])("rejects %s", (_what, value) => {
    expect(isRememberedOptions(value)).toBe(false);
  });
});
