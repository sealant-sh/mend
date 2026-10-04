import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { writeOpencodeDatabase } from "../test/opencode-db.ts";
import {
  OPENCODE_CLOCK_SKEW_MS,
  OPENCODE_DATABASE,
  opencodeConversationOf,
  readOpencodeConversations,
  readOpencodeHome,
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

describe("which conversation an agent process held", () => {
  it("is the one a resume named, while the database still has it", () => {
    const agent = { providerSessionId: "ses_a", startedAt: 0, endedAt: 10 * minute };
    expect(opencodeConversationOf([conversation("ses_a", -99 * minute)], agent, [], 0)).toBe(
      "ses_a",
    );
    expect(opencodeConversationOf([conversation("ses_b", 1)], agent, [], 0)).toBeNull();
  });

  it("is the newest one started while it ran, within the clock skew", () => {
    const agent = { providerSessionId: null, startedAt: 10 * minute, endedAt: 20 * minute };
    const conversations = [
      conversation("ses_before", 5 * minute, 30 * minute),
      conversation("ses_first", 10 * minute + OPENCODE_CLOCK_SKEW_MS / 2 - minute, 12 * minute),
      conversation("ses_second", 15 * minute, 19 * minute),
      conversation("ses_after", 25 * minute),
    ];
    expect(opencodeConversationOf(conversations, agent, [], 99 * minute)).toBe("ses_second");
    expect(opencodeConversationOf([conversations[0]!], agent, [], 99 * minute)).toBeNull();
  });

  it("two sessions in one worktree, both stopped: each resumes its own, never the newer one", () => {
    // A ran first and B after it; the head capture after both holds both conversations, and B's
    // is the most recently updated: `--continue` would have opened B's for A.
    const a = { providerSessionId: null, startedAt: 0, endedAt: 10 * minute };
    const b = { providerSessionId: null, startedAt: 11 * minute, endedAt: 20 * minute };
    const conversations = [
      conversation("ses_a", 1 * minute, 9 * minute),
      conversation("ses_b", 12 * minute, 19 * minute),
    ];
    expect(opencodeConversationOf(conversations, a, [b], 30 * minute)).toBe("ses_a");
    expect(opencodeConversationOf(conversations, b, [a], 30 * minute)).toBe("ses_b");
    // Once B's id is known, A never takes it, even inside A's window.
    const late = [conversation("ses_b", 9 * minute, 19 * minute)];
    expect(
      opencodeConversationOf(late, a, [{ ...b, providerSessionId: "ses_b" }], 30 * minute),
    ).toBeNull();
  });

  it("a conversation started while another opencode process of the worktree ran is nobody's to guess", () => {
    const a = { providerSessionId: null, startedAt: 0, endedAt: 20 * minute };
    const b = { providerSessionId: null, startedAt: 5 * minute, endedAt: 15 * minute };
    const conversations = [conversation("ses_x", 6 * minute, 14 * minute)];
    expect(opencodeConversationOf(conversations, a, [b], 30 * minute)).toBeNull();
    expect(opencodeConversationOf(conversations, b, [a], 30 * minute)).toBeNull();
    // A's own conversation from before B started is still A's.
    const own = [...conversations, conversation("ses_a", 1 * minute, 2 * minute)];
    expect(opencodeConversationOf(own, a, [b], 30 * minute)).toBe("ses_a");
  });
});
