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
import {
  CheckpointId,
  SealantRunId,
  SealantWorkspaceId,
  SessionProcessId,
  SessionId,
} from "@mend/domain";
import { Session, SessionProcess, TurnBoundaryId } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import { SessionEngine, startFromBase } from "@mend/sessions";
import { makeFsBlobStore, worktreePathOf } from "@mend/store";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ProtocolHostLive } from "../src/protocol-host.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { headFlush, shipCaptureFiles } from "./engine/capture-fixture.ts";
import { fakeExecRun, makeWorld, sealantLaunchLayer, setup, withEngine } from "./engine/fixture.ts";
import { personPlatform } from "./engine/person-fixture.ts";
import { startPickupChannel } from "./pickup-channel.ts";
import { makePipe } from "./support/codex-peer.ts";

const claudePipe = (onUser: () => void) => {
  const base = makePipe([]);
  const written: Array<Readonly<Record<string, unknown>>> = [];
  return {
    ...base,
    written,
    pipe: {
      ...base.pipe,
      send: (input: string | Uint8Array) => {
        const frame = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(typeof input === "string" ? input : new TextDecoder().decode(input));
        written.push(frame);
        if (frame["type"] === "control_request")
          base.push({
            type: "control_response",
            response: { subtype: "success", request_id: frame["request_id"] },
          });
        if (frame["type"] === "user") {
          base.push({ type: "system", subtype: "init", session_id: frame["session_id"] });
          base.push({
            type: "result",
            subtype: "success",
            session_id: frame["session_id"],
            result: "done",
          });
          onUser();
        }
        return Promise.resolve();
      },
    },
  };
};

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
    beforeEach(async () => {
      await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE projects CASCADE`));
    });
    afterAll(async () => {
      if (created)
        await Effect.runPromise(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`),
          ).pipe(Effect.provide(admin), Effect.scoped),
        );
    });

    it.each([
      { layout: "person", harness: "codex", initiallyStopped: false },
      { layout: "shared", harness: "codex", initiallyStopped: false },
      { layout: "person", harness: "claude", initiallyStopped: false },
      { layout: "shared", harness: "claude", initiallyStopped: false },
      { layout: "shared", harness: "codex", initiallyStopped: true },
      { layout: "shared", harness: "claude", initiallyStopped: true },
    ] as const)(
      "$layout $harness stopped=$initiallyStopped saves staging, publishes zero and sends once through its retained replacement",
      async ({ layout, harness, initiallyStopped }) => {
        const tmp = (
          await exec("mktemp", ["-d", "-t", "mend-engine-rollback.XXXXXX"])
        ).stdout.trim();
        const world = makeWorld();
        const memory = makeMemoryCaptureStore();
        const state = makeHarnessLayoutsMemoryState();
        const peer = harness === "codex" ? makePipe([]) : claudePipe(() => {});
        const sent = Promise.withResolvers<void>();
        const nextPeer =
          harness === "claude"
            ? claudePipe(() => sent.resolve())
            : makePipe(["after-rollback"], {
                start: async (request, push) => {
                  push({ id: request.id, result: { turn: { id: "after-rollback" } } });
                  sent.resolve();
                },
              });
        const scripts: string[] = [];
        const logins: string[] = [];
        const pickup = await startPickupChannel();
        let repository = "";
        let opened = 0;
        let missingTranscript = false;
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
            getWorkspace: (id) =>
              inner.getWorkspace(id).pipe(
                Effect.map((workspace) =>
                  id === "prior-workspace"
                    ? { ...workspace, status: async () => "stopped" as const }
                    : workspace,
                ),
              ),
            openSession: (workspace, argv, options) => {
              if (options?.mode !== "pipe") return inner.openSession(workspace, argv, options);
              opened++;
              return Effect.succeed(opened === 1 ? peer.pipe : nextPeer.pipe);
            },
            getSession: () => Effect.succeed(opened <= 1 ? peer.pipe : nextPeer.pipe),
            exec: (workspace, argv, options) => {
              if (argv[3] === "mend-write" && argv.some((arg) => arg.endsWith("/.mend-history"))) {
                const mapPath = (value: string) =>
                  value.replaceAll(
                    "/workspace/harness-home",
                    path.join(tmp, "workspace", "workspace/harness-home"),
                  );
                const targets = argv.slice(5).map(mapPath);
                const marker = targets.find((arg) => arg.endsWith("/.mend-history"));
                if (marker === undefined) throw new Error("Missing native marker target");
                fs.mkdirSync(path.join(tmp, "workspace", "workspace/harness-home"), {
                  recursive: true,
                });
                const ticket = pickup.mint([
                  {
                    path: marker,
                    bytes: new TextEncoder().encode("operation"),
                  },
                ]);
                return Effect.tryPromise({
                  try: async () => ({
                    ...(await exec("sh", [...argv.slice(1, 4), ticket, ...targets], {
                      env: { ...cleanEnv, ...pickup.env },
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
              }
              if (argv[0] !== "node" || argv[1] !== "-e" || argv[3] === undefined)
                return inner.exec(workspace, argv, options);
              const raw: unknown = JSON.parse(argv[3]);
              const input = Schema.decodeUnknownSync(fileInput)(argv[3]);
              if (input.repository !== "/workspace/repo")
                return inner.exec(workspace, argv, options);
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
                flush: headFlush(memory),
                exec: (argv) => {
                  if (argv[0] !== "sh") return undefined;
                  scripts.push(argv[2] ?? "");
                  return {
                    exitCode: 0,
                    stdout: `${missingTranscript ? "mend-conv missing\n" : ""}mend-conv empty\n`,
                    stderr: "",
                  };
                },
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
                  harness,
                  label: null,
                  name: "rollback",
                  start: startFromBase(null),
                  ownerUserId: "user-fixture",
                });
                repository =
                  layout === "person"
                    ? path.join(directory, "origin")
                    : worktreePathOf(project.storePath, session.worktree);
                const workspaceId = SealantWorkspaceId.make(
                  initiallyStopped ? "prior-workspace" : "workspace-1",
                );
                w.sessions.set(
                  session.id,
                  new Session({ ...session, sealantWorkspaceId: workspaceId, status: "completed" }),
                );
                w.executorLaunches.set(session.id, { workspaceId, launchId: "rollback-launch" });
                state.worktrees.set(session.worktreeId, {
                  layout: layout === "person" ? "person" : null,
                  requested: null,
                });
                state.launches.set("rollback-launch", {
                  launchId: "rollback-launch",
                  worktreeId: session.worktreeId,
                  sessionId: session.id,
                  layout,
                  source: "flag",
                  reason: null,
                  imageKey: null,
                  confirmed: true,
                });
                memory.leases.set(session.worktreeId, {
                  executorId: session.id,
                  launchId: "rollback-launch",
                  epoch: 1,
                  expiresAt: Date.now() + 300_000,
                });
                if (layout === "person")
                  yield* shipCaptureFiles(tmp, memory, session.worktreeId, 1, {
                    "harness/retained.txt": "fake capture",
                  }).pipe(Effect.provide(memory.layer));
                const checkpointId = CheckpointId.make("engine-origin");
                const boundaryId = TurnBoundaryId.make("engine-origin-boundary");
                yield* Effect.promise(() =>
                  run(
                    Effect.gen(function* () {
                      const sql = yield* SqlClient.SqlClient;
                      yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id) VALUES (${project.id},'Fixture',${project.storePath},'main','org-test','user-fixture')`;
                      yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES (${session.worktreeId},${project.id},'rollback',${session.worktree},${session.branch},${session.baseSha})`;
                      yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,harness,worktree,branch,base_sha,status,owner_user_id,provider_session_id,sealant_workspace_id) VALUES (${session.id},${project.id},${session.worktreeId},${harness},${session.worktree},${session.branch},${session.baseSha},'completed','user-fixture','old-native',${workspaceId})`;
                      yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status,exited_at) VALUES ('old-process',${session.id},${workspaceId},'agent-protocol',${harness},'exited',now())`;
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
                            harness,
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
                  commandId: `engine-rollback-${layout}-${harness}-${initiallyStopped}`,
                  request: {
                    sessionId: session.id,
                    at: { checkpointId, boundaryId },
                    expected: { historyRevision: 0, worktreeEpoch: 0 },
                  },
                };
                if (layout === "shared") {
                  const holder = new Session({
                    ...session,
                    id: SessionId.make("other-holder"),
                    ownerUserId: "another-person",
                    sealantWorkspaceId: workspaceId,
                  });
                  w.sessions.set(holder.id, holder);
                  w.executorLaunches.delete(session.id);
                  w.executorLaunches.set(holder.id, { workspaceId, launchId: "rollback-launch" });
                  const effectsBefore = scripts.length;
                  const refused = yield* engine.rollbackSession(input).pipe(Effect.result);
                  expect(refused).toMatchObject({ failure: { code: "login_required" } });
                  expect(opened).toBe(0);
                  expect(scripts).toHaveLength(effectsBefore);
                  expect(fs.readFileSync(path.join(repository, "staged.txt"), "utf8")).toBe(
                    "latest editor bytes\n",
                  );
                  const noReceipt = yield* Effect.promise(() =>
                    run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(session.id))),
                  );
                  expect(noReceipt.rollback).toBeNull();
                  w.executorLaunches.delete(holder.id);
                  w.sessions.delete(holder.id);
                  w.executorLaunches.set(session.id, { workspaceId, launchId: "rollback-launch" });
                }
                const result = yield* engine.rollbackSession(input);
                expect(result.progress, JSON.stringify(result.progress)).toMatchObject({
                  kind: "complete",
                  result: { position: { historyRevision: 1, worktreeEpoch: 1 }, files: "restored" },
                });
                const replay = yield* engine.rollbackSession(input);
                expect(replay).toEqual(result);
                expect(opened).toBe(1);
                if (harness === "codex")
                  expect(
                    peer.written.map((frame) => ("method" in frame ? frame.method : null)),
                  ).toEqual(["initialize", "initialized", "thread/start"]);
                else
                  expect(peer.written).toMatchObject([
                    { type: "control_request", request: { subtype: "initialize" } },
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
                expect(rows.view.providerSessionId).toBe(
                  harness === "codex" ? "thread-1" : rows.view.nativeBinding?.key,
                );
                if (rows.save === null) return yield* Effect.die("No retained recovery save");
                const indexBytes = yield* makeFsBlobStore(
                  layout === "person"
                    ? path.join(tmp, "blobs")
                    : path.join(project.storePath, "history-blobs"),
                ).get(rows.save.index.key);
                const savedIndex = Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.Struct({ raw: Schema.String, support: Schema.String }),
                  ),
                )(new TextDecoder().decode(indexBytes));
                expect(Buffer.from(savedIndex.raw, "base64")).toEqual(originalIndex);
                expect(originalIndex.byteLength).toBeGreaterThan(0);
                expect(logins.some((call) => call.startsWith("post:user-fixture:"))).toBe(true);
                const coreSession = w.sessions.get(session.id);
                if (coreSession === undefined) return yield* Effect.die("Session missing");
                w.sessions.set(
                  session.id,
                  new Session({
                    ...coreSession,
                    providerSessionId: rows.view.providerSessionId ?? null,
                  }),
                );
                const stopped = [...w.processes.values()].find(
                  (row) => row.kind === "agent-protocol",
                );
                if (stopped === undefined) return yield* Effect.die("No candidate process");
                w.processes.set(
                  "supporting-shell",
                  new SessionProcess({
                    ...stopped,
                    id: SessionProcessId.make("supporting-shell"),
                    kind: "shell",
                    status: "running",
                    exitedAt: null,
                  }),
                );
                const beforeNext = scripts.length;
                yield* engine.launchProtocol(
                  session.id,
                  { mode: "protocol", model: "gpt-test", effort: "medium" },
                  "user-fixture",
                );
                if (harness === "codex") {
                  expect(
                    nextPeer.written.map((frame) => ("method" in frame ? frame.method : null)),
                  ).toContain("thread/resume");
                  expect(
                    nextPeer.written.map((frame) => ("method" in frame ? frame.method : null)),
                  ).not.toContain("thread/start");
                } else
                  expect(nextPeer.written).toMatchObject([
                    { type: "control_request", request: { subtype: "initialize" } },
                  ]);
                expect(
                  scripts
                    .slice(beforeNext)
                    .some((script) =>
                      script.includes(rows.view.nativeBinding?.key ?? "missing-binding"),
                    ),
                ).toBe(true);
                const next = yield* engine.submitTurn(
                  session.id,
                  "new words after Undo",
                  "user-fixture",
                );
                expect(next.ordinal).toBe(1);
                yield* Effect.promise(() => sent.promise).pipe(Effect.timeout("5 seconds"));
                const words = nextPeer.written.filter(
                  (frame) =>
                    ("method" in frame && frame.method === "turn/start") ||
                    ("type" in frame && frame.type === "user"),
                );
                expect(words).toHaveLength(1);
                expect(JSON.stringify(words)).toContain("new words after Undo");
                if (harness === "claude") {
                  yield* Effect.promise(() =>
                    expect
                      .poll(async () => {
                        const turnRows = await run(
                          Effect.flatMap(
                            SqlClient.SqlClient,
                            (sql) =>
                              sql<{
                                status: string;
                              }>`SELECT status FROM agent_turns WHERE id=${next.id}`,
                          ),
                        );
                        return turnRows[0]?.status;
                      })
                      .toBe("completed"),
                  );
                  missingTranscript = true;
                  yield* withDatabase(
                    Effect.gen(function* () {
                      const processes = yield* SessionProcessesRepo;
                      for (const process of yield* processes.listForSession(session.id)) {
                        if (process.kind !== "agent-protocol" || process.exitedAt !== null)
                          continue;
                        yield* processes.markExited(process.id, "exited", 0);
                        state.exitedProcesses.add(process.id);
                        w.processes.set(
                          process.id,
                          new SessionProcess({
                            ...process,
                            status: "exited",
                            exitedAt: new Date(),
                          }),
                        );
                      }
                    }),
                  );
                  const stoppedSession = w.sessions.get(session.id);
                  if (stoppedSession === undefined) return yield* Effect.die("Session missing");
                  w.sessions.set(
                    session.id,
                    new Session({ ...stoppedSession, status: "completed" }),
                  );
                  const openedBeforeMissing = opened;
                  const denied = yield* engine
                    .launchProtocol(session.id, { mode: "protocol" }, "user-fixture")
                    .pipe(Effect.result);
                  expect(denied).toMatchObject({ failure: { code: "conversation_missing" } });
                  expect(opened).toBe(openedBeforeMissing);
                }
              }),
            {
              fixture: { tmp, world },
              ...(layout === "person" ? { captured: memory } : {}),
              history: { layer: historyLayer },
              protocolHostLayer: hostLayer,
              sealantLayer: platform,
              harnessLayout: {
                flag: layout,
                state,
                platform: personPlatform(logins, { person: true }),
              },
              wrapProcesses: (inner) => ({
                ...inner,
                listForSession: (id) =>
                  withDatabase(
                    Effect.flatMap(SessionProcessesRepo, (repo) => repo.listForSession(id)),
                  ),
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
          await pickup.close();
          peer.end();
          nextPeer.end();
          console.info("Removing task-owned engine rollback fixture", tmp, fs.readdirSync(tmp));
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
      30_000,
    );
  },
);
