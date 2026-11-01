import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";

import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  migrations,
  ProofArtifactsRepo,
  ProofArtifactsRepoLive,
  ProjectsRepoLive,
  SlackInstallsRepoLive,
  SlackProofDeliveriesRepo,
  SlackProofDeliveriesRepoLive,
  SlackThreadsRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import {
  AgentTurnId,
  ChangeId,
  ProjectId,
  ProofArtifactId,
  ScreenId,
  SessionId,
  WorktreeId,
} from "@mend/domain";
import { ProofArtifact, type ProofCapture } from "@mend/domain/workbench";
import { makeFakeSlack, SlackApi, SlackApiError } from "@mend/slack/client";
import { BlobNotFoundError, BlobStore, SecretCipher, SecretCipherError } from "@mend/store";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JobRunner, JobEnqueueError, type JobSpec } from "../src/job-runner.ts";
import {
  ProofArtifactsWithSlackDeliveryLive,
  reconcileSlackProof,
  runSlackProof,
  slackProofJob,
  SlackProofWorkerLive,
} from "../src/slack-proof-jobs.ts";

const postgres = postgresTestConfig();
const database = `mend_proof_jobs_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(postgres.adminUrl);
databaseUrl.pathname = `/${database}`;
const pg = PgClient.layer({ url: Redacted.make(databaseUrl.toString()), maxConnections: 4 });
const repositories = Layer.mergeAll(
  ProofArtifactsRepoLive,
  ProjectsRepoLive,
  SlackInstallsRepoLive,
  SlackProofDeliveriesRepoLive,
  SlackThreadsRepoLive,
).pipe(Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(pg))));
const admin = (query: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );
const sqlRun = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(pg), Effect.scoped));

const screenshot: ProofCapture = {
  _tag: "Screenshot",
  moment: { screenId: ScreenId.make("screen"), seq: 1 },
  media: { blobKey: "proof/image.png", bytes: 4, mimeType: "image/png", sha256: "a".repeat(64) },
};
const recording: ProofCapture = {
  _tag: "Recording",
  screenId: ScreenId.make("screen"),
  fromSeq: 1,
};
const artifact = (
  turnId: AgentTurnId,
  capture: ProofCapture = screenshot,
  sessionId = SessionId.make("session"),
) =>
  new ProofArtifact({
    id: ProofArtifactId.make(crypto.randomUUID()),
    changeId: ChangeId.make("change"),
    projectId: ProjectId.make("project"),
    worktreeId: WorktreeId.make("tree"),
    sessionId,
    turnId,
    title: "Task board",
    caption: "The task appears in Done.",
    source: { _tag: "Unknown", reason: "No checkpoint" },
    capture,
    launch: null,
    differences: null,
    observedFrom: new Date(),
    observedTo: null,
    createdAt: new Date(),
  });

const fixture = () => {
  const turnId = AgentTurnId.make(crypto.randomUUID());
  const queued: Array<JobSpec> = [];
  const handlers = new Map<string, (payload: unknown) => Effect.Effect<void>>();
  let enqueueFails = false;
  const queue = Layer.succeed(JobRunner, {
    enqueue: (job) =>
      Effect.suspend(() => {
        if (enqueueFails)
          return Effect.fail(new JobEnqueueError({ job: job.name, cause: "queue unavailable" }));
        return Effect.sync(() => {
          queued.push(job);
          return { _tag: "Queued", id: crypto.randomUUID() } as const;
        });
      }),
    work: (name, handler) =>
      Effect.sync(() => {
        handlers.set(name, handler);
      }),
  });
  const slack = makeFakeSlack([
    {
      teamId: "T1",
      teamName: "Test",
      appId: "A1",
      botId: "B1",
      botUserId: "UBOT",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      threads: { "C1:1.0": [] },
    },
  ]);
  const uploads: Array<Uint8Array> = [];
  const slackLayer = Layer.succeed(SlackApi, {
    ...slack.service,
    filesUpload: (url, input) =>
      Effect.gen(function* () {
        const uploadBody = input.body;
        const body =
          uploadBody instanceof Uint8Array
            ? uploadBody
            : yield* Effect.tryPromise({
                try: () => buffer(uploadBody),
                catch: () =>
                  new SlackApiError({
                    method: "files.uploadBytes",
                    code: "invalid_bytes",
                    message: "Test upload stream could not be read",
                  }),
              });
        yield* slack.service.filesUpload(url, { ...input, body });
        uploads.push(body);
      }),
  });
  const bytes = new Map([["proof/image.png", new Uint8Array([1, 2, 3, 4])]]);
  let reads = 0;
  const streams: Array<Readable> = [];
  const blobs = Layer.mock(BlobStore, {
    identity: "memory:proof-jobs",
    getStream: (key) =>
      Effect.suspend(() => {
        reads += 1;
        const body = bytes.get(key);
        if (body === undefined) return Effect.fail(new BlobNotFoundError({ key }));
        const stream = Readable.from([body]);
        streams.push(stream);
        return Effect.succeed(stream);
      }),
  });
  const cipher = Layer.succeed(SecretCipher, {
    encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext}`),
    decrypt: (sealed) =>
      sealed === "sealed:xoxb-test"
        ? Effect.succeed("xoxb-test")
        : Effect.fail(
            new SecretCipherError({ operation: "decrypt", message: "invalid test token" }),
          ),
  });
  const layer = ProofArtifactsWithSlackDeliveryLive.pipe(
    Layer.provideMerge(Layer.mergeAll(repositories, queue, slackLayer, blobs, cipher)),
  );
  return {
    layer,
    turnId,
    artifact: (capture: ProofCapture = screenshot) => artifact(turnId, capture),
    prepare: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind) VALUES (${turnId}, 'session', 'workspace', 'agent-protocol')`;
      yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,status,input) SELECT ${turnId}, 'session', ${turnId}, coalesce(max(ordinal),0)+1, 'completed', 'Capture' FROM agent_turns WHERE session_id = 'session'`;
    }),
    ready: Effect.flatMap(SlackProofDeliveriesRepo, (repo) =>
      repo.readyTurn(SessionId.make("session"), turnId, {
        projectId: ProjectId.make("project"),
        changeId: ChangeId.make("change"),
        url: "https://mend.test/session",
        previewUrl: null,
        push: { sessionId: SessionId.make("session"), updates: false },
      }),
    ),
    slack,
    queued,
    handlers,
    bytes,
    streams,
    uploads,
    reads: () => reads,
    failEnqueue: (fail: boolean) => {
      enqueueFails = fail;
    },
  };
};

describe.skipIf(postgres.skip)("Slack proof jobs with Postgres and fake Slack", () => {
  beforeAll(async () => {
    await admin(`CREATE DATABASE ${database}`);
    await sqlRun(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        yield* sql`INSERT INTO "user" (id,name,email) VALUES ('alice','Alice','alice@example.test')`;
        yield* sql`INSERT INTO organizations (id,name) VALUES ('org','Proof')`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,visibility) VALUES ('project','proof','/store/proof','main','org','shared')`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES ('tree','project','proof','proof','mend/proof','abc')`;
        yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,harness,worktree,branch,base_sha) VALUES ('session','project','tree','claude','proof','mend/proof','abc'), ('no-thread','project','tree','claude','proof','mend/proof','abc')`;
        yield* sql`INSERT INTO worktree_changes (id,project_id,worktree_id,branch,base_sha) VALUES ('change','project','tree','mend/proof','abc')`;
        yield* sql`INSERT INTO slack_threads (session_id,team_id,channel_id,thread_ts,request_ts,slack_user_id,project_source,external) VALUES ('session','T1','C1','1.0','1.0','U1','message',false)`;
        yield* sql`INSERT INTO slack_installs (organization_id,team_id,team_name,bot_user_id,app_id,sealed_bot_token,sealed_app_token,web_origin,installed_by_user_id) VALUES ('org','T1','Test','UBOT','A1','sealed:xoxb-test','sealed:xapp-test','https://mend.example','alice')`;
      }),
    );
  }, 60_000);
  afterAll(() => admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`));

  it("keys captures and recovery by turn, including a recording", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.prepare;
        const repo = yield* ProofArtifactsRepo;
        const image = yield* repo.insert(h.artifact(), `${h.turnId}:image`);
        const active = yield* repo.insert(h.artifact(recording), `${h.turnId}:recording`);
        expect(h.queued).toEqual([
          slackProofJob(image.sessionId ?? SessionId.make("session"), h.turnId),
          slackProofJob(SessionId.make("session"), h.turnId),
        ]);
        expect(h.queued[0]?.idempotencyKey).toBe(h.queued[1]?.idempotencyKey);
        h.failEnqueue(true);
        yield* repo.settleVideo(active.id, {
          _tag: "NotCaptured",
          kind: "video",
          reason: "Encoder stopped",
        });
        h.failEnqueue(false);
        yield* h.ready;
        h.queued.length = 0;
        yield* reconcileSlackProof();
        expect(h.queued).toContainEqual(slackProofJob(SessionId.make("session"), h.turnId));
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });

  it("registers the worker, streams one batch, and resumes without reposting", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.prepare;
        yield* Layer.build(SlackProofWorkerLive);
        const handler = h.handlers.get("slack-deliver-proof");
        if (handler === undefined) return yield* Effect.die("worker not registered");
        const repo = yield* ProofArtifactsRepo;
        const image = yield* repo.insert(h.artifact(), `${h.turnId}:image`);
        yield* repo.insert(
          new ProofArtifact({ ...h.artifact(), title: "Second capture" }),
          "second",
        );
        const payload = { sessionId: SessionId.make("session"), turnId: h.turnId };
        yield* handler(payload);
        expect(h.slack.calls).toEqual([]);
        yield* h.ready;
        yield* handler(payload);
        yield* handler(payload);
        expect(h.uploads.map((body) => [...body])).toEqual([
          [1, 2, 3, 4],
          [1, 2, 3, 4],
        ]);
        expect(h.streams.every((stream) => stream.destroyed)).toBe(true);
        expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toMatchObject([
          { input: { files: [{ title: "Task board" }, { title: "Second capture" }] } },
        ]);
        const delivery = yield* (yield* SlackProofDeliveriesRepo).withDelivery(
          { sessionId: SessionId.make("session"), artifactId: image.id },
          (store) => store.read(),
        );
        expect(delivery).toMatchObject({
          state: "shared",
          attempts: 1,
          messageTs: expect.any(String),
        });
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });

  it("waits for a recording to settle and includes it in the first batch", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.prepare;
        const repo = yield* ProofArtifactsRepo;
        yield* repo.insert(h.artifact(), `${h.turnId}:image`);
        const active = yield* repo.insert(h.artifact(recording), `${h.turnId}:recording`);
        yield* h.ready;
        yield* Effect.all(
          [
            runSlackProof({ sessionId: SessionId.make("session"), turnId: h.turnId }),
            Effect.sleep("50 millis").pipe(
              Effect.andThen(
                repo.settleVideo(active.id, {
                  _tag: "Video",
                  span: { screenId: ScreenId.make("screen"), fromSeq: 1, toSeq: 2 },
                  media: {
                    blobKey: "proof/image.png",
                    bytes: 4,
                    mimeType: "video/mp4",
                    sha256: "a".repeat(64),
                  },
                  durationMs: 28_000,
                  ending: "stopped",
                }),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
        expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toMatchObject([
          { input: { files: [{ title: "Task board" }, { title: "Task board · 0:28" }] } },
        ]);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });

  it("a missing blob becomes a note in the same message as delivered files", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.prepare;
        const repo = yield* ProofArtifactsRepo;
        yield* repo.insert(h.artifact(), `${h.turnId}:image`);
        yield* repo.insert(
          h.artifact({
            _tag: "Video",
            span: { screenId: ScreenId.make("screen"), fromSeq: 1, toSeq: 2 },
            media: {
              blobKey: "missing.mp4",
              bytes: 4,
              mimeType: "video/mp4",
              sha256: "a".repeat(64),
            },
            durationMs: 1000,
            ending: "stopped",
          }),
          "video",
        );
        yield* h.ready;
        const payload = { sessionId: SessionId.make("session"), turnId: h.turnId };
        yield* runSlackProof(payload);
        yield* runSlackProof(payload);
        expect(h.slack.calls.filter((call) => call.kind === "postMessage")).toHaveLength(0);
        expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toMatchObject([
          {
            input: {
              files: [{ title: "Task board" }],
              blocks: [
                {
                  text: {
                    text: "Captured · source unknown · the video didn't reach Slack, it's in Mend",
                  },
                },
                { type: "actions" },
              ],
            },
          },
        ]);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });

  it("a no-capture turn still recovers its single button row", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* h.prepare;
        yield* h.ready;
        const payload = { sessionId: SessionId.make("session"), turnId: h.turnId };
        yield* runSlackProof(payload);
        yield* runSlackProof(payload);
        expect(h.slack.calls).toMatchObject([
          {
            kind: "postMessage",
            input: {
              blocks: [
                {
                  type: "actions",
                  elements: [
                    { text: { text: "Open in Mend" } },
                    { text: { text: "Push and open pull request" } },
                  ],
                },
              ],
            },
          },
        ]);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });
});
