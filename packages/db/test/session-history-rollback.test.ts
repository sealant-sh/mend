import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  AgentTurnId,
  CheckpointId,
  SessionId,
  SessionProcessId,
  Sha,
  SealantRunId,
} from "@mend/domain";
import {
  NativeSeedId,
  TurnBoundaryId,
  RollbackRecoveryId,
  type RollbackProgress,
  type RollbackOperation,
  type RollbackRequest,
} from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
} from "../src/repos/agent-conversation.ts";
import { HarnessLayoutsRepo, HarnessLayoutsRepoLive } from "../src/repos/harness-layouts.ts";
import { HistoryWorkerContext } from "../src/repos/history-fence.ts";
import { RemovalFencesRepo, RemovalFencesRepoLive } from "../src/repos/removal-fences.ts";
import { SessionHistoryRepo, SessionHistoryRepoLive } from "../src/repos/session-history.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_rollback_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const connection = PgClient.layer({ url: Redacted.make(url.toString()) });
const layer = Layer.mergeAll(
  SessionHistoryRepoLive,
  RemovalFencesRepoLive,
  HarnessLayoutsRepoLive,
  AgentConversationRepoLive.pipe(Layer.provide(MendDBLive)),
).pipe(Layer.provideMerge(connection));
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | SessionHistoryRepo
    | HarnessLayoutsRepo
    | RemovalFencesRepo
    | AgentConversationRepo
    | SqlClient.SqlClient
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
const head = Sha.make("a".repeat(40));
const session = SessionId.make("source");
const request: RollbackRequest = {
  sessionId: session,
  at: {
    checkpointId: CheckpointId.make("checkpoint"),
    boundaryId: TurnBoundaryId.make("boundary"),
  },
  expected: { historyRevision: 0, worktreeEpoch: 0 },
};
const input = { actorId: "asker", commandId: "rollback", request };
let created = false;

describe.skipIf(postgres.skip)("rollback admission against PostgreSQL", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)).pipe(
        Effect.provide(admin),
        Effect.scoped,
      ),
    );
    created = true;
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES ('asker','Asker','rollback@example.invalid',now())`;
        yield* sql`INSERT INTO organization_members (organization_id,user_id,role) SELECT id,'asker','member' FROM organizations LIMIT 1`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id) SELECT 'project','project','/unused','main',id,'asker' FROM organizations LIMIT 1`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES ('worktree','project','worktree','worktree','mend/worktree',${head})`;
        yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,harness,worktree,branch,base_sha,status,owner_user_id) VALUES ('source','project','worktree','codex','worktree','mend/worktree',${head},'completed','asker')`;
        yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status,exited_at) VALUES ('process','source','ws','agent-protocol','codex','completed',now())`;
        yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,input,status,provider_turn_id) VALUES ('kept','source','process',0,'keep','completed','native-kept'),('suffix','source','process',1,'withdraw','completed','native-suffix')`;
        yield* sql`INSERT INTO checkpoints (id,worktree_id,ordinal,ref,sha,seq,trigger) VALUES ('checkpoint','worktree',0,'refs/mend/rollback',${head},10,'turn-boundary')`;
        const repo = yield* SessionHistoryRepo;
        const content = "retained\n";
        const file = { relativePath: ".codex/sessions/2026/11/05/rollout-native.jsonl", content };
        const ref = {
          relativePath: file.relativePath,
          byteLength: Buffer.byteLength(content),
          sha256: createHash("sha256").update(content).digest("hex"),
        };
        const seedId = NativeSeedId.make("seed");
        yield* repo.saveSeed(
          {
            id: seedId,
            format: 1,
            providerVersion: "0.162.1",
            cutoff: {
              provider: "codex",
              threadId: "native",
              throughTurnId: "native-kept",
              historyMode: "paginated",
            },
            selectedFile: ref,
            files: [ref],
            manifestDigest: createHash("sha256").update("manifest").digest("hex"),
          },
          [file],
        );
        yield* repo.observe({
          kind: "ready",
          boundary: {
            id: request.at.boundaryId,
            sessionId: session,
            revision: 0,
            anchor: { kind: "turn", turnId: AgentTurnId.make("kept") },
            checkpointId: request.at.checkpointId,
            checkpointSha: head,
            nativeSeedId: seedId,
            selection: { harness: "codex", model: null, effort: null, interactionMode: "default" },
            gitHead: head,
            reviewBase: { sha: head, ref: "main" },
            repositorySeed: null,
            observedAt: new Date(),
            nativeObservedAt: new Date(),
            record: { runId: SealantRunId.make("run"), seq: 10n },
          },
        });
      }),
    );
  });
  beforeEach(async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE worktrees SET history_operation_id = NULL, history_epoch = 0`;
        yield* sql`UPDATE agent_turns SET withdrawn_history_revision=NULL,withdrawn_by_operation_id=NULL`;
        yield* sql`DELETE FROM session_history_revisions`;
        yield* sql`DELETE FROM session_history_recoveries`;
        yield* sql`DELETE FROM session_history_operations WHERE operation->'intent'->>'kind' = 'rollback'`;
        yield* sql`UPDATE agent_sessions SET history_revision = 0`;
        yield* sql`UPDATE agent_turns SET status = 'completed'`;
        yield* sql`DELETE FROM agent_turn_steers`;
        yield* sql`DELETE FROM session_admissions`;
        yield* sql`DELETE FROM conversation_processes`;
      }),
    );
  });
  afterAll(async () => {
    if (created)
      await Effect.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`),
        ).pipe(Effect.provide(admin), Effect.scoped),
      );
  });

  it("reserves one actor-keyed receipt, normalizes default files, and replays before a newer revision", async () => {
    const first = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)),
    );
    expect(first.intent.restoreFiles).toBe(true);
    expect(first.intent.removedTurnIds).toEqual(["suffix"]);
    await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE agent_sessions SET history_revision = 1 WHERE id = 'source'`,
      ),
    );
    const replay = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        repo.admitRollback({
          ...input,
          request: {
            ...request,
            restoreFiles: true,
            expected: { historyRevision: 1, worktreeEpoch: 0 },
          },
        }),
      ),
    );
    expect(replay).toEqual(first);
    const conflict = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        repo.admitRollback({ ...input, request: { ...request, restoreFiles: false } }),
      ).pipe(Effect.result),
    );
    expect(conflict._tag === "Failure" && conflict.failure.code).toBe("command_conflict");
  });

  it("refuses a continuation when its requester's session control was revoked", async () => {
    const admitted = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)),
    );
    await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE agent_sessions SET owner_user_id=NULL WHERE id='source'`,
      ),
    );
    try {
      const continued = await run(
        Effect.flatMap(SessionHistoryRepo, (repo) =>
          repo.claimRollback({
            operationId: admitted.id,
            token: "revoked",
            expectedVersion: admitted.version,
            previousWorkerExited: false,
          }),
        ).pipe(Effect.result),
      );
      expect(continued._tag).toBe("Failure");
      expect(continued._tag === "Failure" && continued.failure.code).toBe("actor_revoked");
      const view = await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(session)));
      expect(view.fence).toBe(admitted.id);
      expect(view.position?.historyRevision).toBe(0);
    } finally {
      await run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`UPDATE agent_sessions SET owner_user_id='asker' WHERE id='source'`,
        ),
      );
    }
  });

  it("audits an authorized recovery actor separately and refuses file recovery by a shared controller", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO "user" (id,name,email,"createdAt") VALUES ('recoverer','Recoverer','recoverer@example.invalid',now()) ON CONFLICT DO NOTHING`;
        yield* sql`INSERT INTO organization_members (organization_id,user_id,role) SELECT id,'recoverer','member' FROM organizations LIMIT 1 ON CONFLICT DO NOTHING`;
        yield* sql`UPDATE projects SET visibility='shared' WHERE id='project'`;
        yield* sql`UPDATE agent_sessions SET shared_control_enabled_at=now(),shared_control_enabled_by_user_id='asker' WHERE id='source'`;
      }),
    );
    try {
      const admitted = await run(
        Effect.flatMap(SessionHistoryRepo, (repo) =>
          repo.admitRollback({ ...input, request: { ...request, restoreFiles: false } }),
        ),
      );
      const forbidden = await run(
        Effect.flatMap(SessionHistoryRepo, (repo) =>
          repo.claimRollback({
            operationId: admitted.id,
            token: "recovery",
            expectedVersion: admitted.version,
            previousWorkerExited: false,
            recovery: { actorId: "recoverer", action: "restoreSaved" },
          }),
        ).pipe(Effect.result),
      );
      expect(forbidden._tag === "Failure" && forbidden.failure.code).toBe("actor_revoked");
      const claimed = await run(
        Effect.flatMap(SessionHistoryRepo, (repo) =>
          repo.claimRollback({
            operationId: admitted.id,
            token: "recovery",
            expectedVersion: admitted.version,
            previousWorkerExited: false,
            recovery: { actorId: "recoverer", action: "finish" },
          }),
        ),
      );
      expect(claimed?.actorId).toBe("asker");
      expect(claimed?.recoveryAttempt).toMatchObject({ actorId: "recoverer", action: "finish" });
      expect(
        (await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.rollback(admitted.id))))
          ?.recoveryAttempt?.actorId,
      ).toBe("recoverer");
    } finally {
      await run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql`UPDATE agent_sessions SET shared_control_enabled_at=NULL,shared_control_enabled_by_user_id=NULL WHERE id='source'`,
        ),
      );
    }
  });

  it("reads a rollback receipt through the shared history receipt lookup", async () => {
    const admitted = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)),
    );
    const read = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        repo.operation(admitted.organizationId, input.actorId, input.commandId),
      ),
    );
    expect(read).toEqual(admitted);
  });

  it("normalizes the exact target independently of JSON key insertion order", async () => {
    const admitted = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)),
    );
    const replay = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        repo.admitRollback({
          ...input,
          request: {
            ...request,
            at: { boundaryId: request.at.boundaryId, checkpointId: request.at.checkpointId },
          },
        }),
      ),
    );
    expect(replay.id).toBe(admitted.id);
  });

  it("refuses a new steer while the worktree is fenced", async () => {
    await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)));
    const result = await run(
      Effect.flatMap(AgentConversationRepo, (repo) =>
        repo.admitTurnSteer({
          turnId: AgentTurnId.make("kept"),
          author: "asker",
          input: "Keep my steer",
          clientSteerId: null,
        }),
      ).pipe(Effect.result),
    );
    expect(result._tag === "Failure" && result.failure._tag).toBe("HistoryAdmissionRefusedError");
    const rows = await run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT input FROM agent_turn_steers`),
    );
    expect(rows).toHaveLength(0);
  });

  it("resumes a durable receipt with a generation and refuses a stale worker", async () => {
    const admitted = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)),
    );
    expect(
      await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.rollback(admitted.id))),
    ).toEqual(admitted);
    const claimed = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        repo.claimRollback({
          operationId: admitted.id,
          token: "worker",
          expectedVersion: admitted.version,
          previousWorkerExited: false,
        }),
      ),
    );
    expect(claimed?.generation).toBe(1);
    expect(claimed?.version).toBe(1);
    const advanced = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        repo.advanceRollback(
          { operationId: admitted.id, token: "worker", generation: 1, version: 1 },
          { kind: "saving" },
        ),
      ),
    );
    expect(advanced?.progress.kind).toBe("saving");
    expect(
      await run(
        Effect.flatMap(SessionHistoryRepo, (repo) =>
          repo.advanceRollback(
            { operationId: admitted.id, token: "worker", generation: 1, version: 1 },
            { kind: "saving" },
          ),
        ),
      ),
    ).toBeNull();
  });

  it("refuses a fabricated empty origin after a native turn was dispatched", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const repo = yield* SessionHistoryRepo;
        const retained = yield* repo.boundary(TurnBoundaryId.make("boundary"));
        if (retained === null) return yield* Effect.die("Missing retained fixture");
        return yield* repo
          .observe({
            kind: "ready",
            boundary: {
              ...retained,
              id: TurnBoundaryId.make("origin-source"),
              nativeSeedId: null,
              anchor: { kind: "threadStart" },
              originProof: {
                processId: SessionProcessId.make("process"),
                beforeFirstDispatch: true,
                contextSnapshotId: null,
              },
            },
          })
          .pipe(Effect.exit);
      }),
    );
    expect(outcome._tag).toBe("Failure");
    const rows = await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`SELECT id FROM session_turn_boundaries WHERE id='origin-source'`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("publishes one revision and fixed withdrawal without rewriting original execution evidence", async () => {
    let operation: RollbackOperation = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)),
    );
    const claimed = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        repo.claimRollback({
          operationId: operation.id,
          token: "publish",
          expectedVersion: operation.version,
          previousWorkerExited: false,
        }),
      ),
    );
    expect(claimed).not.toBeNull();
    if (claimed === null) throw new Error("Worker not claimed");
    operation = claimed;
    const worker = () => ({
      operationId: operation.id,
      token: "publish",
      generation: operation.generation,
      version: operation.version,
    });
    const advance = async (progress: Exclude<RollbackProgress, { readonly kind: "complete" }>) => {
      const next = await run(
        Effect.flatMap(SessionHistoryRepo, (repo) => repo.advanceRollback(worker(), progress)),
      );
      expect(next).not.toBeNull();
      if (next === null) throw new Error("Progress rejected");
      operation = next;
    };
    await advance({ kind: "saving" });
    const recoveryId = RollbackRecoveryId.make("recovery");
    const blob = { key: "retained-proof", sha256: "a".repeat(64), byteLength: 1 };
    expect(
      await run(
        Effect.flatMap(SessionHistoryRepo, (repo) =>
          repo.saveRecovery(worker(), {
            id: recoveryId,
            operationId: operation.id,
            worktreeId: operation.intent.worktreeId,
            workspaceId: "fake",
            launchId: "fake",
            generation: operation.generation,
            head: { oid: head, symbolicRef: "refs/heads/mend/worktree" },
            checkpoint: { ref: "refs/mend/history/recovery", sha: head, rawTree: head },
            index: blob,
            files: blob,
            objects: blob,
            native: blob,
            journal: blob,
            manifestDigest: "b".repeat(64),
            savedAt: new Date(),
          }),
        ),
      ),
    ).toBe(true);
    await advance({ kind: "saved", recoveryId });
    await advance({ kind: "preparingNative", recoveryId });
    const candidate = {
      provider: "codex" as const,
      providerSessionId: "replacement-native",
      ownerId: "asker",
      key: "revision",
      verifiedDigest: "c".repeat(64),
    };
    await advance({ kind: "nativeReady", recoveryId, candidate });
    await advance({ kind: "restoringFiles", recoveryId, candidate });
    await advance({
      kind: "readyToPublish",
      recoveryId,
      candidate,
      evidenceDigest: "d".repeat(64),
      filesChanged: true,
    });
    const published = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) => repo.publishRollback(worker())),
    );
    expect(published.progress.kind).toBe("complete");
    const evidence = await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`SELECT s.history_revision,s.provider_session_id,w.history_epoch,w.history_operation_id,t.id,t.status,t.provider_turn_id,t.withdrawn_history_revision FROM agent_sessions s JOIN worktrees w ON w.id=s.worktree_id JOIN agent_turns t ON t.session_id=s.id ORDER BY t.ordinal`,
      ),
    );
    expect(
      evidence.map((row) => ({
        id: row["id"],
        status: row["status"],
        native: row["provider_turn_id"],
        withdrawn: row["withdrawn_history_revision"],
      })),
    ).toEqual([
      { id: "kept", status: "completed", native: "native-kept", withdrawn: null },
      { id: "suffix", status: "completed", native: "native-suffix", withdrawn: 1n },
    ]);
    expect(evidence[0]).toMatchObject({
      history_revision: 1n,
      history_epoch: 1n,
      provider_session_id: "replacement-native",
      history_operation_id: null,
    });
    expect(
      await run(
        Effect.flatMap(SessionHistoryRepo, (repo) =>
          repo.advanceRollback(worker(), {
            kind: "recoveryRequired",
            reason: { code: "recovery_required", message: "late callback" },
            recoveryId,
          }),
        ),
      ),
    ).toBeNull();
    expect(
      (await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)))).id,
    ).toBe(published.id);
  });

  it("reads the fence, exact position and original turn evidence in one snapshot", async () => {
    const admitted = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)),
    );
    const view = await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(session)));
    expect(view.position).toEqual({ historyRevision: 0, worktreeEpoch: 0 });
    expect(view.fence).toBe(admitted.id);
    expect(view.rollback?.id).toBe(admitted.id);
    expect(
      view.turns?.map((turn) => ({
        id: turn.id,
        ordinal: turn.ordinal,
        status: turn.status,
        withdrawn: turn.withdrawnHistoryRevision,
      })),
    ).toEqual([
      { id: "kept", ordinal: 0, status: "completed", withdrawn: null },
      { id: "suffix", ordinal: 1, status: "completed", withdrawn: null },
    ]);
  });

  it("atomically admits exactly one of two competing commands", async () => {
    const results = await Promise.all(
      ["left", "right"].map((commandId) =>
        run(
          Effect.flatMap(SessionHistoryRepo, (repo) =>
            repo.admitRollback({ ...input, commandId }),
          ).pipe(Effect.result),
        ),
      ),
    );
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
    expect(
      results.flatMap((result) => (result._tag === "Failure" ? [result.failure.code] : [])),
    ).toEqual(["busy"]);
    const rows = await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`SELECT history_operation_id FROM worktrees WHERE id = 'worktree'`,
      ),
    );
    expect(rows[0]?.["history_operation_id"]).toBeTruthy();
  });

  it("refuses admitted queued work without changing or stopping it", async () => {
    await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE agent_turns SET status = 'queued' WHERE id = 'suffix'`,
      ),
    );
    const result = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)).pipe(Effect.result),
    );
    expect(result._tag === "Failure" && result.failure.code).toBe("queued_work");
    const rows = await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`SELECT status FROM agent_turns WHERE id = 'suffix'`,
      ),
    );
    expect(rows[0]?.["status"]).toBe("queued");
  });

  it("refuses a new send while the worktree is fenced and leaves its words unadmitted", async () => {
    await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)));
    const result = await run(
      Effect.flatMap(AgentConversationRepo, (repo) =>
        repo.submitTurn(session, SessionProcessId.make("process"), "Keep these words", "asker"),
      ).pipe(Effect.result),
    );
    expect(result._tag === "Failure" && result.failure._tag).toBe("HistoryAdmissionRefusedError");
    const rows = await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`SELECT input FROM agent_turns ORDER BY ordinal`,
      ),
    );
    expect(rows.map((row) => row["input"])).toEqual(["keep", "withdraw"]);
  });

  it("refuses the existing launch admission before external process creation", async () => {
    await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)));
    const result = await run(
      Effect.flatMap(RemovalFencesRepo, (repo) => repo.admit(session)).pipe(Effect.exit),
    );
    expect(result._tag).toBe("Failure");
    const rows = await run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT id FROM session_admissions`),
    );
    expect(rows).toHaveLength(0);
  });

  it("admits only the exact rollback worker's candidate through the native process fence", async () => {
    const operation = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)),
    );
    const claimed = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        repo.claimRollback({
          operationId: operation.id,
          token: "candidate",
          expectedVersion: operation.version,
          previousWorkerExited: false,
        }),
      ),
    );
    if (claimed === null) throw new Error("Missing worker");
    const take = (token: string) =>
      run(
        Effect.flatMap(HarnessLayoutsRepo, (repo) =>
          repo.takeConversation(session, "candidate-launch"),
        ).pipe(
          Effect.provideService(HistoryWorkerContext, {
            operationId: operation.id,
            token,
            generation: claimed.generation,
          }),
        ),
      );
    expect((await take("wrong-worker")).taken).toBe(false);
    expect((await take("candidate")).taken).toBe(true);
  });

  it("refuses a new native launch while rollback holds the worktree", async () => {
    await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.admitRollback(input)));
    const answer = await run(
      Effect.flatMap(HarnessLayoutsRepo, (repo) => repo.takeConversation(session, "late-launch")),
    );
    expect(answer.taken).toBe(false);
    const rows = await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`SELECT launch_id FROM conversation_processes WHERE session_id='source'`,
      ),
    );
    expect(rows).toHaveLength(0);
  });
});
