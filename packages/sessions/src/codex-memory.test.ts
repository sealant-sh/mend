import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  CARRIED_INCOMING,
  CODEX_CARRY_MAX_CONVERSATIONS,
  carryConversationsExec,
  codexWouldSummarise,
  consolidateCodexDatabase,
  materializeCarriedConversations,
  parseCarryOutcomes,
  planCodexCarry,
  prepareCarriedConversations,
  rolloutPathOf,
  summarisedThreads,
  type CodexRevision,
} from "./codex-memory.ts";
import { CARRIED_TRANSCRIPTS, locateLiveTranscript } from "./harness-state.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const id = (n: number) => `0000000${n}-1111-2222-3333-444444444444`;
const metaLine = (source = "cli", memoryMode: string | null = null) =>
  JSON.stringify({
    type: "session_meta",
    payload: {
      timestamp: "2026-09-30T08:00:00Z",
      source,
      ...(memoryMode === null ? {} : { memory_mode: memoryMode }),
    },
  });
const revision = (n: number, hoursAgo: number, at = `/store/${n}/${hoursAgo}`): CodexRevision => ({
  providerSessionId: id(n),
  transcriptPath: at,
  capturedAt: new Date(NOW - hoursAgo * HOUR),
});
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "mend-codex-memory-test-"));
const plan = (
  revisions: ReadonlyArray<CodexRevision>,
  options: {
    readonly summarised?: ReadonlyMap<string, number>;
    readonly imported?: ReadonlyMap<string, string>;
    readonly lines?: ReadonlyMap<string, string>;
  } = {},
) =>
  planCodexCarry({
    revisions,
    firstLines:
      options.lines ?? new Map(revisions.map((r) => [r.transcriptPath, metaLine()] as const)),
    summarised: options.summarised ?? new Map(),
    imported: options.imported ?? new Map(),
    now: NOW,
  });
const fullIds = (carry: ReturnType<typeof plan>) => carry.full.map((r) => r.providerSessionId);

describe("which conversations a Codex launch carries", () => {
  it("in full: quiet six hours, under ten days old, newest first, a few at most", () => {
    const carry = plan([7, 8, 9, 10, 11, 12, 1, 24 * 11].map((hours, n) => revision(n, hours)));
    expect(fullIds(carry)).toEqual([id(0), id(1), id(2), id(3)]);
    expect(carry.full).toHaveLength(CODEX_CARRY_MAX_CONVERSATIONS);
  });

  it("counts a conversation by its latest revision: still active, it is not carried at all", () => {
    expect(fullIds(plan([revision(1, 30), revision(1, 2)]))).toEqual([]);
    expect(plan([revision(1, 30), revision(1, 8)]).full[0]?.capturedAt).toEqual(
      new Date(NOW - 8 * HOUR),
    );
  });

  it("only what Codex would summarise: an interactive source, memory not turned off", () => {
    const lines = new Map([
      ["/a", metaLine("exec")],
      ["/b", metaLine("cli", "disabled")],
      ["/c", metaLine("vscode")],
    ]);
    const carry = plan([revision(1, 8, "/a"), revision(2, 8, "/b"), revision(3, 8, "/c")], {
      lines,
    });
    expect(fullIds(carry)).toEqual([id(3)]);
    expect(codexWouldSummarise("not json")).toBe(false);
  });

  it("a summarised conversation goes as a stub at the summary's time; a later revision goes in full", () => {
    const summarisedAt = Math.floor((NOW - 30 * HOUR) / 1000);
    const summarised = new Map([
      [id(1), summarisedAt],
      [id(2), summarisedAt],
    ]);
    const carry = plan([revision(1, 30), revision(2, 30), revision(2, 8)], { summarised });
    expect(fullIds(carry)).toEqual([id(2)]);
    expect(carry.stubs).toEqual([
      { providerSessionId: id(1), firstLine: metaLine(), mtime: summarisedAt },
    ]);
  });

  it("a summary imported from another machine gets its stub from the imported line", () => {
    const carry = plan([], {
      summarised: new Map([[id(7), 1_700_000_000]]),
      imported: new Map([[id(7), metaLine()]]),
    });
    expect(carry.stubs.map((stub) => stub.providerSessionId)).toEqual([id(7)]);
  });
});

describe("rolloutPathOf", () => {
  it("names the rollout as Codex does, from its first line's start time", () => {
    expect(rolloutPathOf(metaLine(), id(1), new Date(NOW))).toBe(
      `.codex/sessions/2026/09/30/rollout-2026-09-30T08-00-00-${id(1)}.jsonl`,
    );
    expect(rolloutPathOf("not json", id(1), new Date(NOW))).toBe(
      `.codex/sessions/2026/10/02/rollout-2026-10-02T12-00-00-${id(1)}.jsonl`,
    );
  });
});

describe("Codex's summary database", () => {
  const withWal = (dir: string) => {
    const file = path.join(dir, "memories_1.sqlite");
    const db = new DatabaseSync(file);
    db.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0");
    db.exec(
      "create table stage1_outputs (thread_id text primary key, source_updated_at integer not null)",
    );
    db.prepare("insert into stage1_outputs values (?, ?)").run(id(4), 1234);
    // Copied while open: the row is in the write-ahead log, not the database file.
    const copy = {
      db: fs.readFileSync(file),
      wal: fs.readFileSync(`${file}-wal`),
    };
    db.close();
    return copy;
  };

  it("is stored as one file with its write-ahead log folded in, and read for what it summarised", async () => {
    const { db, wal } = withWal(scratch());
    const consolidated = await Effect.runPromise(consolidateCodexDatabase(db, wal));
    expect(consolidated).not.toBeNull();
    const read = await Effect.runPromise(summarisedThreads(consolidated));
    expect([...read]).toEqual([[id(4), 1234]]);
  });

  it("stores nothing for bytes that are not a database, and reads them as nothing summarised", async () => {
    expect(await Effect.runPromise(consolidateCodexDatabase(Buffer.from("torn"), null))).toBeNull();
    expect(await Effect.runPromise(summarisedThreads(Buffer.from("torn")))).toEqual(new Map());
    expect(await Effect.runPromise(summarisedThreads(null))).toEqual(new Map());
  });
});

describe("laying carried conversations down", () => {
  const files = async (dir: string, hoursAgo = 8) => {
    const transcript = path.join(dir, `transcript-${hoursAgo}.native`);
    fs.writeFileSync(transcript, `${metaLine()}\n{"type":"x","at":${hoursAgo}}\n`);
    return Effect.runPromise(
      prepareCarriedConversations({ full: [revision(5, hoursAgo, transcript)], stubs: [] }),
    );
  };

  it("on this machine: listed before it appears, its time kept, replaced only by a later revision", async () => {
    const dir = scratch();
    const home = path.join(dir, "home");
    const older = await files(dir, 30);
    expect(await Effect.runPromise(materializeCarriedConversations(home, older))).toEqual([
      { outcome: "written", id: id(5) },
    ]);
    const carried = path.join(home, older[0]?.path ?? "");
    expect(Math.round(fs.statSync(carried).mtimeMs / 1000)).toBe((NOW - 30 * HOUR) / 1000);
    expect(fs.readFileSync(path.join(home, CARRIED_TRANSCRIPTS), "utf8")).toBe(`${id(5)}\n`);
    expect(await Effect.runPromise(materializeCarriedConversations(home, older))).toEqual([
      { outcome: "present", id: id(5) },
    ]);
    const newer = await files(dir, 8);
    expect(await Effect.runPromise(materializeCarriedConversations(home, newer))).toEqual([
      { outcome: "written", id: id(5) },
    ]);
    expect(fs.readFileSync(carried, "utf8")).toContain('"at":8');
  });

  it("never touches or lists a conversation already in the home that Mend did not carry", async () => {
    const dir = scratch();
    const home = path.join(dir, "home");
    const carry = await files(dir);
    const own = path.join(home, carry[0]?.path ?? "");
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, "the session's own\n");
    expect(await Effect.runPromise(materializeCarriedConversations(home, carry))).toEqual([
      { outcome: "own", id: id(5) },
    ]);
    expect(fs.readFileSync(own, "utf8")).toBe("the session's own\n");
    expect(fs.existsSync(path.join(home, CARRIED_TRANSCRIPTS))).toBe(false);
    expect((await Effect.runPromise(locateLiveTranscript(home, "codex")))?.providerSessionId).toBe(
      id(5),
    );
  });

  it("in a workspace: the program does the same from staged files, and no lookup takes them", async () => {
    const dir = scratch();
    const home = path.join(dir, "home");
    const carry = await files(dir);
    const exec = carryConversationsExec(home, carry);
    for (const staged of exec.staged) {
      fs.mkdirSync(path.dirname(staged.path), { recursive: true });
      fs.writeFileSync(staged.path, staged.bytes);
    }
    const [command, ...args] = exec.argv;
    const run = spawnSync(command ?? "node", args, { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(parseCarryOutcomes(run.stdout)).toEqual([{ outcome: "written", id: id(5) }]);
    expect(fs.readdirSync(path.join(home, CARRIED_INCOMING))).toEqual([]);
    expect(await Effect.runPromise(locateLiveTranscript(home, "codex"))).toBeNull();
  });
});
