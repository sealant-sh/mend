import { PgClient } from "@effect/sql-pg";
import { ChangeId, SessionId, Sha } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
} from "../src/repos/agent-conversation.ts";
import { WorktreeChangesRepo, WorktreeChangesRepoLive } from "../src/repos/worktree-changes.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_inbox_row_facts_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(url.toString()) });
const reposLayer = Layer.mergeAll(AgentConversationRepoLive, WorktreeChangesRepoLive).pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const withRepos = <A, E>(
  effect: Effect.Effect<A, E, AgentConversationRepo | WorktreeChangesRepo | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const base = Sha.make("a".repeat(40));
const CHANGE = ChangeId.make("change-1");

/**
 * One worktree and its change, and three sessions in it: `talks` with a conversation whose items
 * were written out of order, `quiet` with none.
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)))
    yield* migration;
  yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES ('u-1', 'u-1', 'u-1@example.invalid', '2026-01-01T00:00:00Z')`;
  yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id)
    VALUES ('proj-1','fixture','/store/fixture/repo.git','main',(SELECT id FROM organizations LIMIT 1),'u-1')`;
  yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
    VALUES ('wt-1','proj-1','fixture','fixture','mend/fixture',${base})`;
  for (const id of ["talks", "quiet", "between"])
    yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status)
      VALUES (${id},'proj-1','wt-1','u-1','codex','fixture','mend/fixture',${base},'running')`;
  yield* sql`INSERT INTO worktree_changes (id,project_id,worktree_id,session_id,branch,base_sha)
    VALUES (${CHANGE},'proj-1','wt-1','talks','mend/fixture',${base})`;
  yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status)
    VALUES ('p-1','talks','ws-1','agent-protocol','codex','running')`;
  yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, author, input, status)
    VALUES ('t-1', 'talks', 'p-1', 1, 'u-1', 'go', 'running')`;
  // The command started first and was updated last (seq 3): it is what the agent touched last,
  // though the reply was created after it.
  const items = [
    ["i-reply", 2, "assistant-message", null],
    ["i-command", 3, "command-execution", "pnpm test"],
    ["i-read", 1, "reasoning", null],
  ] as const;
  for (const [id, seq, kind, title] of items)
    yield* sql`INSERT INTO agent_items (id, session_id, process_id, turn_id, seq, provider_item_id, provider_output_process_id, provider_output_seq, provider_event_index, kind, status, title)
      VALUES (${id}, 'talks', 'p-1', 't-1', ${seq}, ${id}, 'p-1', ${seq}, 0, ${kind}, 'in-progress', ${title})`;
  // A conversation between turns: its last turn ended, and its last item is the reply.
  yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status)
    VALUES ('p-2','between','ws-2','agent-protocol','codex','running')`;
  yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, author, input, status)
    VALUES ('t-2', 'between', 'p-2', 1, 'u-1', 'go', 'completed')`;
  yield* sql`INSERT INTO agent_items (id, session_id, process_id, turn_id, seq, provider_item_id, provider_output_process_id, provider_output_seq, provider_event_index, kind, status, title)
    VALUES ('i-done', 'between', 'p-2', 't-2', 1, 'i-done', 'p-2', 1, 0, 'assistant-message', 'completed', null)`;
  // Its older ask, answered after its turn was sent: the answer is the newest thing it did.
  yield* sql`UPDATE agent_turns SET created_at = '2026-11-20T10:00:00Z' WHERE id = 't-2'`;
  yield* sql`INSERT INTO agent_requests (id, session_id, process_id, turn_id, provider_request_id, kind, status, created_at, decided_at)
    VALUES ('r-2', 'between', 'p-2', 't-2', 'r-2', 'user-input', 'resolved', '2026-11-20T09:59:00Z', '2026-11-20T10:05:00Z')`;
});

describe.skipIf(postgres.skip)("what an inbox row knows without reading a worktree", () => {
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

  it("keeps a change's file count for its head, and never lets a count for an older head replace it", async () => {
    const counts = await withRepos(
      Effect.gen(function* () {
        const changes = yield* WorktreeChangesRepo;
        const countOf = () =>
          changes
            .annotationsForSessions([SessionId.make("talks")])
            .pipe(Effect.map((rows) => rows[0]?.fileCount));
        const uncounted = yield* countOf();
        const first = Sha.make("1".repeat(40));
        const second = Sha.make("2".repeat(40));
        yield* changes.refreshHead(CHANGE, first, SessionId.make("talks"));
        yield* changes.recordFileCount(CHANGE, first, 3);
        const counted = yield* countOf();
        // A newer checkpoint moves the head; the count for the older head lands after its own.
        yield* changes.refreshHead(CHANGE, second, SessionId.make("talks"));
        yield* changes.recordFileCount(CHANGE, second, 0);
        yield* changes.recordFileCount(CHANGE, first, 5);
        return { uncounted, counted, newest: yield* countOf() };
      }),
    );
    expect(counts).toEqual({ uncounted: null, counted: 3, newest: 0 });
  });

  it("reads each session's newest item while its turn runs, and nothing between turns or for a session with none", async () => {
    const newest = await withRepos(
      Effect.gen(function* () {
        return yield* (yield* AgentConversationRepo).newestItems([
          SessionId.make("talks"),
          SessionId.make("quiet"),
          SessionId.make("between"),
        ]);
      }),
    );
    expect(newest.map(({ sessionId, kind, title }) => ({ sessionId, kind, title }))).toEqual([
      { sessionId: "talks", kind: "command-execution", title: "pnpm test" },
    ]);
  });

  it("says whether a turn is open and when the newest turn or ask happened, and nothing for a session with neither", async () => {
    const facts = await withRepos(
      Effect.gen(function* () {
        return yield* (yield* AgentConversationRepo).inboxTurnFacts([
          SessionId.make("talks"),
          SessionId.make("quiet"),
          SessionId.make("between"),
        ]);
      }),
    );
    const byId = new Map(facts.map((fact) => [fact.sessionId, fact]));
    expect(byId.get(SessionId.make("talks"))?.turnOpen).toBe(true);
    expect(byId.get(SessionId.make("talks"))?.newestAt).toBeInstanceOf(Date);
    expect(byId.get(SessionId.make("between"))).toEqual({
      sessionId: "between",
      turnOpen: false,
      newestAt: new Date("2026-11-20T10:05:00Z"),
    });
    expect(byId.has(SessionId.make("quiet"))).toBe(false);
  });

  it("reads each session's first message Mend sent, not a turn the harness opened, and nothing for a session sent none", async () => {
    const first = await withRepos(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Each was sent "go", and before it, a turn the harness opened by itself. Last in this
        // file: these turns are newer than what the facts above read.
        yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, author, input, status, origin)
          VALUES ('t-2-harness', 'between', 'p-2', 0, null, 'background task ended', 'completed', 'harness')`;
        yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, author, input, status, origin)
          VALUES ('t-1-harness', 'talks', 'p-1', 0, null, 'woke up', 'completed', 'harness')`;
        return yield* (yield* AgentConversationRepo).firstMessages([
          SessionId.make("talks"),
          SessionId.make("quiet"),
          SessionId.make("between"),
        ]);
      }),
    );
    expect(first.toSorted((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: "between", input: "go" },
      { sessionId: "talks", input: "go" },
    ]);
  });

  it("reads a session's first messages Mend sent, oldest first and up to the count, not a turn the harness opened", async () => {
    const opening = await withRepos(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // After the harness's own turn (ordinal 0) and "go", two more, written out of order.
        yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, author, input, status)
          VALUES ('t-1-third', 'talks', 'p-1', 4, 'u-1', 'and the tests', 'completed')`;
        yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, author, input, status)
          VALUES ('t-1-second', 'talks', 'p-1', 3, 'u-1', 'fix the login loop', 'completed')`;
        const conversations = yield* AgentConversationRepo;
        return {
          two: yield* conversations.openingMessages(SessionId.make("talks"), 2),
          none: yield* conversations.openingMessages(SessionId.make("quiet"), 2),
        };
      }),
    );
    expect(opening).toEqual({ two: ["go", "fix the login loop"], none: [] });
  });
});
