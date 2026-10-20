import {
  CaptureStoreRepo,
  ChangePassesRepo,
  ProjectsRepo,
  ProjectNotFoundError,
  SessionNotFoundError,
  SessionProcessesRepo,
  SessionsRepo,
  SettingsRepo,
  WorktreeChangesRepo,
} from "@mend/db";
import {
  ChangeId,
  defaultSettings,
  OrganizationId,
  ProjectId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
  SealantWorkspaceId,
} from "@mend/domain";
import { Change, Project, Session, SessionProcess } from "@mend/domain/workbench";
import {
  CaptureChannel,
  CaptureRuntimeLive,
  CaptureRuntimeOff,
  WorktreeReads,
  WORKTREE_STAMP,
} from "@mend/sessions";
import { makeMemoryCaptureStore } from "@mend/sessions/testing";
import { BlobStore, GitError } from "@mend/store";
import { buildManifest } from "@mend/store/testing";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { type Enqueued, JobRunner, type JobSpec } from "../src/job-runner.ts";
import { reviewPrep } from "../src/review-prep.ts";

const PROJECT = ProjectId.make("review-project");
const WORKTREE = WorktreeId.make("review-worktree");
const SESSION = SessionId.make("later-member-session");
const CHANGE = ChangeId.make("shared-change");
const BASE = Sha.make("a".repeat(40));
const NOW = new Date("2026-10-01T10:00:00.000Z");
const project = new Project({
  id: PROJECT,
  name: "review",
  organizationId: OrganizationId.make("review-org"),
  visibility: "shared",
  createdByUserId: "first-owner-alice",
  originUrl: null,
  storePath: "/owned-fixture/repo.git",
  defaultBranch: "main",
  adoptedSha: BASE,
  autoTour: "on",
  autoSuggest: "on",
  autoName: "off",
  autoLand: "off",
  backgroundSessions: "inherit",
  gitAuthMode: "mend-key",
  workspaceImage: null,
  applyDotfiles: false,
  defaultShellProfile: false,
  inheritUserSkills: false,
  hotSessions: 0,
  installCommand: null,
  installEnabled: false,
  createdAt: NOW,
  updatedAt: NOW,
});
const sessionRow = (status: Session["status"]) =>
  new Session({
    id: SESSION,
    projectId: PROJECT,
    worktreeId: WORKTREE,
    harness: "claude",
    providerSessionId: null,
    label: "later session",
    worktree: "review-worktree",
    branch: "mend/review",
    baseSha: BASE,
    baseRef: "main",
    contextSnapshotId: null,
    referenceMounts: [],
    extraMounts: [],
    sealantRunId: null,
    sealantWorkspaceId: null,
    sealantSessionId: null,
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    workspaceImage: null,
    dotfiles: null,
    ownerUserId: "later-member-bob",
    origin: "mend",
    hasTranscript: true,
    status,
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: true,
    startedAt: NOW,
    settledAt: status === "completed" ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  });
const change = new Change({
  id: CHANGE,
  projectId: PROJECT,
  worktreeId: WORKTREE,
  sessionId: SessionId.make("first-owner-alice-session"),
  branch: "mend/review",
  baseSha: BASE,
  headSha: null,
  createdAt: NOW,
  updatedAt: NOW,
});
const agentRow = (kind: "agent-pty" | "service", live: boolean) =>
  new SessionProcess({
    id: SessionProcessId.make(kind),
    sessionId: SESSION,
    sealantWorkspaceId: SealantWorkspaceId.make("workspace-fixture"),
    sealantSessionId: kind,
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind,
    harness: kind === "agent-pty" ? "claude" : null,
    providerSessionId: null,
    protocolOptions: null,
    label: kind,
    argv: [],
    status: live ? "running" : "stopped",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: NOW,
    exitedAt: live ? null : NOW,
    updatedAt: NOW,
  });

interface EventRecord {
  readonly payload: string;
  readonly handled: Deferred.Deferred<void>;
}
const makeEvents = Effect.gen(function* () {
  const records = yield* Queue.unbounded<EventRecord>();
  const ready = yield* Deferred.make<void>();
  let closed = false;
  // One record per pull, with no prefetch. The next demand acknowledges the previous callback.
  const stream = Stream.fromPull(
    Effect.sync(() => {
      let previous: Deferred.Deferred<void> | undefined;
      return Effect.gen(function* () {
        yield* Deferred.succeed(ready, undefined);
        if (previous !== undefined) yield* Deferred.succeed(previous, undefined);
        const record = yield* Queue.take(records);
        previous = record.handled;
        return [record.payload] as const;
      });
    }),
  ).pipe(
    Stream.ensuring(
      Effect.sync(() => {
        closed = true;
      }),
    ),
  );
  const publish = (payload: string) =>
    Effect.gen(function* () {
      const handled = yield* Deferred.make<void>();
      yield* Queue.offer(records, { payload, handled });
      yield* Deferred.await(handled);
    }).pipe(Effect.timeout("2 seconds"));
  return {
    stream,
    publish,
    ready,
    closed: () => closed,
    shutdown: Queue.shutdown(records),
  };
});
type Events = Effect.Success<typeof makeEvents>;
interface Options {
  readonly baseline?: "running" | "completed" | "unknown";
  readonly captured?: boolean;
  readonly read?: "files" | "empty" | "git-error";
  readonly missingChange?: boolean;
  readonly noOwner?: boolean;
  readonly blockedJob?: {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}
const unused = (): never => {
  throw new Error("unused review-prep fixture capability");
};
const makeWorld = (events: Events, options: Options) => {
  let session = sessionRow(options.baseline === "completed" ? "completed" : "running");
  if (options.noOwner) session = new Session({ ...session, ownerUserId: null });
  let processes: ReadonlyArray<SessionProcess> = [];
  const jobs: Array<JobSpec> = [];
  const queued: Array<Parameters<ChangePassesRepo["Service"]["queue"]>> = [];
  const reads: Array<Parameters<WorktreeReads["Service"]["diffWorktree"]>> = [];
  const prepared = new Map<string, string>();
  const memory = makeMemoryCaptureStore(() => BASE);
  const capture = options.captured
    ? CaptureRuntimeLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            memory.layer,
            Layer.mock(CaptureChannel, { apiFor: unused, standbyApiFor: unused, publish: unused }),
            Layer.mock(BlobStore, { identity: "unused-owned-review-blobs" }),
          ),
        ),
      )
    : CaptureRuntimeOff;
  const dependencies = Layer.mergeAll(
    capture,
    Layer.mock(SessionsRepo, {
      liveMarkNow: () => Effect.succeed(0),
      listActive: () => Effect.sync(() => (options.baseline === "unknown" ? [] : [session])),
      byId: (id) =>
        id === SESSION
          ? Effect.sync(() => session)
          : Effect.fail(new SessionNotFoundError({ sessionId: id })),
    }),
    Layer.mock(SessionProcessesRepo, { listForSession: () => Effect.sync(() => processes) }),
    Layer.mock(WorktreeChangesRepo, {
      byWorktree: (id) => Effect.succeed(options.missingChange || id !== WORKTREE ? null : change),
    }),
    Layer.mock(ProjectsRepo, {
      byId: (id) =>
        id === PROJECT
          ? Effect.succeed(project)
          : Effect.fail(new ProjectNotFoundError({ projectId: id })),
    }),
    Layer.mock(SettingsRepo, { forOrganization: () => Effect.succeed(defaultSettings) }),
    Layer.mock(WorktreeReads, {
      diffWorktree: (...args) =>
        Effect.gen(function* () {
          reads.push(args);
          if (options.read === "git-error")
            return yield* new GitError({
              args: ["diff", BASE],
              cwd: "/owned-fixture",
              exitCode: 128,
              stderr: "fixture missing tree",
            });
          return {
            stamp: WORKTREE_STAMP,
            value:
              options.read === "empty" ? "" : "diff --git a/changed.ts b/changed.ts\n+changed\n",
          };
        }),
    }),
    Layer.mock(ChangePassesRepo, {
      queue: (...args) =>
        Effect.sync(() => {
          queued.push(args);
        }),
      preparedDigest: (changeId, kind) =>
        Effect.sync(() => prepared.get(`${changeId}:${kind}`) ?? null),
      recordPrep: (changeId, kind, diffDigest) =>
        Effect.sync(() => void prepared.set(`${changeId}:${kind}`, diffDigest)),
    }),
    Layer.mock(JobRunner, {
      enqueue: (job) =>
        Effect.gen(function* () {
          jobs.push(job);
          if (job.name === "suggest-change" && options.blockedJob !== undefined) {
            yield* Deferred.succeed(options.blockedJob.entered, undefined);
            yield* Deferred.await(options.blockedJob.release);
          }
          return { _tag: "Queued", id: `job-${jobs.length}` } satisfies Enqueued;
        }),
    }),
  );
  const seed = Effect.gen(function* () {
    if (!options.captured) return null;
    const repo = yield* CaptureStoreRepo;
    yield* repo.init(WORKTREE);
    const claimed = yield* repo.claim(WORKTREE, "owned-executor");
    const built = buildManifest({
      worktreeId: WORKTREE,
      epoch: claimed.epoch,
      n: 0,
      parent: null,
      kind: "checkpoint",
      seq: 1,
      git: {
        packs: [],
        refs: { "refs/heads/mend/review": BASE },
        head: "refs/heads/mend/review",
        fsck: "verified",
      },
    });
    yield* repo.register({
      worktreeId: WORKTREE,
      id: built.id,
      n: 0,
      parent: null,
      epoch: claimed.epoch,
      seq: 1n,
      kind: "checkpoint",
      manifestKey: built.key,
      sections: built.manifest.sections,
      gitFsck: "verified",
    });
    yield* repo.acceptSummary(WORKTREE, built.id, "owned-summary");
    return built.id;
  }).pipe(Effect.provide(memory.layer));
  return {
    events,
    jobs,
    queued,
    reads,
    seed,
    layer: Layer.effectDiscard(reviewPrep(events.stream)).pipe(Layer.provide(dependencies)),
    setSession: (patch: Partial<Session>) => {
      session = new Session({ ...session, ...patch });
    },
    setProcesses: (rows: ReadonlyArray<SessionProcess>) => {
      processes = rows;
    },
    publish: () =>
      events.publish(JSON.stringify({ type: "session", sessionId: SESSION, projectId: PROJECT })),
  };
};
type World = ReturnType<typeof makeWorld>;
const withWorld = <E>(
  options: Options,
  work: (world: World, head: string | null) => Effect.Effect<void, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* makeEvents;
      yield* Effect.addFinalizer(() => events.shutdown);
      const world = makeWorld(events, options);
      const head = yield* world.seed;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(world.layer);
          yield* Deferred.await(events.ready).pipe(Effect.timeout("2 seconds"));
          yield* work(world, head);
        }),
      );
      expect(events.closed()).toBe(true);
    }).pipe(Effect.scoped),
  );
const expectedPasses: ReadonlyArray<JobSpec> = [
  {
    name: "compose-tour",
    payload: { changeId: CHANGE, requestedBy: "later-member-bob" },
    idempotencyKey: "compose-tour:shared-change",
  },
  {
    name: "suggest-change",
    payload: { changeId: CHANGE, requestedBy: "later-member-bob" },
    idempotencyKey: "suggest-change:shared-change",
  },
];
const expectedSummary = (head: string): JobSpec => ({
  name: "summary-observe",
  payload: { worktreeId: WORKTREE, captureId: head },
  idempotencyKey: `summary-observe:${head}`,
});

describe("ReviewPrepLive event worker", () => {
  it("records an already settled baseline silently and closes its owned listener", () =>
    withWorld({ baseline: "completed" }, (world) =>
      Effect.gen(function* () {
        yield* world.publish();
        expect({ jobs: world.jobs, reads: world.reads, queued: world.queued }).toEqual({
          jobs: [],
          reads: [],
          queued: [],
        });
      }),
    ));

  it("queues claimed summary and owner-paid passes once, waiting for the actual job callback", async () => {
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    await withWorld({ captured: true, blockedJob: { entered, release } }, (world, head) =>
      Effect.gen(function* () {
        if (head === null) throw new Error("Missing capture head");
        world.setSession({ status: "completed", settledAt: NOW });
        const published = yield* world.publish().pipe(Effect.forkChild);
        yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"));
        expect(published.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(published);
        expect(world.jobs).toEqual([expectedSummary(head), ...expectedPasses]);
        expect(world.queued).toEqual([
          [CHANGE, "tour"],
          [CHANGE, "suggest"],
        ]);
        expect(world.reads).toEqual([[PROJECT, WORKTREE, BASE]]);
        yield* world.publish();
        world.setSession({ status: "stopped" });
        yield* world.publish();
        expect(world.jobs).toEqual([expectedSummary(head), ...expectedPasses]);
      }),
    );
  });

  it("prepares an ended agent while a service keeps the session idle, without a second stopped enqueue", () =>
    withWorld({}, (world) =>
      Effect.gen(function* () {
        world.setSession({ status: "idle" });
        world.setProcesses([agentRow("agent-pty", false), agentRow("service", true)]);
        yield* world.publish();
        expect(world.jobs).toEqual(expectedPasses);
        world.setSession({ status: "stopped", settledAt: NOW });
        yield* world.publish();
        expect(world.jobs).toEqual(expectedPasses);
      }),
    ));

  it.each(["empty", "git-error"] satisfies ReadonlyArray<Options["read"]>)(
    "queues no passes when the change is %s",
    (read) =>
      withWorld({ read }, (world) =>
        Effect.gen(function* () {
          world.setSession({ status: "completed", settledAt: NOW });
          yield* world.publish();
          expect(world.reads).toEqual([[PROJECT, WORKTREE, BASE]]);
          expect({ jobs: world.jobs, queued: world.queued }).toEqual({ jobs: [], queued: [] });
        }),
      ),
  );

  it.each([{ missingChange: true }, { noOwner: true }])(
    "queues no paid pass with missing change or owner: %j",
    (options) =>
      withWorld(options, (world) =>
        Effect.gen(function* () {
          world.setSession({ status: "completed", settledAt: NOW });
          yield* world.publish();
          expect({ jobs: world.jobs, queued: world.queued }).toEqual({ jobs: [], queued: [] });
        }),
      ),
  );

  it.each(["empty", "git-error"] satisfies ReadonlyArray<Options["read"]>)(
    "still observes a claimed summary when the change is %s",
    (read) =>
      withWorld({ captured: true, read }, (world, head) =>
        Effect.gen(function* () {
          if (head === null) throw new Error("Missing claimed head");
          world.setSession({ status: "completed", settledAt: NOW });
          yield* world.publish();
          expect(world.jobs).toEqual([expectedSummary(head)]);
          expect(world.queued).toEqual([]);
        }),
      ),
  );

  it("survives malformed and unrelated events, and treats an unknown settled session as baseline", () =>
    withWorld({ baseline: "unknown" }, (world) =>
      Effect.gen(function* () {
        yield* world.events.publish("malformed-json");
        yield* world.events.publish(JSON.stringify({ type: "project", projectId: PROJECT }));
        world.setSession({ status: "completed", settledAt: NOW });
        yield* world.publish();
        expect(world.jobs).toEqual([]);
        world.setSession({ status: "running", settledAt: null });
        yield* world.publish();
        world.setSession({ status: "completed", settledAt: NOW });
        yield* world.publish();
        expect(world.jobs).toEqual(expectedPasses);
      }),
    ));
});
