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
import { NativeSeedId, TurnBoundaryId, type RollbackRequest } from "@mend/domain/workbench";
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
  HarnessLayoutsRepoLive,
  AgentConversationRepoLive.pipe(Layer.provide(MendDBLive)),
).pipe(Layer.provideMerge(connection));
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    SessionHistoryRepo | HarnessLayoutsRepo | AgentConversationRepo | SqlClient.SqlClient
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
        yield* sql`DELETE FROM session_history_operations WHERE operation->'intent'->>'kind' = 'rollback'`;
        yield* sql`UPDATE agent_sessions SET history_revision = 0`;
        yield* sql`UPDATE agent_turns SET status = 'completed'`;
        yield* sql`DELETE FROM agent_turn_steers`;
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
