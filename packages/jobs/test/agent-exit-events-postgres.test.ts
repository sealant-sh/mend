import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepoLive,
  ChangePassesRepoLive,
  listenEvents,
  MendDBLive,
  migrations,
  NotificationSettingsRepoLive,
  notifyEvent,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  PushDevicesRepo,
  PushDevicesRepoLive,
  SessionProcessesRepo,
  SessionProcessesRepoLive,
  SessionsRepo,
  SessionsRepoLive,
  SettingsRepoLive,
  SlackInstallsRepoLive,
  SlackThreadsRepoLive,
  WorktreeChangesRepo,
  WorktreeChangesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import {
  type ChangeId,
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  type SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { AgentWait, type SessionProcessKind, type SessionStatus } from "@mend/domain/workbench";
import { CaptureRuntimeOff, WorktreeReads, WORKTREE_STAMP } from "@mend/sessions";
import { Effect, Layer, Redacted, Schedule, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JobRunner, type JobSpec } from "../src/job-runner.ts";
import { PushSender, type PushMessage } from "../src/push-sender.ts";
import { reviewPrep } from "../src/review-prep.ts";
import { sessionNotifier } from "../src/session-notifier.ts";

const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
const SCRATCH_DB = `mend_agent_exit_events_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = Layer.mergeAll(
  SessionsRepoLive,
  SessionProcessesRepoLive,
  ProjectsRepoLive,
  AgentConversationRepoLive,
  OrganizationsRepoLive,
  NotificationSettingsRepoLive,
  PushDevicesRepoLive,
  SlackThreadsRepoLive,
  SlackInstallsRepoLive,
  WorktreeChangesRepoLive,
  ChangePassesRepoLive,
  SettingsRepoLive,
).pipe(Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))));
type Repos = Layer.Success<typeof reposLayer>;

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));

const PROJECT = ProjectId.make("p-web");
const OWNER = "alice";
const PHONE = "alice-phone";
const BASE = Sha.make("a".repeat(40));

interface Seeded {
  readonly sessionId: SessionId;
  readonly changeId: ChangeId;
  readonly agentId: SessionProcessId;
}

const finishedTurn = () =>
  new AgentWait({ kind: "prompt", tool: null, since: new Date(Date.now() - 1_000) });

/**
 * One session in its own worktree, with its change, a live terminal agent and a live shell. The
 * agent holds `wait` when it is given one: a finished turn.
 */
const seedSession = (name: string, status: SessionStatus, wait: AgentWait | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* SessionsRepo;
    const processes = yield* SessionProcessesRepo;
    const changes = yield* WorktreeChangesRepo;
    const worktreeId = WorktreeId.make(`wt-${name}`);
    const sessionId = SessionId.make(`s-${name}`);
    const workspaceId = SealantWorkspaceId.make(`ws-${name}`);
    yield* sql`
      INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
      VALUES (${worktreeId}, ${PROJECT}, ${name}, ${name}, ${`mend/${name}`}, ${BASE})`;
    const change = yield* changes.ensureForWorktree(PROJECT, worktreeId, `mend/${name}`, BASE);
    yield* sessions.create({
      id: sessionId,
      projectId: PROJECT,
      worktreeId,
      harness: "claude",
      label: name,
      worktree: name,
      branch: `mend/${name}`,
      baseSha: BASE,
      baseRef: "main",
      contextSnapshotId: null,
      ownerUserId: OWNER,
      origin: "mend",
    });
    yield* sessions.setStatus(sessionId, status);
    const create = (kind: SessionProcessKind) =>
      processes.create({
        sessionId,
        sealantWorkspaceId: workspaceId,
        sealantSessionId: `pty-${name}-${kind}`,
        kind,
        harness: kind === "agent-pty" ? "claude" : null,
        label: kind,
        argv: [kind],
      });
    const agent = yield* create("agent-pty");
    yield* create("shell");
    if (wait !== null) {
      const set = yield* processes.setWaiting(agent.id, sessionId, null, wait);
      expect(set, "the agent holds its finished turn").toBe(true);
    }
    return { sessionId, changeId: change.id, agentId: agent.id } satisfies Seeded;
  });

/** Above `eventually`'s deadline, so a missing push fails on its assertion, not on vitest's clock. */
const TEST_TIMEOUT_MS = 30_000;

/** Polls `ready` until it holds or ten seconds pass; the assertions after it say what was seen. */
const eventually = (ready: () => boolean) =>
  Effect.sync(ready).pipe(
    Effect.repeat({ until: (ok) => ok, schedule: Schedule.spaced("50 millis") }),
    Effect.timeoutOption("10 seconds"),
  );

interface Observed {
  readonly pushes: ReadonlyArray<{
    readonly token: string;
    readonly title: string;
    readonly body: string;
    readonly sessionId: string;
  }>;
  readonly jobs: ReadonlyArray<JobSpec>;
}

/**
 * Starts the session notifier and review prep on their own `listenEvents` streams over the
 * scratch database, with only the push transport, the job queue and the git read faked. Returns
 * once both streams have heard a NOTIFY, so the LISTEN is in place before the caller triggers.
 */
const startWorkers = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const pushes: Array<PushMessage> = [];
  const jobs: Array<JobSpec> = [];
  const fakes = Layer.mergeAll(
    CaptureRuntimeOff,
    Layer.mock(PushSender, {
      send: (messages) =>
        Effect.sync(() => {
          pushes.push(...messages);
          return [];
        }),
    }),
    Layer.mock(JobRunner, {
      enqueue: (job) =>
        Effect.sync(() => {
          jobs.push(job);
          return `job-${jobs.length}`;
        }),
    }),
    Layer.mock(WorktreeReads, {
      changedFiles: () =>
        Effect.succeed({
          stamp: WORKTREE_STAMP,
          value: [{ path: "src/billing.ts", additions: 3, deletions: 1 }],
        }),
    }),
  );
  const heard = { notifier: false, prep: false };
  const listening = (mark: () => void) =>
    listenEvents(sql).pipe(Stream.tap(() => Effect.sync(mark)));
  yield* sessionNotifier(listening(() => (heard.notifier = true))).pipe(Effect.provide(fakes));
  yield* reviewPrep(listening(() => (heard.prep = true))).pipe(Effect.provide(fakes));
  const listeningNow = yield* notifyEvent(sql, {
    type: "project",
    projectId: "listen-canary",
  }).pipe(
    Effect.map(() => heard.notifier && heard.prep),
    Effect.repeat({ until: (ok) => ok, schedule: Schedule.spaced("50 millis") }),
    Effect.timeoutOption("10 seconds"),
  );
  expect(listeningNow._tag, "both workers hear the channel").toBe("Some");
  return {
    observed: (): Observed => ({
      pushes: pushes.map((message) => ({
        token: Redacted.value(message.token),
        title: message.title,
        body: message.body,
        sessionId: message.data.sessionId,
      })),
      jobs: [...jobs],
    }),
  };
});

const reviewPasses = (changeId: ChangeId): ReadonlyArray<JobSpec> => [
  {
    name: "compose-tour",
    payload: { changeId, requestedBy: OWNER },
    idempotencyKey: `compose-tour:${changeId}`,
  },
  {
    name: "suggest-change",
    payload: { changeId, requestedBy: OWNER },
    idempotencyKey: `suggest-change:${changeId}`,
  },
];
const jobsFor = (observed: Observed, changeId: ChangeId) =>
  observed.jobs.filter((job) => job.payload["changeId"] === changeId);
const pushesFor = (observed: Observed, sessionId: SessionId) =>
  observed.pushes.filter((push) => push.sessionId === sessionId);

const run = <A, E>(effect: Effect.Effect<A, E, Repos | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(reposLayer)));

describe.skipIf(postgres.skip)("a terminal agent's exit under a live shell, through LISTEN", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const devices = yield* PushDevicesRepo;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email")
          VALUES (${OWNER}, 'Alice', 'alice@example.com')`;
        yield* sql`
          INSERT INTO projects
            (id, name, store_path, default_branch, organization_id, auto_tour, auto_suggest)
          VALUES (${PROJECT}, 'web', '/store/p-web/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1), 'on', 'on')`;
        yield* devices.register(OWNER, PHONE, "ios");
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it(
    "rings `completed` and prepares review when only the agent's row changes",
    async () => {
      await run(
        Effect.gen(function* () {
          const sessions = yield* SessionsRepo;
          const processes = yield* SessionProcessesRepo;
          const seeded = yield* seedSession("billing-fix", "idle", finishedTurn());
          const before = yield* sessions.byId(seeded.sessionId);
          const workers = yield* startWorkers;

          yield* processes.markExited(seeded.agentId, "exited", 0);

          yield* eventually(() => {
            const observed = workers.observed();
            return (
              pushesFor(observed, seeded.sessionId).length > 0 &&
              jobsFor(observed, seeded.changeId).length >= 2
            );
          });
          const observed = workers.observed();
          expect(pushesFor(observed, seeded.sessionId)).toEqual([
            {
              token: PHONE,
              title: "web",
              body: "billing-fix completed",
              sessionId: seeded.sessionId,
            },
          ]);
          expect(jobsFor(observed, seeded.changeId)).toEqual(reviewPasses(seeded.changeId));
          const after = yield* sessions.byId(seeded.sessionId);
          expect(
            { status: after.status, updatedAt: after.updatedAt },
            "the exit wrote no session row, so no `session` event fired",
          ).toEqual({ status: "idle", updatedAt: before.updatedAt });
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rings nothing and prepares nothing when a terminal agent only finishes its turn",
    async () => {
      await run(
        Effect.gen(function* () {
          const sessions = yield* SessionsRepo;
          const processes = yield* SessionProcessesRepo;
          const finishing = yield* seedSession("finishing", "running", null);
          const marker = yield* seedSession("marker", "idle", finishedTurn());
          const workers = yield* startWorkers;

          const set = yield* processes.setWaiting(
            finishing.agentId,
            finishing.sessionId,
            null,
            finishedTurn(),
          );
          expect(set).toBe(true);
          yield* sessions.setStatus(finishing.sessionId, "idle");
          // Each worker handles its events in NOTIFY order: once the marker's exit is handled, the
          // finished turn's events before it have been handled too.
          yield* processes.markExited(marker.agentId, "exited", 0);

          yield* eventually(() => {
            const observed = workers.observed();
            return (
              pushesFor(observed, marker.sessionId).length > 0 &&
              jobsFor(observed, marker.changeId).length >= 2
            );
          });
          const observed = workers.observed();
          expect(pushesFor(observed, marker.sessionId)).toHaveLength(1);
          expect(jobsFor(observed, marker.changeId)).toEqual(reviewPasses(marker.changeId));
          expect({
            pushes: pushesFor(observed, finishing.sessionId),
            jobs: jobsFor(observed, finishing.changeId),
          }).toEqual({ pushes: [], jobs: [] });
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
