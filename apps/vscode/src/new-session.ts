import {
  catalogEfforts,
  catalogModelLabel,
  emptyHarnessModelCatalog,
  PROMPTABLE_HARNESSES,
  type HarnessModelCatalogView,
} from "@mend/domain/workbench";

import { modelPickRows } from "./model-picks.js";
import { redactOrigin } from "./project-match.js";
import type { Effort, LaunchStart, Project } from "./types.js";

/**
 * Mend: New session (story a): one quick input whose prompt is its value, a dim line under it
 * that says what Enter starts, and Change…'s steps in the same input. Pure: the extension maps
 * `render`'s view onto one `vscode.QuickPick` and its events back into `step`.
 */

/** `ask` opts into the harness's own approval prompts; `default` sends nothing (the server's bypass). */
export type PermissionChoice = "default" | "ask";

/** Where a fresh worktree starts, as she chose it. */
export type BaseChoice =
  /** The window's branch when its commits are pushed, else the project's default branch. */
  | { readonly kind: "auto" }
  /** The project's default branch, whatever the window is on. */
  | { readonly kind: "default" }
  /** A branch or commit she typed in the base step. */
  | { readonly kind: "ref"; readonly ref: string };

/** What Change… chooses. One per project per server, in `globalState`. */
export interface SessionOptions {
  /** `claude`, `codex`, `opencode`, `pi`, or `shell` (no agent: a shell holds the workspace). */
  readonly harness: string;
  /** Null sends no model: the harness's default from the server's catalog. */
  readonly model: string | null;
  /** Null sends no effort: the harness's own default. */
  readonly effort: Effort | null;
  readonly permission: PermissionChoice;
  readonly base: BaseChoice;
}

export const DEFAULT_OPTIONS: SessionOptions = {
  harness: "claude",
  model: null,
  effort: null,
  permission: "default",
  base: { kind: "auto" },
};

/** `globalState["mend.newSession"]`: per server URL, per project id. */
export type RememberedOptions = Readonly<Record<string, Readonly<Record<string, SessionOptions>>>>;

export const REMEMBERED_OPTIONS_KEY = "mend.newSession";

/**
 * The window's checkout against its remote-tracking branch (`git merge-base --is-ancestor HEAD
 * <upstream>`): the base-pushed fact. Read from git on this machine, not the server.
 */
export type CheckoutFact =
  /** Not this project's checkout, not a git folder, or a detached HEAD: nothing to say. */
  | { readonly kind: "elsewhere" }
  /**
   * HEAD is an ancestor of `commit`, what `upstream` (`refs/remotes/<remote>/<branch>`) pointed at
   * when it was read once: the server's store can have every commit of it. The upstream's branch
   * may be named unlike the local one.
   */
  | {
      readonly kind: "pushed";
      readonly branch: string;
      readonly upstream: string;
      readonly commit: string;
    }
  /** HEAD has commits origin lacks (or the branch has no remote-tracking ref). */
  | { readonly kind: "unpushed"; readonly branch: string }
  /** Git did not answer in time, failed, or said "no" where a shallow boundary can hide history. */
  | { readonly kind: "unknown"; readonly branch: string | null };

/** Joining an existing worktree: its base is fixed. */
export interface JoinTarget {
  /** The server's name for it, which create sends. */
  readonly worktree: string;
  readonly worktreeId: string;
  /** What the title and dim line call it: its name, or whose it is when the name is `wt-<uuid>`. */
  readonly shown: string;
}

/** The new session as the quick input holds it. */
export interface NewSessionDraft {
  readonly project: Project;
  /** Joining an existing worktree (`New session · <project> · in <worktree>`): its base is fixed. */
  readonly join: JoinTarget | null;
  readonly prompt: string;
  readonly options: SessionOptions;
  readonly checkout: CheckoutFact;
  /** The upstream base the store refused at create: the draft starts from the default instead. */
  readonly refusedBase: string | null;
}

/**
 * Where the session starts, resolved from the draft: `ref` is what the create request sends,
 * `shown` what the dim line says, and `note` what Mend observed that moved it to the default.
 */
export type ResolvedBase =
  | {
      readonly kind: "ref";
      readonly ref: string;
      readonly shown: string;
      readonly note: string | null;
    }
  | { readonly kind: "worktree"; readonly worktree: string; readonly shown: string };

/** What the flow reads beside its own state; the extension owns each and passes them in. */
export interface FlowFacts {
  /** Every adopted project, for the project step. */
  readonly projects: ReadonlyArray<Project>;
  /** This window's repository when no project matched it: what Adopt this repository adopts. */
  readonly adoptable: { readonly origin: string; readonly name: string } | null;
  /**
   * The projects the window's repository matches equally (one origin, several projects): the
   * project step lists only them, and the one she picks starts from the window's checkout.
   */
  readonly candidates: ReadonlyArray<Project>;
  /** The window folder's checkout: the draft's once its project is the folder's (matched or adopted). */
  readonly checkout: CheckoutFact;
  /**
   * `GET /harnesses/models`, null until it is read. Once read, a remembered model it does not
   * list is dropped; until then the model step offers `default model` and the remembered one.
   */
  readonly catalogs: ReadonlyArray<HarnessModelCatalogView> | null;
  /** This server's remembered options, by project id. */
  readonly remembered: Readonly<Record<string, SessionOptions>>;
  /** Prompts typed and not started, by `keptPromptKey`, for this server. */
  readonly kept: ReadonlyMap<string, string>;
  /** Who else runs in the joined worktree (`worktreeJoinLine`); null when nobody does. */
  readonly joinLine: string | null;
}

// ─── the quick-input step machine ─────────────────────────────────────────────

export type OptionStep = "harness" | "model" | "effort" | "permission" | "base";

export type Step =
  /** No project matched the window: pick one, or adopt this repository (top, when adoptable). */
  | { readonly kind: "project" }
  /** The prompt, and the dim line under it with Change…. Enter starts. */
  | { readonly kind: "prompt" }
  /** One of Change…'s steps, with its counter `n/total` and Back. */
  | { readonly kind: "option"; readonly option: OptionStep }
  /** Enter started the session: nothing more is taken. */
  | { readonly kind: "started" };

export interface FlowState {
  readonly step: Step;
  /** Null only on the project step, before a project is chosen. */
  readonly draft: NewSessionDraft | null;
  /** What she typed on a step whose value is not the prompt: the project or option filter. */
  readonly query: string;
  /** Mend is unreachable: the dim line says so and Enter keeps the input open. */
  readonly offline: boolean;
  /** An adopt is in flight: the input is busy and takes nothing. */
  readonly adopting: boolean;
  /** Whether Back from the prompt returns to the project step. */
  readonly cameFromProjects: boolean;
  /** What the catalog read dropped from the remembered options: the dim line says it once. */
  readonly dropped: string | null;
}

export type FlowEvent =
  | { readonly kind: "typed"; readonly value: string }
  /** Enter, or a click, on an item: its id. */
  | { readonly kind: "accept"; readonly item: string }
  | { readonly kind: "change" }
  | { readonly kind: "back" }
  | { readonly kind: "connection"; readonly offline: boolean }
  | { readonly kind: "adopted"; readonly project: Project }
  | { readonly kind: "adoptFailed" }
  /** `GET /harnesses/models` answered: `facts.catalogs` holds it now. */
  | { readonly kind: "catalogsRead" }
  /** The store does not know `base`, sent from the upstream: the prompt returns, from the default. */
  | { readonly kind: "baseRefused"; readonly base: string };

/** `POST /projects/:id/sessions`, as the start sends it. */
export interface CreateRequest {
  readonly purpose?: "setup";
  readonly harness: string;
  readonly mode: "pty";
  readonly label: string | null;
  /** The worktree a join names; null derives a fresh one. */
  readonly name: string | null;
  /** Null for a join: the worktree keeps its own base. */
  readonly base: string | null;
}

/** `POST /sessions/:id/launch`, as the start sends it. */
export type LaunchRequest = LaunchStart & { readonly mode: "pty" };

/** What the shell around the machine does after an event. */
export type FlowEffect =
  | { readonly kind: "none" }
  | { readonly kind: "remember"; readonly projectId: string; readonly options: SessionOptions }
  | { readonly kind: "adopt"; readonly origin: string; readonly name: string }
  | {
      readonly kind: "start";
      readonly draft: NewSessionDraft;
      readonly create: CreateRequest;
      readonly launch: LaunchRequest;
    };

export interface QuickInputItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Shown whatever she typed: the typed base. */
  readonly alwaysShow?: boolean;
  readonly current?: boolean;
}

interface InputView {
  readonly title: string;
  readonly back: boolean;
  readonly placeholder: string;
  readonly value: string;
  readonly busy: boolean;
}

/** What the quick input shows for a state; the adapter maps each kind onto its own VS Code input. */
export type QuickInputView =
  /** The project step and Change…'s steps: a `vscode.QuickPick`, its rows filtered by `value`. */
  | (InputView & {
      readonly kind: "pick";
      /** `n/total` on Change…'s steps; null on the project step. */
      readonly step: { readonly n: number; readonly total: number } | null;
      readonly items: ReadonlyArray<QuickInputItem>;
    })
  /**
   * The prompt: a `vscode.InputBox`, which filters nothing. A QuickPick matches its value against
   * its rows as a regular expression, which VS Code's renderer cannot build past about 32,000
   * characters, so a longer prompt never reached the extension. `line` is the dim line under the
   * input, `warned` when it says something Mend observed; Change… is a button on the title bar.
   */
  | (InputView & { readonly kind: "prompt"; readonly line: string; readonly warned: boolean });

// ─── reading the draft ────────────────────────────────────────────────────────

const SHELL = "shell";
export const HARNESSES: ReadonlyArray<string> = [...PROMPTABLE_HARNESSES, SHELL];
export const OFFLINE_LINE = "Mend is offline · retrying";
const ADOPT_ITEM = "adopt";

const catalogOf = (
  catalogs: ReadonlyArray<HarnessModelCatalogView> | null,
  harness: string,
): HarnessModelCatalogView =>
  catalogs?.find((catalog) => catalog.harness === harness) ?? emptyHarnessModelCatalog(harness);

/** `default model`, or the catalog's label for the chosen one. */
const modelWords = (facts: FlowFacts, options: SessionOptions): string =>
  options.model === null
    ? "default model"
    : catalogModelLabel(catalogOf(facts.catalogs, options.harness), options.model);

/**
 * Remembered options against the catalog just read: a model it no longer lists, and an effort the
 * model no longer takes, are dropped, and `dropped` says which.
 */
export const reconcileOptions = (
  options: SessionOptions,
  catalogs: ReadonlyArray<HarnessModelCatalogView>,
): { readonly options: SessionOptions; readonly dropped: string | null } => {
  if (options.harness === SHELL) return { options, dropped: null };
  const catalog = catalogOf(catalogs, options.harness);
  const model =
    options.model !== null && !catalog.models.some((entry) => entry.id === options.model)
      ? null
      : options.model;
  const effort =
    options.effort !== null && !catalogEfforts(catalog, model).includes(options.effort)
      ? null
      : options.effort;
  const dropped = [
    ...(model === options.model ? [] : [`the server no longer lists ${options.model}`]),
    ...(effort === options.effort ? [] : [`${options.effort} thinking isn't offered`]),
  ];
  return dropped.length === 0
    ? { options, dropped: null }
    : { options: { ...options, model, effort }, dropped: dropped.join(" · ") };
};

/**
 * The base the window's upstream gives the create route. A branch of the project's origin goes by
 * its name, which the store fetches and resolves on origin and records for landing: origin moving
 * on since the read only adds commits after the one that holds HEAD, unless someone rewrote the
 * branch. An upstream on another remote goes by the commit HEAD was checked against.
 */
const upstreamBase = (
  checkout: Extract<CheckoutFact, { readonly kind: "pushed" }>,
): { readonly ref: string; readonly shown: string } => {
  const ORIGIN = "refs/remotes/origin/";
  if (checkout.upstream.startsWith(ORIGIN)) {
    const branch = checkout.upstream.slice(ORIGIN.length);
    return { ref: branch, shown: branch };
  }
  return { ref: checkout.commit, shown: checkout.upstream.replace(/^refs\/remotes\//, "") };
};

export const resolveBase = (draft: NewSessionDraft): ResolvedBase => {
  if (draft.join !== null)
    return { kind: "worktree", worktree: draft.join.worktree, shown: draft.join.shown };
  const { base } = draft.options;
  const fallback = draft.project.defaultBranch;
  const fromDefault = (note: string | null): ResolvedBase => ({
    kind: "ref",
    ref: fallback,
    shown: fallback,
    note,
  });
  if (base.kind === "ref") return { kind: "ref", ref: base.ref, shown: base.ref, note: null };
  if (base.kind === "default") return fromDefault(null);
  const { checkout } = draft;
  switch (checkout.kind) {
    case "elsewhere":
      return fromDefault(null);
    case "unknown":
      return fromDefault("couldn't read your branch");
    case "unpushed":
      return fromDefault(
        checkout.branch === fallback
          ? `your commits on ${fallback} aren't pushed`
          : `your branch ${checkout.branch} isn't pushed`,
      );
    case "pushed": {
      const upstream = upstreamBase(checkout);
      return draft.refusedBase === upstream.ref
        ? fromDefault(`Mend's store couldn't find ${upstream.shown}`)
        : { kind: "ref", ...upstream, note: null };
    }
  }
};

/** The base create sends when it came from the window's upstream: the one a refusal moves off. */
const upstreamRef = (draft: NewSessionDraft): string | null =>
  draft.join === null &&
  draft.options.base.kind === "auto" &&
  draft.checkout.kind === "pushed" &&
  draft.refusedBase === null
    ? upstreamBase(draft.checkout).ref
    : null;

/**
 * Whether create's refusal moves the draft to the default: only when the store named the base it
 * does not know (`StoreFailure.unknownBase`) and that base came from the window's upstream. Any
 * other refusal (a fetch, `git worktree add`, the disk) is said as it is, and the base stays.
 */
export const movesToDefault = (draft: NewSessionDraft, unknownBase: string | null): boolean =>
  unknownBase !== null && unknownBase === upstreamRef(draft);

const baseWords = (base: ResolvedBase): string =>
  base.kind === "worktree"
    ? `in ${base.shown}`
    : [`from ${base.shown}`, ...(base.note === null ? [] : [base.note])].join(" · ");

/**
 * The most UTF-8 bytes a prompt may have. The prompt reaches the harness as one argv word, and
 * Linux takes at most 131,072 bytes per word with its NUL (`MAX_ARG_STRLEN`), which the Sealant
 * SDK enforces as 131,071 (`SESSION_ARGV_MAX_WORD_BYTES`). The rest is headroom.
 */
export const PROMPT_MAX_BYTES = 120_000;

const BYTES = new Intl.NumberFormat("en-US");

/** Why the trimmed prompt cannot be the harness's argument; null when it can. */
export const promptIssue = (prompt: string, harness: string): string | null => {
  if (prompt.includes("\0")) return "the prompt has a NUL character, which no argument can carry";
  if (!prompt.isWellFormed()) return "the prompt has a broken character (a lone surrogate)";
  if (prompt.startsWith("-")) return `${harness} would read a prompt that starts with - as a flag`;
  const bytes = Buffer.byteLength(prompt, "utf8");
  return bytes > PROMPT_MAX_BYTES
    ? `the prompt is ${BYTES.format(bytes)} bytes · ${harness} takes at most ${BYTES.format(PROMPT_MAX_BYTES)}`
    : null;
};

/** Why Enter starts nothing for this draft; null when it starts. A shell's text is its label. */
const draftIssue = (draft: NewSessionDraft): string | null => {
  const typed = draft.prompt.trim();
  if (draft.options.harness !== SHELL) return promptIssue(typed, draft.options.harness);
  return typed.includes("\0") ? "the name has a NUL character" : null;
};

/** `claude · default model · high thinking · asks before acting · from main`. */
export const dimLine = (
  draft: NewSessionDraft,
  facts: FlowFacts,
  offline: boolean,
  dropped: string | null = null,
): string => {
  if (offline) return OFFLINE_LINE;
  const { options } = draft;
  const issue = draftIssue(draft);
  if (issue !== null) return issue;
  const base = resolveBase(draft);
  const agent =
    options.harness === SHELL
      ? []
      : [
          modelWords(facts, options),
          ...(options.effort === null ? [] : [`${options.effort} thinking`]),
          ...(options.permission === "ask" ? ["asks before acting"] : []),
        ];
  return [
    options.harness,
    ...agent,
    baseWords(base),
    ...(base.kind === "worktree" && facts.joinLine !== null ? [facts.joinLine] : []),
    ...(dropped === null ? [] : [dropped]),
  ].join(" · ");
};

/** What Enter sends: the create, then the launch on the session it made. */
export const startRequests = (
  draft: NewSessionDraft,
): { readonly create: CreateRequest; readonly launch: LaunchRequest } => {
  const { options } = draft;
  const base = resolveBase(draft);
  const typed = draft.prompt.trim();
  const shell = options.harness === SHELL;
  return {
    create: {
      harness: options.harness,
      mode: "pty",
      label: shell && typed !== "" ? typed : null,
      name: base.kind === "worktree" ? base.worktree : null,
      base: base.kind === "ref" ? base.ref : null,
    },
    launch: {
      mode: "pty",
      ...(shell || typed === "" ? {} : { prompt: typed }),
      ...(shell || options.model === null ? {} : { model: options.model }),
      ...(shell || options.effort === null ? {} : { effort: options.effort }),
      ...(shell || options.permission === "default" ? {} : { permissionMode: "ask" }),
    },
  };
};

// ─── Change…'s steps, one table ───────────────────────────────────────────────

interface OptionRow {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly current: boolean;
  readonly alwaysShow?: boolean;
  readonly apply: (options: SessionOptions) => SessionOptions;
}

interface OptionStepSpec {
  readonly applies: (draft: NewSessionDraft, facts: FlowFacts) => boolean;
  readonly placeholder: (draft: NewSessionDraft, facts: FlowFacts) => string;
  readonly rows: (
    draft: NewSessionDraft,
    facts: FlowFacts,
    query: string,
  ) => ReadonlyArray<OptionRow>;
}

const PERMISSIONS: ReadonlyArray<PermissionChoice> = ["default", "ask"];

const OPTION_ORDER: ReadonlyArray<OptionStep> = [
  "harness",
  "model",
  "effort",
  "permission",
  "base",
];

const OPTION_STEPS: Readonly<Record<OptionStep, OptionStepSpec>> = {
  harness: {
    applies: () => true,
    placeholder: () => "Harness",
    rows: ({ options }) =>
      HARNESSES.map((harness) => ({
        id: `harness:${harness}`,
        label: harness,
        ...(harness === SHELL ? { description: "no agent: a shell holds the workspace" } : {}),
        current: options.harness === harness,
        apply: (current) =>
          current.harness === harness
            ? current
            : { ...current, harness, model: null, effort: null },
      })),
  },
  model: {
    // Every harness but the shell has this step, catalog read or not: `default model` is always here.
    applies: ({ options }) => options.harness !== SHELL,
    placeholder: ({ options }, facts) =>
      facts.catalogs === null
        ? `Model for ${options.harness} · the server's models aren't read yet`
        : `Model for ${options.harness}`,
    rows: ({ options }, facts) => {
      const catalog = catalogOf(facts.catalogs, options.harness);
      const listed = modelPickRows(catalog, options.harness);
      const remembered =
        options.model !== null && !listed.some((row) => row.model === options.model)
          ? [{ label: options.model, description: "remembered", model: options.model }]
          : [];
      return [...listed, ...remembered].map((row) => ({
        id: `model:${row.model ?? ""}`,
        label: row.label,
        description: row.description,
        current: options.model === row.model,
        apply: (current) => {
          const takes = catalogEfforts(catalog, row.model);
          return {
            ...current,
            model: row.model,
            effort:
              current.effort !== null && (facts.catalogs === null || takes.includes(current.effort))
                ? current.effort
                : null,
          };
        },
      }));
    },
  },
  effort: {
    applies: ({ options }, facts) =>
      options.harness !== SHELL &&
      (facts.catalogs === null ||
        catalogEfforts(catalogOf(facts.catalogs, options.harness), options.model).length > 0),
    placeholder: ({ options }, facts) => `Thinking for ${modelWords(facts, options)}`,
    rows: ({ options }, facts) => {
      const takes = catalogEfforts(catalogOf(facts.catalogs, options.harness), options.model);
      const efforts = [
        null,
        ...takes,
        ...(options.effort !== null && !takes.includes(options.effort) ? [options.effort] : []),
      ];
      return efforts.map((effort) => ({
        id: `effort:${effort ?? ""}`,
        label: effort ?? "default",
        current: options.effort === effort,
        apply: (current) => ({ ...current, effort }),
      }));
    },
  },
  permission: {
    applies: ({ options }) => options.harness !== SHELL,
    placeholder: () => "Permissions",
    rows: ({ options }) =>
      PERMISSIONS.map((permission) => ({
        id: `permission:${permission}`,
        label: permission === "default" ? "Skip permission prompts" : "Ask before acting",
        current: options.permission === permission,
        apply: (current) => ({ ...current, permission }),
      })),
  },
  base: {
    applies: (draft) => draft.join === null,
    placeholder: () => "Base: a branch or commit",
    rows: (draft, _facts, query) => {
      const { base } = draft.options;
      const auto = resolveBase({ ...draft, options: { ...draft.options, base: { kind: "auto" } } });
      const fallback = draft.project.defaultBranch;
      const typed = query.trim();
      const refs = [
        ...(base.kind === "ref" ? [base.ref] : []),
        ...(typed !== "" && typed !== fallback && !(base.kind === "ref" && base.ref === typed)
          ? [typed]
          : []),
      ];
      return [
        {
          id: "base:auto",
          label: "this window's branch",
          description: baseWords(auto),
          current: base.kind === "auto",
          apply: (current) => ({ ...current, base: { kind: "auto" } }),
        },
        {
          id: "base:default",
          label: fallback,
          description: "the default branch",
          current: base.kind === "default",
          apply: (current) => ({ ...current, base: { kind: "default" } }),
        },
        ...refs.map(
          (ref): OptionRow => ({
            id: `base:ref:${ref}`,
            label: ref,
            description: "a branch or commit",
            alwaysShow: true,
            current: base.kind === "ref" && base.ref === ref,
            apply: (current) => ({ ...current, base: { kind: "ref", ref } }),
          }),
        ),
      ];
    },
  },
};

/** The option steps that apply to this draft, in order: the counter counts only these. */
export const applicableSteps = (
  draft: NewSessionDraft,
  facts: FlowFacts,
): ReadonlyArray<OptionStep> =>
  OPTION_ORDER.filter((option) => OPTION_STEPS[option].applies(draft, facts));

// ─── opening, and the reducer ─────────────────────────────────────────────────

/** Where a typed prompt is kept until a session starts: per project and joined worktree. */
export const keptPromptKey = (projectId: string, join: JoinTarget | null): string =>
  `${projectId}:${join?.worktreeId ?? ""}`;

const draftFor = (
  project: Project,
  join: JoinTarget | null,
  checkout: CheckoutFact,
  facts: FlowFacts,
): NewSessionDraft => ({
  project,
  join,
  prompt: facts.kept.get(keptPromptKey(project.id, join)) ?? "",
  options: facts.remembered[project.id] ?? DEFAULT_OPTIONS,
  checkout,
  refusedBase: null,
});

/**
 * The flow as it opens: the prompt step of the window's project (its checkout read) or the
 * project a row named; the project step when neither is known.
 */
export const openFlow = (
  opening: {
    readonly project: Project | null;
    readonly join: JoinTarget | null;
    readonly checkout: CheckoutFact;
    readonly offline: boolean;
  },
  facts: FlowFacts,
): FlowState => ({
  step: opening.project === null ? { kind: "project" } : { kind: "prompt" },
  draft:
    opening.project === null
      ? null
      : draftFor(opening.project, opening.join, opening.checkout, facts),
  query: "",
  offline: opening.offline,
  adopting: false,
  cameFromProjects: false,
  dropped: null,
});

const NONE: FlowEffect = { kind: "none" };

/**
 * The prompt step on `draft`, its options checked against the catalog once it is read: what the
 * check dropped is said on the dim line and remembered, so a retired model is never sent again.
 */
const atCheckedPrompt = (
  state: FlowState,
  draft: NewSessionDraft,
  facts: FlowFacts,
): { readonly state: FlowState; readonly effect: FlowEffect } => {
  const checked =
    facts.catalogs === null
      ? { options: draft.options, dropped: null }
      : reconcileOptions(draft.options, facts.catalogs);
  const next = { ...draft, options: checked.options };
  return {
    state: { ...atPrompt(state, next), dropped: checked.dropped },
    effect:
      checked.dropped === null
        ? NONE
        : { kind: "remember", projectId: next.project.id, options: next.options },
  };
};
const ELSEWHERE: CheckoutFact = { kind: "elsewhere" };

const projectItems = (facts: FlowFacts): ReadonlyArray<QuickInputItem> => [
  ...(facts.adoptable === null || facts.candidates.length > 0
    ? []
    : [
        {
          id: ADOPT_ITEM,
          label: "$(repo-clone) Adopt this repository",
          description: redactOrigin(facts.adoptable.origin),
        },
      ]),
  ...(facts.candidates.length > 0 ? facts.candidates : facts.projects).map((project) => ({
    id: `project:${project.id}`,
    label: project.name,
    description: project.defaultBranch,
  })),
];

const atOption = (state: FlowState, draft: NewSessionDraft, option: OptionStep): FlowState => ({
  ...state,
  step: { kind: "option", option },
  draft,
  query: "",
});

const atPrompt = (state: FlowState, draft: NewSessionDraft): FlowState => ({
  ...state,
  step: { kind: "prompt" },
  draft,
  query: "",
});

const acceptProject = (
  state: FlowState,
  item: string,
  facts: FlowFacts,
): { readonly state: FlowState; readonly effect: FlowEffect } => {
  if (state.adopting) return { state, effect: NONE };
  if (item === ADOPT_ITEM) {
    if (facts.adoptable === null || facts.candidates.length > 0 || state.offline)
      return { state, effect: NONE };
    return {
      state: { ...state, adopting: true },
      effect: { kind: "adopt", ...facts.adoptable },
    };
  }
  const listed = facts.candidates.length > 0 ? facts.candidates : facts.projects;
  const project = listed.find((candidate) => `project:${candidate.id}` === item);
  if (project === undefined) return { state, effect: NONE };
  const checkout = facts.candidates.includes(project) ? facts.checkout : ELSEWHERE;
  return atCheckedPrompt(
    { ...state, cameFromProjects: true },
    draftFor(project, null, checkout, facts),
    facts,
  );
};

const acceptOption = (
  state: FlowState,
  draft: NewSessionDraft,
  option: OptionStep,
  item: string,
  facts: FlowFacts,
): { readonly state: FlowState; readonly effect: FlowEffect } => {
  const row = OPTION_STEPS[option].rows(draft, facts, state.query).find((one) => one.id === item);
  if (row === undefined) return { state, effect: NONE };
  const next = { ...draft, options: row.apply(draft.options) };
  const steps = applicableSteps(next, facts);
  const after = OPTION_ORDER.slice(OPTION_ORDER.indexOf(option) + 1).find((candidate) =>
    steps.includes(candidate),
  );
  return {
    state: after === undefined ? atPrompt(state, next) : atOption(state, next, after),
    effect: { kind: "remember", projectId: next.project.id, options: next.options },
  };
};

const back = (state: FlowState, facts: FlowFacts): FlowState => {
  const { step, draft } = state;
  if (draft === null) return state;
  if (step.kind === "prompt")
    return state.cameFromProjects
      ? { ...state, step: { kind: "project" }, draft: null, query: "", cameFromProjects: false }
      : state;
  if (step.kind !== "option") return state;
  const earlier = OPTION_ORDER.slice(0, OPTION_ORDER.indexOf(step.option))
    .filter((option) => applicableSteps(draft, facts).includes(option))
    .at(-1);
  return earlier === undefined ? atPrompt(state, draft) : atOption(state, draft, earlier);
};

/** One event, one next state and what the extension does about it. */
export const step = (
  state: FlowState,
  event: FlowEvent,
  facts: FlowFacts,
): { readonly state: FlowState; readonly effect: FlowEffect } => {
  const unchanged = { state, effect: NONE };
  const { draft } = state;
  if (state.step.kind === "started") {
    // The store could not resolve her upstream: the prompt is back, and Enter starts from the default.
    return event.kind === "baseRefused" && draft !== null && movesToDefault(draft, event.base)
      ? { state: atPrompt(state, { ...draft, refusedBase: event.base }), effect: NONE }
      : unchanged;
  }
  switch (event.kind) {
    case "connection":
      return { state: { ...state, offline: event.offline }, effect: NONE };
    case "typed":
      return state.step.kind === "prompt" && draft !== null
        ? { state: { ...state, draft: { ...draft, prompt: event.value } }, effect: NONE }
        : { state: { ...state, query: event.value }, effect: NONE };
    case "adopted":
      if (!state.adopting) return unchanged;
      return atCheckedPrompt(
        { ...state, adopting: false, cameFromProjects: true },
        draftFor(event.project, null, facts.checkout, facts),
        facts,
      );
    case "catalogsRead": {
      if (draft === null) return unchanged;
      const checked = atCheckedPrompt(state, draft, facts);
      const at = state.step;
      // On one of Change…'s steps she stays there, unless the catalog took that step away.
      return at.kind === "option" &&
        checked.state.draft !== null &&
        applicableSteps(checked.state.draft, facts).includes(at.option)
        ? { ...checked, state: { ...checked.state, step: at, query: state.query } }
        : checked;
    }
    case "baseRefused":
      return unchanged;
    case "adoptFailed":
      return { state: { ...state, adopting: false }, effect: NONE };
    case "back":
      return { state: back(state, facts), effect: NONE };
    case "change": {
      if (state.step.kind !== "prompt" || draft === null) return unchanged;
      const [first] = applicableSteps(draft, facts);
      return first === undefined
        ? unchanged
        : { state: atOption(state, draft, first), effect: NONE };
    }
    case "accept": {
      if (state.step.kind === "project") return acceptProject(state, event.item, facts);
      if (draft === null) return unchanged;
      if (state.step.kind === "option")
        return acceptOption(state, draft, state.step.option, event.item, facts);
      if (state.offline || draftIssue(draft) !== null) return unchanged;
      return {
        state: { ...state, step: { kind: "started" } },
        effect: { kind: "start", draft, ...startRequests(draft) },
      };
    }
  }
};

/** The kept prompts after a step: what she typed is kept, and a start forgets it. */
export const keptAfter = (
  kept: ReadonlyMap<string, string>,
  state: FlowState,
  effect: FlowEffect,
): ReadonlyMap<string, string> => {
  const draft = effect.kind === "start" ? effect.draft : state.draft;
  if (draft === null) return kept;
  const key = keptPromptKey(draft.project.id, draft.join);
  if (effect.kind !== "start" && kept.get(key) === draft.prompt) return kept;
  const next = new Map(kept);
  if (effect.kind === "start" || draft.prompt === "") next.delete(key);
  else next.set(key, draft.prompt);
  return next;
};

// ─── the view ─────────────────────────────────────────────────────────────────

const titleOf = (draft: NewSessionDraft | null): string =>
  draft === null
    ? "New session"
    : draft.join === null
      ? `New session · ${draft.project.name}`
      : `New session · ${draft.project.name} · in ${draft.join.shown}`;

export const render = (state: FlowState, facts: FlowFacts): QuickInputView => {
  const { step: at, draft } = state;
  if (at.kind === "project" || draft === null)
    return {
      kind: "pick",
      title: "New session",
      step: null,
      back: false,
      placeholder:
        facts.candidates.length > 0
          ? "Several projects have this repository's origin: choose one"
          : "Choose a project",
      value: state.query,
      busy: state.adopting,
      items: projectItems(facts),
    };
  if (at.kind === "option") {
    const spec = OPTION_STEPS[at.option];
    const steps = applicableSteps(draft, facts);
    const remembered = facts.remembered[draft.project.id] !== undefined;
    return {
      kind: "pick",
      title: titleOf(draft),
      step: { n: steps.indexOf(at.option) + 1, total: steps.length },
      back: true,
      placeholder: spec.placeholder(draft, facts),
      value: state.query,
      busy: false,
      items: spec.rows(draft, facts, state.query).map((row) => ({
        id: row.id,
        label: row.current ? `$(check) ${row.label}` : row.label,
        ...(row.current && remembered
          ? { description: `remembered for ${draft.project.name}` }
          : row.description === undefined
            ? {}
            : { description: row.description }),
        ...(row.alwaysShow === true ? { alwaysShow: true } : {}),
        current: row.current,
      })),
    };
  }
  const base = resolveBase(draft);
  return {
    kind: "prompt",
    title: titleOf(draft),
    back: state.cameFromProjects,
    placeholder:
      draft.options.harness === SHELL
        ? "A name for this shell (optional)"
        : `What should ${draft.options.harness} do?`,
    value: draft.prompt,
    busy: at.kind === "started",
    line: dimLine(draft, facts, state.offline, state.dropped),
    warned:
      !state.offline && ((base.kind === "ref" && base.note !== null) || draftIssue(draft) !== null),
  };
};

// ─── what globalState keeps ───────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const EFFORTS: ReadonlyArray<Effort> = ["low", "medium", "high", "xhigh", "max", "ultra"];

const isBaseChoice = (value: unknown): value is BaseChoice =>
  isRecord(value) &&
  (value["kind"] === "auto" ||
    value["kind"] === "default" ||
    (value["kind"] === "ref" && typeof value["ref"] === "string" && value["ref"] !== ""));

export const isSessionOptions = (value: unknown): value is SessionOptions =>
  isRecord(value) &&
  typeof value["harness"] === "string" &&
  HARNESSES.includes(value["harness"]) &&
  (value["model"] === null || typeof value["model"] === "string") &&
  (value["effort"] === null || EFFORTS.some((effort) => effort === value["effort"])) &&
  (value["permission"] === "default" || value["permission"] === "ask") &&
  isBaseChoice(value["base"]);

/** `globalState["mend.newSession"]` as written: anything else reads as nothing remembered. */
export const isRememberedOptions = (value: unknown): value is RememberedOptions =>
  isRecord(value) &&
  Object.values(value).every(
    (projects) => isRecord(projects) && Object.values(projects).every(isSessionOptions),
  );

/** The remembered options with one project's replaced. */
export const remember = (
  all: RememberedOptions,
  server: string,
  projectId: string,
  options: SessionOptions,
): RememberedOptions => ({ ...all, [server]: { ...all[server], [projectId]: options } });
