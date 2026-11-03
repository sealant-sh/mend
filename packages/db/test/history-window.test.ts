import { PgClient } from "@effect/sql-pg";
import { ProjectId, SessionId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
  type HistoryCursor,
  type HistoryWindow,
} from "../src/repos/agent-conversation.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_history_window_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(url.toString()) });
const reposLayer = Layer.mergeAll(AgentConversationRepoLive, SessionsRepoLive).pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const withRepos = <A, E>(
  effect: Effect.Effect<A, E, AgentConversationRepo | SessionsRepo | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const SESSION = SessionId.make("sess-1");
const sha = "a".repeat(40);

/**
 * A conversation of five turns of four items each, in time order (turn n's items at minute
 * 10n + i), a request in turn 2, and a sixth turn with no items yet: the newest end, as an agent
 * that has just been sent a message leaves it.
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)))
    yield* migration;
  yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES ('u-1', 'u-1', 'u-1@example.invalid', '2026-01-01T00:00:00Z')`;
  yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id)
    VALUES ('proj-1','fixture','/store/fixture/repo.git','main',(SELECT id FROM organizations LIMIT 1),'u-1')`;
  yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
    VALUES ('wt-1','proj-1','fixture','fixture','mend/fixture',${sha})`;
  yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status)
    VALUES ('sess-1','proj-1','wt-1','u-1','codex','fixture','mend/fixture',${sha},'waiting')`;
  yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status)
    VALUES ('p-1','sess-1','ws-1','agent-protocol','codex','running')`;
  for (let turn = 1; turn <= 6; turn += 1) {
    const at = new Date(Date.UTC(2026, 10, 2, 10, turn * 10));
    yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, author, input, status, created_at)
      VALUES (${`t-${turn}`}, 'sess-1', 'p-1', ${turn}, 'u-1', ${`turn ${turn}`}, 'completed', ${at})`;
    if (turn === 6) continue;
    for (let item = 1; item <= 4; item += 1)
      yield* sql`INSERT INTO agent_items (id, session_id, process_id, turn_id, seq, provider_item_id, provider_output_process_id, provider_output_seq, provider_event_index, kind, status, text, created_at, updated_at)
        VALUES (${`i-${turn}-${item}`}, 'sess-1', 'p-1', ${`t-${turn}`}, ${turn * 10 + item}, ${`pi-${turn}-${item}`}, 'p-1', ${turn * 10 + item}, 0, 'assistant-message', 'completed', 'x',
          ${new Date(at.getTime() + item * 1000)}, ${new Date(at.getTime() + item * 1000)})`;
  }
  yield* sql`INSERT INTO agent_requests (id, session_id, process_id, turn_id, kind, provider_request_id, title, status, created_at)
    VALUES ('r-2', 'sess-1', 'p-1', 't-2', 'command-approval', 'pr-2', 'pnpm test', 'pending', '2026-11-02T10:21:00Z')`;
});

describe.skipIf(postgres.skip)("a conversation's history, a window at a time", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
      }),
    );
    await withRepos(seed);
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(
          `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
        );
      }),
    );
  });

  it("reads the newest window first, then each older one by the cursor the newer gave, to the start", async () => {
    const windows = await withRepos(
      Effect.gen(function* () {
        const repo = yield* AgentConversationRepo;
        const read = [];
        let before: HistoryCursor | null = null;
        for (;;) {
          const window: HistoryWindow = yield* repo.historyWindow(SESSION, before, 6);
          const turns = yield* repo.turnsInRange(SESSION, window.range);
          const requests = yield* repo.requestsInRange(SESSION, window.range);
          read.push({
            items: window.items.map((item) => item.id),
            turns: turns.map((turn) => turn.ordinal),
            requests: requests.map((request) => request.id),
            feed: window.feed,
          });
          if (window.next === null) return read;
          before = window.next;
        }
      }),
    );
    // The newest window: turn 5's four items and turn 4's last two, oldest first, with turn 6
    // (no items yet) because it is newer than anything in the window.
    expect(windows[0]).toEqual({
      items: ["i-4-3", "i-4-4", "i-5-1", "i-5-2", "i-5-3", "i-5-4"],
      turns: [4, 5, 6],
      requests: [],
      feed: 54,
    });
    expect(windows[1]?.items).toEqual(["i-3-1", "i-3-2", "i-3-3", "i-3-4", "i-4-1", "i-4-2"]);
    expect(windows[1]?.turns).toEqual([3, 4]);
    expect(windows.at(-1)?.turns).toContain(1);
    const all = windows.flatMap((window) => window.items);
    expect(new Set(all).size).toBe(20);
    expect(windows.flatMap((window) => window.requests)).toEqual(["r-2"]);
  });

  it("lists every session not ended and only the newest ended ones in the inbox", async () => {
    const listed = await withRepos(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (let n = 1; n <= 5; n += 1)
          yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status,updated_at)
            VALUES (${`ended-${n}`},'proj-1','wt-1','u-1','codex','fixture','mend/fixture',${sha},'completed',${new Date(Date.UTC(2026, 9, n))})`;
        return yield* (yield* SessionsRepo).listForInbox([ProjectId.make("proj-1")], "u-1", 2);
      }),
    );
    expect(listed.map((session) => session.id).toSorted()).toEqual([
      "ended-4",
      "ended-5",
      "sess-1",
    ]);
  });

  it("lists every ended session still waiting for review, past the cap, unless the person settled it or it ended over a week ago", async () => {
    const listed = await withRepos(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const day = 24 * 60 * 60 * 1000;
        const daysAgo = (days: number) => new Date(Date.now() - days * day);
        // Ended sessions older than the newest ones, each in its own worktree with a change: 1-5
        // ended this week, 6 and 7 more than a week ago.
        for (const [n, status, ended] of [
          [1, "completed", daysAgo(3)],
          [2, "completed", daysAgo(3)],
          [3, "completed", daysAgo(3)],
          [4, "stopped", daysAgo(3)],
          [5, "stopped", daysAgo(2)],
          [6, "stopped", daysAgo(8)],
          [7, "stopped", daysAgo(9)],
        ] as const) {
          yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
            VALUES (${`wt-r${n}`},'proj-1',${`review-${n}`},${`review-${n}`},${`mend/review-${n}`},${sha})`;
          yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status,updated_at)
            VALUES (${`review-${n}`},'proj-1',${`wt-r${n}`},'u-1','codex',${`review-${n}`},${`mend/review-${n}`},${sha},${status},${ended})`;
          yield* sql`INSERT INTO worktree_changes (id,project_id,branch,base_sha,worktree_id)
            VALUES (${`change-r${n}`},'proj-1',${`mend/review-${n}`},${sha},${`wt-r${n}`})`;
        }
        // 2: reviewed (a comment); 3: settled by hand; 4: stopped, with a follow-up to send;
        // 7: ended more than a week ago, with a follow-up to send.
        yield* sql`INSERT INTO review_comments (id,change_id,author_kind,author_name,body)
          VALUES ('comment-r2','change-r2','person','u-1','looks right')`;
        yield* sql`INSERT INTO session_inbox_marks (user_id,session_id,state) VALUES ('u-1','review-3','settled')`;
        yield* sql`INSERT INTO follow_ups (id,session_id,change_id,instruction,status)
          VALUES ('follow-r4','review-4','change-r4','tighten the retry','pending')`;
        yield* sql`INSERT INTO follow_ups (id,session_id,change_id,instruction,status)
          VALUES ('follow-r7','review-7','change-r7','rename the flag','pending')`;
        // Newer ended sessions fill the cap of two.
        for (let n = 1; n <= 4; n += 1)
          yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status,updated_at)
            VALUES (${`newer-${n}`},'proj-1','wt-1','u-1','codex','fixture','mend/fixture',${sha},'completed',${new Date(Date.now() - n * 60_000)})`;
        return yield* (yield* SessionsRepo).listForInbox([ProjectId.make("proj-1")], "u-1", 2);
      }),
    );
    const ids = listed.map((session) => session.id);
    // Ended this week, completed or stopped, its change unreviewed: listed. A follow-up to send:
    // listed, however old.
    expect(ids).toContain("review-1");
    expect(ids).toContain("review-4");
    expect(ids).toContain("review-5");
    expect(ids).toContain("review-7");
    // An unreviewed change whose session ended more than a week ago has settled on its own.
    expect(ids).not.toContain("review-6");
    // Reviewed, or settled by hand: left to the cap, which newer sessions filled.
    expect(ids).not.toContain("review-2");
    expect(ids).not.toContain("review-3");
  });
});
