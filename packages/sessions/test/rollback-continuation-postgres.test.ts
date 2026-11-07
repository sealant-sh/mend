import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepoLive,
  CheckpointsRepo,
  CheckpointsRepoLive,
  MendDBLive,
  migrations,
  SessionHistoryRepo,
  SessionHistoryRepoLive,
  SessionProcessesRepo,
  SessionProcessesRepoLive,
  SessionsRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import {
  CheckpointId,
  SealantRunId,
  SessionId,
  SessionProcessId,
  Sha,
  SealantWorkspaceId,
} from "@mend/domain";
import {
  RollbackRefusedError,
  TurnBoundaryId,
  type RollbackOperation,
} from "@mend/domain/workbench";
import { BlobStore, BlobStoreFsLive } from "@mend/store";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ProtocolHost, ProtocolHostLive } from "../src/protocol-host.ts";
import type { RollbackFileAuthority } from "../src/rollback-files.ts";
import {
  continueSessionRollback,
  recoverSessionRollback,
  type RollbackRuntime,
} from "../src/session-rollback.ts";
import { makePipe } from "./support/codex-peer.ts";
import { cleanupRollbackFiles, rollbackFileFixture } from "./support/rollback-files.ts";

const exec = promisify(execFile);
const postgres = postgresTestConfig();
const database = `mend_rollback_continuation_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const infrastructure = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.toString()) })),
);
const repos = Layer.mergeAll(
  SessionHistoryRepoLive,
  CheckpointsRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  AgentConversationRepoLive,
);
const layer = Layer.mergeAll(repos, ProtocolHostLive.pipe(Layer.provide(repos))).pipe(
  Layer.provideMerge(infrastructure),
);
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    SessionHistoryRepo | SessionProcessesRepo | CheckpointsRepo | ProtocolHost | SqlClient.SqlClient
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
let created = false;
afterEach(cleanupRollbackFiles);

describe.skipIf(postgres.skip)("durable rollback continuation with real Git and PostgreSQL", () => {
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
        yield* sql`INSERT INTO "user" (id,name,email,"createdAt") VALUES ('asker','Asker','asker@invalid.example',now())`;
        yield* sql`INSERT INTO organization_members (organization_id,user_id,role) SELECT id,'asker','member' FROM organizations LIMIT 1`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id) SELECT 'project','project','/unused','main',id,'asker' FROM organizations LIMIT 1`;
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
  const fixture = async (name: string, restoreFiles = true) => {
    const f = await rollbackFileFixture();
    const sessionId = SessionId.make(name),
      processId = SessionProcessId.make(`old-${name}`);
    const checkpointId = CheckpointId.make(`zero-${name}`),
      boundaryId = TurnBoundaryId.make(`origin-${name}`);
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES (${name},'project',${name},${name},${`mend/${name}`},${f.target})`;
        yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,harness,worktree,branch,base_sha,status,owner_user_id,provider_session_id) VALUES (${sessionId},'project',${name},'codex',${name},${`mend/${name}`},${f.target},'completed','asker','old-native')`;
        yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status,exited_at) VALUES (${processId},${sessionId},'fake-workspace','agent-protocol','codex','completed',now())`;
        yield* sql`INSERT INTO checkpoints (id,worktree_id,session_id,ordinal,ref,sha,seq,trigger) VALUES (${checkpointId},${name},${sessionId},0,${`refs/mend/${name}/zero`},${f.target},0,'turn-boundary')`;
        yield* (yield* SessionHistoryRepo).observe({
          kind: "ready",
          boundary: {
            id: boundaryId,
            sessionId,
            revision: 0,
            anchor: { kind: "threadStart" },
            nativeSeedId: null,
            originProof: { processId, beforeFirstDispatch: true, contextSnapshotId: null },
            checkpointId,
            checkpointSha: Sha.make(f.target),
            gitHead: Sha.make(f.target),
            reviewBase: { sha: Sha.make(f.target), ref: "main" },
            repositorySeed: null,
            selection: { harness: "codex", model: null, effort: null, interactionMode: "default" },
            observedAt: new Date(),
            nativeObservedAt: new Date(),
            record: { runId: SealantRunId.make(`run-${name}`), seq: 0n },
          },
        });
        yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,input,status,provider_turn_id) VALUES (${`turn-${name}`},${sessionId},${processId},0,'withdraw these words','completed',${`native-${name}`})`;
      }),
    );
    await fs.writeFile(path.join(f.repo, "tracked"), "staged words\n");
    await f.git("add", "tracked");
    await fs.writeFile(path.join(f.repo, "tracked"), "unsaved editor words\n");
    const originalIndex = await fs.readFile(path.join(f.repo, ".git/index"));
    const operation = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        repo.admitRollback({
          actorId: "asker",
          commandId: `command-${name}`,
          request: {
            sessionId,
            restoreFiles,
            at: { checkpointId, boundaryId },
            expected: { historyRevision: 0, worktreeEpoch: 0 },
          },
        }),
      ),
    );
    return { ...f, sessionId, operation, originalIndex };
  };
  const execute = (
    f: Awaited<ReturnType<typeof fixture>>,
    operation: RollbackOperation,
    options: {
      readonly failBeforeSave?: boolean;
      readonly redactSaveRead?: boolean;
      readonly failAfterFiles?: boolean;
      readonly restoreSaved?: boolean;
      readonly nativeWrites?: boolean;
      readonly location?: "holderHome" | "revisionHome";
    } = {},
  ) =>
    run(
      Effect.gen(function* () {
        const history = yield* SessionHistoryRepo,
          host = yield* ProtocolHost,
          processes = yield* SessionProcessesRepo,
          checkpoints = yield* CheckpointsRepo;
        const blobs = yield* BlobStore;
        let token: string = crypto.randomUUID();
        const claim = history.claimRollback({
          operationId: operation.id,
          token,
          expectedVersion: operation.version,
          previousWorkerExited: operation.generation > 0,
          ...(options.restoreSaved
            ? { recovery: { actorId: "asker", action: "restoreSaved" } }
            : {}),
        });
        const claimed = yield* operation.generation > 0
          ? recoverSessionRollback(
              {
                actor: "asker",
                operationId: operation.id,
                expectedProgressVersion: operation.version,
                action: options.restoreSaved ? "restoreSaved" : "finish",
              },
              history,
              (_operation, recheck) => recheck,
              (resumed, claimedToken) => {
                token = claimedToken;
                return Effect.succeed(resumed);
              },
            )
          : claim;
        if (claimed === null) return yield* Effect.die("Worker was not claimed");
        const candidateId = SessionProcessId.make(`candidate-${f.sessionId}-${claimed.generation}`);
        const peer = makePipe([]);
        let flushes = 0;
        const files: RollbackFileAuthority = {
          ...f.input,
          operationId: operation.id,
          worktreeId: operation.intent.worktreeId,
          generation: claimed.generation,
          workspaceId: "fake-workspace",
          launchId: "fake-launch",
          blobs,
          execute: (argv) =>
            Effect.tryPromise({
              try: async () => {
                const [command, ...args] = argv;
                if (command === undefined) throw new Error("Missing helper");
                const result = await exec(command, args, {
                  env: {
                    PATH: process.env["PATH"],
                    HOME: f.root,
                    GIT_CONFIG_GLOBAL: "/dev/null",
                  },
                  maxBuffer: 16 * 1024 * 1024,
                });
                const request = Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.Struct({
                      action: Schema.String,
                      artifact: Schema.optional(Schema.String),
                    }),
                  ),
                )(argv.at(-1) ?? "{}");
                return {
                  ...result,
                  stdout:
                    options.redactSaveRead &&
                    request.action === "read" &&
                    request.artifact === "objects.pack"
                      ? result.stdout.slice(0, 20) + "***REDACTED***" + result.stdout.slice(40)
                      : result.stdout,
                  exitCode: 0,
                };
              },
              catch: (error) => ({ message: String(error) }),
            }),
        };
        const makeRuntime = (): Effect.Effect<RollbackRuntime> =>
          Effect.succeed({
            stopTarget: Effect.void,
            files: options.failBeforeSave
              ? Effect.fail(
                  new RollbackRefusedError({
                    code: "save_incomplete",
                    message: "The target pack could not be written before saving.",
                  }),
                )
              : Effect.succeed(files),
            checkpointSaved: (recovery) =>
              Effect.gen(function* () {
                const all = yield* checkpoints.listForSession(f.sessionId);
                if (all.some((c) => c.ref === recovery.checkpoint.ref)) return;
                yield* checkpoints
                  .create({
                    worktreeId: operation.intent.worktreeId,
                    sessionId: f.sessionId,
                    ordinal: all.length,
                    ref: recovery.checkpoint.ref,
                    sha: Sha.make(recovery.checkpoint.sha),
                    sealantRunId: null,
                    seq: 0n,
                    trigger: "user-mark",
                  })
                  .pipe(Effect.orDie);
              }),
            prepareNative: (current, _boundary, _existing) =>
              Effect.gen(function* () {
                const key = current.nativeAttempts?.at(-1)?.key ?? operation.intent.candidateKey;
                const process = yield* processes.create({
                  id: candidateId,
                  sessionId: f.sessionId,
                  sealantWorkspaceId: SealantWorkspaceId.make("fake-workspace"),
                  sealantSessionId: null,
                  label: "rollback candidate",
                  argv: ["codex", "app-server"],
                  kind: "agent-protocol",
                  harness: "codex",
                  runsAs: "asker",
                  providerSessionId: null,
                });
                if (
                  host.prepareHistoryReplacement === undefined ||
                  host.stopHistoryReplacement === undefined
                )
                  return yield* Effect.die("Native history host missing");
                const native = yield* host
                  .prepareHistoryReplacement({
                    process,
                    pipe: peer.pipe,
                    cwd: "/workspace/repo",
                    permissionMode: "bypass",
                    launchedWithLoginOf: "asker",
                    runsAs: "asker",
                    historyCandidate: {
                      operationId: operation.id,
                      sourceProviderSessionId: "old-native",
                      key,
                      actorId: "asker",
                    },
                    nativeBootstrap: {
                      kind: "emptyOrigin",
                      purpose: "rollback",
                      childSessionId: key,
                    },
                    hooks: {
                      onRequestChanged: () => Effect.void,
                      onTurnCompleted: () => Effect.void,
                    },
                  })
                  .pipe(Effect.orDie);
                expect(peer.written.some((request) => request.method === "turn/start")).toBe(false);
                yield* host
                  .stopHistoryReplacement(
                    candidateId,
                    processes.markExited(candidateId, "stopped", 0).pipe(Effect.as(true)),
                  )
                  .pipe(Effect.orDie);
                if (options.nativeWrites)
                  yield* Effect.promise(() =>
                    fs.writeFile(
                      path.join(f.repo, "tracked"),
                      "provider hook changed these words\n",
                    ),
                  );
                return {
                  provider: "codex",
                  providerSessionId: native,
                  ownerId: "asker",
                  key,
                  location: options.location ?? "revisionHome",
                  verifiedDigest: "d".repeat(64),
                };
              }),
            flush: Effect.suspend(() =>
              ++flushes === 2 && options.failAfterFiles
                ? Effect.fail(
                    new RollbackRefusedError({
                      code: "authority_uncertain",
                      message: "Fake capture acknowledgement lost after files",
                    }),
                  )
                : Effect.succeed("capture-proof"),
            ),
            candidateFiles: () => Effect.succeed(files),
            publish: (candidate, commit) =>
              host.publishHistoryReplacement?.(
                candidateId,
                {
                  operationId: operation.id,
                  sourceProviderSessionId: "old-native",
                  key: candidate.key,
                  actorId: "asker",
                  sessionId: f.sessionId,
                  providerSessionId: candidate.providerSessionId,
                },
                commit,
              ) ?? Effect.die("Publication host missing"),
          });
        return yield* continueSessionRollback(claimed, token, history, makeRuntime);
      }).pipe(Effect.provide(BlobStoreFsLive(path.join(f.root, "blobs")))),
    );

  it("releases a failed pre-save Undo without withdrawing history or blocking another command", async () => {
    const f = await fixture("save-incomplete");
    const result = await execute(f, f.operation, { failBeforeSave: true });
    expect(result.progress).toMatchObject({ kind: "failed", recoveryId: null });
    const view = await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(f.sessionId)));
    expect(view.fence).toBeNull();
    expect(view.position).toEqual({ historyRevision: 0, worktreeEpoch: 0 });
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("unsaved editor words\n");
    expect(await fs.readFile(path.join(f.repo, ".git/index"))).toEqual(f.originalIndex);
    await run(
      Effect.flatMap(SessionProcessesRepo, (repo) =>
        Effect.gen(function* () {
          const shell = yield* repo.create({
            sessionId: f.sessionId,
            sealantWorkspaceId: SealantWorkspaceId.make("fake-workspace"),
            sealantSessionId: null,
            kind: "shell",
            label: "after refused Undo",
            argv: ["sh"],
          });
          yield* repo.markExited(shell.id, "exited", 0);
        }),
      ),
    );
    const another = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        repo.admitRollback({
          actorId: "asker",
          commandId: "after-save-incomplete",
          request: f.operation.request,
        }),
      ),
    );
    expect(another.progress.kind).toBe("admitted");
  });

  it("releases a legacy save-incomplete receipt after authenticated recovery observes its writer exit", async () => {
    const f = await fixture("legacy-save-incomplete");
    const abandoned = await run(
      Effect.flatMap(SessionHistoryRepo, (repo) =>
        Effect.gen(function* () {
          const token = crypto.randomUUID();
          const claimed = yield* repo.claimRollback({
            operationId: f.operation.id,
            token,
            expectedVersion: f.operation.version,
            previousWorkerExited: false,
          });
          if (claimed === null) return yield* Effect.die("Missing claimed fixture");
          const held = yield* repo.advanceRollback(
            {
              operationId: claimed.id,
              token,
              generation: claimed.generation,
              version: claimed.version,
            },
            {
              kind: "recoveryRequired",
              recoveryId: null,
              resume: { kind: "admitted" },
              reason: { code: "save_incomplete", message: "The target pack could not be written." },
            },
          );
          if (held === null) return yield* Effect.die("Missing retained fixture");
          return held;
        }),
      ),
    );
    const released = await execute(f, abandoned, { restoreSaved: true });
    expect(released.progress).toMatchObject({ kind: "failed", recoveryId: null });
    const view = await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(f.sessionId)));
    expect(view.fence).toBeNull();
    expect(view.position).toEqual({ historyRevision: 0, worktreeEpoch: 0 });
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("unsaved editor words\n");
  });

  it("retains a completed original save and can finish the same Undo after an unreadable pack", async () => {
    const f = await fixture("retained-redacted-save");
    const interrupted = await execute(f, f.operation, { redactSaveRead: true });
    expect(interrupted.progress).toMatchObject({ kind: "recoveryRequired", recoveryId: null });
    const held = await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(f.sessionId)));
    expect(held.fence).not.toBeNull();
    expect(
      (await f.git("rev-parse", `refs/mend/history/${f.operation.id}/recovery`)).stdout.trim(),
    ).toMatch(/^[a-f0-9]{40}$/);
    const completed = await execute(f, interrupted);
    expect(completed.id).toBe(interrupted.id);
    expect(completed.progress.kind).toBe("complete");
  });

  it("publishes the exact zero prefix after saving actual staging and restoring files", async () => {
    const f = await fixture("complete");
    const result = await execute(f, f.operation);
    expect(result.progress.kind).toBe("complete");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("baseline\n");
    expect((await f.git("diff", "--cached", "--name-only")).stdout).toBe("");
    expect((await f.git("rev-parse", "HEAD")).stdout.trim()).toBe(f.target);
    const view = await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(f.sessionId)));
    expect(view.position).toEqual({ historyRevision: 1, worktreeEpoch: 1 });
    expect(view.fence).toBeNull();
    expect(
      view.turns?.map((t) => ({
        id: t.id,
        status: t.status,
        withdrawn: t.withdrawnHistoryRevision,
      })),
    ).toEqual([{ id: `turn-${f.sessionId}`, status: "completed", withdrawn: 1 }]);
  });
  it.each(["holderHome", "revisionHome"] as const)(
    "finishes the original %s journal after restart and a lost post-restore acknowledgement",
    async (location) => {
      const f = await fixture(`restart-${location}`);
      const interrupted = await execute(f, f.operation, { failAfterFiles: true, location });
      expect(interrupted.progress).toMatchObject({
        kind: "recoveryRequired",
        resume: { kind: "restoringFiles" },
      });
      const original = await run(
        Effect.flatMap(SessionHistoryRepo, (repo) => repo.recovery(f.operation.id)),
      );
      const result = await execute(f, interrupted, { location });
      expect(result.progress.kind).toBe("complete");
      expect(
        (await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(f.sessionId)))).position
          ?.worktreeEpoch,
      ).toBe(1);
      expect(
        await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.recovery(f.operation.id))),
      ).toEqual(original);
      const binding = await run(
        Effect.flatMap(
          SessionHistoryRepo,
          (repo) =>
            repo.nativeBinding?.(f.sessionId) ?? Effect.die("Missing native binding repository"),
        ),
      );
      expect(binding?.location).toBe(location);
    },
  );
  it("retains unexpected native startup writes while refusing conversation-only success", async () => {
    const f = await fixture("native-writes", false);
    const interrupted = await execute(f, f.operation, { nativeWrites: true });
    expect(interrupted.progress).toMatchObject({ kind: "recoveryRequired" });
    expect(interrupted.progress).toHaveProperty("observedEvidence.key");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe(
      "provider hook changed these words\n",
    );
    if (
      interrupted.progress.kind !== "recoveryRequired" ||
      interrupted.progress.observedEvidence === undefined
    )
      return;
    const evidence = await Effect.runPromise(
      Effect.flatMap(BlobStore, (blobs) =>
        blobs.get(
          interrupted.progress.kind === "recoveryRequired" &&
            interrupted.progress.observedEvidence !== undefined
            ? interrupted.progress.observedEvidence.key
            : "missing",
        ),
      ).pipe(Effect.provide(BlobStoreFsLive(path.join(f.root, "blobs")))),
    );
    expect(JSON.parse(Buffer.from(evidence).toString("utf8")).files).toContainEqual({
      path: "tracked",
      mode: "100644",
      bytes: Buffer.from("provider hook changed these words\n").toString("base64"),
    });
    const view = await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(f.sessionId)));
    expect(view.fence).toBe(f.operation.id);
    expect(view.position?.historyRevision).toBe(0);
  });
  it("keeps the old generation and save when the prior workspace has no exit witness", async () => {
    const f = await fixture("uncertain-exit");
    const interrupted = await execute(f, f.operation, { failAfterFiles: true });
    let continued = false;
    const result = await run(
      Effect.gen(function* () {
        const history = yield* SessionHistoryRepo;
        return yield* recoverSessionRollback(
          {
            actor: "asker",
            operationId: interrupted.id,
            expectedProgressVersion: interrupted.version,
            action: "finish",
          },
          history,
          () =>
            Effect.fail(
              new RollbackRefusedError({
                code: "authority_uncertain",
                message: "The prior workspace is kept.",
              }),
            ),
          () => {
            continued = true;
            return Effect.succeed(interrupted);
          },
        ).pipe(Effect.result);
      }),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "authority_uncertain" } });
    expect(continued).toBe(false);
    expect(
      await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.rollback(interrupted.id))),
    ).toEqual(interrupted);
    expect(
      (await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(f.sessionId)))).fence,
    ).toBe(interrupted.id);
  });
  it("rechecks current actor authority before observing or stopping a recovery workspace", async () => {
    const f = await fixture("revoked-recovery");
    const interrupted = await execute(f, f.operation, { failAfterFiles: true });
    let observed = false;
    const result = await run(
      Effect.gen(function* () {
        const history = yield* SessionHistoryRepo;
        return yield* recoverSessionRollback(
          {
            actor: "unknown",
            operationId: interrupted.id,
            expectedProgressVersion: interrupted.version,
            action: "restoreSaved",
          },
          history,
          () => {
            observed = true;
            return Effect.void;
          },
          () => Effect.succeed(interrupted),
        ).pipe(Effect.result);
      }),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "actor_revoked" } });
    expect(observed).toBe(false);
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("baseline\n");
  });
  it("restores saved words and exact staging through authenticated recovery", async () => {
    const f = await fixture("restore");
    const interrupted = await execute(f, f.operation, { failAfterFiles: true });
    const recovered = await execute(f, interrupted, { restoreSaved: true });
    expect(recovered.progress.kind).toBe("failed");
    expect(await fs.readFile(path.join(f.repo, "tracked"), "utf8")).toBe("unsaved editor words\n");
    expect(await fs.readFile(path.join(f.repo, ".git/index"))).toEqual(f.originalIndex);
    const view = await run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(f.sessionId)));
    expect(view.fence).toBeNull();
    expect(view.position?.historyRevision).toBe(0);
    expect(view.turns?.[0]?.withdrawnHistoryRevision).toBeNull();
  });
});
