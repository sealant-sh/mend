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
const artifact = (capture: ProofCapture = screenshot, sessionId = SessionId.make("session")) =>
  new ProofArtifact({
    id: ProofArtifactId.make(crypto.randomUUID()),
    changeId: ChangeId.make("change"),
    projectId: ProjectId.make("project"),
    worktreeId: WorktreeId.make("tree"),
    sessionId,
    turnId: null,
    title: "Task board",
    caption: "The task appears in Done.",
    side: "after",
    source: { _tag: "Unknown", reason: "No checkpoint" },
    capture,
    launch: null,
    differences: null,
    observedFrom: new Date(),
    observedTo: null,
    createdAt: new Date(),
  });

const fixture = () => {
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

  it("enqueues committed screenshots and missing captures, but waits for a video to settle", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ProofArtifactsRepo;
        const image = yield* repo.insert(artifact(), "screenshot");
        expect(h.queued).toEqual([slackProofJob(image.id)]);
        const video = yield* repo.insert(artifact(recording), "video");
        expect(h.queued).toHaveLength(1);
        yield* repo.settleVideo(video.id, {
          _tag: "Video",
          span: { screenId: ScreenId.make("screen"), fromSeq: 1, toSeq: 2 },
          media: { ...screenshot.media, mimeType: "video/mp4" },
          durationMs: 1000,
          ending: "stopped",
        });
        expect(h.queued.at(-1)).toEqual(slackProofJob(video.id));
        const missing = yield* repo.insert(
          artifact({ _tag: "NotCaptured", kind: "screenshot", reason: "No login" }),
          "missing",
        );
        expect(h.queued.at(-1)).toEqual(slackProofJob(missing.id));
        const unavailable = yield* repo.insert(artifact(recording), "unavailable");
        const count = h.queued.length;
        yield* repo.settleVideo(unavailable.id, {
          _tag: "NotCaptured",
          kind: "video",
          reason: "Encoder unavailable",
        });
        expect(h.queued).toHaveLength(count + 1);
        yield* repo.insert(artifact(screenshot, SessionId.make("no-thread")), "no-thread");
        expect(h.queued).toHaveLength(count + 1);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });

  it("recovers the commit/enqueue gap and excludes recordings, old artifacts and terminal deliveries", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ProofArtifactsRepo;
        h.failEnqueue(true);
        const missed = yield* repo.insert(artifact(), "missed");
        h.failEnqueue(false);
        const old = new ProofArtifact({
          ...artifact(),
          createdAt: new Date(Date.now() - 25 * 60 * 60_000),
        });
        yield* repo.insert(old, "old");
        const active = yield* repo.insert(artifact(recording), "recording");
        const deliveries = yield* SlackProofDeliveriesRepo;
        const terminalIds: Array<ProofArtifactId> = [];
        for (const state of ["shared", "withheld", "failed"] as const) {
          const saved = yield* repo.insert(artifact(), state);
          terminalIds.push(saved.id);
          yield* deliveries.withDelivery(
            { sessionId: SessionId.make("session"), artifactId: saved.id },
            (store) =>
              Effect.gen(function* () {
                yield* store.save({ ...(yield* store.read()), state });
              }),
          );
        }
        h.queued.length = 0;
        yield* reconcileSlackProof();
        const ids = h.queued.map((job) => job.payload["artifactId"]);
        expect(ids).toContain(missed.id);
        expect(ids).not.toContain(old.id);
        expect(ids).not.toContain(active.id);
        for (const id of terminalIds) expect(ids).not.toContain(id);
        yield* repo.settleStaleRecordings();
        h.queued.length = 0;
        yield* reconcileSlackProof();
        expect(h.queued.map((job) => job.payload["artifactId"])).toContain(active.id);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });

  it("runs the registered worker with streamed bytes and durable progress, without reposting", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Layer.build(SlackProofWorkerLive);
        const handler = h.handlers.get("slack-deliver-proof");
        if (handler === undefined) return yield* Effect.die("worker was not registered");
        const saved = yield* (yield* ProofArtifactsRepo).insert(artifact(), "worker");
        yield* handler({ artifactId: saved.id });
        yield* handler({ artifactId: saved.id });
        const delivery = yield* (yield* SlackProofDeliveriesRepo).withDelivery(
          { sessionId: SessionId.make("session"), artifactId: saved.id },
          (store) => store.read(),
        );
        expect(delivery).toMatchObject({
          state: "shared",
          attempts: 1,
          messageTs: expect.any(String),
        });
        expect(h.reads()).toBe(1);
        expect(h.uploads.map((body) => [...body])).toEqual([[1, 2, 3, 4]]);
        expect(h.streams.every((stream) => stream.destroyed)).toBe(true);
        expect(h.slack.calls.map((call) => call.kind)).toEqual([
          "filesGetUploadUrl",
          "filesUpload",
          "filesCompleteUpload",
        ]);
        expect(h.slack.calls.at(-1)).toMatchObject({
          input: {
            channelId: "C1",
            threadTs: "1.0",
            initialComment: expect.stringContaining(saved.caption),
          },
        });
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });

  it("observes a delayed Slack share on retry without another upload or completion", async () => {
    const h = fixture();
    let hideShare = true;
    const delayed = {
      ...h.slack.service,
      filesInfo: (token: string, fileId: string, channel: string) =>
        hideShare ? Effect.succeed([]) : h.slack.service.filesInfo(token, fileId, channel),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const saved = yield* (yield* ProofArtifactsRepo).insert(artifact(), "delayed");
        expect(yield* runSlackProof({ artifactId: saved.id }).pipe(Effect.flip)).toMatchObject({
          code: "share_not_observed",
        });
        hideShare = false;
        yield* runSlackProof({ artifactId: saved.id });
        expect(h.slack.calls.filter((call) => call.kind === "filesCompleteUpload")).toHaveLength(1);
        expect(h.reads()).toBe(1);
        const delivery = yield* (yield* SlackProofDeliveriesRepo).withDelivery(
          { sessionId: SessionId.make("session"), artifactId: saved.id },
          (store) => store.read(),
        );
        expect(delivery).toMatchObject({ state: "shared", attempts: 2 });
      }).pipe(Effect.provideService(SlackApi, delayed), Effect.provide(h.layer), Effect.scoped),
    );
  });

  it("retries transient failures, then posts one named final failure when attempts are exhausted", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const saved = yield* (yield* ProofArtifactsRepo).insert(artifact(), "exhausted");
        const retries = slackProofJob(saved.id).retryLimit ?? 0;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          h.slack.refuseFiles(
            new SlackApiError({
              method: "files.getUploadURLExternal",
              code: "request_failed",
              message: "temporarily unavailable",
            }),
          );
          if (attempt < retries) yield* runSlackProof({ artifactId: saved.id }).pipe(Effect.flip);
          else yield* runSlackProof({ artifactId: saved.id });
        }
        yield* runSlackProof({ artifactId: saved.id });
        const posts = h.slack.calls.filter((call) => call.kind === "postMessage");
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({ input: { text: expect.stringContaining(saved.id) } });
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });

  it("posts not-captured captions and names missing stored files once", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* ProofArtifactsRepo;
        const missing = yield* repo.insert(
          artifact({ _tag: "NotCaptured", kind: "video", reason: "The screen did not start" }),
          "worker-missing",
        );
        yield* runSlackProof({ artifactId: missing.id });
        yield* runSlackProof({ artifactId: missing.id });
        expect(h.reads()).toBe(0);
        expect(h.slack.calls).toHaveLength(1);
        expect(h.slack.calls[0]).toMatchObject({
          kind: "postMessage",
          input: { text: expect.stringContaining("not captured") },
        });
        const gone = yield* repo.insert(artifact(), "missing-blob");
        h.bytes.clear();
        yield* runSlackProof({ artifactId: gone.id });
        yield* runSlackProof({ artifactId: gone.id });
        const failed = yield* (yield* SlackProofDeliveriesRepo).withDelivery(
          { sessionId: SessionId.make("session"), artifactId: gone.id },
          (store) => store.read(),
        );
        expect(failed).toMatchObject({
          state: "failed",
          errorCode: "media_not_found",
          messageTs: expect.any(String),
        });
        const posts = h.slack.calls.filter((call) => call.kind === "postMessage");
        expect(posts).toHaveLength(2);
        expect(posts.at(-1)).toMatchObject({ input: { text: expect.stringContaining(gone.id) } });
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });

  it("finishes a deleted artifact or a session without a Slack thread without calling Slack", async () => {
    const h = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const deleted = yield* (yield* ProofArtifactsRepo).insert(artifact(), "deleted");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM proof_artifacts WHERE id = ${deleted.id}`;
        yield* runSlackProof({ artifactId: deleted.id });
        const saved = yield* (yield* ProofArtifactsRepo).insert(
          artifact(screenshot, SessionId.make("no-thread")),
          "worker-no-thread",
        );
        yield* runSlackProof({ artifactId: saved.id });
        expect(h.slack.calls).toEqual([]);
        expect(h.reads()).toBe(0);
      }).pipe(Effect.provide(h.layer), Effect.scoped),
    );
  });
});
