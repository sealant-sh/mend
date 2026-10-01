import { PROMPTABLE_HARNESSES } from "@mend/domain/workbench";
import { Duration } from "effect";

/**
 * An agent's first screen can take most of a minute on a fresh executor (alpha 2026-09-30,
 * fda7180d): the machine is ready in ~13 s and the harness starts at once, but its image disk is
 * fetched lazily, so node and the harness's own files are read from it for the first time, and
 * the harness makes its startup network calls. Two things answer that wait:
 *
 * - the session line says the agent is starting until its record carries output
 *   (`agentStartingWords` in `@mend/domain/workbench`), and every attach says so until the first
 *   bytes arrive;
 * - the launch reads the harness's files once, in the background, while the rest of the setup
 *   runs (`harnessWarmupArgv`), so the real start finds them read.
 */

/**
 * A record entry that carries process output: the first one is the agent's first screen. The
 * byte count is a decimal string on the wire; one that does not parse counts as output, since the
 * entry exists only because the process wrote something.
 */
export const isOutputEntry = (entry: {
  readonly kind: string;
  readonly data?: unknown;
}): boolean => {
  if (entry.kind !== "ioChunk") return false;
  const data = entry.data;
  if (typeof data !== "object" || data === null || !("byteCount" in data)) return true;
  const count = data.byteCount;
  if (typeof count === "number") return count > 0;
  if (typeof count !== "string") return true;
  try {
    return BigInt(count) > 0n;
  } catch {
    return true;
  }
};

/** How long the harness warm-up may run before it is abandoned: it never holds anything up. */
export const HARNESS_WARMUP_TIMEOUT = Duration.seconds(60);

/**
 * The warm-up script (`sh -c <script> sh <binary>`): read the harness's own files from the
 * executor's disk once, before the real start needs them. Read-only toward everything that is the
 * user's: it runs from `/`, never the worktree, with HOME, the XDG roots and the harnesses' own
 * config roots pointed at a throwaway directory it removes, so nothing lands in the harness home.
 *
 * It reads the resolved executable and, when that is a script, the interpreter its first line
 * names (node, for an npm-installed harness), then asks the harness for its version, which loads
 * what it runs at start. `timeout` bounds it inside the executor too; without one it still ends
 * with the launch's own bound.
 */
const WARMUP_SCRIPT = [
  `bin=$(command -v "$1" 2>/dev/null) || exit 0`,
  `real=$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")`,
  `cat "$real" >/dev/null 2>&1`,
  `interp=$(head -c 256 "$real" 2>/dev/null | head -n 1 | sed -n 's|^#![[:space:]]*||p' | awk '{ if ($1 ~ /\\/env$/) print $2; else print $1 }')`,
  `if [ -n "$interp" ]; then ipath=$(command -v "$interp" 2>/dev/null) && cat "$(readlink -f "$ipath" 2>/dev/null || printf '%s' "$ipath")" >/dev/null 2>&1; fi`,
  `d=$(mktemp -d 2>/dev/null) || exit 0`,
  `cd / || exit 0`,
  `limit=""`,
  `command -v timeout >/dev/null 2>&1 && limit="timeout ${Duration.toSeconds(HARNESS_WARMUP_TIMEOUT)}"`,
  `HOME="$d" XDG_CONFIG_HOME="$d/config" XDG_CACHE_HOME="$d/cache" XDG_DATA_HOME="$d/data" XDG_STATE_HOME="$d/state" CLAUDE_CONFIG_DIR="$d/claude" CODEX_HOME="$d/codex" PI_CODING_AGENT_DIR="$d/pi" PI_SKIP_VERSION_CHECK=1 OPENCODE_DISABLE_AUTOUPDATE=1 DISABLE_AUTOUPDATER=1 $limit "$bin" --version >/dev/null 2>&1`,
  `code=$?`,
  `rm -rf "$d"`,
  `exit $code`,
].join("\n");

/**
 * The read-only warm-up for a harness's files (`WARMUP_SCRIPT`); null for anything that is not a
 * coding-agent TUI Mend launches by name.
 */
export const harnessWarmupArgv = (harness: string): ReadonlyArray<string> | null =>
  PROMPTABLE_HARNESSES.has(harness) ? ["sh", "-c", WARMUP_SCRIPT, "sh", harness] : null;
