import {
  type EffortLevel,
  type HarnessModelCatalogView,
  loginChoiceOf,
  type ModelPicker,
  modelPickerFor,
  type PermissionMode,
  type SpeedMode,
} from "@mend/domain/workbench";

import type { ConnectedAccountDto, ProjectDto, SessionDefaultsDto } from "./api.ts";
import { createCookieStore } from "./cookie-store.ts";

/**
 * What the New session composer starts from and what it sends: the agents it offers and the
 * login each needs, the agent, model and effort a person last used (kept on their account), the
 * project they last used (kept in this browser), and automatic landing, which starts from their
 * own automation and is sent with every session so it records what was picked.
 */

/** The agents the composer offers, in the menu's order, with the login each runs on. */
export const AGENTS = [
  { id: "claude", label: "Claude Code", login: "claude" },
  { id: "codex", label: "Codex", login: "codex" },
  { id: "antigravity", label: "Antigravity", login: "antigravity" },
  // opencode and pi run on the ChatGPT login Mend writes for Codex.
  { id: "opencode", label: "opencode", login: "codex" },
  { id: "pi", label: "pi", login: "codex" },
] as const;

export type Agent = (typeof AGENTS)[number]["id"];
type LoginProvider = (typeof AGENTS)[number]["login"];

const LOGIN_LABELS: Readonly<Record<LoginProvider, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

const isAgent = (value: string | null): value is Agent =>
  AGENTS.some((agent) => agent.id === value);

export const agentOf = (id: Agent): (typeof AGENTS)[number] => {
  const agent = AGENTS.find((row) => row.id === id);
  // SAFETY: `Agent` is derived from `AGENTS`, so every id has its row.
  if (agent === undefined) throw new Error(`Unknown agent ${id}`);
  return agent;
};

/**
 * Whether an agent can start for this person: their chosen login for its provider works
 * (`ready`), the provider refused it (`refused`: the token expired or was revoked), they hold
 * logins but chose none (`unchosen`: sessions use only the chosen one), or they hold none.
 */
export type AgentLogin = "ready" | "refused" | "unchosen" | "none";

export const agentLogin = (
  accounts: ReadonlyArray<ConnectedAccountDto>,
  agent: Agent,
): AgentLogin => {
  const choice = loginChoiceOf(accounts, agentOf(agent).login);
  if (choice._tag !== "chosen") return choice._tag;
  return choice.account.status === "active" ? "ready" : "refused";
};

/** The word beside an agent in the menu. */
export const agentLoginWord = (login: AgentLogin): string => {
  switch (login) {
    case "ready":
      return "Signed in";
    case "refused":
      return "Login refused";
    case "unchosen":
      return "No login chosen";
    case "none":
      return "No login";
  }
};

/** Whether the person holds no login any agent here could run on: they skipped it at setup. */
export const noAgentLogin = (accounts: ReadonlyArray<ConnectedAccountDto>): boolean =>
  AGENTS.every((agent) => agentLogin(accounts, agent.id) === "none");

/**
 * Why the picked agent can't start, as the banner says it, with its action's label. Null when it
 * can start.
 */
export const loginBlock = (
  agent: Agent,
  login: AgentLogin,
  others: ReadonlyArray<Agent>,
): {
  readonly title: string;
  readonly text: string;
  readonly action: string;
  readonly hint: string;
} | null => {
  if (login === "ready") return null;
  const name = agentOf(agent).label;
  const loginName = LOGIN_LABELS[agentOf(agent).login];
  const other = others.map((id) => agentOf(id).label)[0];
  const fix = {
    refused: `${loginName} refused your login. Connect it again in your account settings`,
    unchosen: `You have ${loginName} logins but haven't chosen which one sessions use. Choose one in your account settings`,
    none: `You haven't added a ${loginName} login. Add one in your account settings`,
  }[login];
  const action = {
    refused: `Connect ${loginName} again`,
    unchosen: `Choose a ${loginName} login`,
    none: `Add ${loginName} login`,
  }[login];
  return {
    title: `${name} can't start.`,
    text: other === undefined ? `${fix}.` : `${fix}, or pick ${other}.`,
    action,
    hint:
      login === "refused"
        ? `You can start the session once ${name} has a login that works.`
        : `You can start the session once ${name} has a login.`,
  };
};

/**
 * The agent the composer opens on: the one last used, else Claude Code. The shell is not offered
 * here, so a person whose last session was a shell starts on Claude Code.
 */
export const startingAgent = (defaults: SessionDefaultsDto): Agent =>
  isAgent(defaults.harness) ? defaults.harness : "claude";

/** The model and effort picker for an agent, from the catalog and what the person last used. */
export const pickerFor = (
  catalogs: ReadonlyArray<HarnessModelCatalogView> | undefined,
  defaults: SessionDefaultsDto,
  agent: Agent,
): ModelPicker => {
  const last = defaults.byHarness[agent];
  return modelPickerFor(catalogs, agent, {
    model: last?.model ?? null,
    effort: last?.effort ?? null,
  });
};

/** "Claude Code · Opus": the agent and model pick's words. */
export const agentAndModel = (agent: Agent, picker: ModelPicker): string =>
  picker.hasModels && picker.model !== null
    ? `${agentOf(agent).label} · ${picker.modelLabel}`
    : agentOf(agent).label;

/**
 * The defaults a start leaves behind: this agent first next time, with the model and effort it
 * ran. Every other agent keeps what it had.
 */
export const defaultsAfterStart = (
  defaults: SessionDefaultsDto,
  agent: Agent,
  picked: { readonly model: string | null; readonly effort: EffortLevel | null },
): SessionDefaultsDto => ({
  harness: agent,
  byHarness: { ...defaults.byHarness, [agent]: { model: picked.model, effort: picked.effort } },
});

/**
 * Automatic landing for one new session. A project whose own policy is off never lands, so the
 * choice is shown off and the session follows the project. Otherwise it starts from the person's
 * own automation and the session is sent the value picked.
 */
export type LandingChoice =
  | { readonly _tag: "project-off" }
  | { readonly _tag: "pick"; readonly land: boolean };

export const landingChoice = (
  project: Pick<ProjectDto, "autoLand">,
  automation: boolean,
  picked: boolean | null,
): LandingChoice =>
  project.autoLand === "off"
    ? { _tag: "project-off" }
    : { _tag: "pick", land: picked ?? automation };

/** What the session's `autoLand` is sent as: null follows the project. */
export const autoLandOf = (choice: LandingChoice): boolean | null =>
  choice._tag === "pick" ? choice.land : null;

/** Where the session runs: a new worktree from the project's default branch, or an existing one. */
export type WorktreeTarget =
  | { readonly _tag: "new" }
  | { readonly _tag: "existing"; readonly id: string; readonly branch: string };

/** The first message and the options a start sends, wherever the session runs. */
export interface StartSpec {
  readonly agent: Agent;
  readonly prompt: string;
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  readonly speed: SpeedMode | null;
  /** `ask`: the agent asks before it acts. Null skips its permission prompts, the default. */
  readonly permission: PermissionMode | null;
  readonly autoLand: boolean | null;
}

/** Why a prompt can't be sent, in the composer's words; null when it can. */
export const promptProblem = (prompt: string): string | null =>
  prompt.trim().startsWith("-")
    ? 'A task can\'t start with "-". The agent would read it as a command-line option.'
    : null;

/** The launch request's options for a spec; absent fields leave the choice to the server. */
export const launchFields = (
  spec: StartSpec,
): {
  readonly prompt?: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly speed?: SpeedMode;
  readonly permissionMode?: PermissionMode;
} => ({
  ...(spec.prompt.trim() === "" ? {} : { prompt: spec.prompt.trim() }),
  ...(spec.model === null ? {} : { model: spec.model }),
  ...(spec.effort === null ? {} : { effort: spec.effort }),
  ...(spec.speed === null ? {} : { speed: spec.speed }),
  ...(spec.permission === null ? {} : { permissionMode: spec.permission }),
});

/** The project the composer opens on: the one last used here while it still exists, else the first. */
export const startingProject = <P extends { readonly id: string }>(
  projects: ReadonlyArray<P>,
  lastId: string | null,
): P | undefined => projects.find((project) => project.id === lastId) ?? projects[0];

/**
 * The project this browser last started a session in. The server keeps a person's agent, model
 * and effort, but no project, so the project is remembered per browser, in a cookie the server
 * renders the page with.
 */
export const lastProject = createCookieStore<string | null>(
  "mend-last-project",
  (stored) => (typeof stored === "string" ? stored : null),
  null,
);
