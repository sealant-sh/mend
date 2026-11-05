import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepoLive,
  MendDBLive,
  migrations,
  SessionHistoryRepo,
  SessionHistoryRepoLive,
  SessionProcessesRepo,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  makeHarnessLayoutsMemoryState,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { CheckpointId, SealantRunId, SealantWorkspaceId, SessionProcessId } from "@mend/domain";
import { Session, TurnBoundaryId } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import { SessionEngine, startFromBase } from "@mend/sessions";
import { makeFsBlobStore, worktreePathOf } from "@mend/store";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProtocolHostLive } from "../src/protocol-host.ts";
import { fakeExecRun, makeWorld, sealantLaunchLayer, setup, withEngine } from "./engine/fixture.ts";
import { personPlatform } from "./engine/person-fixture.ts";
import { makePipe } from "./support/codex-peer.ts";

const exec = promisify(execFile);
const postgres = postgresTestConfig();
const database = `mend_engine_rollback_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const infrastructure = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.toString()) })),
  Layer.orDie,
);
const repos = Layer.mergeAll(SessionProcessesRepoLive, SessionsRepoLive, AgentConversationRepoLive);
const historyLayer = SessionHistoryRepoLive.pipe(Layer.provide(infrastructure), Layer.orDie);
const hostLayer = ProtocolHostLive.pipe(
  Layer.provide(repos),
  Layer.provide(infrastructure),
  Layer.orDie,
);
const withDatabase = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | SessionHistoryRepo | SessionProcessesRepo>,
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(SessionHistoryRepoLive, SessionProcessesRepoLive).pipe(
        Layer.provideMerge(infrastructure),
      ),
    ),
    Effect.scoped,
  );
const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | SessionHistoryRepo | SessionProcessesRepo>,
) => Effect.runPromise(withDatabase(effect));
let created = false;

describe.skipIf(postgres.skip)(
  "SessionEngine rollback with PostgreSQL and workspace SDK fakes",
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
          for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
            a.localeCompare(b),
          ))
            yield* migration;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO "user" (id,name,email,"createdAt") VALUES ('user-fixture','Fake','engine-rollback@invalid.example',now())`;
          yield* sql`INSERT INTO organizations (id,name) VALUES ('org-test','Fixture')`;
          yield* sql`INSERT INTO organization_members (organization_id,user_id,role) VALUES ('org-test','user-fixture','owner')`;
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

    it("saves actual staging, publishes zero through the host and replays the receipt without another process", async () => {
      const tmp = (await exec("mktemp", ["-d", "-t", "mend-engine-rollback.XXXXXX"])).stdout.trim();
      const world = makeWorld();
      const state = makeHarnessLayoutsMemoryState();
      const peer = makePipe([]);
      const logins: string[] = [];
      let repository = "";
      let opened = 0;
      const cleanEnv = {
        PATH: process.env["PATH"],
        HOME: tmp,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      };
      const fileInput = Schema.fromJsonString(
        Schema.Struct({
          repository: Schema.String,
          journalRoot: Schema.String,
          nativeRoot: Schema.String,
        }),
      );
      const platform = Layer.effect(
        SealantClient,
        Effect.map(SealantClient, (inner) => ({
          ...inner,
          openSession: () => {
            opened++;
            return Effect.succeed(peer.pipe);
          },
          getSession: () => Effect.succeed(peer.pipe),
          exec: (workspace, argv, options) => {
            if (argv[0] !== "node" || argv[1] !== "-e" || argv[3] === undefined)
              return inner.exec(workspace, argv, options);
            const raw: unknown = JSON.parse(argv[3]);
            const input = Schema.decodeUnknownSync(fileInput)(argv[3]);
            if (input.repository !== "/workspace/repo") return inner.exec(workspace, argv, options);
            const mappedRoot = (value: string) => path.join(tmp, "workspace", value);
            const nativeRoot = mappedRoot(input.nativeRoot);
            fs.mkdirSync(nativeRoot, { recursive: true });
            const mapped = {
              ...(typeof raw === "object" && raw !== null ? raw : {}),
              repository,
              journalRoot: mappedRoot(input.journalRoot),
              nativeRoot,
            };
            return Effect.tryPromise({
              try: async () => ({
                ...(await exec("node", ["-e", argv[2] ?? "", JSON.stringify(mapped)], {
                  env: cleanEnv,
                  maxBuffer: 16 * 1024 * 1024,
                })),
                exitCode: 0,
                run: fakeExecRun,
              }),
              catch: (cause) =>
                new SealantPlatformError({
                  code: "fake_exec_failed",
                  status: null,
                  message: String(cause),
                  cause,
                }),
            });
          },
        })),
      ).pipe(
        Layer.provide(
          sealantLaunchLayer(
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            {
              exec: (argv) =>
                argv[0] === "sh"
                  ? { exitCode: 0, stdout: "mend-conv empty\n", stderr: "" }
                  : undefined,
            },
          ),
        ),
      );
      try {
        await withEngine(
          (w, directory) =>
            Effect.gen(function* () {
              const project = yield* setup(directory, w);
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: "rollback",
                start: startFromBase(null),
                ownerUserId: "user-fixture",
              });
              repository = worktreePathOf(project.storePath, session.worktree);
              const workspaceId = SealantWorkspaceId.make("workspace-1");
              w.sessions.set(
                session.id,
                new Session({ ...session, sealantWorkspaceId: workspaceId, status: "completed" }),
              );
              w.executorLaunches.set(session.id, { workspaceId, launchId: "rollback-launch" });
              state.worktrees.set(session.worktreeId, { layout: "person", requested: null });
              state.launches.set("rollback-launch", {
                launchId: "rollback-launch",
                worktreeId: session.worktreeId,
                sessionId: session.id,
                layout: "person",
                source: "flag",
                reason: null,
                imageKey: null,
                confirmed: true,
              });
              const checkpointId = CheckpointId.make("engine-origin");
              const boundaryId = TurnBoundaryId.make("engine-origin-boundary");
              yield* Effect.promise(() =>
                run(
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id) VALUES (${project.id},'Fixture',${project.storePath},'main','org-test','user-fixture')`;
                    yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES (${session.worktreeId},${project.id},'rollback',${session.worktree},${session.branch},${session.baseSha})`;
                    yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,harness,worktree,branch,base_sha,status,owner_user_id,provider_session_id,sealant_workspace_id) VALUES (${session.id},${project.id},${session.worktreeId},'codex',${session.worktree},${session.branch},${session.baseSha},'completed','user-fixture','old-native',${workspaceId})`;
                    yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status,exited_at) VALUES ('old-process',${session.id},${workspaceId},'agent-protocol','codex','completed',now())`;
                    yield* sql`INSERT INTO checkpoints (id,worktree_id,session_id,ordinal,ref,sha,seq,trigger) VALUES (${checkpointId},${session.worktreeId},${session.id},0,'refs/mend/engine/zero',${session.baseSha},0,'turn-boundary')`;
                    yield* (yield* SessionHistoryRepo).observe({
                      kind: "ready",
                      boundary: {
                        id: boundaryId,
                        sessionId: session.id,
                        revision: 0,
                        anchor: { kind: "threadStart" },
                        nativeSeedId: null,
                        originProof: {
                          processId: SessionProcessId.make("old-process"),
                          beforeFirstDispatch: true,
                          contextSnapshotId: null,
                        },
                        checkpointId,
                        checkpointSha: session.baseSha,
                        gitHead: session.baseSha,
                        reviewBase: { sha: session.baseSha, ref: "main" },
                        repositorySeed: null,
                        selection: {
                          harness: "codex",
                          model: null,
                          effort: null,
                          interactionMode: "default",
                        },
                        observedAt: new Date(),
                        nativeObservedAt: new Date(),
                        record: { runId: SealantRunId.make("old-run"), seq: 0n },
                      },
                    });
                    yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,input,status,provider_turn_id) VALUES ('withdraw-me',${session.id},'old-process',0,'later words','completed','old-turn')`;
                  }),
                ),
              );
              fs.writeFileSync(path.join(repository, "staged.txt"), "actual staged bytes\n");
              yield* Effect.promise(() =>
                exec("git", ["add", "staged.txt"], { cwd: repository, env: cleanEnv }),
              );
              fs.writeFileSync(path.join(repository, "staged.txt"), "latest editor bytes\n");
              const originalIndex = fs.readFileSync(
                path.resolve(
                  repository,
                  (yield* Effect.promise(() =>
                    exec("git", ["rev-parse", "--git-path", "index"], {
                      cwd: repository,
                      env: cleanEnv,
                    }),
                  )).stdout.trim(),
                ),
              );
              const input = {
                actor: "user-fixture",
                commandId: "engine-rollback",
                request: {
                  sessionId: session.id,
                  at: { checkpointId, boundaryId },
                  expected: { historyRevision: 0, worktreeEpoch: 0 },
                },
              };
              const result = yield* engine.rollbackSession(input);
              expect(result.progress).toMatchObject({
                kind: "complete",
                result: { position: { historyRevision: 1, worktreeEpoch: 1 }, files: "restored" },
              });
              const replay = yield* engine.rollbackSession(input);
              expect(replay).toEqual(result);
              expect(opened).toBe(1);
              expect(peer.written.map((frame) => frame.method)).toEqual([
                "initialize",
                "initialized",
                "thread/start",
              ]);
              expect(fs.existsSync(path.join(repository, "staged.txt"))).toBe(false);
              const head = yield* Effect.promise(() =>
                exec("git", ["rev-parse", "HEAD"], { cwd: repository, env: cleanEnv }),
              );
              expect(head.stdout.trim()).toBe(session.baseSha);
              const rows = yield* Effect.promise(() =>
                run(
                  Effect.gen(function* () {
                    const history = yield* SessionHistoryRepo;
                    return {
                      view: yield* history.read(session.id),
                      save: yield* history.recovery(result.id),
                    };
                  }),
                ),
              );
              expect(rows.view.turns?.[0]).toMatchObject({
                status: "completed",
                withdrawnHistoryRevision: 1,
              });
              expect(rows.view.providerSessionId).toBe("thread-1");
              if (rows.save === null) return yield* Effect.die("No retained recovery save");
              const indexBytes = yield* makeFsBlobStore(
                path.join(project.storePath, "history-blobs"),
              ).get(rows.save.index.key);
              const savedIndex = Schema.decodeUnknownSync(
                Schema.fromJsonString(
                  Schema.Struct({ raw: Schema.String, support: Schema.String }),
                ),
              )(new TextDecoder().decode(indexBytes));
              expect(Buffer.from(savedIndex.raw, "base64")).toEqual(originalIndex);
              expect(originalIndex.byteLength).toBeGreaterThan(0);
              expect(logins.some((call) => call.startsWith("post:user-fixture:"))).toBe(true);
            }),
          {
            fixture: { tmp, world },
            history: { layer: historyLayer },
            protocolHostLayer: hostLayer,
            sealantLayer: platform,
            harnessLayout: {
              flag: "person",
              state,
              platform: personPlatform(logins, { person: true }),
            },
            wrapProcesses: (inner) => ({
              ...inner,
              create: (input) =>
                withDatabase(
                  Effect.flatMap(SessionProcessesRepo, (repo) => repo.create(input)),
                ).pipe(
                  Effect.tap((process) =>
                    Effect.sync(() => {
                      world.processes.set(process.id, process);
                    }),
                  ),
                ),
              markExited: (id, how, code) =>
                withDatabase(
                  Effect.flatMap(SessionProcessesRepo, (repo) => repo.markExited(id, how, code)),
                ).pipe(Effect.andThen(inner.markExited(id, how, code))),
            }),
          },
        );
      } finally {
        peer.end();
        console.info("Removing task-owned engine rollback fixture", tmp, fs.readdirSync(tmp));
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
