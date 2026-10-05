/**
 * What a session row calls its harness: the product's own name for the three that have one, and
 * the harness id as it is for every other (pi, a shell, a custom command). Every harness the server
 * did not name used to read "OpenCode", so a pi session showed up as an OpenCode one. A Map, not
 * an object literal, so an id like "__proto__" or "constructor" never reads an inherited value.
 */
const NAMES: ReadonlyMap<string, string> = new Map([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
]);

export const harnessName = (harness: string): string => NAMES.get(harness) ?? harness;
