import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

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

/**
 * A conversation's first line (`session_meta`), as Codex reads it: whether Codex would summarise
 * it (an interactive source, memory not turned off for it).
 */
export const codexWouldSummarise = (firstLine: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (typeof parsed !== "object" || parsed === null || !("payload" in parsed)) return false;
    const payload = parsed.payload;
    if (typeof payload !== "object" || payload === null) return false;
    const source = "source" in payload ? payload.source : "vscode";
    const mode = "memory_mode" in payload ? payload.memory_mode : null;
    return (
      typeof source === "string" &&
      CODEX_INTERACTIVE_SOURCES.has(source) &&
      (mode === null || mode === undefined || mode === "enabled")
    );
  } catch {
    return false;
  }
};

export interface CarryPlan {
  /** Laid down whole, for Codex to summarise. */
  readonly full: ReadonlyArray<CodexRevision>;
  /** Laid down as their first line, at the summary's time, so Codex keeps their summaries. */
  readonly stubs: ReadonlyArray<{
    readonly providerSessionId: string;
    readonly firstLine: string;
    readonly mtime: number;
  }>;
}

/**
 * What a launch lays down. Each conversation counts by its latest revision only; one still active
 * (its latest revision under six hours old) is never carried in full. In full: those Codex would
 * summarise and has not summarised at that revision, newest first, at most
 * `CODEX_CARRY_MAX_CONVERSATIONS`. As a stub: every other one Codex summarised, by the first line
 * of its latest revision or, for one summarised on another machine, the line imported with it.
 */
export const planCodexCarry = (input: {
  readonly revisions: ReadonlyArray<CodexRevision>;
  /** Each latest revision's first line, by its transcript path. */
  readonly firstLines: ReadonlyMap<string, string>;
  readonly summarised: Summarised;
  /** First lines imported from another machine, by thread id. */
  readonly imported: ReadonlyMap<string, string>;
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
      const firstLine = input.firstLines.get(revision.transcriptPath);
      return firstLine !== undefined && codexWouldSummarise(firstLine);
    })
    .toSorted((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())
    .slice(0, CODEX_CARRY_MAX_CONVERSATIONS);
  const inFull = new Set(full.map((revision) => revision.providerSessionId));
  const stubs: Array<CarryPlan["stubs"][number]> = [];
  for (const [id, mtime] of input.summarised) {
    if (inFull.has(id) || stubs.length >= CODEX_CARRY_MAX_STUBS) continue;
    const revision = latest.get(id);
    const firstLine =
      (revision === undefined ? undefined : input.firstLines.get(revision.transcriptPath)) ??
      input.imported.get(id);
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
        const rows = db.prepare("select thread_id, source_updated_at from stage1_outputs").all();
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
      return new Uint8Array(await fs.readFile(out));
    } catch {
      return null;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

/** A rollout's first line, read without reading the rest; null when it cannot be read. */
export const readFirstLine = (file: string): Effect.Effect<string | null> =>
  Effect.promise(async () => {
    const handle = await fs.open(file, "r").catch(() => null);
    if (handle === null) return null;
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const end = text.indexOf("\n");
      return end === -1 ? null : text.slice(0, end);
    } finally {
      await handle.close();
    }
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

/** Read and compress a plan's files: full rollouts within the limits, then every stub. */
export const prepareCarriedConversations = (
  plan: CarryPlan,
): Effect.Effect<ReadonlyArray<CarriedFile>> =>
  Effect.promise(async () => {
    const files: Array<CarriedFile> = [];
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
      files.push({
        providerSessionId: revision.providerSessionId,
        path: rolloutPathOf(firstLine, revision.providerSessionId, revision.capturedAt),
        gzipped,
        mtime: Math.floor(revision.capturedAt.getTime() / 1000),
      });
    }
    for (const stub of plan.stubs) {
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
