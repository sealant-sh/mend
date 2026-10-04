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
  codexDatabaseHolds,
  codexWouldSummarise,
  consolidateCodexDatabase,
  materializeCarriedConversations,
  mergeCodexDatabases,
  parseCarryOutcomes,
  planCodexCarry,
  prepareCarriedConversations,
  readRolloutFacts,
  rolloutPathOf,
  summarisedThreads,
  type CodexRevision,
  CODEX_MEMORY_WITHHELD,
  CODEX_STATE_DATABASE,
  codexMemoryMayStayOn,
  withholdCodexThreadsExec,
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
    readonly modes?: ReadonlyMap<string, string>;
    readonly live?: ReadonlySet<string>;
  } = {},
) =>
  planCodexCarry({
    revisions,
    facts: new Map(
      revisions.map((r) => [
        r.transcriptPath,
        {
          firstLine: options.lines?.get(r.transcriptPath) ?? metaLine(),
          memoryMode: options.modes?.get(r.transcriptPath) ?? null,
        },
      ]),
    ),
    summarised: options.summarised ?? new Map(),
    imported: options.imported ?? new Map(),
    live: options.live ?? new Set(),
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
      modes: new Map([["/b", "disabled"]]),
    });
    expect(fullIds(carry)).toEqual([id(3)]);
    expect(codexWouldSummarise({ firstLine: "not json", memoryMode: null })).toBe(false);
  });

  it("memory turned off later in a conversation: no full copy, and no stub to turn it back on", () => {
    const summarisedAt = Math.floor((NOW - 30 * HOUR) / 1000);
    const carry = plan([revision(1, 8, "/later-off"), revision(2, 30, "/summarised-off")], {
      summarised: new Map([[id(2), summarisedAt]]),
      modes: new Map([
        ["/later-off", "disabled"],
        ["/summarised-off", "polluted"],
      ]),
    });
    expect(fullIds(carry)).toEqual([]);
    expect(carry.stubs).toEqual([]);
  });

  it("a conversation an agent holds right now is never carried in full", () => {
    expect(fullIds(plan([revision(1, 8)], { live: new Set([id(1)]) }))).toEqual([]);
  });

  it("a summarised conversation goes as a stub at the summary's time; a later revision goes in full", () => {
    const summarisedAt = Math.floor((NOW - 30 * HOUR) / 1000);
    const summarised = new Map([
      [id(1), summarisedAt],
      [id(2), summarisedAt],
    ]);
    const carry = plan([revision(1, 30), revision(2, 30), revision(2, 8)], { summarised });
    expect(fullIds(carry)).toEqual([id(2)]);
    // Every summarised one has a stub ready; preparing drops the stubs of those laid down in full.
    expect(carry.stubs.map((stub) => stub.providerSessionId)).toEqual([id(1), id(2)]);
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

/** Whether `current` holds every summary of `version`. */
const holds = (current: Uint8Array, version: Uint8Array) =>
  Effect.runPromise(codexDatabaseHolds({ current, version }));

/** A summary database with `rows` of (thread, revision, summary), and `extra` columns. */
const summaryDatabase = (
  rows: ReadonlyArray<readonly [string, number | string, string]>,
  extra = "",
) => {
  const file = path.join(scratch(), "memories_1.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    `create table stage1_outputs (thread_id text primary key, source_updated_at integer not null, raw_memory text not null${extra})`,
  );
  const insert = db.prepare(
    `insert into stage1_outputs values (?, ?, ?${extra === "" ? "" : ", null"})`,
  );
  for (const row of rows) insert.run(...row);
  db.close();
  return new Uint8Array(fs.readFileSync(file));
};

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

  it("reads summaries in Codex's own order of preference", async () => {
    const file = path.join(scratch(), "memories_1.sqlite");
    const db = new DatabaseSync(file);
    db.exec(
      "create table stage1_outputs (thread_id text primary key, source_updated_at integer not null, usage_count integer, last_usage integer)",
    );
    const row = db.prepare("insert into stage1_outputs values (?, ?, ?, ?)");
    row.run(id(1), 100, 0, null);
    row.run(id(2), 50, 5, 60);
    row.run(id(3), 200, 0, null);
    db.close();
    const read = await Effect.runPromise(summarisedThreads(fs.readFileSync(file)));
    expect([...read.keys()]).toEqual([id(2), id(3), id(1)]);
  });

  it("merges an imported database by conversation: the newer summary of each, from either", async () => {
    const ours = summaryDatabase([
      [id(1), 100, "mend's only"],
      [id(2), 300, "mend's newer"],
      [id(3), 100, "mend's older"],
    ]);
    const theirs = summaryDatabase([
      [id(2), 200, "laptop's older"],
      [id(3), 200, "laptop's newer"],
      [id(4), 100, "laptop's only"],
    ]);
    const merged = await Effect.runPromise(mergeCodexDatabases({ ours, theirs }));
    if (merged === null) throw new Error("the two merge");
    const file = path.join(scratch(), "merged.sqlite");
    fs.writeFileSync(file, merged);
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare("select thread_id, raw_memory from stage1_outputs order by thread_id")
      .all()
      .map((row) => [row["thread_id"], row["raw_memory"]]);
    db.close();
    expect(rows).toEqual([
      [id(1), "mend's only"],
      [id(2), "mend's newer"],
      [id(3), "laptop's newer"],
      [id(4), "laptop's only"],
    ]);
    // Another Codex's columns, or bytes that are not a database: not merged.
    const other = summaryDatabase([[id(5), 1, "x"]], ", usage_count integer");
    expect(await Effect.runPromise(mergeCodexDatabases({ ours, theirs: other }))).toBeNull();
    expect(
      await Effect.runPromise(mergeCodexDatabases({ ours, theirs: Buffer.from("torn") })),
    ).toBeNull();
  });

  // Review round 3, invariant C: a replaced summary database is pinned unless the new one holds
  // every summary it held, at the same revision or newer.
  it("says whether one database holds every summary of another", async () => {
    const older = summaryDatabase([
      [id(1), 100, "one"],
      [id(2), 100, "two"],
    ]);
    const newer = summaryDatabase([
      [id(1), 200, "one, again"],
      [id(2), 100, "two"],
      [id(3), 100, "three"],
    ]);
    const missing = summaryDatabase([[id(1), 200, "one, again"]]);
    expect(await holds(newer, older)).toBe(true);
    expect(await holds(older, newer)).toBe(false);
    expect(await holds(missing, older)).toBe(false);
    expect(await holds(newer, Buffer.from("torn"))).toBe(false);
  });

  // Review round 4, finding 1 (reproduced): two databases with conversation t at revision 100 and
  // other words. The merge kept the store's and the check called the machine's held, so its
  // summary sat in an unpinned version.
  it("neither merges nor counts as held a summary with other words at the same revision", async () => {
    const mend = summaryDatabase([[id(1), 100, "mend's words"]]);
    const laptop = summaryDatabase([[id(1), 100, "laptop's words"]]);
    expect(await Effect.runPromise(mergeCodexDatabases({ ours: mend, theirs: laptop }))).toBeNull();
    expect(await holds(mend, laptop)).toBe(false);
    // The same words at the same revision, in another file: held.
    expect(await holds(mend, summaryDatabase([[id(1), 100, "mend's words"]]))).toBe(true);
  });

  // Review round 4, finding 3 (reproduced): a revision that is not a number read as NaN, and
  // every comparison with NaN is false, so a missing row or a corrupt database counted as held.
  it("does not count a missing row, an invalid revision or an unreadable database as held", async () => {
    const version = summaryDatabase([[id(1), 100, "one"]]);
    expect(await holds(summaryDatabase([[id(2), 100, "two"]]), version)).toBe(false);
    const unknown = summaryDatabase([[id(1), "unknown", "one"]]);
    expect(await holds(unknown, version)).toBe(false);
    expect(await holds(version, unknown)).toBe(false);
    expect(await holds(Buffer.from("torn"), version)).toBe(false);
    expect(
      await Effect.runPromise(mergeCodexDatabases({ ours: version, theirs: unknown })),
    ).toBeNull();
  });

  it("stores nothing for bytes that are not a database, and reads them as nothing summarised", async () => {
    expect(await Effect.runPromise(consolidateCodexDatabase(Buffer.from("torn"), null))).toBeNull();
    expect(await Effect.runPromise(summarisedThreads(Buffer.from("torn")))).toEqual(new Map());
    expect(await Effect.runPromise(summarisedThreads(null))).toEqual(new Map());
  });
});

describe("preparing a carry", () => {
  it("a full rollout that cannot be prepared keeps its stub", async () => {
    const dir = scratch();
    const missing = path.join(dir, "gone.native");
    const files = await Effect.runPromise(
      prepareCarriedConversations({
        full: [revision(1, 8, missing)],
        stubs: [{ providerSessionId: id(1), firstLine: metaLine(), mtime: 1_700_000_000 }],
      }),
    );
    expect(files.map((file) => [file.providerSessionId, file.mtime])).toEqual([
      [id(1), 1_700_000_000],
    ]);
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

describe("readRolloutFacts", () => {
  it("takes the memory mode from the last session_meta line that names one, as Codex does", async () => {
    const file = path.join(scratch(), "rollout.jsonl");
    fs.writeFileSync(
      file,
      [metaLine(), '{"type":"x"}', metaLine("cli", "disabled"), '{"type":"y"}', ""].join("\n"),
    );
    expect(await Effect.runPromise(readRolloutFacts(file))).toEqual({
      firstLine: metaLine(),
      memoryMode: "disabled",
    });
    expect(await Effect.runPromise(readRolloutFacts(path.join(scratch(), "none")))).toBeNull();
  });
});

const runWithhold = (home: string, own: ReadonlyArray<string>) => {
  const [, , script, ...args] = withholdCodexThreadsExec(home, own);
  return spawnSync("sh", ["-c", script ?? "", ...args], { encoding: "utf8" });
};
const threadModes = (home: string) => {
  const db = new DatabaseSync(path.join(home, CODEX_STATE_DATABASE), { readOnly: true });
  const rows = db.prepare("SELECT id, memory_mode FROM threads ORDER BY id").all();
  db.close();
  return Object.fromEntries(rows.map((row) => [String(row["id"]), String(row["memory_mode"])]));
};

describe("other people's conversations in a capture-mode home (docs/adr/0009, Codex)", () => {
  const OWN = "11111111-1111-4111-8111-111111111111";
  const THEIRS = "22222222-2222-4222-8222-222222222222";
  const THEY_CHOSE = "33333333-3333-4333-8333-333333333333";
  const OWN_WITHHELD = "44444444-4444-4444-8444-444444444444";
  const OWN_CHOSE = "55555555-5555-4555-8555-555555555555";
  it("takes every thread that is not the launcher's out of Codex's memory, gives back only what it took, through the write-ahead log", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-withhold-"));
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const db = new DatabaseSync(path.join(home, CODEX_STATE_DATABASE));
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, memory_mode TEXT NOT NULL DEFAULT 'enabled')",
    );
    const insert = db.prepare("INSERT INTO threads (id, memory_mode) VALUES (?, ?)");
    insert.run(OWN, "enabled");
    insert.run(THEIRS, "enabled");
    insert.run(THEY_CHOSE, "disabled");
    insert.run(OWN_WITHHELD, "disabled");
    insert.run(OWN_CHOSE, "disabled");
    // Held open, as a Codex in a joined executor would: the change goes through SQLite's locking.
    fs.mkdirSync(path.join(home, ".mend"), { recursive: true });
    fs.writeFileSync(path.join(home, CODEX_MEMORY_WITHHELD), JSON.stringify([OWN_WITHHELD]));

    const result = runWithhold(home, [OWN, OWN_WITHHELD, OWN_CHOSE]);
    expect(result.status).toBe(0);
    expect(codexMemoryMayStayOn(result.status ?? -1, result.stdout)).toBe(true);
    expect(result.stdout.trim()).toBe("withheld 1 restored 1");
    db.close();
    expect(threadModes(home)).toEqual({
      [OWN]: "enabled",
      [THEIRS]: "disabled",
      // A mode a person chose is theirs: neither taken nor given back.
      [THEY_CHOSE]: "disabled",
      [OWN_WITHHELD]: "enabled",
      [OWN_CHOSE]: "disabled",
    });
    expect(JSON.parse(fs.readFileSync(path.join(home, CODEX_MEMORY_WITHHELD), "utf8"))).toEqual([
      THEIRS,
    ]);

    // The other person launches next: theirs comes back, the first launcher's goes out.
    const next = runWithhold(home, [THEIRS]);
    expect(next.stdout.trim()).toBe("withheld 2 restored 1");
    expect(threadModes(home)[THEIRS]).toBe("enabled");
    expect(threadModes(home)[OWN]).toBe("disabled");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("with no state database yet, Codex's memory goes off when another person's rollout is in the home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-withhold-"));
    const day = path.join(home, ".codex", "sessions", "2026", "10", "05");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, `rollout-2026-10-05T10-00-00-${OWN}.jsonl`), "{}\n");
    const clean = runWithhold(home, [OWN]);
    expect(clean.stdout.trim()).toBe("clean");
    expect(codexMemoryMayStayOn(clean.status ?? -1, clean.stdout)).toBe(true);
    fs.writeFileSync(path.join(day, `rollout-2026-10-05T11-00-00-${THEIRS}.jsonl`), "{}\n");
    const theirs = runWithhold(home, [OWN]);
    expect(theirs.stdout).toContain("memory-off");
    expect(codexMemoryMayStayOn(theirs.status ?? -1, theirs.stdout)).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("anything else turns Codex's memory off: no node, no node:sqlite, a failure", () => {
    expect(codexMemoryMayStayOn(127, "")).toBe(false);
    expect(codexMemoryMayStayOn(3, "")).toBe(false);
    expect(codexMemoryMayStayOn(1, "withheld 1 restored 0")).toBe(false);
  });
});
