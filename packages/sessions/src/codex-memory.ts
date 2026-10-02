import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

import { CODEX_MEMORY_DATABASE } from "@mend/domain/workbench";
import { Effect } from "effect";

import { CARRIED_TRANSCRIPTS, parseCarriedTranscripts } from "./harness-state.ts";

/**
 * Codex memory, carried between one person's sessions on a project (docs/adr/0009, "Codex").
 *
 * Codex builds memory from past conversations when a session starts: up to two a start, each quiet
 * for six hours and under ten days old, summarised by the model and consolidated into
 * `.codex/memories/`. A Mend session's home starts empty, so Mend carries in the person's own
 * conversations on the project that Codex has not summarised yet, a few at a time. The summary
 * database (`memories_1.sqlite`) and the memory folder travel as agent memory; this module picks
 * and lays down the conversations.
 */

/** Codex's own defaults (codex-rs `config/src/types.rs`, 0.159). */
const CODEX_MIN_IDLE_MS = 6 * 60 * 60 * 1000;
const CODEX_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;

/** At most this many a launch: Codex summarises two a start, so a few more cover a refusal. */
export const CODEX_CARRY_MAX_CONVERSATIONS = 4;
/** At most this many compressed bytes a launch: what one launch spends on the copy. */
export const CODEX_CARRY_MAX_BYTES = 8 * 1024 * 1024;

/** One harvested Codex conversation of the person's on the project. */
export interface CodexConversation {
  readonly providerSessionId: string;
  /** The harvested rollout (`transcript.native`) in the store. */
  readonly transcriptPath: string;
  /** When it was harvested: as late as its last write. */
  readonly capturedAt: Date;
}

/**
 * The conversations to carry into a launch: quiet long enough for Codex to take, young enough to
 * be in its window, not summarised yet, not already in the home; newest first, at most
 * `CODEX_CARRY_MAX_CONVERSATIONS`.
 */
export const planCarriedConversations = (input: {
  readonly conversations: ReadonlyArray<CodexConversation>;
  readonly summarised: ReadonlySet<string>;
  readonly alreadyCarried: ReadonlySet<string>;
  readonly now: number;
}): ReadonlyArray<CodexConversation> => {
  const seen = new Set<string>();
  return input.conversations
    .filter((conversation) => {
      const age = input.now - conversation.capturedAt.getTime();
      if (age < CODEX_MIN_IDLE_MS || age > CODEX_MAX_AGE_MS) return false;
      const id = conversation.providerSessionId;
      if (input.summarised.has(id) || input.alreadyCarried.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .toSorted((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())
    .slice(0, CODEX_CARRY_MAX_CONVERSATIONS);
};

/**
 * The thread ids Codex has summarised, from the stored summary database and its write-ahead log;
 * empty when none is stored or it cannot be read (the worst case is a summary made twice).
 */
export const summarisedThreads = (database: {
  readonly db: Uint8Array | null;
  readonly wal: Uint8Array | null;
}): Effect.Effect<ReadonlySet<string>> =>
  Effect.promise(async () => {
    if (database.db === null) return new Set<string>();
    const dir = await mkdtemp(path.join(os.tmpdir(), "mend-codex-memory-"));
    try {
      const file = path.join(dir, "memories_1.sqlite");
      await writeFile(file, database.db);
      if (database.wal !== null) await writeFile(`${file}-wal`, database.wal);
      const db = new DatabaseSync(file);
      try {
        const rows = db.prepare("select thread_id from stage1_outputs").all();
        return new Set(
          rows.flatMap((row) => (typeof row["thread_id"] === "string" ? [row["thread_id"]] : [])),
        );
      } finally {
        db.close();
      }
    } catch {
      return new Set<string>();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

/** `2026-09-30T14-02-11`: the time in a rollout's file name, from an ISO timestamp, UTC. */
const nameTime = (at: Date): string => at.toISOString().slice(0, 19).replaceAll(":", "-");

/**
 * Where Codex keeps a rollout, relative to the harness home:
 * `.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. The time is the conversation's start
 * from its first line (`session_meta`), else when it was harvested.
 */
export const rolloutPathOf = (
  firstLine: string,
  providerSessionId: string,
  capturedAt: Date,
): string => {
  let started = capturedAt;
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
    // Not JSON: the harvest time names it.
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
  /** Seconds since the epoch: its modification time, so it never reads as the newest. */
  readonly mtime: number;
}

/** Read and compress the planned conversations, within `CODEX_CARRY_MAX_BYTES`. */
export const prepareCarriedConversations = (
  planned: ReadonlyArray<CodexConversation>,
): Effect.Effect<ReadonlyArray<CarriedFile>> =>
  Effect.promise(async () => {
    const files: Array<CarriedFile> = [];
    let total = 0;
    for (const conversation of planned) {
      const bytes = await readFile(conversation.transcriptPath).catch(() => null);
      if (bytes === null || bytes.byteLength === 0) continue;
      const gzipped = gzipSync(bytes);
      if (total + gzipped.byteLength > CODEX_CARRY_MAX_BYTES) continue;
      total += gzipped.byteLength;
      const firstLine = bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1024)).toString("utf8");
      files.push({
        providerSessionId: conversation.providerSessionId,
        path: rolloutPathOf(
          firstLine.split("\n", 1)[0] ?? "",
          conversation.providerSessionId,
          conversation.capturedAt,
        ),
        gzipped,
        mtime: Math.floor(conversation.capturedAt.getTime() / 1000),
      });
    }
    return files;
  });

/** Where compressed conversations wait in the home for the program. */
export const CARRIED_INCOMING = ".mend/carried-incoming";

/**
 * Lays carried conversations down in a workspace (`node -e`, argv: the harness home and the
 * `[{id, path, mtime}]` JSON; each `<incoming>/<id>.gz` waits staged). A conversation already in
 * place is left as it is. Every id is listed in `CARRIED_TRANSCRIPTS` before its file appears, so
 * nothing ever reads one as the session's own. Prints `carried <outcome> <id>` per conversation.
 */
export const CARRY_PROGRAM = [
  `const fs=require("fs"),path=require("path"),zlib=require("zlib");`,
  `const [home,list]=process.argv.slice(1),items=JSON.parse(list);`,
  `const L=path.join(home,${JSON.stringify(CARRIED_TRANSCRIPTS)}),I=path.join(home,${JSON.stringify(CARRIED_INCOMING)});`,
  `fs.mkdirSync(path.dirname(L),{recursive:true});`,
  `const listed=new Set(fs.existsSync(L)?fs.readFileSync(L,"utf8").split("\\n").filter(Boolean):[]);`,
  `let failed=false;`,
  `for(const it of items){const staged=path.join(I,it.id+".gz"),to=path.join(home,it.path);try{`,
  `if(!listed.has(it.id)){fs.appendFileSync(L,it.id+"\\n");listed.add(it.id);}`,
  `if(fs.existsSync(to)){console.log("carried present "+it.id);continue;}`,
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

/** Lay carried conversations down in a harness home on this machine (the co-located store). */
export const materializeCarriedConversations = (
  home: string,
  files: ReadonlyArray<CarriedFile>,
): Effect.Effect<ReadonlyArray<{ readonly outcome: string; readonly id: string }>> =>
  Effect.promise(async () => {
    const list = path.join(home, CARRIED_TRANSCRIPTS);
    await mkdir(path.dirname(list), { recursive: true });
    const listed = new Set(parseCarriedTranscripts(await readFile(list, "utf8").catch(() => null)));
    const outcomes: Array<{ readonly outcome: string; readonly id: string }> = [];
    for (const file of files) {
      const id = file.providerSessionId;
      try {
        if (!listed.has(id)) {
          await appendFile(list, `${id}\n`);
          listed.add(id);
        }
        const to = path.join(home, file.path);
        const present = await access(to).then(
          () => true,
          () => false,
        );
        if (present) {
          outcomes.push({ outcome: "present", id });
          continue;
        }
        await mkdir(path.dirname(to), { recursive: true });
        await writeFile(`${to}.mend-part`, gunzipSync(file.gzipped));
        await utimes(`${to}.mend-part`, file.mtime, file.mtime);
        await rename(`${to}.mend-part`, to);
        outcomes.push({ outcome: "written", id });
      } catch {
        outcomes.push({ outcome: "error", id });
      }
    }
    return outcomes;
  });

/** The stored summary database and its log, from a person's stored memory. */
export const storedCodexDatabase = (
  stored: ReadonlyArray<{
    readonly path: string;
    readonly encoding: "utf8" | "base64";
    readonly contents: string;
  }>,
): { readonly db: Uint8Array | null; readonly wal: Uint8Array | null } => {
  const bytesOf = (filePath: string): Uint8Array | null => {
    const file = stored.find((candidate) => candidate.path === filePath);
    if (file === undefined) return null;
    return file.encoding === "base64"
      ? Buffer.from(file.contents, "base64")
      : Buffer.from(file.contents, "utf8");
  };
  return { db: bytesOf(CODEX_MEMORY_DATABASE), wal: bytesOf(`${CODEX_MEMORY_DATABASE}-wal`) };
};
