/**
 * What a session row calls its harness: the product's own name for the three that have one, and
 * the harness id as it is for every other (pi, a shell, a custom command). Every harness the server
 * did not name used to read "OpenCode", so a pi session showed up as an OpenCode one.
 */
const NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export const harnessName = (harness: string): string => NAMES[harness] ?? harness;
