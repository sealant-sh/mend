import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as zlib from "node:zlib";

import {
  AGENT_MEMORY_MAX_DATABASE_BYTES,
  AGENT_MEMORY_MAX_FILE_BYTES,
  AGENT_MEMORY_ROOTS,
  agentMemoryNameOf,
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

/**
 * This machine's id for imports, made once and kept beside the CLI's config: Mend records what it
 * last imported from each checkout on each machine and merges the next import from there against
 * it. A machine without the file gets a new id, and its next import merges with no shared version,
 * which keeps both sides' lines all the same.
 */
export const machineIdFor = (configDir: string, create: boolean): string | null => {
  const file = path.join(configDir, "machine-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing !== "") return existing;
  } catch {
    // None yet.
  }
  if (!create) return null;
  const id = randomUUID();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
};

/**
 * Where an import comes from: this checkout on this machine, named by the host. Without `create`
 * (a dry run) a machine that has no id yet gets none and null: a new id would have no earlier
 * import to merge against either, so the plan is the same.
 */
export const importSourceFor = (
  configDir: string,
  repoRoot: string,
  options: { readonly create: boolean; readonly hostname?: string },
): { readonly id: string; readonly label: string } | null => {
  const machine = machineIdFor(configDir, options.create);
  if (machine === null) return null;
  return {
    id: `${machine}:${repoRoot}`.slice(0, 1024),
    label:
      (options.hostname ?? os.hostname()).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) ||
      "this machine",
  };
};

/** What an import did, or would do, as the server reports it; an older server sends less. */
export interface ImportReport {
  readonly added: ReadonlyArray<string>;
  readonly unchanged: ReadonlyArray<string>;
  readonly updated?: ReadonlyArray<string>;
  readonly merged?: ReadonlyArray<{
    readonly path: string;
    readonly against: "last-import" | "no-shared-version" | "summaries";
    readonly missingLines?: number;
    readonly storeMissingLines?: number;
  }>;
  readonly keptStored?: ReadonlyArray<string>;
  readonly removedInMend?: ReadonlyArray<string>;
  readonly conflicting: ReadonlyArray<string>;
  readonly skipped?: ReadonlyArray<string>;
}

/** A memory path as `mend memory` names it: Claude's by name, another harness's as `codex:name`. */
export const memoryDisplayName = (filePath: string): string => {
  const named = agentMemoryNameOf(filePath);
  if (named === null) return filePath;
  return named.harness === "claude" ? named.name : `${named.harness}:${named.name}`;
};

/** At most this many added files are named one by one. */
const ADDED_NAMED = 20;

/**
 * The lines `mend memory import` prints for a report, after its summary line: one per file that
 * did not stay as it was, with what happened and why. A dry run prints the same.
 */
export const importReportLines = (report: ImportReport): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  const row = (word: string, filePath: string, why?: string) =>
    lines.push(
      `  ${word.padEnd(9)} ${memoryDisplayName(filePath)}${why === undefined ? "" : ` · ${why}`}`,
    );
  report.added.slice(0, ADDED_NAMED).forEach((p) => row("added", p));
  if (report.added.length > ADDED_NAMED) {
    lines.push(`  ${"added".padEnd(9)} and ${report.added.length - ADDED_NAMED} more`);
  }
  for (const p of report.updated ?? []) {
    row("updated", p, "unchanged in Mend since this machine's last import");
  }
  for (const merge of report.merged ?? []) {
    const missing = merge.missingLines ?? 0;
    const storeMissing = merge.storeMissingLines ?? 0;
    const lost = (n: number, whose: string) =>
      `${n} of ${whose} line${n === 1 ? " is" : "s are"} not in the result: its copy kept as a version`;
    row(
      "merged",
      merge.path,
      missing > 0
        ? lost(missing, "this machine's")
        : storeMissing > 0
          ? lost(storeMissing, "Mend's")
          : merge.against === "last-import"
            ? "both changed since this machine's last import, both sides' lines kept"
            : merge.against === "summaries"
              ? "both sides' summaries kept, the newer one per conversation"
              : "both sides' lines kept, no earlier import to compare against",
    );
  }
  for (const p of report.keptStored ?? []) {
    row("kept", p, "changed in Mend since this machine's last import, not here");
  }
  for (const p of report.removedInMend ?? []) {
    row("not added", p, "removed in Mend since this machine's last import");
  }
  for (const p of report.conflicting) {
    row(
      "conflict",
      p,
      "both changed, not mergeable: Mend's kept, this machine's kept as a version",
    );
  }
  for (const p of report.skipped ?? []) row("skipped", p, "outside the memory limits");
  return lines;
};

/** The summary line's counts: only those that are not zero. */
export const importReportCounts = (report: ImportReport): string =>
  [
    [report.added.length, "added"],
    [report.unchanged.length, "unchanged"],
    [report.updated?.length ?? 0, "updated"],
    [report.merged?.length ?? 0, "merged"],
    [report.keptStored?.length ?? 0, "kept as Mend has it"],
    [report.removedInMend?.length ?? 0, "not added again"],
    [report.conflicting.length, report.conflicting.length === 1 ? "conflict" : "conflicts"],
    [report.skipped?.length ?? 0, "skipped"],
  ]
    .filter(([count]) => count !== 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(" · ") || "nothing to import";

/** Where `mend memory import` keeps each imported summary's conversation line (docs/adr/0009). */
const CODEX_THREADS_ROOT =
  AGENT_MEMORY_ROOTS.find((root) => root.root.endsWith("codex-threads"))?.root ??
  ".mend/codex-threads";

/**
 * A rollout's first line, read without the rest; null when it cannot be read. Codex may have
 * compressed an old rollout to `<path>.zst` (its opt-in rollout compression): that is read too.
 */
const firstLineOf = async (file: string): Promise<string | null> => {
  const plain = fs.existsSync(file) ? file : null;
  const compressed = plain === null && fs.existsSync(`${file}.zst`) ? `${file}.zst` : null;
  if (plain === null && compressed === null) return null;
  const source = fs.createReadStream(plain ?? compressed ?? file);
  const stream = compressed === null ? source : source.pipe(zlib.createZstdDecompress());
  let text = "";
  try {
    for await (const chunk of stream) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const end = text.indexOf("\n");
      if (end !== -1) return text.slice(0, end);
      if (text.length > 1024 * 1024) return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    source.destroy();
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
export const scanCodexMemory = async (
  repoRoot: string,
  home: string = codexHome(),
): Promise<CodexMemoryScan> => {
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
          // Only threads whose memory is on: Codex leaves the others out of its memory, and so does
          // the import (a stub would turn it back on).
          .prepare(
            threads
              .prepare("select name from pragma_table_info('threads') where name = 'memory_mode'")
              .get() === undefined
              ? "select id, cwd, rollout_path from threads"
              : "select id, cwd, rollout_path from threads where memory_mode = 'enabled'",
          )
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
      const head = rollout === null ? null : await firstLineOf(rollout);
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
