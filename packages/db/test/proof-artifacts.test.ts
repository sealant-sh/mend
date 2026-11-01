import { PgClient } from "@effect/sql-pg";
import {
  AgentTurnId,
  ChangeId,
  CheckpointId,
  ProofArtifactId,
  ProjectId,
  ScreenId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { ProofArtifact, ProofRef } from "@mend/domain/workbench";
import { Schema } from "effect";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { ProofArtifactsRepo, ProofArtifactsRepoLive } from "../src/repos/proof-artifacts.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_proof_test_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const reposLayer = Layer.mergeAll(ProofArtifactsRepoLive, SessionsRepoLive).pipe(
  Layer.provideMerge(
    MendDBLive.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
    ),
  ),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<A, E, ProofArtifactsRepo | SessionsRepo | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const PROJECT = ProjectId.make("p-pages");
const WORKTREE = WorktreeId.make("wt-pages");
const SESSION = SessionId.make("s-pages");
const OTHER = SessionId.make("s-pages-other");

const artifact = (id: string, recording = false) =>
  new ProofArtifact({
    id: ProofArtifactId.make(id),
    changeId: ChangeId.make("proof-change"),
    projectId: PROJECT,
    worktreeId: WORKTREE,
    sessionId: SESSION,
    turnId: AgentTurnId.make("proof-turn"),
    title: "Task board",
    caption: "Completed task",
    side: "after",
    source: {
      _tag: "Checkpoint",
      checkpointId: CheckpointId.make("checkpoint"),
      ordinal: 2,
      commit: Sha.make("abc"),
    },
    capture: recording
      ? { _tag: "Recording", screenId: ScreenId.make("screen"), fromSeq: 1 }
      : { _tag: "NotCaptured", kind: "screenshot", reason: "Missing test account" },
    launch: null,
    differences: null,
    observedFrom: new Date("2026-11-01T14:02:00Z"),
    observedTo: null,
    createdAt: new Date("2026-11-01T14:02:01Z"),
  });
describe.skipIf(postgres.skip)("proof artifacts in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'pages', '/store/p-pages/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-pages', 'wt-pages', 'mend/wt-pages', 'abc')`;
        for (const id of [SESSION, OTHER]) {
          yield* (yield* SessionsRepo).create({
            id,
            projectId: PROJECT,
            worktreeId: WORKTREE,
            harness: "claude",
            label: null,
            worktree: "wt-pages",
            branch: "mend/wt-pages",
            baseSha: Sha.make("abc"),
            baseRef: "main",
            contextSnapshotId: null,
            ownerUserId: "alice",
            origin: "mend",
          });
        }
        yield* sql`INSERT INTO worktree_changes (id, project_id, worktree_id, branch, base_sha) VALUES ('proof-change', ${PROJECT}, ${WORKTREE}, 'mend/wt-pages', 'abc')`;
        yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind) VALUES ('proof-process', ${SESSION}, 'workspace', 'agent-protocol')`;
        yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,status,input) VALUES ('proof-turn', ${SESSION}, 'proof-process', 1, 'running', 'Capture the board')`;
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("inserts one artifact and one feed item for a retried call, even concurrently", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* ProofArtifactsRepo;
        const first = yield* repo.insert(artifact("proof-one"), "call-one");
        const retry = yield* repo.insert(artifact("proof-ignored"), "call-one");
        expect(retry).toEqual(first);
        const copies = yield* Effect.all(
          [
            repo.insert(artifact("proof-race-a"), "race"),
            repo.insert(artifact("proof-race-b"), "race"),
          ],
          { concurrency: "unbounded" },
        );
        expect(copies[0]).toEqual(copies[1]);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          data: unknown;
        }>`SELECT data FROM agent_items WHERE provider_item_id = 'mend-proof:proof-one'`;
        expect(rows).toHaveLength(1);
        expect(Schema.decodeUnknownSync(ProofRef)(rows[0]?.data)).toMatchObject({
          artifactId: first.id,
          state: "not-captured",
          label: "Task board · after · checkpoint #2 · not captured · Missing test account",
        });
        expect(yield* repo.byId(first.id)).toEqual(first);
        expect((yield* repo.listForChange(first.changeId)).map((row) => row.id)).toContain(
          first.id,
        );
      }),
    );
  });

  it("settles a recording once and redelivers the same item with a later seq", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* ProofArtifactsRepo;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* repo.insert(artifact("proof-recording", true), "recording");
        const before = yield* sql<{
          id: string;
          seq: number;
        }>`SELECT id, seq FROM agent_items WHERE provider_item_id = 'mend-proof:proof-recording'`;
        const capture = {
          _tag: "Video",
          span: { screenId: ScreenId.make("screen"), fromSeq: 1, toSeq: 4 },
          media: { blobKey: "proof/video.mp4", mimeType: "video/mp4", bytes: 12, sha256: "digest" },
          durationMs: 1000,
          ending: "stopped",
        } satisfies Parameters<typeof repo.settleVideo>[1];
        const settled = yield* repo.settleVideo(first.id, capture);
        expect(settled?.capture).toEqual(capture);
        expect(settled?.observedTo).toBeInstanceOf(Date);
        expect(
          yield* repo.settleVideo(first.id, {
            _tag: "NotCaptured",
            kind: "video",
            reason: "late failure",
          }),
        ).toEqual(settled);
        const after = yield* sql<{
          id: string;
          seq: number;
          data: unknown;
        }>`SELECT id, seq, data FROM agent_items WHERE provider_item_id = 'mend-proof:proof-recording'`;
        expect(after).toHaveLength(1);
        expect(after[0]?.id).toEqual(before[0]?.id);
        expect(after[0]?.seq).toBeGreaterThan(before[0]?.seq ?? 0);
        expect(Schema.decodeUnknownSync(ProofRef)(after[0]?.data).state).toBe("stored");
        expect(yield* repo.settleVideo(ProofArtifactId.make("missing"), capture)).toBeNull();
      }),
    );
  });

  it("settles stale recordings at boot and updates their existing proof items", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* ProofArtifactsRepo;
        const sql = yield* SqlClient.SqlClient;
        const recording = yield* repo.insert(artifact("proof-stale", true), "stale");
        const settled = yield* repo.byId(ProofArtifactId.make("proof-recording"));
        yield* repo.settleStaleRecordings();
        expect((yield* repo.byId(recording.id))?.capture).toEqual({
          _tag: "NotCaptured",
          kind: "video",
          reason: "Mend restarted while recording",
        });
        expect(yield* repo.byId(ProofArtifactId.make("proof-recording"))).toEqual(settled);
        const rows = yield* sql<{
          data: unknown;
          status: string;
        }>`SELECT data, status FROM agent_items WHERE provider_item_id = 'mend-proof:proof-stale'`;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("completed");
        expect(Schema.decodeUnknownSync(ProofRef)(rows[0]?.data)).toMatchObject({
          artifactId: recording.id,
          state: "not-captured",
          label:
            "Task board · after · checkpoint #2 · not captured · Mend restarted while recording",
        });
        yield* repo.settleStaleRecordings();
        expect((yield* repo.byId(recording.id))?.capture._tag).toBe("NotCaptured");
      }),
    );
  });

  it("keeps artifacts after removing their session, then cascades with the change", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* ProofArtifactsRepo;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* repo.insert(artifact("proof-retained"), "retained");
        yield* sql`DELETE FROM agent_sessions WHERE id = ${SESSION}`;
        expect(yield* repo.byId(first.id)).toMatchObject({ sessionId: null, turnId: null });
        yield* sql`DELETE FROM worktrees WHERE id = ${WORKTREE}`;
        expect(yield* repo.byId(first.id)).toBeNull();
      }),
    );
  });
});
