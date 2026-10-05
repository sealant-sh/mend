import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { writeOpencodeDatabase } from "../test/opencode-db.ts";
import {
  OPENCODE_DATABASE,
  opencodeConversationOf,
  readOpencodeConversations,
  readOpencodeHome,
  readOpencodeLaunchSnapshot,
  snapshotOpencodeHome,
  writeOpencodeLaunchSnapshot,
} from "./opencode-state.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-opencode-state-"));
  dirs.push(dir);
  return dir;
};

const read = (bytes: Uint8Array) => Effect.runPromise(readOpencodeConversations(bytes, null));
const minute = 60_000;
const conversation = (id: string, createdAt: number, updatedAt = createdAt) => ({
  id,
  createdAt,
  updatedAt,
});

describe("reading opencode's database", () => {
  it("lists the top-level conversations started in the worktree, newest first", async () => {
    const file = writeOpencodeDatabase(path.join(tmp(), "opencode.db"), [
      { id: "ses_old", createdAt: 1_000, updatedAt: 2_000 },
      { id: "ses_new", createdAt: 3_000, updatedAt: 4_000 },
      // A subagent's conversation, and one opened in another directory, are not the session's.
      { id: "ses_child", createdAt: 3_500, parentId: "ses_new" },
      { id: "ses_elsewhere", createdAt: 3_600, directory: "/tmp" },
    ]);
    const conversations = await Effect.runPromise(
      readOpencodeConversations(new Uint8Array(fs.readFileSync(file)), null),
    );
    expect(conversations).toEqual([
      { id: "ses_new", createdAt: 3_000, updatedAt: 4_000 },
      { id: "ses_old", createdAt: 1_000, updatedAt: 2_000 },
    ]);
  });

  it("reads what is still only in the write-ahead log, as a capture holds the pair", async () => {
    const file = path.join(tmp(), "opencode.db");
    writeOpencodeDatabase(file, []);
    const live = new DatabaseSync(file);
    try {
      live.exec("pragma wal_autocheckpoint = 0");
      live
        .prepare(
          "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) " +
            "values ('ses_wal', 'global', 's', '/workspace/repo', 't', 'v', 5, 6)",
        )
        .run();
      const database = new Uint8Array(fs.readFileSync(file));
      const wal = new Uint8Array(fs.readFileSync(`${file}-wal`));
      expect(await Effect.runPromise(readOpencodeConversations(database, null))).toEqual([]);
      expect(await Effect.runPromise(readOpencodeConversations(database, wal))).toEqual([
        { id: "ses_wal", createdAt: 5, updatedAt: 6 },
      ]);
    } finally {
      live.close();
    }
  });

  it("reads an empty, corrupt or foreign database as no database at all", async () => {
    expect(await read(new Uint8Array())).toBeNull();
    expect(await read(new TextEncoder().encode("SQLite format 3\0 not really"))).toBeNull();
    const foreign = path.join(tmp(), "other.db");
    const db = new DatabaseSync(foreign);
    db.exec("create table something (id text)");
    db.close();
    expect(await read(new Uint8Array(fs.readFileSync(foreign)))).toBeNull();
    // A real database torn mid-page: its header survives, its pages do not.
    const real = writeOpencodeDatabase(
      path.join(tmp(), "opencode.db"),
      [{ id: "ses_1", createdAt: 1 }],
      {
        checkpoint: true,
      },
    );
    const bytes = new Uint8Array(fs.readFileSync(real));
    bytes.fill(0xff, 100, bytes.byteLength);
    expect(await read(bytes)).toBeNull();
  });

  it("reads a harness home's database only through plain files", async () => {
    const home = tmp();
    expect(await Effect.runPromise(readOpencodeHome(home))).toBeNull();
    const target = writeOpencodeDatabase(path.join(tmp(), "elsewhere.db"), [
      { id: "ses_1", createdAt: 1 },
    ]);
    fs.mkdirSync(path.dirname(path.join(home, OPENCODE_DATABASE)), { recursive: true });
    fs.symlinkSync(target, path.join(home, OPENCODE_DATABASE));
    expect(await Effect.runPromise(readOpencodeHome(home))).toBeNull();
    fs.rmSync(path.join(home, OPENCODE_DATABASE));
    writeOpencodeDatabase(path.join(home, OPENCODE_DATABASE), [{ id: "ses_1", createdAt: 1 }]);
    expect((await Effect.runPromise(readOpencodeHome(home)))?.map((c) => c.id)).toEqual(["ses_1"]);
  });
});

/** A span on Mend's clock; the conversations' own times are the executor's and never compared. */
const span = (
  startedAt: number,
  endedAt: number | null,
  atLaunch: ReadonlyArray<string> | null,
  providerSessionId: string | null = null,
) => ({ providerSessionId, startedAt, endedAt, atLaunch });

describe("which conversation an agent process held", () => {
  it("is the one a resume named, while the database still has it", () => {
    const agent = span(0, 10 * minute, ["ses_a"], "ses_a");
    expect(opencodeConversationOf([conversation("ses_a", -99 * minute)], agent, [], 0)).toBe(
      "ses_a",
    );
    // Gone from the database, with nothing new beside it: none.
    expect(
      opencodeConversationOf([conversation("ses_b", 1)], { ...agent, atLaunch: ["ses_b"] }, [], 0),
    ).toBeNull();
  });

  it("is the newest one its database did not hold when it launched, whatever the executor's clock said", () => {
    const agent = span(10 * minute, 20 * minute, ["ses_before"]);
    const conversations = [
      // Updated last, but there before the launch: another session's.
      conversation("ses_before", 5 * minute, 99 * minute),
      // The executor's clock is days off: no window would have held these.
      conversation("ses_first", -9_000 * minute, -8_999 * minute),
      conversation("ses_second", -8_998 * minute, -8_990 * minute),
    ];
    expect(opencodeConversationOf(conversations, agent, [], 30 * minute)).toBe("ses_second");
    // Without a snapshot, nothing it started is known: no guess.
    expect(
      opencodeConversationOf(conversations, span(10 * minute, 20 * minute, null), [], 30 * minute),
    ).toBeNull();
  });

  it("two sessions in one worktree, both stopped: each resumes its own, never the newer one", () => {
    // A ran, then B; B launched on the head capture A left, which held A's conversation.
    const a = span(0, 10 * minute, []);
    const b = span(11 * minute, 20 * minute, ["ses_a"]);
    const conversations = [
      conversation("ses_a", 1 * minute, 9 * minute),
      conversation("ses_b", 12 * minute, 19 * minute),
    ];
    expect(opencodeConversationOf(conversations, a, [b], 30 * minute)).toBe("ses_a");
    expect(opencodeConversationOf(conversations, b, [a], 30 * minute)).toBe("ses_b");
    // Once B's id is known, A never takes it.
    expect(
      opencodeConversationOf(
        [conversation("ses_b", 12 * minute, 19 * minute)],
        a,
        [span(11 * minute, 20 * minute, ["ses_a"], "ses_b")],
        30 * minute,
      ),
    ).toBeNull();
  });

  it("overlapping sessions in one worktree refuse rather than guess, with any clock skew", () => {
    // B launched while A ran, before A's conversation reached a capture: B's snapshot lacks it.
    const a = span(0, 20 * minute, []);
    const b = span(5 * minute, 15 * minute, []);
    // The executor clocks are minutes apart from each other and from Mend's; nothing reads them.
    const conversations = [
      conversation("ses_x", 90 * minute, 91 * minute),
      conversation("ses_y", -45 * minute, -44 * minute),
    ];
    expect(opencodeConversationOf(conversations, a, [b], 30 * minute)).toBeNull();
    expect(opencodeConversationOf(conversations, b, [a], 30 * minute)).toBeNull();
    // A conversation A started before B launched is in B's snapshot, and stays A's.
    const bAfter = span(5 * minute, 15 * minute, ["ses_a"]);
    const withOwn = [...conversations, conversation("ses_a", 2 * minute, 3 * minute)];
    expect(opencodeConversationOf(withOwn, a, [bAfter], 30 * minute)).toBe("ses_a");
    // A later process with no snapshot makes every new conversation ambiguous.
    expect(
      opencodeConversationOf(withOwn, a, [span(5 * minute, 15 * minute, null)], 30 * minute),
    ).toBeNull();
    // Still running (no recorded end) counts as running.
    expect(opencodeConversationOf(withOwn, b, [span(0, null, [])], 30 * minute)).toBeNull();
  });

  it("a resumed session that opened a new conversation in opencode is recorded on it at its next Stop", () => {
    const first = span(0, 10 * minute, [], "ses_old");
    const resumed = span(20 * minute, 30 * minute, ["ses_old"], "ses_old");
    const conversations = [
      conversation("ses_old", 1 * minute, 21 * minute),
      conversation("ses_new", 22 * minute, 29 * minute),
    ];
    expect(opencodeConversationOf(conversations, resumed, [first], 40 * minute)).toBe("ses_new");
    // Went back to the old one and worked there last: the old one.
    const backAgain = [
      conversation("ses_old", 1 * minute, 29 * minute),
      conversation("ses_new", 22 * minute, 23 * minute),
    ];
    expect(opencodeConversationOf(backAgain, resumed, [first], 40 * minute)).toBe("ses_old");
  });
});

describe("the launch snapshot", () => {
  it("lists a home's conversations, none before the first, null when unreadable, and keeps it", async () => {
    const home = tmp();
    expect(await Effect.runPromise(snapshotOpencodeHome(home))).toEqual([]);
    writeOpencodeDatabase(path.join(home, OPENCODE_DATABASE), [{ id: "ses_1", createdAt: 1 }]);
    expect(await Effect.runPromise(snapshotOpencodeHome(home))).toEqual(["ses_1"]);
    fs.rmSync(path.join(home, OPENCODE_DATABASE));
    fs.writeFileSync(path.join(home, OPENCODE_DATABASE), "not a database");
    expect(await Effect.runPromise(snapshotOpencodeHome(home))).toBeNull();
    const stateDir = path.join(tmp(), "processes", "p1");
    expect(await Effect.runPromise(readOpencodeLaunchSnapshot(stateDir))).toBeNull();
    await Effect.runPromise(writeOpencodeLaunchSnapshot(stateDir, ["ses_1", "ses_2"]));
    expect(await Effect.runPromise(readOpencodeLaunchSnapshot(stateDir))).toEqual([
      "ses_1",
      "ses_2",
    ]);
  });
});

describe("a write-ahead log that cannot be read (review 2026-10-04, round 3)", () => {
  it("leaves the database unread rather than read without its log", async () => {
    const home = tmp();
    const db = path.join(home, OPENCODE_DATABASE);
    writeOpencodeDatabase(db, [{ id: "ses_1", createdAt: 1 }]);
    // A log that is a directory, then one that cannot be opened: no answer either way.
    fs.mkdirSync(`${db}-wal`);
    expect(await Effect.runPromise(readOpencodeHome(home))).toBeNull();
    expect(await Effect.runPromise(snapshotOpencodeHome(home))).toBeNull();
    fs.rmdirSync(`${db}-wal`);
    fs.writeFileSync(`${db}-wal`, "");
    fs.chmodSync(`${db}-wal`, 0o000);
    try {
      if (process.getuid?.() !== 0) {
        expect(await Effect.runPromise(readOpencodeHome(home))).toBeNull();
        expect(await Effect.runPromise(snapshotOpencodeHome(home))).toBeNull();
      }
    } finally {
      fs.chmodSync(`${db}-wal`, 0o600);
    }
    // No log at all is the database read whole.
    fs.rmSync(`${db}-wal`);
    expect(await Effect.runPromise(snapshotOpencodeHome(home))).toEqual(["ses_1"]);
  });
});
