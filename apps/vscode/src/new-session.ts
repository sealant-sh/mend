import {
  catalogEfforts,
  catalogModelLabel,
  emptyHarnessModelCatalog,
  PROMPTABLE_HARNESSES,
  type HarnessModelCatalogView,
} from "@mend/domain/workbench";

import { modelPickRows } from "./model-picks.js";
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
  /** HEAD is on origin: the server's store can have every commit of it. */
  | { readonly kind: "pushed"; readonly branch: string }
  /** HEAD has commits origin lacks (or the branch has no remote-tracking ref). */
  | { readonly kind: "unpushed"; readonly branch: string };

/** Joining an existing worktree: its base is fixed. */
export interface JoinTarget {
  readonly worktree: string;
  readonly worktreeId: string;
}

/** The new session as the quick input holds it. */
export interface NewSessionDraft {
  readonly project: Project;
  /** Joining an existing worktree (`New session · <project> · in <worktree>`): its base is fixed. */
  readonly join: JoinTarget | null;
  readonly prompt: string;
  readonly options: SessionOptions;
  readonly checkout: CheckoutFact;
}

/** Where the session starts, resolved from the draft: what the create request sends and the dim line says. */
export type ResolvedBase =
  | { readonly kind: "ref"; readonly ref: string; readonly unpushed: string | null }
  | { readonly kind: "worktree"; readonly worktree: string };

/** What the flow reads beside its own state; the extension owns each and passes them in. */
export interface FlowFacts {
  /** Every adopted project, for the project step. */
  readonly projects: ReadonlyArray<Project>;
  /** This window's repository when no project matched it: what Adopt this repository adopts. */
  readonly adoptable: { readonly origin: string; readonly name: string } | null;
  /** The window folder's checkout: the draft's once its project is the folder's (matched or adopted). */
  readonly checkout: CheckoutFact;
  /** `GET /harnesses/models`; a harness it does not list has no model step. */
  readonly catalogs: ReadonlyArray<HarnessModelCatalogView>;
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
}

export type FlowEvent =
  | { readonly kind: "typed"; readonly value: string }
  /** Enter, or a click, on an item: its id. */
  | { readonly kind: "accept"; readonly item: string }
  | { readonly kind: "change" }
  | { readonly kind: "back" }
  | { readonly kind: "connection"; readonly offline: boolean }
  | { readonly kind: "adopted"; readonly project: Project }
  | { readonly kind: "adoptFailed" };

/** `POST /projects/:id/sessions`, as the start sends it. */
export interface CreateRequest {
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
  /** The prompt step's one row carries the Change… button. */
  readonly change?: boolean;
  /** Shown whatever she typed: the prompt's row, and the typed base. */
  readonly alwaysShow?: boolean;
  readonly current?: boolean;
}

/** What the quick input shows for a state: the adapter maps it onto one `vscode.QuickPick`. */
export interface QuickInputView {
  readonly title: string;
  /** `n/total` on Change…'s steps; null elsewhere. */
  readonly step: { readonly n: number; readonly total: number } | null;
  readonly back: boolean;
  readonly placeholder: string;
  readonly value: string;
  readonly busy: boolean;
  readonly items: ReadonlyArray<QuickInputItem>;
}

// ─── reading the draft ────────────────────────────────────────────────────────

const SHELL = "shell";
export const HARNESSES: ReadonlyArray<string> = [...PROMPTABLE_HARNESSES, SHELL];
export const OFFLINE_LINE = "Mend is offline · retrying";
const START_ITEM = "start";
const ADOPT_ITEM = "adopt";

const catalogOf = (facts: FlowFacts, harness: string): HarnessModelCatalogView =>
  facts.catalogs.find((catalog) => catalog.harness === harness) ??
  emptyHarnessModelCatalog(harness);

/** `default model`, or the catalog's label for the chosen one. */
const modelWords = (facts: FlowFacts, options: SessionOptions): string =>
  options.model === null
    ? "default model"
    : catalogModelLabel(catalogOf(facts, options.harness), options.model);

export const resolveBase = (draft: NewSessionDraft): ResolvedBase => {
  if (draft.join !== null) return { kind: "worktree", worktree: draft.join.worktree };
  const { base } = draft.options;
  const fallback = draft.project.defaultBranch;
  if (base.kind === "ref") return { kind: "ref", ref: base.ref, unpushed: null };
  if (base.kind === "default") return { kind: "ref", ref: fallback, unpushed: null };
  const { checkout } = draft;
  if (checkout.kind === "pushed") return { kind: "ref", ref: checkout.branch, unpushed: null };
  if (checkout.kind === "elsewhere") return { kind: "ref", ref: fallback, unpushed: null };
  return {
    kind: "ref",
    ref: fallback,
    unpushed:
      checkout.branch === fallback
        ? `your commits on ${fallback} aren't pushed`
        : `your branch ${checkout.branch} isn't pushed`,
  };
};

const baseWords = (base: ResolvedBase): string =>
  base.kind === "worktree"
    ? `in ${base.worktree}`
    : [`from ${base.ref}`, ...(base.unpushed === null ? [] : [base.unpushed])].join(" · ");

const flagLike = (draft: NewSessionDraft): boolean =>
  draft.options.harness !== SHELL && draft.prompt.trim().startsWith("-");

/** `claude · default model · high thinking · asks before acting · from main`. */
export const dimLine = (draft: NewSessionDraft, facts: FlowFacts, offline: boolean): string => {
  if (offline) return OFFLINE_LINE;
  const { options } = draft;
  if (flagLike(draft)) return `${options.harness} would read a prompt that starts with - as a flag`;
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
    applies: ({ options }, facts) =>
      options.harness !== SHELL && catalogOf(facts, options.harness).models.length > 0,
    placeholder: ({ options }) => `Model for ${options.harness}`,
    rows: ({ options }, facts) => {
      const catalog = catalogOf(facts, options.harness);
      return modelPickRows(catalog, options.harness).map((row) => ({
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
              current.effort !== null && takes.includes(current.effort) ? current.effort : null,
          };
        },
      }));
    },
  },
  effort: {
    applies: ({ options }, facts) =>
      options.harness !== SHELL &&
      catalogEfforts(catalogOf(facts, options.harness), options.model).length > 0,
    placeholder: ({ options }, facts) => `Thinking for ${modelWords(facts, options)}`,
    rows: ({ options }, facts) =>
      [null, ...catalogEfforts(catalogOf(facts, options.harness), options.model)].map((effort) => ({
        id: `effort:${effort ?? ""}`,
        label: effort ?? "default",
        current: options.effort === effort,
        apply: (current) => ({ ...current, effort }),
      })),
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
});

const NONE: FlowEffect = { kind: "none" };

const projectItems = (facts: FlowFacts): ReadonlyArray<QuickInputItem> => [
  ...(facts.adoptable === null
    ? []
    : [
        {
          id: ADOPT_ITEM,
          label: "$(repo-clone) Adopt this repository",
          description: facts.adoptable.origin,
        },
      ]),
  ...facts.projects.map((project) => ({
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
    if (facts.adoptable === null || state.offline) return { state, effect: NONE };
    return {
      state: { ...state, adopting: true },
      effect: { kind: "adopt", ...facts.adoptable },
    };
  }
  const project = facts.projects.find((candidate) => `project:${candidate.id}` === item);
  if (project === undefined) return { state, effect: NONE };
  return {
    state: {
      ...atPrompt(state, draftFor(project, null, { kind: "elsewhere" }, facts)),
      cameFromProjects: true,
    },
    effect: NONE,
  };
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
  if (state.step.kind === "started") return unchanged;
  const { draft } = state;
  switch (event.kind) {
    case "connection":
      return { state: { ...state, offline: event.offline }, effect: NONE };
    case "typed":
      return state.step.kind === "prompt" && draft !== null
        ? { state: { ...state, draft: { ...draft, prompt: event.value } }, effect: NONE }
        : { state: { ...state, query: event.value }, effect: NONE };
    case "adopted":
      if (!state.adopting) return unchanged;
      return {
        state: {
          ...atPrompt(state, draftFor(event.project, null, facts.checkout, facts)),
          adopting: false,
          cameFromProjects: true,
        },
        effect: NONE,
      };
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
      if (state.offline || flagLike(draft)) return unchanged;
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
      : `New session · ${draft.project.name} · in ${draft.join.worktree}`;

export const render = (state: FlowState, facts: FlowFacts): QuickInputView => {
  const { step: at, draft } = state;
  if (at.kind === "project" || draft === null)
    return {
      title: "New session",
      step: null,
      back: false,
      placeholder: "Choose a project",
      value: state.query,
      busy: state.adopting,
      items: projectItems(facts),
    };
  if (at.kind === "option") {
    const spec = OPTION_STEPS[at.option];
    const steps = applicableSteps(draft, facts);
    const remembered = facts.remembered[draft.project.id] !== undefined;
    return {
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
  const unpushed = !state.offline && base.kind === "ref" && base.unpushed !== null;
  return {
    title: titleOf(draft),
    step: null,
    back: state.cameFromProjects,
    placeholder:
      draft.options.harness === SHELL
        ? "A name for this shell (optional)"
        : `What should ${draft.options.harness} do?`,
    value: draft.prompt,
    busy: at.kind === "started",
    items: [
      {
        id: START_ITEM,
        label: unpushed ? "$(warning)" : "",
        description: dimLine(draft, facts, state.offline),
        change: true,
        alwaysShow: true,
      },
    ],
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
