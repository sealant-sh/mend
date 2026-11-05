import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  AgentTurnId,
  CheckpointId,
  OrganizationId,
  ProjectId,
  SealantRunId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  HistoryOperationId,
  NativeSeedId,
  TurnBoundaryId,
  type BoundaryObservation,
  type ForkProvenance,
  type ForkOperation,
  type NativeHistorySeed,
  type TurnBoundary,
} from "@mend/domain/workbench";
import { Effect, Layer, Option, Queue, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MEND_EVENTS_CHANNEL, MendEvent, notifyEvent } from "../src/events.ts";
import { migrations } from "../src/migrations.ts";
import { SessionHistoryRepo, SessionHistoryRepoLive } from "../src/repos/session-history.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_fork_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const connection = PgClient.layer({ url: Redacted.make(url.toString()) });
const layer: Layer.Layer<SessionHistoryRepo | PgClient.PgClient | SqlClient.SqlClient, SqlError> =
  SessionHistoryRepoLive.pipe(Layer.provideMerge(connection));
const run = <A, E>(
  effect: Effect.Effect<A, E, SessionHistoryRepo | SqlClient.SqlClient | PgClient.PgClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
let created = false;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const now = new Date("2026-11-05T10:00:00Z");
const source = SessionId.make("source");
const boundaryId = TurnBoundaryId.make("boundary");
const seedId = NativeSeedId.make("seed");
const file = {
  relativePath: ".codex/sessions/2026/11/05/rollout-2026-11-05T10-00-00-native.jsonl",
  content: "authorized conversation\n",
};
const ref = {
  relativePath: file.relativePath,
  sha256: hash(file.content),
  byteLength: Buffer.byteLength(file.content),
};
const seed: NativeHistorySeed = {
  id: seedId,
  format: 1,
  providerVersion: "0.162.1",
  cutoff: {
    provider: "codex",
    threadId: "native",
    throughTurnId: "turn-native",
    historyMode: "paginated",
  },
  selectedFile: ref,
  files: [ref],
  manifestDigest: hash(JSON.stringify(ref)),
};
const boundary: TurnBoundary = {
  id: boundaryId,
  sessionId: source,
  revision: 0,
  anchor: { kind: "turn", turnId: AgentTurnId.make("selected") },
  checkpointId: CheckpointId.make("checkpoint"),
  checkpointSha: Sha.make("b".repeat(40)),
  reviewBase: { sha: Sha.make("a".repeat(40)), ref: "main" },
  repositorySeed: null,
  nativeSeedId: seedId,
  selection: { harness: "codex", model: null, effort: null, interactionMode: "plan" },
  gitHead: Sha.make("a".repeat(40)),
  observedAt: now,
  nativeObservedAt: now,
  record: { runId: SealantRunId.make("run"), seq: 12n },
};
const command: ForkOperation = {
  id: HistoryOperationId.make("fork-op"),
  organizationId: OrganizationId.make("org"),
  actorId: "asker",
  commandId: "command",
  intentDigest: hash("intent"),
  request: {
    sourceSessionId: source,
    at: { kind: "turn", turnId: AgentTurnId.make("selected") },
    title: null,
  },
  intent: {
    kind: "fork",
    projectId: ProjectId.make("project"),
    title: "Fork",
    sourceBoundaryId: boundaryId,
    childSessionId: SessionId.make("child"),
    childWorktreeId: WorktreeId.make("child-worktree"),
  },
  progress: { kind: "preparing" },
  createdAt: now,
  updatedAt: now,
};
const provenance: ForkProvenance = {
  childSessionId: command.intent.childSessionId,
  sourceSessionId: source,
  rootSessionId: source,
  sourceBoundaryId: boundaryId,
  sourceTurnId: AgentTurnId.make("selected"),
  sourceCheckpointId: boundary.checkpointId,
  sourceNativeSeedId: seedId,
  inheritedViewDigest: hash("[]"),
  requestedBy: "asker",
  requestedAt: now,
};

describe.skipIf(postgres.skip)(
  "fork receipts and retained evidence against PostgreSQL 0194",
  () => {
    beforeAll(async () => {
      await Effect.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`CREATE DATABASE ${database}`),
        ).pipe(Effect.provide(admin), Effect.scoped),
      );
      created = true;
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [, migrate] of Object.entries(migrations).toSorted(([a], [b]) =>
            a.localeCompare(b),
          ))
            yield* migrate;
          yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id) VALUES ('project','project','/unused','main',(SELECT id FROM organizations LIMIT 1))`;
          yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES ('worktree','project','source','source','mend/source',${boundary.gitHead})`;
          yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,harness,worktree,branch,base_sha,status) VALUES (${source},'project','worktree','codex','source','mend/source',${boundary.gitHead},'completed')`;
          yield* sql`INSERT INTO checkpoints (id,worktree_id,ordinal,ref,sha,seq,trigger) VALUES ('checkpoint','worktree',0,'refs/mend/test',${boundary.gitHead},12,'turn-boundary')`;
          const repo = yield* SessionHistoryRepo;
          yield* repo.saveSeed(seed, [file]);
          yield* repo.observe({ kind: "ready", boundary });
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

    it.each(["ready", "unavailable"] as const)(
      "notifies session readers after the %s observation commits and is readable",
      async (kind) => {
        await run(
          Effect.gen(function* () {
            const repo = yield* SessionHistoryRepo;
            const pg = yield* PgClient.PgClient;
            const notices = yield* pg.listen(MEND_EVENTS_CHANNEL);
            const next = Queue.take(notices).pipe(
              Effect.map((notice) =>
                Schema.decodeUnknownSync(Schema.fromJsonString(MendEvent))(notice.payload),
              ),
              Effect.timeoutOption("2 seconds"),
              Effect.map(Option.getOrNull),
            );
            const turnId = AgentTurnId.make(`observed-${kind}`);
            const observation: BoundaryObservation =
              kind === "ready"
                ? {
                    kind,
                    boundary: {
                      ...boundary,
                      id: TurnBoundaryId.make("observed-ready"),
                      anchor: { kind: "turn", turnId },
                    },
                  }
                : { kind, sessionId: source, turnId, reason: "native_boundary_unknown" };
            yield* pg.withTransaction(
              Effect.gen(function* () {
                yield* repo.observe(observation);
                expect(yield* Queue.take(notices).pipe(Effect.timeoutOption("100 millis"))).toEqual(
                  Option.none(),
                );
              }),
            );
            expect(yield* next).toEqual({
              type: "session",
              sessionId: source,
              projectId: "project",
            });
            expect(yield* repo.observations(source)).toContainEqual(observation);
            yield* repo.observe(observation);
            const marker = { type: "organization", organizationId: "after-replay" } as const;
            yield* notifyEvent(pg, marker);
            expect(yield* next).toEqual(marker);
          }).pipe(Effect.scoped),
        );
      },
    );

    it("does not publish or retain a rolled-back observation", async () => {
      await run(
        Effect.gen(function* () {
          const repo = yield* SessionHistoryRepo;
          const pg = yield* PgClient.PgClient;
          const notices = yield* pg.listen(MEND_EVENTS_CHANNEL);
          const observation: BoundaryObservation = {
            kind: "unavailable",
            sessionId: source,
            turnId: AgentTurnId.make("rolled-back"),
            reason: "checkpoint_failed",
          };
          yield* pg
            .withTransaction(repo.observe(observation).pipe(Effect.andThen(Effect.fail("abort"))))
            .pipe(Effect.flip);
          const marker = { type: "organization", organizationId: "after-rollback" } as const;
          yield* notifyEvent(pg, marker);
          const notice = yield* Queue.take(notices).pipe(Effect.timeout("2 seconds"));
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(MendEvent))(notice.payload),
          ).toEqual(marker);
          expect(yield* repo.observations(source)).not.toContainEqual(observation);
        }).pipe(Effect.scoped),
      );
    });

    it("returns one child for simultaneous delivery, reconnect and changed defaults; conflicting intent refuses", async () => {
      const competing: ForkOperation = {
        ...command,
        id: HistoryOperationId.make("competing-op"),
        intent: {
          ...command.intent,
          childSessionId: SessionId.make("competing-child"),
          childWorktreeId: WorktreeId.make("competing-worktree"),
        },
      };
      const [receipt, replay] = await Promise.all([
        run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.reserve(command, provenance, []))),
        run(
          Effect.flatMap(SessionHistoryRepo, (repo) =>
            repo.reserve(
              competing,
              { ...provenance, childSessionId: competing.intent.childSessionId },
              [],
            ),
          ),
        ),
      ]);
      expect([command, competing]).toContainEqual(receipt);
      expect(replay).toEqual(receipt);
      await run(
        Effect.gen(function* () {
          const repo = yield* SessionHistoryRepo;
          expect(yield* repo.operation(command.organizationId, "asker", "command")).toEqual(
            receipt,
          );
          expect(yield* repo.reserve(command, provenance, [])).toEqual(receipt);
          expect(
            (yield* repo
              .reserve({ ...command, intentDigest: hash("changed") }, provenance, [])
              .pipe(Effect.flip)).reason,
          ).toBe("command_conflict");
          expect(yield* repo.claim(receipt.id, "first")).toBe(true);
          expect(yield* repo.claim(receipt.id, "second")).toBe(false);
          expect(yield* repo.progress(receipt.id, "second", { kind: "awaitingNative" })).toBe(
            false,
          );
          yield* repo.release(receipt.id, "first");
          expect(yield* repo.claim(receipt.id, "restart")).toBe(true);
          expect(yield* repo.progress(receipt.id, "restart", { kind: "awaitingNative" })).toBe(
            true,
          );
          yield* repo.release(receipt.id, "restart");
        }),
      );
      const retained = await run(
        Effect.flatMap(SessionHistoryRepo, (repo) => repo.fork(receipt.intent.childSessionId)),
      );
      expect(retained?.operation.progress.kind).toBe("awaitingNative");
      expect(retained?.provenance.childSessionId).toBe(receipt.intent.childSessionId);
      const other = receipt.id === command.id ? competing : command;
      expect(
        await run(
          Effect.flatMap(SessionHistoryRepo, (repo) => repo.fork(other.intent.childSessionId)),
        ),
      ).toBeNull();
    });

    it("keeps immutable native bytes and provenance after source checkpoint removal", async () => {
      await run(
        Effect.gen(function* () {
          const repo = yield* SessionHistoryRepo;
          const receipt = yield* repo.reserve(command, provenance, []);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM checkpoints WHERE id = 'checkpoint'`;
          expect((yield* repo.boundary(boundaryId))?.checkpointId).toBe("checkpoint");
          expect((yield* repo.seed(seedId))?.files).toEqual([file]);
          expect(
            (yield* repo.fork(receipt.intent.childSessionId))?.provenance.sourceSessionId,
          ).toBe("source");
          expect(
            yield* repo.selectBoundary(source, {
              kind: "turn",
              turnId: AgentTurnId.make("old-unproven"),
            }),
          ).toBeNull();
          expect((yield* repo.boundary(boundaryId))?.selection).toEqual(boundary.selection);
        }),
      );
    });
  },
);
