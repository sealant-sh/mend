/**
 * Mend's Claude settings (docs/adr/0016-per-person-harness-homes.md, decision 6), passed to every
 * Claude process of a person-layout executor with `--settings '<json>'`: `neutral` for a
 * once-shared session (no memory, no crons), `no-cron` for anyone's personal processes but the
 * worktree's change owner's, `personal` for the change owner's own. Passed inline, not as files:
 * no root write, no dependency on a prepare that ran, so an executor prepared before this release
 * starts Claude as well (Claude refuses a `--settings` file that is not there; verified
 * 2026-10-07 against 2.1.292, which takes the JSON inline).
 */
import { AGENT_HOOKS } from "@mend/domain/workbench";
import type { PlacedLogin } from "@mend/sealant";
import type { EndpointUrl } from "@sealant/sdk";

import { MEND_HELPER_PATH } from "./session-socket.ts";
import { shellQuote } from "./workspace-files.ts";

/** Which settings a Claude process gets (`--settings`). */
export type ClaudeSettingsKind = "neutral" | "no-cron" | "personal";

/**
 * The environment Claude's settings carry (`env`). Claude applies a settings layer's `env` over
 * the process environment, and flag settings rank above project and local settings, so a
 * repository's `.claude/settings.json` or the worktree's `settings.local.json` cannot turn memory
 * or crons back on (verified 2026-10-06 against 2.1.289).
 */
export const CLAUDE_NEUTRAL_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
  CLAUDE_CODE_DISABLE_CRON: "1",
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
};
const CLAUDE_NO_CRON_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_CRON: "1",
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
};
const CLAUDE_PERSONAL_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
};

/** What a Claude process's login adds to its settings (`claudeLoginSettingsOf`). */
export interface ClaudeLoginSettings {
  readonly env: Readonly<Record<string, string>>;
  readonly apiKeyHelper?: string;
}

const NO_LOGIN_SETTINGS: ClaudeLoginSettings = { env: {} };

/**
 * A key's endpoint (docs/adr/0018, decision 11): Claude sends every request there, and only
 * there. Without the traffic switch Claude also calls Anthropic's own hosts; without the marketplace
 * switch a terminal Claude fetches the official plugin marketplace. Three retries bound a turn
 * on an endpoint that does not answer, which takes about 171 seconds at Claude's default of 10.
 */
const endpointEnv = (baseUrl: EndpointUrl): Readonly<Record<string, string>> => ({
  ANTHROPIC_BASE_URL: baseUrl,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_MAX_RETRIES: "3",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
});

/**
 * What the login placed in a Claude process's home adds to its settings (docs/adr/0018, decision
 * 1): a key is read from its file by `apiKeyHelper`, so it is never in argv, the environment or a
 * captured file, and a key with an endpoint sends its requests there. Mend does not set
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. On 2.1.292 it needs bubblewrap and forces the permission
 * mode to default, and a Bash child does not see the helper's key without it. A subscription, or a
 * login Mend cannot tell, adds nothing.
 */
export const claudeLoginSettingsOf = (login: PlacedLogin | undefined): ClaudeLoginSettings =>
  login?.kind === "api-key" && login.keyPath !== undefined
    ? {
        env: login.baseUrl === undefined ? {} : endpointEnv(login.baseUrl),
        apiKeyHelper: `cat ${shellQuote(login.keyPath)}`,
      }
    : NO_LOGIN_SETTINGS;

const settingsOfKind = (kind: ClaudeSettingsKind) => {
  switch (kind) {
    case "neutral":
      return { autoMemoryEnabled: false, env: CLAUDE_NEUTRAL_ENV };
    case "no-cron":
      return { env: CLAUDE_NO_CRON_ENV };
    case "personal":
      return { env: CLAUDE_PERSONAL_ENV };
  }
};

/**
 * What each kind says, the neutral one also turning automatic memory off, with what the process's
 * placed login adds.
 */
export const claudeSettingsOf = (
  kind: ClaudeSettingsKind,
  login?: PlacedLogin,
): Readonly<Record<string, unknown>> => {
  const settings = settingsOfKind(kind);
  const { env, ...fromLogin } = claudeLoginSettingsOf(login);
  return { ...settings, env: { ...settings.env, ...env }, ...fromLogin };
};

/** Claude merges a settings layer's hooks with the others', so a repository's own hooks still run. */
export const CLAUDE_AGENT_HOOKS: Readonly<Record<string, ReadonlyArray<unknown>>> =
  Object.fromEntries(
    AGENT_HOOKS.claude.map((hook) => [
      hook.event,
      [
        {
          ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
          hooks: [{ type: "command", command: `${MEND_HELPER_PATH} hook claude`, timeout: 5 }],
        },
      ],
    ]),
  );

/** The `--settings` argument itself: the settings as one line of JSON. */
export const claudeSettingsArgOf = (kind: ClaudeSettingsKind): string =>
  JSON.stringify(claudeSettingsOf(kind));

const CLAUDE_SESSION_FLAGS = ["--resume", "-r", "--continue", "-c", "--fork-session"];

/**
 * A terminal Claude's own session id, so its hook reports name it (`agentHookTarget`). A fresh
 * Claude is pinned to `fresh` with `--session-id`; a launch that names its id keeps it; one that
 * resumes or continues a conversation is left alone, with no id here (the resume's id is known
 * from the conversation it continues).
 */
export const withClaudeSessionId = (
  argv: ReadonlyArray<string>,
  fresh: string,
): { readonly argv: ReadonlyArray<string>; readonly providerSessionId: string | null } => {
  if (argv[0] !== "claude") return { argv, providerSessionId: null };
  const named = argv.indexOf("--session-id");
  if (named >= 0) return { argv, providerSessionId: argv.at(named + 1) ?? null };
  if (CLAUDE_SESSION_FLAGS.some((flag) => argv.includes(flag))) {
    return { argv, providerSessionId: null };
  }
  return { argv: [...argv, "--session-id", fresh], providerSessionId: fresh };
};
