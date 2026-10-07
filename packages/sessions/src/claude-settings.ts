/**
 * Mend's Claude settings files (docs/adr/0016-per-person-harness-homes.md, decision 6), passed to
 * every Claude process of a person-layout executor with `--settings`: `neutral.json` for a
 * once-shared session (no memory, no crons), `no-cron.json` for anyone's personal processes but
 * the worktree's change owner's, `personal.json` for the change owner's own. Written once per
 * executor, as root, in prepare's exec.
 */
import { shellQuote } from "./workspace-files.ts";

/** Mend's Claude settings files, written once per executor at prepare (root's, 0644). */
export const CLAUDE_SETTINGS_DIR = "/run/mend/claude";

/** Which settings file a Claude process gets (`--settings`). */
export type ClaudeSettingsKind = "neutral" | "no-cron" | "personal";

export const claudeSettingsFileOf = (
  kind: ClaudeSettingsKind,
  dir: string = CLAUDE_SETTINGS_DIR,
): string => `${dir}/${kind}.json`;

/**
 * The environment Claude's settings files carry (`env`). Claude applies a settings file's `env`
 * over the process environment, and flag settings rank above project and local settings, so a
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

/** What each settings file says: the neutral one also turns automatic memory off. */
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

/**
 * The three settings files, written as root into a root-owned 0755 directory, each 0644 and
 * replaced by a rename, so a person can read them and nobody but root can change them. Folded
 * into prepare's exec, so `--settings` adds no exec (Performance).
 */
export const claudeSettingsFilesScript = (dir: string = CLAUDE_SETTINGS_DIR): string => {
  const q = shellQuote;
  const writes = (["neutral", "no-cron", "personal"] as const).map((kind) => {
    const file = claudeSettingsFileOf(kind, dir);
    return (
      `printf '%s\\n' ${q(JSON.stringify(claudeSettingsOf(kind)))} > ${q(`${file}.part`)} && ` +
      `chmod 0644 ${q(`${file}.part`)} && mv -f ${q(`${file}.part`)} ${q(file)}`
    );
  });
  // A link where the directory goes leads root nowhere: nothing is written, and it is said.
  return [
    `if [ -L ${q(dir)} ]; then printf 'mend: unexpected link: %s\\n' ${q(dir)} >&2; else`,
    `mkdir -p ${q(dir)} && chmod 0755 ${q(dir)}`,
    ...writes,
    `fi`,
  ].join("\n");
};
