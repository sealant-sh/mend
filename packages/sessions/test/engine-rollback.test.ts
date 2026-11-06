import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { promisify } from "node:util";

import { PgClient } from "@effect/sql-pg";
import { sealNativeHistory } from "@mend/agent-protocol";
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
import { PersonLayoutPlatform, SealantClient, SealantPlatformError } from "@mend/sealant";
import { SessionEngine, startFromBase } from "@mend/sessions";
import { makeFsBlobStore, worktreePathOf } from "@mend/store";
import { Sealant, type InteractiveSession } from "@sealant/sdk";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ProtocolHostLive } from "../src/protocol-host.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { headFlush, shipCaptureFiles } from "./engine/capture-fixture.ts";
import {
  fakeExecRun,
  makeWorld,
  redeemPickupExec,
  sealantLaunchLayer,
  setup,
  withEngine,
} from "./engine/fixture.ts";
import { isPrepare, LAYOUT_READY, personPlatform } from "./engine/person-fixture.ts";
import { startPickupChannel } from "./pickup-channel.ts";
import { makePipe } from "./support/codex-peer.ts";

const claudePipe = (onUser: (id: string) => void) => {
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
          onUser(String(frame["session_id"]));
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
      {
        layout: "person",
        harness: "codex",
        initiallyStopped: false,
        prefix: false,
        captured: false,
      },
      {
        layout: "shared",
        harness: "codex",
        initiallyStopped: false,
        prefix: false,
        captured: false,
      },
      {
        layout: "person",
        harness: "claude",
        initiallyStopped: false,
        prefix: false,
        captured: false,
      },
      {
        layout: "shared",
        harness: "claude",
        initiallyStopped: false,
        prefix: false,
        captured: false,
      },
      {
        layout: "shared",
        harness: "codex",
        initiallyStopped: true,
        prefix: false,
        captured: false,
      },
      {
        layout: "shared",
        harness: "claude",
        initiallyStopped: true,
        prefix: false,
        captured: false,
      },
      {
        layout: "shared",
        harness: "codex",
        initiallyStopped: false,
        prefix: true,
        captured: false,
      },
      {
        layout: "shared",
        harness: "claude",
        initiallyStopped: false,
        prefix: true,
        captured: false,
      },
      {
        layout: "person",
        harness: "codex",
        initiallyStopped: false,
        prefix: true,
        captured: false,
      },
      {
        layout: "person",
        harness: "claude",
        initiallyStopped: false,
        prefix: true,
        captured: false,
      },
      { layout: "shared", harness: "codex", initiallyStopped: false, prefix: true, captured: true },
      {
        layout: "shared",
        harness: "claude",
        initiallyStopped: false,
        prefix: true,
        captured: true,
      },
    ] as const)(
      "$layout $harness stopped=$initiallyStopped prefix=$prefix captured=$captured saves staging and sends once through its retained replacement",
      async ({ layout, harness, initiallyStopped, prefix, captured }) => {
        const tmp = (
          await exec("mktemp", ["-d", "-t", "mend-engine-rollback.XXXXXX"])
        ).stdout.trim();
        const world = makeWorld();
        const memory = makeMemoryCaptureStore();
        const state = makeHarnessLayoutsMemoryState();
        const nativeRoot = path.join(tmp, "workspace", "workspace/harness-home");
        let activeRoot = nativeRoot;
        const sourceId = "11111111-1111-4111-8111-111111111111";
        let inheritedTranscript = "";
        const materialize = (id: string, root = activeRoot) => {
          const relative =
            harness === "claude"
              ? `.claude/projects/-workspace-repo/${id}.jsonl`
              : `.codex/sessions/2026/11/06/rollout-test-${id}.jsonl`;
          const at = path.join(root, relative);
          fs.mkdirSync(path.dirname(at), { recursive: true });
          fs.writeFileSync(
            at,
            (id !== sourceId && inheritedTranscript !== ""
              ? inheritedTranscript
                  .trim()
                  .split("\n")
                  .map((line) => {
                    const value = Schema.decodeUnknownSync(
                      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
                    )(line);
                    return JSON.stringify(
                      harness === "claude"
                        ? { ...value, sessionId: id }
                        : value["type"] === "session_meta"
                          ? {
                              ...value,
                              payload: {
                                ...Schema.decodeUnknownSync(
                                  Schema.Record(Schema.String, Schema.Unknown),
                                )(value["payload"]),
                                id,
                              },
                            }
                          : value,
                    );
                  })
                  .join("\n") + "\n"
              : "") +
              JSON.stringify(
                harness === "claude"
                  ? {
                      type: "assistant",
                      sessionId: id,
                      uuid: id === sourceId ? "22222222-2222-4222-8222-222222222222" : randomUUID(),
                      parentUuid: null,
                      version: "2.1.318",
                      message: {
                        role: "assistant",
                        content: [{ type: "text", text: "native response" }],
                      },
                    }
                  : id !== sourceId && inheritedTranscript !== ""
                    ? { type: "response_item", payload: { content: "native response" } }
                    : {
                        type: "session_meta",
                        payload: { id, history_mode: "legacy", cli_version: "0.162.1" },
                      },
              ) +
              "\n",
          );
          return at;
        };
        let currentSessionId: SessionId | null = null;
        let candidateNativeId = "";
        let candidateKey = "";
        const nativePeers: Array<ReturnType<typeof makePipe>> = [];
        const sent = Promise.withResolvers<void>();
        let refuseNextPreparation = false;
        let confirmRecoveryStop = false;
        const codexPeer = (after = false) =>
          makePipe([], {
            thread: async (request, push) => {
              if (refuseNextPreparation && request.method === "thread/fork") {
                refuseNextPreparation = false;
                push({ id: request.id, error: { message: "Native preparation refused" } });
                return;
              }
              const id =
                request.method === "thread/resume"
                  ? (request.params?.threadId ?? "missing")
                  : randomUUID();
              if (request.method !== "thread/resume") {
                inheritedTranscript =
                  request.params?.path === undefined
                    ? ""
                    : fs.readFileSync(
                        request.params.path.replaceAll("/workspace/harness-home", nativeRoot),
                        "utf8",
                      );
                candidateNativeId = id;
                materialize(id);
              }
              push({
                id: request.id,
                result: {
                  thread: {
                    id,
                    forkedFromId: request.params?.threadId,
                    historyMode: "legacy",
                    cliVersion: "0.162.1",
                    turns:
                      request.params?.lastTurnId === undefined
                        ? []
                        : [{ id: request.params.lastTurnId }],
                  },
                },
              });
            },
            start: async (request, push) => {
              push({ id: request.id, result: { turn: { id: "after-rollback" } } });
              push({
                method: "turn/completed",
                params: {
                  threadId: request.params?.threadId,
                  turn: { id: "after-rollback", status: "completed" },
                },
              });
              if (after) sent.resolve();
            },
          });
        const peer =
          harness === "codex"
            ? codexPeer()
            : claudePipe((id) => {
                materialize(id);
              });
        const nextPeer =
          harness === "claude"
            ? claudePipe((id) => {
                materialize(id);
                sent.resolve();
              })
            : codexPeer(true);
        const sourceTranscript =
          harness === "claude"
            ? `.claude/projects/-workspace-repo/${sourceId}.jsonl`
            : `.codex/sessions/2026/11/06/rollout-test-${sourceId}.jsonl`;
        const selectedMessage = "22222222-2222-4222-8222-222222222222";
        const plan = ".claude/plans/selected.md";
        const prefixContent =
          JSON.stringify(
            harness === "claude"
              ? {
                  type: "assistant",
                  sessionId: sourceId,
                  uuid: selectedMessage,
                  parentUuid: null,
                  version: "2.1.318",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: `SELECTED /root/${plan}` }],
                  },
                }
              : {
                  type: "session_meta",
                  payload: { id: sourceId, history_mode: "legacy", cli_version: "0.162.1" },
                },
          ) +
          "\n" +
          (harness === "codex"
            ? JSON.stringify({
                type: "event_msg",
                payload: { type: "task_complete", turn_id: "selected-native" },
              }) + "\n"
            : "");
        const seed = prefix
          ? await Effect.runPromise(
              sealNativeHistory({
                observation: {
                  providerVersion: harness === "claude" ? "2.1.318" : "0.162.1",
                  cutoff:
                    harness === "claude"
                      ? {
                          provider: "claude",
                          sessionId: sourceId,
                          throughMessageId: selectedMessage,
                        }
                      : {
                          provider: "codex",
                          threadId: sourceId,
                          throughTurnId: "selected-native",
                          historyMode: "legacy",
                        },
                },
                files: [
                  { relativePath: sourceTranscript, content: prefixContent },
                  ...(harness === "claude"
                    ? [{ relativePath: plan, content: "SELECTED PLAN" }]
                    : []),
                ],
              }),
            )
          : null;
        const scripts: string[] = [];
        const logins: string[] = [];
        const credentialPosts: string[] = [];
        const forbiddenHome = "/run/mend-conv/ff51d664-c8e7-4c4a-b0c8-5623cdb0fb00";
        const refusal = `${forbiddenHome} is not a home Core writes into: it belongs to root and is not /root, or its parent is one its owner could rename it in. Nothing was written.`;
        const credentialServer = http.createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            response.setHeader("content-type", "application/json");
            const body: unknown =
              chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString());
            if (request.method === "POST" && request.url?.split("?")[0]?.endsWith("/credentials")) {
              const home = Schema.decodeUnknownSync(Schema.Struct({ home: Schema.String }))(
                body,
              ).home;
              credentialPosts.push(home);
              if (layout === "shared" && home !== "/root") {
                response.writeHead(409);
                response.end(JSON.stringify({ code: "home-not-writable", message: refusal }));
                return;
              }
              response.end(
                JSON.stringify({
                  workspaceId: "sdk-fixture",
                  runId: "sdk-run",
                  home: { home, onBehalfOfUserId: "user-fixture", accounts: {} },
                  skipped: [],
                }),
              );
              return;
            }
            response.end(
              JSON.stringify({
                workspaceId: "sdk-fixture",
                name: "fixture",
                ownerUserId: "user-fixture",
                status: "running",
                createdAt: "2026-11-06T00:00:00Z",
                updatedAt: "2026-11-06T00:00:00Z",
              }),
            );
          });
        });
        await new Promise<void>((resolve) => credentialServer.listen(0, "127.0.0.1", resolve));
        const address = credentialServer.address();
        if (address === null || typeof address === "string") throw new Error("No fixture port");
        const sdk = new Sealant({ baseUrl: `http://127.0.0.1:${address.port}` });
        const sdkWorkspace = await sdk.workspaces.get("sdk-fixture");
        if (layout === "shared") {
          await expect(
            sdkWorkspace.credentials.put({
              home: forbiddenHome,
              onBehalfOf: "user-fixture",
              [harness]: true,
            }),
          ).rejects.toThrow(/409/);
          credentialPosts.length = 0;
        }
        const loginPlatform = Layer.effect(
          PersonLayoutPlatform,
          Effect.map(PersonLayoutPlatform, (inner) => ({
            ...inner,
            postCredentials: (_workspace, input) =>
              Effect.tryPromise({
                try: async () => {
                  logins.push(`post:${input.onBehalfOf}:${input.home}`);
                  return await sdkWorkspace.credentials.put({
                    home: input.home,
                    onBehalfOf: input.onBehalfOf,
                    ...input.logins,
                    ...(input.owner === undefined
                      ? {}
                      : { uid: input.owner.uid, gid: input.owner.gid }),
                  });
                },
                catch: (cause) =>
                  new SealantPlatformError({
                    code: "home-not-writable",
                    status: 409,
                    message: String(cause),
                    cause,
                  }),
              }),
          })),
        ).pipe(Layer.provide(personPlatform(logins, { person: true })));

        const pickup = await startPickupChannel();
        let repository = "";
        let opened = 0;
        const nativeSessions = new Map<string, InteractiveSession>();
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
                Effect.map((workspace) => ({
                  ...workspace,
                  id,
                  ...(id === "prior-workspace" ? { status: async () => "stopped" as const } : {}),
                })),
              ),
            stopWorkspace: (workspace, options) =>
              inner
                .stopWorkspace(workspace, options)
                .pipe(
                  Effect.map((result) =>
                    confirmRecoveryStop ? { ...result, state: "stopped" as const } : result,
                  ),
                ),
            openSession: (workspace, argv, options) => {
              if (options?.mode !== "pipe") return inner.openSession(workspace, argv, options);
              opened++;
              const resumeAt = argv.indexOf("--resume");
              if (harness === "claude" && argv.includes("--fork-session") && resumeAt >= 0)
                inheritedTranscript = fs.readFileSync(
                  (argv[resumeAt + 1] ?? "missing").replaceAll(
                    "/workspace/harness-home",
                    nativeRoot,
                  ),
                  "utf8",
                );
              const chosen =
                opened === 1
                  ? peer
                  : opened === 2
                    ? nextPeer
                    : harness === "codex"
                      ? codexPeer(true)
                      : claudePipe((id) => {
                          materialize(id);
                          sent.resolve();
                        });
              if (opened > 2) nativePeers.push(chosen);
              let closed = false;
              const pipe: InteractiveSession = {
                ...chosen.pipe,
                id: `native-pipe-${opened}`,
                close: async () => {
                  closed = true;
                  chosen.end();
                },
                status: async () => ({
                  status: closed ? "exited" : "running",
                  outputHighWater: 0n,
                }),
              };
              nativeSessions.set(pipe.id, pipe);
              return Effect.succeed(pipe);
            },
            getSession: (workspace, id) => {
              const pipe = nativeSessions.get(id);
              return pipe === undefined ? inner.getSession(workspace, id) : Effect.succeed(pipe);
            },
            exec: (workspace, received, options) => {
              const command =
                received[3] === "mend-as-person"
                  ? received.findIndex(
                      (arg, index) => index > 4 && (arg === "sh" || arg === "node"),
                    )
                  : -1;
              const argv = command < 0 ? received : received.slice(command);
              if (
                layout === "shared" &&
                argv[0] === "sh" &&
                argv[2]?.includes('mkdir -m 0700 "$N"')
              ) {
                const control = path.join(
                  tmp,
                  initiallyStopped ? "read-only-control" : "writable-control",
                );
                fs.mkdirSync(control, { recursive: true, mode: initiallyStopped ? 0o555 : 0o700 });
                const proc = path.join(tmp, "empty-proc");
                fs.mkdirSync(proc, { recursive: true });
                const script = argv[2]
                  .replaceAll(
                    "/workspace/harness-home",
                    path.join(tmp, "workspace", "workspace/harness-home"),
                  )
                  .replaceAll("/run/mend", control)
                  .replaceAll("/proc", proc)
                  .replaceAll("/root", path.join(tmp, "fake-root"));
                return Effect.tryPromise({
                  try: async () => ({
                    ...(await exec("sh", ["-c", script], { env: cleanEnv })),
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
              if (
                argv[3] === "mend-write" &&
                argv.some(
                  (arg) =>
                    arg.endsWith("/.mend-history") ||
                    (prefix && candidateKey !== "" && arg.includes(candidateKey)),
                )
              ) {
                const mapPath = (value: string) =>
                  value.replaceAll(
                    "/workspace/harness-home",
                    path.join(tmp, "workspace", "workspace/harness-home"),
                  );
                const targets = argv.slice(5).map(mapPath);
                const marker = targets.find((arg) => arg.endsWith("/.mend-history"));
                if (marker !== undefined) {
                  candidateKey = path.basename(path.dirname(marker));
                  activeRoot = layout === "person" ? path.dirname(marker) : nativeRoot;
                }
                fs.mkdirSync(path.join(tmp, "workspace", "workspace/harness-home"), {
                  recursive: true,
                });
                const payload = prefix
                  ? redeemPickupExec(
                      argv,
                      currentSessionId,
                      world.executorLaunches.get(currentSessionId ?? SessionId.make("missing"))
                        ?.launchId ?? null,
                      layout === "person" ? "user-fixture" : null,
                    ).pipe(
                      Effect.map((answer) =>
                        answer.files.map((file) => ({
                          path: mapPath(file.path),
                          bytes: Buffer.from(file.base64, "base64"),
                        })),
                      ),
                      Effect.mapError(
                        (cause) =>
                          new SealantPlatformError({
                            code: "fake_pickup_failed",
                            status: null,
                            message: String(cause),
                            cause,
                          }),
                      ),
                    )
                  : Effect.succeed([
                      { path: marker ?? "missing", bytes: new TextEncoder().encode("operation") },
                    ]);
                return Effect.flatMap(payload, (files) => {
                  const ticket = pickup.mint(files);
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
                });
              }
              if (argv[0] !== "node" || argv[1] !== "-e" || argv[3] === undefined)
                return inner.exec(workspace, argv, options);
              if (argv[3].startsWith("/")) {
                const mapped = argv
                  .slice(2)
                  .map((value) => value.replaceAll("/workspace/harness-home", nativeRoot));
                return Effect.tryPromise({
                  try: async () => ({
                    ...(await exec("node", ["-e", ...mapped], { env: cleanEnv })),
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
              const raw: unknown = JSON.parse(argv[3]);
              const input = Schema.decodeUnknownSync(fileInput)(argv[3]);
              if (input.repository !== "/workspace/repo")
                return inner.exec(workspace, argv, options);
              const mappedRoot = (value: string) => path.join(tmp, "workspace", value);
              const mappedNativeRoot = mappedRoot(input.nativeRoot);
              fs.mkdirSync(mappedNativeRoot, { recursive: true });
              const mapped = {
                ...(typeof raw === "object" && raw !== null ? raw : {}),
                repository,
                journalRoot: mappedRoot(input.journalRoot),
                nativeRoot: mappedNativeRoot,
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
                ptyKeepsRunning: () => true,
                exec: (argv) => {
                  if (argv[0] !== "sh") return undefined;
                  if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
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
                currentSessionId = session.id;

                credentialPosts.length = 0;
                logins.length = 0;
                repository =
                  layout === "person" || captured
                    ? path.join(directory, "origin")
                    : worktreePathOf(project.storePath, session.worktree);
                const workspaceId = SealantWorkspaceId.make(
                  initiallyStopped ? "prior-workspace" : "workspace-1",
                );
                w.sessions.set(
                  session.id,
                  new Session({
                    ...session,
                    providerSessionId: sourceId,
                    sealantWorkspaceId: workspaceId,
                    status: "completed",
                  }),
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
                if (layout === "person" || captured)
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
                      yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,harness,worktree,branch,base_sha,status,owner_user_id,provider_session_id,sealant_workspace_id) VALUES (${session.id},${project.id},${session.worktreeId},${harness},${session.worktree},${session.branch},${session.baseSha},'completed','user-fixture',${sourceId},${workspaceId})`;
                      yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status,exited_at) VALUES ('old-process',${session.id},${workspaceId},'agent-protocol',${harness},'exited',now())`;
                      yield* sql`INSERT INTO checkpoints (id,worktree_id,session_id,ordinal,ref,sha,seq,trigger) VALUES (${checkpointId},${session.worktreeId},${session.id},0,'refs/mend/engine/zero',${session.baseSha},0,'turn-boundary')`;
                      if (seed !== null)
                        yield* (yield* SessionHistoryRepo).saveSeed(seed.manifest, seed.files);
                      yield* (yield* SessionHistoryRepo).observe({
                        kind: "ready",
                        boundary: {
                          id: boundaryId,
                          sessionId: session.id,
                          revision: 0,
                          anchor: { kind: "threadStart" },
                          nativeSeedId: seed?.manifest.id ?? null,
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
                if (prefix) {
                  const beforeWake = w.sessions.get(session.id);
                  if (beforeWake === undefined) return yield* Effect.die("Missing fixture session");
                  const beforeLease = memory.leases.get(session.worktreeId);
                  if (beforeLease !== undefined)
                    memory.leases.set(session.worktreeId, {
                      executorId: null,
                      launchId: null,
                      epoch: 0,
                      expiresAt: null,
                    });
                  w.sessions.set(
                    session.id,
                    new Session({ ...beforeWake, sealantWorkspaceId: null, status: "completed" }),
                  );
                  yield* engine.wakeWorkspace(session.id, { reason: "rollback" });
                  yield* withDatabase(
                    Effect.gen(function* () {
                      const processes = yield* SessionProcessesRepo;
                      for (const process of yield* processes.listForSession(session.id)) {
                        if (process.exitedAt !== null) continue;
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
                  if (beforeLease !== undefined) memory.leases.set(session.worktreeId, beforeLease);
                  w.sessions.set(session.id, beforeWake);
                  w.executorLaunches.set(session.id, { workspaceId, launchId: "rollback-launch" });
                  credentialPosts.length = 0;
                  logins.length = 0;
                }
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
                const sourceHome =
                  layout === "person"
                    ? path.join(nativeRoot, "people", "user-fixture")
                    : nativeRoot;
                const sourceAt = materialize(sourceId, sourceHome);
                if (prefix) {
                  fs.writeFileSync(
                    sourceAt,
                    prefixContent +
                      JSON.stringify(
                        harness === "claude"
                          ? {
                              type: "assistant",
                              sessionId: sourceId,
                              uuid: "33333333-3333-4333-8333-333333333333",
                              parentUuid: selectedMessage,
                              version: "2.1.318",
                              message: { content: "LATER SOURCE" },
                            }
                          : { type: "response_item", payload: { content: "LATER SOURCE" } },
                      ) +
                      "\n",
                  );
                  if (harness === "claude") {
                    fs.mkdirSync(path.join(sourceHome, ".claude/plans"), { recursive: true });
                    fs.writeFileSync(path.join(sourceHome, plan), "LATER PLAN");
                  }
                }
                const originalSource = fs.readFileSync(sourceAt, "utf8");
                const unrelated = path.join(
                  sourceHome,
                  harness === "claude"
                    ? ".claude/plans/unrelated.md"
                    : ".codex/sessions/other-thread.jsonl",
                );
                fs.mkdirSync(path.dirname(unrelated), { recursive: true });
                fs.writeFileSync(unrelated, "OTHER SESSION NEVER RETAIN");
                const input = {
                  actor: "user-fixture",
                  commandId: `engine-rollback-${layout}-${harness}-${initiallyStopped}-${prefix}-${captured}`,
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
                if (captured) {
                  const ownLease = memory.leases.get(session.worktreeId);
                  if (ownLease === undefined) return yield* Effect.die("Missing fixture lease");
                  memory.leases.set(session.worktreeId, { ...ownLease, launchId: "other-launch" });
                  const effects = {
                    scripts: scripts.length,
                    opened,
                    credentials: credentialPosts.length,
                  };
                  const denied = yield* engine.rollbackSession(input).pipe(Effect.result);
                  expect(denied).toMatchObject({ failure: { code: "login_required" } });
                  expect({
                    scripts: scripts.length,
                    opened,
                    credentials: credentialPosts.length,
                  }).toEqual(effects);
                  memory.leases.set(session.worktreeId, ownLease);
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
                  ).toEqual(["initialize", "initialized", prefix ? "thread/fork" : "thread/start"]);
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
                  harness === "codex" ? candidateNativeId : rows.view.nativeBinding?.key,
                );
                expect(rows.view.nativeBinding?.location).toBe(
                  layout === "person" ? "revisionHome" : "holderHome",
                );
                expect(rows.view.providerSessionId).not.toBe(sourceId);
                expect(fs.readFileSync(sourceAt, "utf8")).toBe(originalSource);
                if (prefix && harness === "claude")
                  expect(fs.readFileSync(path.join(sourceHome, plan), "utf8")).toBe("LATER PLAN");
                if (prefix && harness === "claude")
                  expect(
                    fs.readFileSync(
                      path.join(
                        activeRoot,
                        layout === "shared"
                          ? `.claude/plans/${rows.view.nativeBinding?.key}-selected.md`
                          : plan,
                      ),
                      "utf8",
                    ),
                  ).toBe("SELECTED PLAN");
                if (prefix) {
                  console.info(
                    "Removing task-owned source transcript",
                    sourceAt,
                    fs.statSync(sourceAt).size,
                  );
                  fs.unlinkSync(sourceAt);
                }
                if (rows.save === null) return yield* Effect.die("No retained recovery save");
                const recoveryBlobs = makeFsBlobStore(
                  layout === "person" || captured
                    ? path.join(tmp, "blobs")
                    : path.join(project.storePath, "history-blobs"),
                );
                const indexBytes = yield* recoveryBlobs.get(rows.save.index.key);
                const nativeBytes = yield* recoveryBlobs.get(rows.save.native.key);
                expect(new TextDecoder().decode(nativeBytes)).not.toContain(
                  Buffer.from("OTHER SESSION NEVER RETAIN").toString("base64"),
                );
                const savedIndex = Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.Struct({ raw: Schema.String, support: Schema.String }),
                  ),
                )(new TextDecoder().decode(indexBytes));
                expect(Buffer.from(savedIndex.raw, "base64")).toEqual(originalIndex);
                expect(originalIndex.byteLength).toBeGreaterThan(0);
                if (layout === "person")
                  expect(logins.some((call) => call.startsWith("post:user-fixture:"))).toBe(true);
                else expect(logins.filter((call) => call.startsWith("post:"))).toEqual([]);
                const coreSession = w.sessions.get(session.id);
                if (coreSession === undefined) return yield* Effect.die("Session missing");
                w.sessions.set(
                  session.id,
                  new Session({
                    ...coreSession,
                    providerSessionId: rows.view.providerSessionId ?? null,
                  }),
                );
                if (layout === "shared") {
                  const current = w.sessions.get(session.id);
                  if (current === undefined) return yield* Effect.die("Session missing");
                  const ownLaunch = w.executorLaunches.get(session.id);
                  const holder = new Session({
                    ...current,
                    id: SessionId.make("other-holder"),
                    ownerUserId: "another-person",
                  });
                  w.sessions.set(holder.id, holder);
                  w.executorLaunches.delete(session.id);
                  if (ownLaunch !== undefined) w.executorLaunches.set(holder.id, ownLaunch);
                  const effects = {
                    scripts: scripts.length,
                    opened,
                    credentials: credentialPosts.length,
                  };
                  const denied = yield* engine
                    .submitTurn(session.id, "must not dispatch", "user-fixture")
                    .pipe(Effect.result);
                  expect(denied).toMatchObject({ _tag: "Failure" });
                  expect({
                    scripts: scripts.length,
                    opened,
                    credentials: credentialPosts.length,
                  }).toEqual(effects);
                  w.executorLaunches.delete(holder.id);
                  w.sessions.delete(holder.id);
                  if (ownLaunch !== undefined) w.executorLaunches.set(session.id, ownLaunch);
                }
                if (prefix && harness === "claude" && layout === "shared" && !captured) {
                  const staged = path.join(
                    nativeRoot,
                    "history/native",
                    rows.view.nativeBinding?.key ?? "missing",
                    sourceTranscript,
                  );
                  const original = fs.readFileSync(staged);
                  fs.writeFileSync(staged, "modified retained history\n");
                  const before = opened;
                  const refused = yield* engine
                    .launchProtocol(session.id, { mode: "protocol" }, "user-fixture")
                    .pipe(Effect.result);
                  expect(refused).toMatchObject({ _tag: "Failure" });
                  expect(opened).toBe(before);
                  fs.writeFileSync(staged, original);
                }
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
                ).toBe(layout === "person");
                const next = yield* engine.submitTurn(
                  session.id,
                  "new words after Undo",
                  "user-fixture",
                  { harness, model: "gpt-test", effort: "medium", interactionMode: "default" },
                );
                expect(next.ordinal).toBe(1);
                yield* Effect.promise(() => sent.promise).pipe(Effect.timeout("5 seconds"));
                const words = [nextPeer, ...nativePeers]
                  .flatMap((p) => p.written)
                  .filter(
                    (frame) =>
                      ("method" in frame && frame.method === "turn/start") ||
                      ("type" in frame && frame.type === "user"),
                  );
                expect(words).toHaveLength(1);
                expect(JSON.stringify(words)).toContain("new words after Undo");
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
                if (prefix) {
                  const current = w.sessions.get(session.id);
                  if (current === undefined) return yield* Effect.die("Session missing");
                  w.sessions.set(
                    session.id,
                    new Session({
                      ...current,
                      status: "completed",
                      providerSessionId: rows.view.providerSessionId ?? null,
                    }),
                  );
                  w.processes.delete("supporting-shell");
                  const repeated = yield* engine.rollbackSession({
                    ...input,
                    commandId: `${input.commandId}-second`,
                    request: {
                      ...input.request,
                      expected: { historyRevision: 1, worktreeEpoch: 1 },
                    },
                  });
                  expect(repeated.progress, JSON.stringify(repeated.progress)).toMatchObject({
                    kind: "complete",
                    result: { position: { historyRevision: 2, worktreeEpoch: 1 } },
                  });
                  const secondView = yield* Effect.promise(() =>
                    run(Effect.flatMap(SessionHistoryRepo, (repo) => repo.read(session.id))),
                  );
                  expect(secondView.providerSessionId).not.toBe(rows.view.providerSessionId);
                  expect(secondView.nativeBinding?.location).toBe(
                    rows.view.nativeBinding?.location,
                  );
                  expect(secondView.nativeBinding?.key).not.toBe(rows.view.nativeBinding?.key);
                  if (layout === "shared" && harness === "codex" && !captured) {
                    const beforeRecovery = w.sessions.get(session.id);
                    if (beforeRecovery === undefined) return yield* Effect.die("Session missing");
                    w.sessions.set(
                      session.id,
                      new Session({
                        ...beforeRecovery,
                        status: "completed",
                        providerSessionId: secondView.providerSessionId ?? null,
                      }),
                    );
                    refuseNextPreparation = true;
                    const interrupted = yield* engine.rollbackSession({
                      ...input,
                      commandId: `${input.commandId}-recovery`,
                      request: {
                        ...input.request,
                        expected: { historyRevision: 2, worktreeEpoch: 1 },
                      },
                    });
                    expect(interrupted.progress).toMatchObject({ kind: "recoveryRequired" });
                    confirmRecoveryStop = true;
                    const recovered = yield* engine.recoverRollback({
                      actor: "user-fixture",
                      operationId: interrupted.id,
                      expectedProgressVersion: interrupted.version,
                      action: "finish",
                    });
                    expect(recovered.progress).toMatchObject({
                      kind: "complete",
                      result: { position: { historyRevision: 3, worktreeEpoch: 1 } },
                    });
                  }
                }
                if (harness === "claude" && !prefix) {
                  missingTranscript = true;
                  const missingFile = path.join(
                    activeRoot,
                    `.claude/projects/-workspace-repo/${rows.view.providerSessionId}.jsonl`,
                  );
                  console.info(
                    "Removing task-owned native transcript",
                    missingFile,
                    fs.statSync(missingFile).size,
                  );
                  fs.unlinkSync(missingFile);
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
              ...(layout === "person" || captured ? { captured: memory } : {}),
              history: { layer: historyLayer },
              conversationLayer: AgentConversationRepoLive.pipe(Layer.provide(infrastructure)),
              protocolHostLayer: hostLayer,
              sealantLayer: platform,
              harnessLayout: {
                flag: layout,
                state,
                platform: loginPlatform,
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
          credentialServer.closeAllConnections();
          await new Promise<void>((resolve) => credentialServer.close(() => resolve()));
          peer.end();
          nextPeer.end();
          for (const later of nativePeers) later.end();
          console.info("Removing task-owned engine rollback fixture", tmp, fs.readdirSync(tmp));
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
      30_000,
    );
  },
);
