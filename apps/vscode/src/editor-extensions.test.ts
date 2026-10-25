import { describe, expect, it } from "vitest";

import {
  MISSING_TTL_MS,
  TimedOut,
  classifyInstallFailure,
  emptyInstallMemory,
  noteOutcomes,
  parseEditorMode,
  parseInstallMemory,
  parseWorkspaceList,
  planReinstall,
  runInstalls,
  type CompletedRun,
  type InstallDeps,
  type InstallMemory,
  type Listed,
  type Presence,
  type WorkspaceList,
} from "./editor-extensions.js";
import { extensionId, type ExtensionId, type Wanted } from "./editor-picks.js";

const NOW = 1_792_270_215_287;

const id = (raw: string): ExtensionId => {
  const parsed = extensionId(raw);
  if (parsed === null) throw new Error(`not an extension id: ${raw}`);
  return parsed;
};
const ref = (raw: string, preRelease = false): Wanted => ({ id: id(raw), preRelease });
const gallery = (raw: string, preRelease = false): Listed => ({
  id: id(raw),
  source: "gallery",
  preRelease,
});
const fromFile = (raw: string): Listed => ({ id: id(raw), source: "file", preRelease: false });
const listOf = (...listed: ReadonlyArray<Listed>): WorkspaceList =>
  new Map(listed.map((entry) => [entry.id, entry]));
const none: ReadonlySet<ExtensionId> = new Set();
const only = (...listed: ReadonlyArray<Listed>): Presence => ({
  list: listOf(...listed),
  inUiHost: none,
});

/** An `extensions.json` entry the way VS Code 1.139.1's server writes it. */
const entry = (raw: string, metadata: Record<string, unknown> | undefined, version = "1.0.0") => ({
  identifier: { id: raw },
  version,
  location: { $mid: 1, path: `/home/mabc/.vscode-server/extensions/${raw}-${version}` },
  ...(metadata === undefined ? {} : { metadata }),
});

describe("parseEditorMode", () => {
  it.each<[unknown, string]>([
    ["off", "off"],
    ["picked", "picked"],
    [undefined, "picked"],
    ["extensions", "picked"],
    ["extensionsAndSettings", "picked"],
    ["OFF", "picked"],
    [false, "picked"],
    [42, "picked"],
  ])("%o → %s", (value, mode) => expect(parseEditorMode(value)).toBe(mode));
});

describe("parseWorkspaceList", () => {
  it("is no observation for a torn read, a non-array or an empty string", () => {
    for (const text of ['[{"identifier":', "{}", "null", ""]) {
      expect(parseWorkspaceList(text)).toBeNull();
    }
  });

  it("reads [] as an empty list", () => {
    expect(parseWorkspaceList("[]")).toEqual(new Map());
  });

  it("calls a gallery install gallery and every other source a file", () => {
    const text = JSON.stringify([
      entry("EditorConfig.EditorConfig", { source: "gallery", isMachineScoped: true }),
      entry("me.from-vsix", { source: "vsix" }),
      entry("me.from-folder", { source: "resource" }),
      entry("me.no-source", {}),
      entry("me.no-metadata", undefined),
      { identifier: { id: "not an id" }, version: "1.0.0" },
      "junk",
    ]);
    expect(parseWorkspaceList(text)).toEqual(
      listOf(
        gallery("editorconfig.editorconfig"),
        fromFile("me.from-vsix"),
        fromFile("me.from-folder"),
        fromFile("me.no-source"),
        fromFile("me.no-metadata"),
      ),
    );
  });

  it("reads the pre-release choice", () => {
    const text = JSON.stringify([
      entry("eamodio.gitlens", { source: "gallery", preRelease: true }),
    ]);
    expect(parseWorkspaceList(text)).toEqual(listOf(gallery("eamodio.gitlens", true)));
  });
});

describe("planReinstall", () => {
  it("installs the wanted ids the workspace does not list", () => {
    const plan = planReinstall(
      [ref("eamodio.gitlens", true), ref("ms-python.python")],
      only(gallery("ms-python.python")),
      none,
      emptyInstallMemory,
      NOW,
    );
    expect(plan).toEqual({ install: [ref("eamodio.gitlens", true)], recentlyMissing: [] });
  });

  it("does not install an id this window runs in its UI host", () => {
    const plan = planReinstall(
      [ref("eamodio.gitlens"), ref("ms-python.python")],
      { list: listOf(), inUiHost: new Set([id("eamodio.gitlens")]) },
      none,
      emptyInstallMemory,
      NOW,
    );
    expect(plan).toEqual({ install: [ref("ms-python.python")], recentlyMissing: [] });
  });

  it("does not ask again for an id VS Code is still installing", () => {
    const plan = planReinstall(
      [ref("eamodio.gitlens"), ref("ms-python.python")],
      only(),
      new Set([id("eamodio.gitlens")]),
      emptyInstallMemory,
      NOW,
    );
    expect(plan).toEqual({ install: [ref("ms-python.python")], recentlyMissing: [] });
  });

  it("skips an id the gallery lacked within a day, names it, and asks again after", () => {
    const memory: InstallMemory = { version: 2, missing: { "nobody.nothing": NOW - 1_000 } };
    const wanted = [ref("nobody.nothing")];
    expect(planReinstall(wanted, only(), none, memory, NOW)).toEqual({
      install: [],
      recentlyMissing: ["nobody.nothing"],
    });
    expect(planReinstall(wanted, only(), none, memory, NOW + MISSING_TTL_MS).install).toEqual(
      wanted,
    );
  });
});

describe("parseInstallMemory", () => {
  it("keeps only the missing ids of the first design's record", () => {
    expect(
      parseInstallMemory({
        version: 1,
        staysLocal: { "Visual Studio Code 1.139.1 x@a.one@1.0.0": NOW },
        missing: { "nobody.nothing": NOW },
      }),
    ).toEqual({ version: 2, missing: { "nobody.nothing": NOW } });
  });

  it("reads its own record, and anything else as empty", () => {
    const own = { version: 2, missing: { "nobody.nothing": NOW } };
    expect(parseInstallMemory(own)).toEqual(own);
    for (const value of [undefined, null, { version: 3, missing: {} }, { version: 2 }]) {
      expect(parseInstallMemory(value)).toEqual(emptyInstallMemory);
    }
  });
});

describe("classifyInstallFailure", () => {
  it.each([
    ["Failed to fetch", "transient"],
    ["getaddrinfo EAI_AGAIN marketplace.visualstudio.com", "transient"],
    ["request failed: 503 Service Unavailable", "transient"],
    ["Extension 'nobody.nothing' not found.", "missing"],
    ["The extension 'nobody.nothing' cannot be installed because it was not found.", "missing"],
    ["Installing Extension x failed: Manifest is not found.", "failed"],
    ["Can't install 'x' extension because it is not compatible.", "failed"],
    ["This extension cannot be installed because Extension is not allowed.", "refused by policy"],
    [
      "This extension cannot be installed because the extensions from this publisher are not in the [allowed list](command:x)",
      "refused by policy",
    ],
    ["Can't install 'x' extension since it was reported to be problematic.", "refused by policy"],
  ])("%s → %s", (message, kind) => expect(classifyInstallFailure(new Error(message))).toBe(kind));

  it("a timeout is its own class", () => {
    expect(classifyInstallFailure(new TimedOut())).toBe("timed out");
  });
});

const harness = (fail: (raw: string, attempt: number) => string | null) => {
  const calls: Array<string> = [];
  const sleeps: Array<number> = [];
  const progress: Array<string> = [];
  const controller = new AbortController();
  const attempts = new Map<string, number>();
  const deps: InstallDeps = {
    install: async (wanted) => {
      calls.push(wanted.id);
      const attempt = (attempts.get(wanted.id) ?? 0) + 1;
      attempts.set(wanted.id, attempt);
      const message = fail(wanted.id, attempt);
      if (message !== null) throw new Error(message);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    signal: controller.signal,
    onProgress: (current, total) => progress.push(`${current}/${total}`),
  };
  return { deps, calls, sleeps, progress, controller };
};

describe("runInstalls", () => {
  it("retries a transient failure after 1 s and then 4 s", async () => {
    const run = harness((raw, attempt) =>
      raw === "a.one" && attempt < 3 ? "Failed to fetch" : null,
    );
    const result = await runInstalls([ref("a.one"), ref("b.two")], run.deps);
    expect(run.calls).toEqual(["a.one", "a.one", "a.one", "b.two"]);
    expect(run.sleeps).toEqual([1_000, 4_000]);
    expect(result).toEqual({
      kind: "completed",
      outcomes: [
        { ref: ref("a.one"), kind: "reported" },
        { ref: ref("b.two"), kind: "reported" },
      ],
    });
    expect(run.progress).toEqual(["1/2", "2/2"]);
  });

  it("gives up after three transient failures and continues with the rest", async () => {
    const run = harness((raw) => (raw === "a.one" ? "Failed to fetch" : null));
    const result = await runInstalls([ref("a.one"), ref("b.two")], run.deps);
    expect(run.calls).toEqual(["a.one", "a.one", "a.one", "b.two"]);
    expect(result.outcomes).toEqual([
      { ref: ref("a.one"), kind: "failed", failure: "transient" },
      { ref: ref("b.two"), kind: "reported" },
    ]);
  });

  it("does not retry a missing, refused or failed id, and keeps no message", async () => {
    const run = harness((raw) =>
      raw === "a.one"
        ? "Extension 'a.one' not found."
        : raw === "b.two"
          ? "Can't install at /home/mabc/.vscode-server: not compatible"
          : "This extension cannot be installed because Extension is not allowed.",
    );
    const result = await runInstalls([ref("a.one"), ref("b.two"), ref("c.three")], run.deps);
    expect(run.calls).toEqual(["a.one", "b.two", "c.three"]);
    expect(run.sleeps).toEqual([]);
    expect(result.outcomes).toEqual([
      { ref: ref("a.one"), kind: "missing" },
      { ref: ref("b.two"), kind: "failed", failure: "failed" },
      { ref: ref("c.three"), kind: "failed", failure: "refused by policy" },
    ]);
    expect(JSON.stringify(result)).not.toContain("/home/");
  });

  it("stops between ids when aborted, and says it did not complete", async () => {
    const run = harness(() => null);
    const deps: InstallDeps = {
      ...run.deps,
      install: async (wanted) => {
        await run.deps.install(wanted);
        run.controller.abort();
      },
    };
    const result = await runInstalls([ref("a.one"), ref("b.two")], deps);
    expect(run.calls).toEqual(["a.one"]);
    expect(result).toEqual({
      kind: "stopped",
      outcomes: [{ ref: ref("a.one"), kind: "reported" }],
    });
  });

  it("an abort during a retry's wait stops before the next attempt", async () => {
    const run = harness(() => "Failed to fetch");
    const deps: InstallDeps = {
      ...run.deps,
      sleep: async (ms) => {
        await run.deps.sleep(ms);
        run.controller.abort();
      },
    };
    const result = await runInstalls([ref("a.one")], deps);
    expect(run.calls).toEqual(["a.one"]);
    expect(result).toEqual({ kind: "stopped", outcomes: [] });
  });

  it("an empty plan completes with nothing to report", async () => {
    const run = harness(() => null);
    expect(await runInstalls([], run.deps)).toEqual({ kind: "completed", outcomes: [] });
    expect(run.progress).toEqual([]);
  });
});

const completed = (outcomes: CompletedRun["outcomes"]): CompletedRun => ({
  kind: "completed",
  outcomes,
});

describe("noteOutcomes", () => {
  it("installed when listed, notListed when reported but absent, and nothing else learned", () => {
    const { memory, results } = noteOutcomes(
      emptyInstallMemory,
      completed([
        { ref: ref("a.one"), kind: "reported" },
        { ref: ref("b.two"), kind: "reported" },
        { ref: ref("c.three"), kind: "failed", failure: "timed out" },
      ]),
      listOf(gallery("a.one")),
      NOW,
    );
    expect(results).toEqual([
      { id: "a.one", kind: "installed" },
      { id: "b.two", kind: "notListed" },
      { id: "c.three", kind: "failed", failure: "timed out" },
    ]);
    expect(memory).toEqual(emptyInstallMemory);
  });

  it("records missing with a time, clears it on success, drops expired entries", () => {
    const { memory, results } = noteOutcomes(
      {
        version: 2,
        missing: { "a.one": NOW - 1_000, "old.gone": NOW - MISSING_TTL_MS - 1 },
      },
      completed([
        { ref: ref("a.one"), kind: "reported" },
        { ref: ref("nobody.nothing"), kind: "missing" },
      ]),
      listOf(gallery("a.one")),
      NOW,
    );
    expect(results).toEqual([
      { id: "a.one", kind: "installed" },
      { id: "nobody.nothing", kind: "missing" },
    ]);
    expect(memory).toEqual({ version: 2, missing: { "nobody.nothing": NOW } });
  });
});
