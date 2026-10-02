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
  materializeCarriedConversations,
  parseCarryOutcomes,
  planCarriedConversations,
  prepareCarriedConversations,
  rolloutPathOf,
  summarisedThreads,
  type CodexConversation,
} from "./codex-memory.ts";
import { CARRIED_TRANSCRIPTS, locateLiveTranscript } from "./harness-state.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const id = (n: number) => `0000000${n}-1111-2222-3333-444444444444`;
const conversation = (n: number, hoursAgo: number, transcriptPath = ""): CodexConversation => ({
  providerSessionId: id(n),
  transcriptPath,
  capturedAt: new Date(NOW - hoursAgo * HOUR),
});
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "mend-codex-memory-test-"));

describe("planCarriedConversations", () => {
  it("takes conversations Codex would summarise: quiet six hours, under ten days old", () => {
    const planned = planCarriedConversations({
      conversations: [conversation(1, 1), conversation(2, 7), conversation(3, 24 * 11)],
      summarised: new Set(),
      alreadyCarried: new Set(),
      now: NOW,
    });
    expect(planned.map((c) => c.providerSessionId)).toEqual([id(2)]);
  });

  it("skips what Codex already summarised or the home already holds; newest first, a few at most", () => {
    const planned = planCarriedConversations({
      conversations: [7, 8, 9, 10, 11, 12, 13].map((hours, index) => conversation(index, hours)),
      summarised: new Set([id(0)]),
      alreadyCarried: new Set([id(1)]),
      now: NOW,
    });
    expect(planned.map((c) => c.providerSessionId)).toEqual([id(2), id(3), id(4), id(5)]);
    expect(planned).toHaveLength(CODEX_CARRY_MAX_CONVERSATIONS);
  });
});

describe("rolloutPathOf", () => {
  it("names the rollout as Codex does, from its first line's start time", () => {
    const first = JSON.stringify({
      timestamp: "2026-09-30T14:02:11.500Z",
      type: "session_meta",
      payload: { id: id(1), timestamp: "2026-09-30T14:02:11.000Z" },
    });
    expect(rolloutPathOf(first, id(1), new Date(NOW))).toBe(
      `.codex/sessions/2026/09/30/rollout-2026-09-30T14-02-11-${id(1)}.jsonl`,
    );
  });

  it("falls back to the harvest time when the first line is not readable", () => {
    expect(rolloutPathOf("not json", id(1), new Date(NOW))).toBe(
      `.codex/sessions/2026/10/02/rollout-2026-10-02T12-00-00-${id(1)}.jsonl`,
    );
  });
});

describe("summarisedThreads", () => {
  it("reads the thread ids Codex summarised from the stored database", async () => {
    const dir = scratch();
    const file = path.join(dir, "memories_1.sqlite");
    const db = new DatabaseSync(file);
    db.exec(
      "create table stage1_outputs (thread_id text primary key, source_updated_at integer not null, raw_memory text not null)",
    );
    db.prepare("insert into stage1_outputs values (?, 1, 'x')").run(id(4));
    db.close();
    const ids = await Effect.runPromise(
      summarisedThreads({ db: fs.readFileSync(file), wal: null }),
    );
    expect([...ids]).toEqual([id(4)]);
    expect(
      await Effect.runPromise(summarisedThreads({ db: Buffer.from("not sqlite"), wal: null })),
    ).toEqual(new Set());
    expect(await Effect.runPromise(summarisedThreads({ db: null, wal: null }))).toEqual(new Set());
  });
});

describe("laying carried conversations down", () => {
  const prepared = async (dir: string) => {
    const transcript = path.join(dir, "transcript.native");
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: "session_meta", payload: { timestamp: "2026-09-30T08:00:00Z" } })}\n{"type":"x"}\n`,
    );
    return Effect.runPromise(prepareCarriedConversations([conversation(5, 8, transcript)]));
  };

  it("on this machine: listed first, written once, with its harvest time, never the newest", async () => {
    const dir = scratch();
    const home = path.join(dir, "home");
    const own = path.join(
      home,
      `.codex/sessions/2026/10/02/rollout-2026-10-02T11-59-00-${id(9)}.jsonl`,
    );
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, "{}\n");
    const files = await prepared(dir);
    expect(await Effect.runPromise(materializeCarriedConversations(home, files))).toEqual([
      { outcome: "written", id: id(5) },
    ]);
    const carried = path.join(home, files[0]?.path ?? "");
    expect(fs.readFileSync(carried, "utf8")).toContain('{"type":"x"}');
    expect(Math.round(fs.statSync(carried).mtimeMs / 1000)).toBe((NOW - 8 * HOUR) / 1000);
    expect(fs.readFileSync(path.join(home, CARRIED_TRANSCRIPTS), "utf8")).toBe(`${id(5)}\n`);
    // A second carry finds it there and leaves it.
    expect(await Effect.runPromise(materializeCarriedConversations(home, files))).toEqual([
      { outcome: "present", id: id(5) },
    ]);
    // The session's own conversation is still the one every lookup finds, even when the carried
    // one is made newer.
    fs.utimesSync(carried, new Date(), new Date(Date.now() + HOUR));
    expect((await Effect.runPromise(locateLiveTranscript(home, "codex")))?.providerSessionId).toBe(
      id(9),
    );
  });

  it("in a workspace: the program lays them down from the staged files", async () => {
    const dir = scratch();
    const home = path.join(dir, "home");
    const files = await prepared(dir);
    const carry = carryConversationsExec(home, files);
    for (const staged of carry.staged) {
      fs.mkdirSync(path.dirname(staged.path), { recursive: true });
      fs.writeFileSync(staged.path, staged.bytes);
    }
    const [command, ...args] = carry.argv;
    const run = spawnSync(command ?? "node", args, { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(parseCarryOutcomes(run.stdout)).toEqual([{ outcome: "written", id: id(5) }]);
    expect(fs.readFileSync(path.join(home, files[0]?.path ?? ""), "utf8")).toContain(
      '{"type":"x"}',
    );
    expect(fs.readFileSync(path.join(home, CARRIED_TRANSCRIPTS), "utf8")).toBe(`${id(5)}\n`);
    expect(fs.readdirSync(path.join(home, CARRIED_INCOMING))).toEqual([]);
    // With nothing of its own, the session has no conversation: a carried one is never taken.
    expect(await Effect.runPromise(locateLiveTranscript(home, "codex"))).toBeNull();
  });
});
