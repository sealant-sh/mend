import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AGENT_MEMORY_MAX_DATABASE_BYTES,
  AGENT_MEMORY_MAX_FILE_BYTES,
  AGENT_MEMORY_ROOTS,
  CODEX_MEMORY_DATABASE,
} from "@mend/domain/workbench";

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

/** Where `mend memory import` keeps each imported summary's conversation line (docs/adr/0009). */
const CODEX_THREADS_ROOT =
  AGENT_MEMORY_ROOTS.find((root) => root.root.endsWith("codex-threads"))?.root ??
  ".mend/codex-threads";

/** A file's first line, read without the rest; null when it cannot be read. */
const firstLineOf = (file: string): string | null => {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const read = fs.readSync(fd, buffer, 0, buffer.byteLength, 0);
      const text = buffer.subarray(0, read).toString("utf8");
      const end = text.indexOf("\n");
      return end === -1 ? null : text.slice(0, end);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
};

/** Codex's own home on this machine. */
const codexHome = (): string => process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");

/** The newest `state_<n>.sqlite` in a Codex home: where Codex lists its threads. */
const codexStateDatabase = (home: string): string | null => {
  const names = fs.existsSync(home)
    ? fs.readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name))
    : [];
  const newest = names.toSorted(
    (a, b) => Number(/\d+/.exec(b)?.[0] ?? 0) - Number(/\d+/.exec(a)?.[0] ?? 0),
  )[0];
  return newest === undefined ? null : path.join(home, newest);
};

export interface CodexMemoryScan {
  readonly home: string;
  /** The summary database with only this repository's summaries; empty when there are none. */
  readonly files: ReadonlyArray<MemoryFile>;
  /** How many of Codex's conversation summaries are this repository's. */
  readonly summaries: number;
  readonly notes: ReadonlyArray<string>;
}

/**
 * Codex's memory of `repoRoot` on this machine, as Mend stores it (docs/adr/0009, "Codex"): a
 * summary database holding only the summaries of conversations whose working directory is the
 * repository or inside it. Codex keeps one memory for everything it does, so its consolidated
 * `memories/` folder is never imported; the next session consolidates these summaries into the
 * project's own. Every summary comes in unselected, so that consolidation takes them all.
 */
export const scanCodexMemory = (repoRoot: string, home: string = codexHome()): CodexMemoryScan => {
  const memories = path.join(home, "memories_1.sqlite");
  const state = codexStateDatabase(home);
  if (!fs.existsSync(memories) || state === null) {
    return { home, files: [], summaries: 0, notes: [] };
  }
  const threads = new DatabaseSync(state, { readOnly: true });
  // This repository's threads, and where each one's rollout is.
  const inRepo = (() => {
    try {
      return new Map(
        threads
          .prepare("select id, cwd, rollout_path from threads")
          .all()
          .flatMap((row) => {
            const cwd = row["cwd"];
            const id = row["id"];
            const rollout = row["rollout_path"];
            return typeof id === "string" &&
              typeof cwd === "string" &&
              (cwd === repoRoot || cwd.startsWith(`${repoRoot}/`))
              ? [[id, typeof rollout === "string" ? rollout : null] as const]
              : [];
          }),
      );
    } finally {
      threads.close();
    }
  })();
  const ids = [...inRepo.keys()];
  if (ids.length === 0) return { home, files: [], summaries: 0, notes: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-codex-import-"));
  try {
    const out = path.join(dir, "memories_1.sqlite");
    const target = new DatabaseSync(out);
    let summaries = 0;
    try {
      target.exec(`attach database '${memories.replaceAll("'", "''")}' as source`);
      const schema = target
        .prepare(
          "select type, name, sql from source.sqlite_master where sql is not null and name not like 'sqlite_%' order by type = 'index', name",
        )
        .all();
      for (const row of schema) {
        if (typeof row["sql"] === "string") target.exec(row["sql"]);
      }
      // Codex's own migrations, applied: it opens the copy as the version it wrote.
      target.exec("insert into main._sqlx_migrations select * from source._sqlx_migrations");
      // The consolidation's singleton row, as the migration that made the table left it.
      try {
        target.exec(
          "insert into main.consolidation_progress select * from source.consolidation_progress",
        );
      } catch {
        // A Codex without the table: nothing to carry.
      }
      const insert = target.prepare(
        "insert into main.stage1_outputs select * from source.stage1_outputs where thread_id = ?",
      );
      for (const id of ids) summaries += Number(insert.run(id).changes);
      target.exec(
        "update main.stage1_outputs set selected_for_phase2 = 0, selected_for_phase2_source_updated_at = null",
      );
      target.exec("detach database source");
    } finally {
      target.close();
    }
    if (summaries === 0) return { home, files: [], summaries: 0, notes: [] };
    const summarisedIds = (() => {
      const copy = new DatabaseSync(out, { readOnly: true });
      try {
        return copy
          .prepare("select thread_id from stage1_outputs")
          .all()
          .flatMap((row) => (typeof row["thread_id"] === "string" ? [row["thread_id"]] : []));
      } finally {
        copy.close();
      }
    })();
    // Each summarised conversation's first line: a session lists it for Codex again from that,
    // or Codex would drop the summary of a conversation its home does not hold.
    const threadLines: Array<MemoryFile> = [];
    for (const id of summarisedIds) {
      const rollout = inRepo.get(id) ?? null;
      const head = rollout === null ? null : firstLineOf(rollout);
      if (head !== null) {
        threadLines.push({
          path: `${CODEX_THREADS_ROOT}/${id}.jsonl`,
          encoding: "utf8",
          contents: `${head}\n`,
        });
      }
    }
    const bytes = fs.readFileSync(out);
    if (bytes.byteLength > AGENT_MEMORY_MAX_DATABASE_BYTES) {
      return {
        home,
        files: [],
        summaries,
        notes: [
          `codex: ${summaries} summaries, over ${AGENT_MEMORY_MAX_DATABASE_BYTES / 1024 / 1024} MB, left out`,
        ],
      };
    }
    return {
      home,
      files: [
        { path: CODEX_MEMORY_DATABASE, encoding: "base64", contents: bytes.toString("base64") },
        ...threadLines,
      ],
      summaries,
      notes: [],
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
