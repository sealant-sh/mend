import type { ConnectedAccount } from "@mend/api-contracts";
import { loginChoiceOf } from "@mend/domain/workbench";

/**
 * What the Agent login setup step shows about a person's Claude Code and Codex logins, and the
 * words it uses. Mend's web app takes no part in a provider's sign-in (Yiannis, 17 Nov 2026): the
 * person runs `mend connect claude|codex` on their own computer, and the page notices the login
 * when it lands. An API key is the second choice. Pure, so each state's words are testable.
 */

/** The agents a person connects a login for. GitHub is a credential, not an agent. */
export type Agent = "claude" | "codex";

export const AGENTS: ReadonlyArray<Agent> = ["claude", "codex"];

interface AgentFacts {
  /** The agent's name, as the composer and the setup steps say it. */
  readonly name: string;
  /** The service whose sign-in `mend connect` opens, and which holds a subscription login. */
  readonly service: string;
  /** The account a subscription login belongs to. */
  readonly account: string;
  /** Who issues and bills the agent's API keys. */
  readonly issuer: string;
  /** Where a person creates a key, as a sentence names it, and its address. */
  readonly console: { readonly words: string; readonly link: string; readonly url: string };
  /** How the issuer's API keys start. */
  readonly keyPrefix: string;
  readonly keyPlaceholder: string;
}

export const AGENT_FACTS: Readonly<Record<Agent, AgentFacts>> = {
  claude: {
    name: "Claude Code",
    service: "Claude",
    account: "Claude account",
    issuer: "Anthropic",
    console: {
      words: "the",
      link: "Anthropic Console",
      url: "https://console.anthropic.com/settings/keys",
    },
    keyPrefix: "sk-ant-",
    keyPlaceholder: "sk-ant-api03-…",
  },
  codex: {
    name: "Codex",
    service: "ChatGPT",
    account: "ChatGPT account",
    issuer: "OpenAI",
    console: {
      words: "your",
      link: "OpenAI dashboard",
      url: "https://platform.openai.com/api-keys",
    },
    keyPrefix: "sk-",
    keyPlaceholder: "sk-proj-…",
  },
};

/** The command that connects the agent's login from the person's computer (`apps/cli`). */
export const connectCommand = (agent: Agent): string => `mend connect ${agent}`;

/** The agent's login as the step shows it. */
export type AgentLoginState =
  | { readonly kind: "none" }
  | { readonly kind: "connected"; readonly account: ConnectedAccount; readonly key: boolean }
  /** The provider refused the login; it needs connecting again. */
  | { readonly kind: "refused"; readonly account: ConnectedAccount; readonly key: boolean };

const isKey = (account: ConnectedAccount): boolean => account.login?.kind === "api-key";

/**
 * The login the agent's sessions use: the person's chosen one when it works, any other that
 * works, or, when none does, the one the provider refused.
 */
export const agentLoginState = (
  accounts: ReadonlyArray<ConnectedAccount>,
  agent: ConnectedAccount["provider"],
): AgentLoginState => {
  const choice = loginChoiceOf(accounts, agent);
  if (choice._tag === "none") return { kind: "none" };
  const held = choice._tag === "chosen" ? [choice.account, ...accounts] : choice.accounts;
  const working = held.find((account) => account.provider === agent && account.status === "active");
  if (working !== undefined) return { kind: "connected", account: working, key: isKey(working) };
  const refused = choice._tag === "chosen" ? choice.account : choice.accounts[0];
  return { kind: "refused", account: refused, key: isKey(refused) };
};

/** Whether either agent has a login that works: what Continue waits for. */
export const anyAgentConnected = (accounts: ReadonlyArray<ConnectedAccount>): boolean =>
  AGENTS.some((agent) => agentLoginState(accounts, agent).kind === "connected");

/** The agent the step opens on: the one already connected, else Claude Code. */
export const initialAgent = (accounts: ReadonlyArray<ConnectedAccount>): Agent =>
  agentLoginState(accounts, "claude").kind === "none" &&
  agentLoginState(accounts, "codex").kind !== "none"
    ? "codex"
    : "claude";

/** Who the login belongs to, as the platform reports it: an email, a login, or its name. */
const ownerOf = (account: ConnectedAccount): string | null => {
  for (const key of ["email", "accountEmail", "login", "accountId"]) {
    const value = account.metadata[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return account.name === "" || account.name === "default" ? null : account.name;
};

/** The sentence beside the tick once the agent's login works. */
export const connectedLine = (agent: Agent, key: boolean): string => {
  const facts = AGENT_FACTS[agent];
  return key
    ? `${facts.name} is connected with an ${facts.issuer} API key. ${facts.name} sessions will use it.`
    : `${facts.name} is connected. ${facts.name} sessions will use this ${facts.account}.`;
};

/** The facts under it: whose login, and what kind. Never any part of a key. */
export const accountFacts = (account: ConnectedAccount): string => {
  const kind = isKey(account) ? "API key" : "Subscription";
  const owner = ownerOf(account);
  return owner === null ? kind : `${owner} · ${kind.toLowerCase()}`;
};

/** What the page says about a login the provider refused, and what fixes it. */
export const refusedWords = (
  agent: Agent,
  key: boolean,
): { readonly title: string; readonly advice: string } => {
  const facts = AGENT_FACTS[agent];
  return key
    ? {
        title: `${facts.issuer} refused your API key.`,
        advice: `${facts.name} sessions can't start on it. Paste a new key, or run the command instead.`,
      }
    : {
        title: `Your ${facts.name} login needs connecting again.`,
        advice: `${facts.service} refused it, so ${facts.name} sessions can't start. Run the command again.`,
      };
};

/**
 * What is wrong with a key before it is sent: nothing pasted, spaces inside it (the platform
 * refuses those), or the other issuer's key. The platform checks the rest.
 */
export const keyProblem = (
  agent: Agent,
  key: string,
): { readonly title: string; readonly advice: string } | null => {
  const facts = AGENT_FACTS[agent];
  if (key === "") return { title: "Paste a key.", advice: "The field is empty." };
  if (/\s/.test(key)) {
    return {
      title: "That key has a space or a line break in it.",
      advice: "An API key has none. Copy it again from the start.",
    };
  }
  // OpenAI's `sk-` prefix also starts every Anthropic key.
  const otherIssuers = AGENTS.filter(
    (other) => other !== agent && AGENT_FACTS[other].keyPrefix.startsWith(facts.keyPrefix),
  );
  const theirs = otherIssuers.some((other) => key.startsWith(AGENT_FACTS[other].keyPrefix));
  if (!key.startsWith(facts.keyPrefix) || theirs) {
    return {
      title: `That isn't an ${facts.issuer} API key.`,
      advice: `${facts.issuer} keys start with ${facts.keyPrefix}. Paste another key here, or create a new one in ${facts.console.words} ${facts.console.link}.`,
    };
  }
  return null;
};

/** What a refused save says, after the platform's own words. */
export const rejectedAdvice = (agent: Agent): string => {
  const { console } = AGENT_FACTS[agent];
  return `Paste another key here, or create a new one in ${console.words} ${console.link}.`;
};

/** The line beside Continue. */
export const agentLoginNote = (
  accounts: ReadonlyArray<ConnectedAccount>,
  shown: { readonly agent: Agent; readonly mode: "command" | "key" },
): string => {
  if (!anyAgentConnected(accounts)) return "You need an agent login to start a session.";
  const login = agentLoginState(accounts, shown.agent);
  return shown.mode === "key" && login.kind === "connected" && login.key
    ? "Mend stores the key and never shows it again."
    : "You can change this login later in Settings.";
};

/** What the setup steps say the Agent login step saved: the agents with a login that works. */
export const savedAgentLine = (accounts: ReadonlyArray<ConnectedAccount>): string =>
  AGENTS.filter((agent) => agentLoginState(accounts, agent).kind === "connected")
    .map((agent) => AGENT_FACTS[agent].name)
    .join(" and ");

/**
 * The line under a login's name in Settings → Agent logins and Git: whose login and what kind,
 * and when it arrived, or that there is none, or that the provider refused it. Never any part of
 * a key (Yiannis, 17 Nov 2026).
 */
export const loginLine = (
  provider: ConnectedAccount["provider"],
  login: AgentLoginState,
  since: (date: Date) => string,
): string => {
  if (provider === "github") {
    switch (login.kind) {
      case "none":
        return "Your sessions run gh without a GitHub login.";
      case "connected": {
        const owner = ownerOf(login.account);
        return `${owner === null ? "Connected" : `Connected as ${owner}`} ${since(login.account.connectedAt)}. Your sessions' gh uses it.`;
      }
      case "refused":
        return "GitHub refused this login, so gh in your sessions runs without one. Run the command again.";
    }
  }
  const facts = AGENT_FACTS[provider];
  switch (login.kind) {
    case "none":
      return `Not connected. ${facts.name} sessions can't start until you connect a login.`;
    case "connected":
      return login.key
        ? `${facts.issuer} API key. Saved ${since(login.account.connectedAt)}.`
        : `${accountFacts(login.account)}. Connected ${since(login.account.connectedAt)}.`;
    case "refused":
      return `${refusedWords(provider, login.key).title} ${refusedWords(provider, login.key).advice}`;
  }
};

/** The toast once a login arrives while its dialog waits. */
export const arrivedToast = (
  provider: ConnectedAccount["provider"],
  account: ConnectedAccount,
): string => {
  const owner = ownerOf(account);
  if (provider === "github") {
    return owner === null ? "GitHub is connected." : `GitHub is connected as ${owner}.`;
  }
  const facts = AGENT_FACTS[provider];
  if (isKey(account)) return `${facts.name} is connected with an ${facts.issuer} API key.`;
  return owner === null ? `${facts.name} is connected.` : `${facts.name} is connected as ${owner}.`;
};

/**
 * Whether the login a dialog waits for has arrived: the provider now has a working login and it
 * isn't the one the dialog opened with, or that one was written again since. A reconnect can
 * reuse the account, so its `connectedAt` may be older than the dialog.
 */
export const loginArrived = (
  login: AgentLoginState,
  opened: { readonly login: AgentLoginState; readonly at: Date },
): boolean => {
  if (login.kind !== "connected") return false;
  const before = opened.login;
  if (before.kind !== "connected" || before.account.id !== login.account.id) return true;
  return login.account.updatedAt.getTime() > before.account.updatedAt.getTime();
};
