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

import { MEND_HELPER_PATH } from "./session-socket.ts";

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

/** What each kind says: the neutral one also turns automatic memory off. */
export const claudeSettingsOf = (kind: ClaudeSettingsKind): Readonly<Record<string, unknown>> => {
  switch (kind) {
    case "neutral":
      return { autoMemoryEnabled: false, env: CLAUDE_NEUTRAL_ENV };
    case "no-cron":
      return { env: CLAUDE_NO_CRON_ENV };
    case "personal":
      return { env: CLAUDE_PERSONAL_ENV };
  }
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
