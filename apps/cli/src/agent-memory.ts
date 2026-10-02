import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AGENT_MEMORY_MAX_FILE_BYTES, AGENT_MEMORY_ROOTS } from "@mend/domain/workbench";

/**
 * `mend memory import`: the agent memory this machine holds for a repository, as Mend stores it
 * (docs/adr/0009). Claude Code keeps auto memory per working directory, under
 * `~/.claude/projects/<the directory, each character that is not a letter or digit as ->/memory/`;
 * in a session the same files live under the workspace's own key.
 */

type MemoryFile = {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
};

const CLAUDE_ROOT = AGENT_MEMORY_ROOTS.find((root) => root.harness === "claude")?.root ?? "";

/** Claude Code's own config directory on this machine. */
const claudeHome = (): string =>
  process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude");

/**
 * The memory directory Claude Code keeps for `repoRoot`, or null. Two spellings of the key are
 * tried: every character that is not a letter or digit as `-` (Claude Code's own), and only `/` and
 * `.` (an older one); they differ only for paths with other punctuation.
 */
export const claudeMemoryDirFor = (
  repoRoot: string,
  home: string = claudeHome(),
): string | null => {
  const keys = [repoRoot.replace(/[^a-zA-Z0-9]/g, "-"), repoRoot.replace(/[/.]/g, "-")];
  for (const key of new Set(keys)) {
    const dir = path.join(home, "projects", key, "memory");
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return null;
};

export interface ClaudeMemoryScan {
  readonly dir: string;
  readonly files: ReadonlyArray<MemoryFile>;
  /** What was left out, one line each. */
  readonly notes: ReadonlyArray<string>;
}

/** Every file in a Claude memory directory, at the path a session keeps it under. */
export const scanClaudeMemory = (dir: string): ClaudeMemoryScan => {
  const files: Array<MemoryFile> = [];
  const notes: Array<string> = [];
  const walk = (abs: string, rel: string) => {
    for (const entry of fs
      .readdirSync(abs, { withFileTypes: true })
      .toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const at = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(full, at);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = fs.readFileSync(full);
      if (bytes.byteLength > AGENT_MEMORY_MAX_FILE_BYTES) {
        notes.push(`${at}: over ${AGENT_MEMORY_MAX_FILE_BYTES / 1024} KB, left out`);
        continue;
      }
      const text = bytes.includes(0) ? null : bytes.toString("utf8");
      files.push(
        text !== null && Buffer.from(text, "utf8").equals(bytes)
          ? { path: `${CLAUDE_ROOT}/${at}`, encoding: "utf8", contents: text }
          : {
              path: `${CLAUDE_ROOT}/${at}`,
              encoding: "base64",
              contents: bytes.toString("base64"),
            },
      );
    }
  };
  walk(dir, "");
  return { dir, files, notes };
};
