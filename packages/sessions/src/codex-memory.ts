import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

import type { HoldsDatabase, MergeDatabase } from "@mend/db";
import { CODEX_MEMORY_DATABASE } from "@mend/domain/workbench";
import { Effect } from "effect";

import { CARRIED_TRANSCRIPTS, parseCarriedTranscripts } from "./harness-state.ts";

/**
 * Codex memory, carried between one person's sessions on a project (docs/adr/0009, "Codex").
 *
 * Codex builds memory from past conversations when a session starts: up to two a start, each quiet
 * for six hours and under ten days old, summarised by the model and consolidated into
 * `.codex/memories/`. It merges only summaries whose conversation its state database lists, and a
 * fresh home lists only the rollouts in it. So each launch lays down, for the person's own Codex
 * conversations on the project:
 * - in full, the ones Codex would summarise and has not (a few a launch);
 * - as a stub (the conversation's first line, at the summary's time), every one it has summarised,
 *   so it keeps that summary without summarising it again.
 * The summary database and the memory folder travel as agent memory.
 */

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** Codex's own defaults (codex-rs `config/src/types.rs`, 0.159). */
const CODEX_MIN_IDLE_MS = 6 * 60 * 60 * 1000;
const CODEX_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;
/** The session sources Codex summarises (codex-rs `rollout/src/lib.rs`, `INTERACTIVE_SESSION_SOURCES`). */
const CODEX_INTERACTIVE_SOURCES: ReadonlySet<string> = new Set([
  "cli",
  "vscode",
  "atlas",
  "chatgpt",
]);

/** At most this many in full a launch: Codex summarises two a start, a few more cover a refusal. */
export const CODEX_CARRY_MAX_CONVERSATIONS = 4;
/** At most this many compressed bytes a launch: what one launch spends on the copy. */
export const CODEX_CARRY_MAX_BYTES = 8 * 1024 * 1024;
/** A rollout over this is not read at all: the compressed limit must not cost the server more. */
export const CODEX_CARRY_MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
/** At most this many stubs a launch (Codex merges at most 256 summaries). */
export const CODEX_CARRY_MAX_STUBS = 512;

/** One harvested revision of a Codex conversation of the person's on the project. */
export interface CodexRevision {
  readonly providerSessionId: string;
  /** The harvested rollout (`transcript.native`) in the store. */
  readonly transcriptPath: string;
  /** When it was harvested: as late as its last write. */
  readonly capturedAt: Date;
}

/** What Codex records of a summary: the thread, and the conversation's time it summarised. */
export type Summarised = ReadonlyMap<string, number>;

/** What a rollout says of itself, as Codex reads it at backfill. */
export interface RolloutFacts {
  /** Its first line (`session_meta`): the stub of it. */
  readonly firstLine: string;
  /** The memory mode its last `session_meta` that names one sets; null when none does. */
  readonly memoryMode: string | null;
}

const payloadOf = (line: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || !("payload" in parsed)) return null;
    const payload = parsed.payload;
    return typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * Whether Codex would summarise a conversation (codex-rs `phase1.rs`, `metadata.rs`): an
 * interactive source, from its first line, and memory not turned off for it, from the last
 * `session_meta` line that names a mode (a later turn can turn it off).
 */
export const codexWouldSummarise = (facts: RolloutFacts): boolean => {
  const payload = payloadOf(facts.firstLine);
  if (payload === null) return false;
  const source = payload["source"] ?? "vscode";
  return (
    typeof source === "string" &&
    CODEX_INTERACTIVE_SOURCES.has(source) &&
    (facts.memoryMode === null || facts.memoryMode === "enabled")
  );
};

/** Codex keeps a summary only for a thread whose memory is not turned off. */
const memoryOn = (facts: RolloutFacts): boolean =>
  facts.memoryMode === null || facts.memoryMode === "enabled";

export interface CarryPlan {
  /** Laid down whole, for Codex to summarise; a stub stands in when one cannot be. */
  readonly full: ReadonlyArray<CodexRevision>;
  /**
   * Every summarised conversation's stub (its first line, at the summary's time), in Codex's own
   * order of preference: the ones laid down in full are left out when they are prepared.
   */
  readonly stubs: ReadonlyArray<{
    readonly providerSessionId: string;
    readonly firstLine: string;
    readonly mtime: number;
  }>;
}

/**
 * What a launch lays down. Each conversation counts by its latest harvested revision; one with a
 * live agent, or whose latest revision is under six hours old, is still going and is not carried
 * in full. In full: those Codex would summarise and has not summarised at that revision, newest
 * first, at most `CODEX_CARRY_MAX_CONVERSATIONS`. As stubs: every summarised one whose memory is
 * on, by its latest revision's first line or, for one summarised on another machine, the line
 * imported with it.
 */
export const planCodexCarry = (input: {
  readonly revisions: ReadonlyArray<CodexRevision>;
  /** What each revision's rollout says of itself, by its transcript path. */
  readonly facts: ReadonlyMap<string, RolloutFacts>;
  /** Codex's summaries, in its own order of preference. */
  readonly summarised: Summarised;
  /** First lines imported from another machine, by thread id. */
  readonly imported: ReadonlyMap<string, string>;
  /** Conversations an agent holds right now. */
  readonly live: ReadonlySet<string>;
  readonly now: number;
}): CarryPlan => {
  const latest = new Map<string, CodexRevision>();
  for (const revision of input.revisions) {
    const known = latest.get(revision.providerSessionId);
    if (known === undefined || revision.capturedAt > known.capturedAt) {
      latest.set(revision.providerSessionId, revision);
    }
  }
  const full = [...latest.values()]
    .filter((revision) => {
      if (input.live.has(revision.providerSessionId)) return false;
      const age = input.now - revision.capturedAt.getTime();
      if (age < CODEX_MIN_IDLE_MS || age > CODEX_MAX_AGE_MS) return false;
      const summarisedAt = input.summarised.get(revision.providerSessionId);
      // Codex records a thread's time as its rollout's modification time, whole seconds, which
      // Mend sets from the harvest time: summarised at this revision or later, nothing is new.
      if (
        summarisedAt !== undefined &&
        summarisedAt >= Math.floor(revision.capturedAt.getTime() / 1000)
      ) {
        return false;
      }
      const facts = input.facts.get(revision.transcriptPath);
      return facts !== undefined && codexWouldSummarise(facts);
    })
    .toSorted((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())
    .slice(0, CODEX_CARRY_MAX_CONVERSATIONS);
  const stubs: Array<CarryPlan["stubs"][number]> = [];
  for (const [id, mtime] of input.summarised) {
    const revision = latest.get(id);
    const facts = revision === undefined ? undefined : input.facts.get(revision.transcriptPath);
    if (facts !== undefined && !memoryOn(facts)) continue;
    const firstLine = facts?.firstLine ?? input.imported.get(id);
    if (firstLine === undefined) continue;
    stubs.push({ providerSessionId: id, firstLine, mtime });
  }
  return { full, stubs };
};

/**
 * What Codex has summarised, by thread, from the stored summary database; empty when none is
 * stored or it cannot be read (the worst case is a summary made twice).
 */
export const summarisedThreads = (database: Uint8Array | null): Effect.Effect<Summarised> =>
  Effect.promise(async () => {
    if (database === null) return new Map<string, number>();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mend-codex-memory-"));
    try {
      const file = path.join(dir, "memories_1.sqlite");
      await fs.writeFile(file, database);
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        // Codex's own order of preference for its 256 (codex-rs `memories.rs`
        // `get_phase2_input_selection`); a database without its columns reads unordered.
        const rows = (() => {
          try {
            return db
              .prepare(
                "select thread_id, source_updated_at from stage1_outputs order by usage_count desc, coalesce(last_usage, source_updated_at) desc, source_updated_at desc, thread_id desc",
              )
              .all();
          } catch {
            return db.prepare("select thread_id, source_updated_at from stage1_outputs").all();
          }
        })();
        return new Map(
          rows.flatMap((row) =>
            typeof row["thread_id"] === "string"
              ? [[row["thread_id"], Number(row["source_updated_at"] ?? 0)] as const]
              : [],
          ),
        );
      } finally {
        db.close();
      }
    } catch {
      return new Map<string, number>();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

/**
 * Codex's summary database as one self-contained file: the database and its write-ahead log,
 * read together, rewritten with `VACUUM INTO`. Null when they do not open as a database (a copy
 * torn mid-checkpoint): nothing is stored then, and the last stored one stays.
 */
export const consolidateCodexDatabase = (
  db: Uint8Array,
  wal: Uint8Array | null,
): Effect.Effect<Uint8Array | null> =>
  Effect.promise(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mend-codex-consolidate-"));
    try {
      const file = path.join(dir, "memories_1.sqlite");
      const out = path.join(dir, "consolidated.sqlite");
      await fs.writeFile(file, db);
      if (wal !== null) await fs.writeFile(`${file}-wal`, wal);
      const opened = new DatabaseSync(file);
      try {
        opened.exec(`vacuum into '${out}'`);
      } finally {
        opened.close();
      }
      const check = new DatabaseSync(out, { readOnly: true });
      try {
        const verdict = check.prepare("pragma integrity_check").get();
        if (verdict?.["integrity_check"] !== "ok") return null;
      } finally {
        check.close();
      }
      return new Uint8Array(await fs.readFile(out));
    } catch {
      return null;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

/**
 * Two of Codex's summary databases as one (docs/adr/0009, decision 4): `ours` with every summary
 * `theirs` holds of a conversation `ours` has not summarised, or has summarised at an older
 * revision. Everything else (Codex's jobs, its consolidation state) stays `ours`'. Null, and the
 * caller keeps `ours` and the machine's whole, when the two do not open as databases, their
 * `stage1_outputs` columns differ (another Codex version), a revision is not an integer, or both
 * hold one conversation at the same revision with other words, which one row cannot keep.
 */
export const mergeCodexDatabases: MergeDatabase = ({ ours, theirs }) =>
  Effect.promise(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mend-codex-merge-"));
    try {
      const mine = path.join(dir, "ours.sqlite");
      const other = path.join(dir, "theirs.sqlite");
      const out = path.join(dir, "merged.sqlite");
      await fs.writeFile(mine, ours);
      await fs.writeFile(other, theirs);
      const db = new DatabaseSync(mine);
      try {
        db.exec(`attach database '${other.replaceAll("'", "''")}' as theirs`);
        const columns = (schema: string) =>
          db
            .prepare("select name from pragma_table_info('stage1_outputs', ?) order by cid")
            .all(schema)
            .map((row) => String(row["name"]))
            .join(",");
        const own = columns("main");
        if (own === "" || own !== columns("theirs") || !own.split(",").includes("thread_id")) {
          return null;
        }
        const count = (query: string) => Number(db.prepare(query).get()?.["n"] ?? 1);
        // A revision that is not an integer cannot say which summary is newer: not merged.
        for (const schema of ["main", "theirs"]) {
          if (
            count(
              `select count(*) as n from ${schema}.stage1_outputs where typeof(source_updated_at) != 'integer'`,
            ) > 0
          ) {
            return null;
          }
        }
        // The same conversation at the same revision with other words: one row cannot keep both,
        // so the two are not merged (a conflict, with the machine's database kept, pinned).
        const content = own
          .split(",")
          .filter((column) => !SUMMARY_KEY_AND_USE.has(column))
          .map((column) => `"${column.replaceAll('"', '""')}"`);
        if (
          content.length > 0 &&
          count(`select count(*) as n from theirs.stage1_outputs t
            join main.stage1_outputs m on m.thread_id = t.thread_id
            where t.source_updated_at = m.source_updated_at
              and (${content.map((column) => `t.${column} is not m.${column}`).join(" or ")})`) > 0
        ) {
          return null;
        }
        db.exec(`delete from main.stage1_outputs where thread_id in (
          select t.thread_id from theirs.stage1_outputs t
          join main.stage1_outputs m on m.thread_id = t.thread_id
          where t.source_updated_at > m.source_updated_at)`);
        db.exec("insert or ignore into main.stage1_outputs select * from theirs.stage1_outputs");
        db.exec("detach database theirs");
        db.exec(`vacuum into '${out.replaceAll("'", "''")}'`);
      } finally {
        db.close();
      }
      const check = new DatabaseSync(out, { readOnly: true });
      try {
        if (check.prepare("pragma integrity_check").get()?.["integrity_check"] !== "ok")
          return null;
      } finally {
        check.close();
      }
      return new Uint8Array(await fs.readFile(out));
    } catch {
      return null;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

/**
 * Whether summary database `current` holds every summary `version` holds, at the same revision or
 * a newer one (docs/adr/0009): when it does, a replaced `version` is not the only copy of anything
 * and need not be pinned. False when either does not open as a summary database.
 */
export const codexDatabaseHolds: HoldsDatabase = ({ current, version }) =>
  Effect.gen(function* () {
    if (Buffer.from(current).equals(Buffer.from(version))) return true;
    const [now, then] = yield* Effect.all([summaryRows(current), summaryRows(version)]);
    // A database that does not open as a summary database holds nothing anyone can check.
    if (now === null || then === null) return false;
    for (const [thread, row] of then) {
      const held = now.get(thread);
      // Held only by the same thread, at a valid revision: a newer one, or the same one saying
      // exactly the same. A missing row, an invalid revision or other words at the same revision
      // is not held.
      if (held === undefined || held.revision === null || row.revision === null) return false;
      if (held.revision > row.revision) continue;
      if (held.revision === row.revision && held.content === row.content) continue;
      return false;
    }
    return true;
  });

/**
 * Columns Codex changes as it uses a summary, or that key it: not part of what the summary says.
 * Everything else in a row (`raw_memory`, `rollout_summary`, …) is its content.
 */
const SUMMARY_KEY_AND_USE = new Set([
  "thread_id",
  "source_updated_at",
  "usage_count",
  "last_usage",
  "selected_for_phase2",
  "selected_for_phase2_source_updated_at",
]);

/** One SQLite value as text that tells every value apart. */
const valueText = (value: unknown): string =>
  value === null
    ? "n"
    : typeof value === "string"
      ? `s${value}`
      : value instanceof Uint8Array
        ? `b${Buffer.from(value).toString("base64")}`
        : `v${String(value)}`;

/**
 * Each summary in a database, by thread: its revision (null unless a finite integer) and what it
 * says (its content columns, as text). Null when the bytes do not open as a database with
 * `stage1_outputs`.
 */
const summaryRows = (
  database: Uint8Array,
): Effect.Effect<ReadonlyMap<
  string,
  { readonly revision: number | null; readonly content: string }
> | null> =>
  Effect.promise(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mend-codex-rows-"));
    try {
      const file = path.join(dir, "memories_1.sqlite");
      await fs.writeFile(file, database);
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const rows = db.prepare("select * from stage1_outputs").all();
        const out = new Map<string, { revision: number | null; content: string }>();
        for (const row of rows) {
          const thread = row["thread_id"];
          if (typeof thread !== "string") return null;
          const revision = row["source_updated_at"];
          const content = Object.entries(row)
            .filter(([column]) => !SUMMARY_KEY_AND_USE.has(column))
            .map(([column, value]) => `${column}=${valueText(value)}`);
          out.set(thread, {
            revision:
              typeof revision === "number" && Number.isSafeInteger(revision) ? revision : null,
            content: JSON.stringify(content),
          });
        }
        return out;
      } finally {
        db.close();
      }
    } catch {
      return null;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

/** Rollout facts already read, by path, size and time: a launch reads each file once. */
const factsRead = new Map<string, RolloutFacts | null>();

/**
 * What a rollout says of itself (`RolloutFacts`), read line by line; null when it cannot be read,
 * has no first line, or is over `CODEX_CARRY_MAX_ROLLOUT_BYTES`.
 */
export const readRolloutFacts = (file: string): Effect.Effect<RolloutFacts | null> =>
  Effect.promise(async () => {
    const stat = await fs.stat(file).catch(() => null);
    if (stat === null || stat.size === 0 || stat.size > CODEX_CARRY_MAX_ROLLOUT_BYTES) return null;
    const key = `${file}\0${stat.size}\0${stat.mtimeMs}`;
    if (factsRead.has(key)) return factsRead.get(key) ?? null;
    const handle = await fs.open(file, "r").catch(() => null);
    if (handle === null) return null;
    let firstLine: string | null = null;
    let memoryMode: string | null = null;
    try {
      for await (const line of handle.readLines()) {
        if (firstLine === null) firstLine = line;
        if (!line.includes('"session_meta"')) continue;
        const mode = payloadOf(line)?.["memory_mode"];
        if (typeof mode === "string") memoryMode = mode;
      }
    } catch {
      firstLine = null;
    } finally {
      await handle.close().catch(() => undefined);
    }
    const facts = firstLine === null ? null : { firstLine, memoryMode };
    if (factsRead.size > 4096) factsRead.clear();
    factsRead.set(key, facts);
    return facts;
  });

/** `2026-09-30T14-02-11`: the time in a rollout's file name, from an ISO timestamp, UTC. */
const nameTime = (at: Date): string => at.toISOString().slice(0, 19).replaceAll(":", "-");

/**
 * Where Codex keeps a rollout, relative to the harness home:
 * `.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. The time is the conversation's start
 * from its first line (`session_meta`), else `fallback`.
 */
export const rolloutPathOf = (
  firstLine: string,
  providerSessionId: string,
  fallback: Date,
): string => {
  let started = fallback;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (typeof parsed === "object" && parsed !== null) {
      const payload = "payload" in parsed ? parsed.payload : null;
      const raw =
        typeof payload === "object" && payload !== null && "timestamp" in payload
          ? payload.timestamp
          : "timestamp" in parsed
            ? parsed.timestamp
            : null;
      if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) started = new Date(raw);
    }
  } catch {
    // Not JSON: the fallback names it.
  }
  const day = started.toISOString().slice(0, 10).split("-");
  return path.posix.join(
    ".codex/sessions",
    ...day,
    `rollout-${nameTime(started)}-${providerSessionId}.jsonl`,
  );
};

/** One conversation ready to lay down: its place in the home, compressed bytes, and its time. */
export interface CarriedFile {
  readonly providerSessionId: string;
  /** Relative to the harness home. */
  readonly path: string;
  readonly gzipped: Uint8Array;
  /** Seconds since the epoch: its modification time, which Codex reads as its last activity. */
  readonly mtime: number;
}

/**
 * Read and compress a plan's files: full rollouts within the limits, then the stubs of every
 * summarised conversation not laid down in full, up to `CODEX_CARRY_MAX_STUBS` in Codex's order.
 * A full rollout that cannot be prepared keeps its stub.
 */
export const prepareCarriedConversations = (
  plan: CarryPlan,
): Effect.Effect<ReadonlyArray<CarriedFile>> =>
  Effect.promise(async () => {
    const files: Array<CarriedFile> = [];
    const inFull = new Set<string>();
    let total = 0;
    for (const revision of plan.full) {
      const stat = await fs.stat(revision.transcriptPath).catch(() => null);
      if (stat === null || stat.size === 0 || stat.size > CODEX_CARRY_MAX_ROLLOUT_BYTES) continue;
      const bytes = await fs.readFile(revision.transcriptPath).catch(() => null);
      if (bytes === null) continue;
      const gzipped = await gzip(bytes);
      if (total + gzipped.byteLength > CODEX_CARRY_MAX_BYTES) continue;
      total += gzipped.byteLength;
      const firstLine =
        bytes
          .subarray(0, 256 * 1024)
          .toString("utf8")
          .split("\n", 1)[0] ?? "";
      inFull.add(revision.providerSessionId);
      files.push({
        providerSessionId: revision.providerSessionId,
        path: rolloutPathOf(firstLine, revision.providerSessionId, revision.capturedAt),
        gzipped,
        mtime: Math.floor(revision.capturedAt.getTime() / 1000),
      });
    }
    let stubs = 0;
    for (const stub of plan.stubs) {
      if (inFull.has(stub.providerSessionId) || stubs >= CODEX_CARRY_MAX_STUBS) continue;
      stubs += 1;
      files.push({
        providerSessionId: stub.providerSessionId,
        path: rolloutPathOf(stub.firstLine, stub.providerSessionId, new Date(stub.mtime * 1000)),
        gzipped: await gzip(Buffer.from(`${stub.firstLine}\n`, "utf8")),
        mtime: stub.mtime,
      });
    }
    return files;
  });

/** Where compressed conversations wait in the home for the program. */
export const CARRIED_INCOMING = ".mend/carried-incoming";

/**
 * Lays carried conversations down in a workspace (`node -e`, argv: the harness home and the
 * `[{id, path, mtime}]` JSON; each `<incoming>/<id>.gz` waits staged). Nothing that was not carried
 * is ever touched or listed: a file already at the path that Mend did not carry is left, and stays
 * the session's own. One Mend carried is replaced only by a later revision. Each id is listed in
 * `CARRIED_TRANSCRIPTS` before its file appears. Prints `carried <outcome> <id>` per conversation.
 */
export const CARRY_PROGRAM = [
  `const fs=require("fs"),path=require("path"),zlib=require("zlib");`,
  `const [home,list]=process.argv.slice(1),items=JSON.parse(list);`,
  `const L=path.join(home,${JSON.stringify(CARRIED_TRANSCRIPTS)}),I=path.join(home,${JSON.stringify(CARRIED_INCOMING)});`,
  `fs.mkdirSync(path.dirname(L),{recursive:true});`,
  `const listed=new Set(fs.existsSync(L)?fs.readFileSync(L,"utf8").split("\\n").filter(Boolean):[]);`,
  `let failed=false;`,
  `for(const it of items){const staged=path.join(I,it.id+".gz"),to=path.join(home,it.path);try{`,
  `const there=fs.existsSync(to);`,
  `if(there&&!listed.has(it.id)){console.log("carried own "+it.id);continue;}`,
  `if(there&&fs.statSync(to).mtimeMs/1000>=it.mtime){console.log("carried present "+it.id);continue;}`,
  `if(!listed.has(it.id)){fs.appendFileSync(L,it.id+"\\n");listed.add(it.id);}`,
  `fs.mkdirSync(path.dirname(to),{recursive:true});`,
  `fs.writeFileSync(to+".mend-part",zlib.gunzipSync(fs.readFileSync(staged)));`,
  `fs.utimesSync(to+".mend-part",it.mtime,it.mtime);fs.renameSync(to+".mend-part",to);`,
  `console.log("carried written "+it.id);`,
  `}catch(e){failed=true;console.log("carried error "+it.id+" "+e.message);}`,
  `finally{try{fs.rmSync(staged,{force:true});}catch{}}}`,
  `process.exit(failed?1:0);`,
].join("");

/** The staged files and the exec that lays `files` down in a workspace's harness home. */
export const carryConversationsExec = (
  home: string,
  files: ReadonlyArray<CarriedFile>,
): {
  readonly staged: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>;
  readonly argv: ReadonlyArray<string>;
} => ({
  staged: files.map((file) => ({
    path: path.posix.join(home, CARRIED_INCOMING, `${file.providerSessionId}.gz`),
    bytes: file.gzipped,
  })),
  argv: [
    "node",
    "-e",
    CARRY_PROGRAM,
    home,
    JSON.stringify(
      files.map((file) => ({ id: file.providerSessionId, path: file.path, mtime: file.mtime })),
    ),
  ],
});

/** What one carry did, per conversation, from the program's output. */
export const parseCarryOutcomes = (
  stdout: string,
): ReadonlyArray<{ readonly outcome: string; readonly id: string }> =>
  stdout.split("\n").flatMap((line) => {
    const match = /^carried (\S+) (\S+)/.exec(line.trim());
    return match?.[1] === undefined || match[2] === undefined
      ? []
      : [{ outcome: match[1], id: match[2] }];
  });

/** Lay carried conversations down in a harness home on this machine, as the program does. */
export const materializeCarriedConversations = (
  home: string,
  files: ReadonlyArray<CarriedFile>,
): Effect.Effect<ReadonlyArray<{ readonly outcome: string; readonly id: string }>> =>
  Effect.promise(async () => {
    const list = path.join(home, CARRIED_TRANSCRIPTS);
    await fs.mkdir(path.dirname(list), { recursive: true });
    const listed = new Set(
      parseCarriedTranscripts(await fs.readFile(list, "utf8").catch(() => null)),
    );
    const outcomes: Array<{ readonly outcome: string; readonly id: string }> = [];
    for (const file of files) {
      const id = file.providerSessionId;
      try {
        const to = path.join(home, file.path);
        const there = await fs.stat(to).catch(() => null);
        if (there !== null && !listed.has(id)) {
          outcomes.push({ outcome: "own", id });
          continue;
        }
        if (there !== null && there.mtimeMs / 1000 >= file.mtime) {
          outcomes.push({ outcome: "present", id });
          continue;
        }
        if (!listed.has(id)) {
          await fs.appendFile(list, `${id}\n`);
          listed.add(id);
        }
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.writeFile(`${to}.mend-part`, await gunzip(file.gzipped));
        await fs.utimes(`${to}.mend-part`, file.mtime, file.mtime);
        await fs.rename(`${to}.mend-part`, to);
        outcomes.push({ outcome: "written", id });
      } catch {
        outcomes.push({ outcome: "error", id });
      }
    }
    return outcomes;
  });

type StoredFile = {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
};

const bytesOf = (file: StoredFile): Uint8Array =>
  file.encoding === "base64"
    ? Buffer.from(file.contents, "base64")
    : Buffer.from(file.contents, "utf8");

/** The stored summary database, from a person's stored memory. */
export const storedCodexDatabase = (stored: ReadonlyArray<StoredFile>): Uint8Array | null => {
  const file = stored.find((candidate) => candidate.path === CODEX_MEMORY_DATABASE);
  return file === undefined ? null : bytesOf(file);
};

/** Where `mend memory import` keeps each imported summary's conversation line. */
export const CODEX_THREADS_ROOT = ".mend/codex-threads";

/** The imported first lines, by thread id, from a person's stored memory. */
export const storedCodexThreadLines = (
  stored: ReadonlyArray<StoredFile>,
): ReadonlyMap<string, string> =>
  new Map(
    stored.flatMap((file) => {
      const match = new RegExp(`^${CODEX_THREADS_ROOT}/([0-9a-f-]{36})\\.jsonl$`).exec(file.path);
      if (match?.[1] === undefined) return [];
      const line = Buffer.from(bytesOf(file)).toString("utf8").split("\n", 1)[0] ?? "";
      return line === "" ? [] : [[match[1], line] as const];
    }),
  );
