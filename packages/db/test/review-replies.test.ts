import { PgClient } from "@effect/sql-pg";
import { ChangeId, ReviewCommentId, SessionId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { FollowUpsRepo, FollowUpsRepoLive } from "../src/repos/follow-ups.ts";
import { ReviewCommentsRepo, ReviewCommentsRepoLive } from "../src/repos/review-comments.ts";
import { WorktreeChangesRepo, WorktreeChangesRepoLive } from "../src/repos/worktree-changes.ts";
import { postgresTestConfig } from "./postgres.ts";

/**
 * Second look (SLNT-1176) in storage: 0232 leaves every existing comment a comment and fills in who
 * sent each earlier follow-up from the turn it started; replies hang under their comment and are
 * never listed as comments; a person's last review is the newest follow-up they sent.
 */
const postgres = postgresTestConfig();
const database = `mend_review_replies_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(url.toString()) });
const reposLayer = Layer.mergeAll(
  ReviewCommentsRepoLive,
  FollowUpsRepoLive,
  WorktreeChangesRepoLive,
).pipe(Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))));
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const withRepos = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ReviewCommentsRepo | FollowUpsRepo | WorktreeChangesRepo | SqlClient.SqlClient
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const MIGRATION = "0232_review_replies";
const CHANGE = ChangeId.make("change-1");
const sha = "a".repeat(40);

/** A server as it stood before 0232: one comment, a send that started a turn, one that didn't. */
const seedBefore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
  for (const [name, migration] of ordered) if (name < MIGRATION) yield* migration;
  yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
    VALUES ('u-1', 'Ada', 'ada@example.invalid', '2026-01-01T00:00:00Z')`;
  yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id)
    VALUES ('proj-1','fixture','/store/fixture/repo.git','main',(SELECT id FROM organizations LIMIT 1),'u-1')`;
  yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
    VALUES ('wt-1','proj-1','fixture','fixture','mend/fixture',${sha})`;
  yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status)
    VALUES ('sess-1','proj-1','wt-1','u-1','claude','fixture','mend/fixture',${sha},'waiting')`;
  yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status)
    VALUES ('p-1','sess-1','ws-1','agent-protocol','claude','running')`;
  yield* sql`INSERT INTO worktree_changes (id,project_id,branch,base_sha,worktree_id)
    VALUES ('change-1','proj-1','mend/fixture',${sha},'wt-1')`;
  for (const ordinal of [7, 8]) {
    yield* sql`INSERT INTO checkpoints (id,worktree_id,ordinal,ref,sha,trigger)
      VALUES (${`cp-${ordinal}`},'wt-1',${ordinal},${`refs/mend/checkpoints/wt-1/${ordinal}`},${sha},'turn-boundary')`;
  }
  yield* sql`INSERT INTO review_comments (id,change_id,file,line,author_kind,author_name,body,created_at)
    VALUES ('c-1','change-1','src/retry.ts',31,'reviewer','Ada','Should we back off on a 409 too?',
      '2026-11-19T10:15:00Z')`;
  // Sent at checkpoint 7 and answered in turn 4; then a send to a terminal agent, no turn.
  yield* sql`INSERT INTO follow_ups (id,session_id,change_id,checkpoint_b_id,comment_ids,instruction,status,created_at)
    VALUES ('f-1','sess-1','change-1','cp-7','["c-1"]'::jsonb,'Review comments…','delivered',
      '2026-11-19T10:20:00Z')`;
  yield* sql`INSERT INTO follow_ups (id,session_id,change_id,checkpoint_b_id,comment_ids,instruction,status,created_at)
    VALUES ('f-2','sess-1','change-1','cp-8','[]'::jsonb,'Review comments…','delivered',
      '2026-11-19T10:25:00Z')`;
  yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,author,input,status,launch_correlation_id,created_at,started_at,ended_at)
    VALUES ('t-4','sess-1','p-1',4,'u-1','Review comments…','completed','follow-up:f-1',
      '2026-11-19T10:20:01Z','2026-11-19T10:20:02Z','2026-11-19T10:23:00Z')`;
  for (const [seq, text] of [
    [1, "Looking at retry.ts."],
    [2, "Yes. A 409 now backs off like a 503."],
  ] as const) {
    yield* sql`INSERT INTO agent_items (id, session_id, process_id, turn_id, seq, provider_item_id, provider_output_process_id, provider_output_seq, provider_event_index, kind, status, text)
      VALUES (${`i-${seq}`}, 'sess-1', 'p-1', 't-4', ${seq}, ${`pi-${seq}`}, 'p-1', ${seq}, 0, 'assistant-message', 'completed', ${text})`;
  }
  yield* migrations[MIGRATION];
});

describe.skipIf(postgres.skip)("review replies and last reviews in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)),
    );
    await withRepos(seedBefore);
  }, 120_000);
  afterAll(async () => {
    await withAdmin(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
      ),
    );
  }, 60_000);

  it("reads an existing comment exactly as before, with no parent", async () => {
    const comments = await withRepos(
      Effect.flatMap(ReviewCommentsRepo, (repo) => repo.listForChange(CHANGE)),
    );
    expect(comments).toEqual([
      expect.objectContaining({
        id: "c-1",
        file: "src/retry.ts",
        line: 31,
        body: "Should we back off on a 409 too?",
        state: "open",
        parentId: null,
      }),
    ]);
  });

  it("takes an earlier follow-up's sender from the turn it started, and leaves the rest unknown", async () => {
    const sentBy = await withRepos(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly id: string; readonly requested_by: string | null }>`
          SELECT id, requested_by FROM follow_ups ORDER BY id`,
      ),
    );
    expect(sentBy.map((row) => [row.id, row.requested_by])).toEqual([
      ["f-1", "u-1"],
      ["f-2", null],
    ]);
  });

  it("names the checkpoint of the newest follow-up a person sent as their last review", async () => {
    const last = await withRepos(
      Effect.flatMap(FollowUpsRepo, (repo) =>
        Effect.all([repo.lastSentBy(CHANGE, "u-1"), repo.lastSentBy(CHANGE, "u-2")]),
      ),
    );
    expect(last).toEqual([
      { followUpId: "f-1", checkpointBId: "cp-7", sentAt: new Date("2026-11-19T10:20:00Z") },
      null,
    ]);
  });

  it("lists each follow-up that started a turn with the turn's last message", async () => {
    const turns = await withRepos(
      Effect.flatMap(FollowUpsRepo, (repo) => repo.turnsForChange(CHANGE)),
    );
    expect(turns).toEqual([
      expect.objectContaining({
        followUp: expect.objectContaining({ id: "f-1", commentIds: ["c-1"] }),
        harness: "claude",
        ordinal: 4,
        status: "completed",
        lastMessage: "Yes. A 409 now backs off like a 503.",
      }),
    ]);
  });

  it("keeps a reply under its comment, never among the comments or their counts", async () => {
    const [comments, replies, annotations] = await withRepos(
      Effect.gen(function* () {
        const repo = yield* ReviewCommentsRepo;
        const parent = yield* repo.byId(ReviewCommentId.make("c-1"));
        yield* repo.createReply(parent, { authorName: "Grace", body: "Run the refund tests too." });
        return [
          yield* repo.listForChange(CHANGE),
          yield* repo.listReplies(CHANGE),
          yield* (yield* WorktreeChangesRepo).annotationsForSessions([SessionId.make("sess-1")]),
        ] as const;
      }),
    );
    expect(comments.map((comment) => comment.id)).toEqual(["c-1"]);
    // The session's open comments, as the inbox and the CLI count them: still the one comment.
    expect(annotations).toEqual([expect.objectContaining({ openComments: 1, totalComments: 1 })]);
    expect(replies).toEqual([
      expect.objectContaining({
        parentId: "c-1",
        authorName: "Grace",
        body: "Run the refund tests too.",
        state: "open",
        sentToSessionId: null,
        file: "src/retry.ts",
        line: 31,
      }),
    ]);
  });
});
