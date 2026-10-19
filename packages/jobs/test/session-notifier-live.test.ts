import {
  AgentConversationRepo,
  NotificationSettingsRepo,
  OrganizationsRepo,
  ProjectsRepo,
  ProjectNotFoundError,
  PushDevice,
  PushDevicesRepo,
  SessionNotFoundError,
  SessionProcessesRepo,
  SessionsRepo,
  SlackInstallsRepo,
  SlackThreadsRepo,
} from "@mend/db";
import {
  AgentTurnId,
  OrganizationId,
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  AgentTurn,
  AgentWait,
  type AgentWaitKind,
  foldSessionLiveness,
  NotificationSettings,
  Organization,
  Project,
  Session,
  SessionProcess,
} from "@mend/domain/workbench";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Redacted, Stream, type Scope } from "effect";
import { describe, expect } from "vitest";

import { PushSender, PushSendError, type PushMessage } from "../src/push-sender.ts";
import { ATTENTION_RERING_MS, sessionNotifier } from "../src/session-notifier.ts";
const PROJECT = ProjectId.make("review-project");
const WORKTREE = WorktreeId.make("review-worktree");
const SESSION = SessionId.make("later-member-session");
const BASE = Sha.make("a".repeat(40));
/** Where the TestClock starts: the notifier's "now" in every case. */
const NOW = new Date(0);
const project = new Project({
  id: PROJECT,
  name: "review",
  organizationId: OrganizationId.make("review-org"),
  visibility: "shared",
  createdByUserId: "project-owner-bob",
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
    label: "billing-fix",
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
    ownerUserId: "alice",
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
const unused = (): never => {
  throw new Error("unused notifier fixture capability");
};
const DEVICE_ROWS = [
  new PushDevice({ token: "alice-first", userId: "alice", platform: "ios" }),
  new PushDevice({ token: "carol-phone", userId: "carol", platform: "android" }),
  new PushDevice({ token: "alice-last", userId: "alice", platform: "ios" }),
  new PushDevice({ token: "dave-other", userId: "dave", platform: "ios" }),
];
const turnRow = (
  status: AgentTurn["status"],
  id = "turn-1",
  author = "carol",
  endedAt: Date | null = null,
) =>
  new AgentTurn({
    id: AgentTurnId.make(id),
    sessionId: SESSION,
    processId: SessionProcessId.make("agent"),
    ordinal: 1,
    author,
    input: "fix the login",
    status,
    providerTurnId: null,
    error: null,
    usage: null,
    createdAt: NOW,
    startedAt: NOW,
    endedAt,
  });
const makeWorld = (
  events: Events,
  options: {
    readonly unknown?: boolean;
    readonly baseline?: Session["status"];
    readonly unavailable?: ReadonlyArray<string>;
    readonly failure?: boolean;
    readonly blocked?: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
  } = {},
) => {
  let session = sessionRow(options.baseline ?? "running");
  let turns: ReadonlyArray<AgentTurn> = [];
  let processRows: ReadonlyArray<SessionProcess> = [];
  let phones = [...DEVICE_ROWS];
  const members = new Set(["alice", "carol"]);
  const settings = new Map<string, NotificationSettings>();
  const sent: Array<ReadonlyArray<PushMessage>> = [];
  const removed: Array<string> = [];
  const queried: Array<ReadonlyArray<string>> = [];
  let failNext = options.failure ?? false;
  const dependencies = Layer.mergeAll(
    Layer.mock(SessionsRepo, {
      listActive: () => Effect.sync(() => (options.unknown ? [] : [session])),
      byId: (id) =>
        id === SESSION
          ? Effect.sync(() => session)
          : Effect.fail(new SessionNotFoundError({ sessionId: id })),
    }),
    Layer.mock(SessionProcessesRepo, {
      listForSession: () => Effect.sync(() => processRows),
    }),
    Layer.mock(ProjectsRepo, {
      byId: (id) =>
        id === PROJECT
          ? Effect.succeed(project)
          : Effect.fail(new ProjectNotFoundError({ projectId: id })),
    }),
    Layer.mock(AgentConversationRepo, {
      listTurns: (id) =>
        id === SESSION ? Effect.sync(() => turns) : Effect.die("wrong conversation session"),
      openTurns: (id) =>
        id === SESSION
          ? Effect.sync(() => turns.filter((t) => t.status === "queued" || t.status === "running"))
          : Effect.die("wrong open-turn session"),
      byTurnId: (id) => Effect.sync(() => turns.find((t) => t.id === id) ?? null),
    }),
    Layer.mock(OrganizationsRepo, {
      membershipOf: (userId) =>
        Effect.sync(() =>
          members.has(userId)
            ? {
                organization: new Organization({
                  id: project.organizationId,
                  name: "review-org",
                  createdByUserId: null,
                  createdAt: NOW,
                  updatedAt: NOW,
                }),
                role: "member" as const,
                joinedAt: NOW,
              }
            : null,
        ),
    }),
    Layer.mock(NotificationSettingsRepo, { forUsers: () => Effect.sync(() => settings) }),
    Layer.mock(PushDevicesRepo, {
      listForUsers: (users) =>
        Effect.sync(() => {
          queried.push([...users]);
          return phones.filter((p) => users.includes(p.userId));
        }),
      remove: (token) =>
        Effect.sync(() => {
          removed.push(token);
          phones = phones.filter((p) => p.token !== token);
        }),
    }),
    Layer.mock(SlackThreadsRepo, { forSession: () => Effect.succeed(null) }),
    Layer.mock(SlackInstallsRepo, { byTeam: unused }),
    Layer.succeed(PushSender, {
      send: (messages) =>
        Effect.gen(function* () {
          sent.push(messages);
          if (options.blocked !== undefined) {
            yield* Deferred.succeed(options.blocked.entered, undefined);
            yield* Deferred.await(options.blocked.release);
          }
          const fail = failNext;
          failNext = false;
          if (fail) return yield* new PushSendError({ reason: "request" });
          return messages
            .filter((m) => options.unavailable?.includes(Redacted.value(m.token)))
            .map((m) => m.token);
        }),
    }),
  );
  return {
    layer: Layer.effectDiscard(sessionNotifier(events.stream)).pipe(Layer.provide(dependencies)),
    sent,
    removed,
    queried,
    members,
    settings,
    update: (patch: Partial<Session>) => {
      session = new Session({ ...session, ...patch });
    },
    turns: (next: ReadonlyArray<AgentTurn>) => {
      turns = next;
    },
    /** The session's processes, and the status the engine folds from them while one is live. */
    processes: (next: ReadonlyArray<SessionProcess>) => {
      processRows = next;
      const liveness = foldSessionLiveness(next);
      if (liveness !== "settled") session = new Session({ ...session, status: liveness });
    },
    sessionEvent: () =>
      events.publish(JSON.stringify({ type: "session", sessionId: SESSION, projectId: PROJECT })),
    turnEvent: () =>
      events.publish(
        JSON.stringify({ type: "agent-conversation", sessionId: SESSION, projectId: PROJECT }),
      ),
  };
};
type World = ReturnType<typeof makeWorld>;
/** The session's live terminal claude, waiting as its hooks last reported. */
const terminalAgent = (kind: AgentWaitKind | null, tool: string | null = null) =>
  new SessionProcess({
    id: SessionProcessId.make("agent"),
    sessionId: SESSION,
    sealantWorkspaceId: SealantWorkspaceId.make("review-workspace"),
    sealantSessionId: "pty-1",
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind: "agent-pty",
    harness: "claude",
    providerSessionId: "claude-session",
    protocolOptions: null,
    label: "claude",
    argv: ["claude"],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: NOW,
    exitedAt: null,
    updatedAt: NOW,
    waiting: kind === null ? null : new AgentWait({ kind, tool, since: NOW }),
  });
const deliveries = (world: World) =>
  world.sent.map((batch) =>
    batch.map((message) => ({ ...message, token: Redacted.value(message.token) })),
  );
const expected = (tokens: ReadonlyArray<string>, body: string) =>
  tokens.map((token) => ({
    token,
    title: "review",
    body,
    data: { sessionId: SESSION, projectId: PROJECT },
  }));
const runWorld = (
  scenario: (world: World, events: Events) => Effect.Effect<void, unknown, Scope.Scope>,
  options: Parameters<typeof makeWorld>[1] = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* makeEvents;
      yield* Effect.addFinalizer(() => events.shutdown);
      const world = makeWorld(events, options);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(world.layer);
          yield* Deferred.await(events.ready).pipe(Effect.timeout("2 seconds"));
          yield* scenario(world, events);
        }),
      );
      expect(events.closed()).toBe(true);
    }),
  );

describe("SessionNotifierLive event worker", () => {
  it.effect("records a known terminal baseline silently and closes its listener", () =>
    runWorld(
      (world) =>
        Effect.gen(function* () {
          yield* world.sessionEvent();
          expect(deliveries(world)).toEqual([]);
        }),
      { baseline: "completed" },
    ),
  );
  it.effect(
    "ignores unknown settled state, then sends one fresh completion with exact identity and ordered pruning",
    () =>
      runWorld(
        (world) =>
          Effect.gen(function* () {
            world.update({
              status: "completed",
              settledAt: NOW,
              captureNotSavedAt: NOW,
              captureDrain: "stop",
              capturePending: 3,
            });
            yield* world.sessionEvent();
            expect(deliveries(world)).toEqual([]);
            world.update({
              status: "running",
              settledAt: null,
              captureNotSavedAt: null,
              captureDrain: null,
              capturePending: null,
            });
            yield* world.sessionEvent();
            world.update({ status: "completed", settledAt: NOW, summary: "Login fixed" });
            yield* world.sessionEvent();
            expect(deliveries(world)).toEqual([
              expected(["alice-first", "alice-last"], "billing-fix completed: Login fixed"),
            ]);
            expect(world.removed).toEqual(["alice-last"]);
            yield* world.sessionEvent();
            world.update({ status: "stopped" });
            yield* world.sessionEvent();
            expect(world.sent).toHaveLength(1);
          }),
        { unknown: true, unavailable: ["alice-last"] },
      ),
  );
  it.effect(
    "prunes multiple unavailable tokens in delivery order and preserves other registered phones",
    () =>
      runWorld(
        (world) =>
          Effect.gen(function* () {
            world.update({ sharedControlEnabledAt: NOW });
            world.turns([turnRow("running")]);
            world.update({ status: "waiting" });
            yield* world.sessionEvent();
            expect(deliveries(world)).toEqual([
              expected(
                ["alice-first", "carol-phone", "alice-last"],
                "billing-fix is waiting on you",
              ),
            ]);
            expect(world.removed).toEqual(["alice-first", "carol-phone"]);
            world.update({ status: "running" });
            yield* world.sessionEvent();
            yield* TestClock.adjust(ATTENTION_RERING_MS);
            world.update({ status: "waiting" });
            yield* world.sessionEvent();
            expect(deliveries(world)).toEqual([
              expected(
                ["alice-first", "carol-phone", "alice-last"],
                "billing-fix is waiting on you",
              ),
              expected(["alice-last"], "billing-fix is waiting on you"),
            ]);
            expect(world.removed).toEqual(["alice-first", "carol-phone"]);
          }),
        { unavailable: ["alice-first", "carol-phone"] },
      ),
  );
  it.effect("acknowledges an event only after its owned delivery has settled", () => {
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    return runWorld(
      (world) =>
        Effect.gen(function* () {
          world.update({ status: "waiting" });
          const publish = yield* world.sessionEvent().pipe(Effect.forkScoped);
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"));
          expect(publish.pollUnsafe()).toBeUndefined();
          expect(deliveries(world)).toEqual([
            expected(["alice-first", "alice-last"], "billing-fix is waiting on you"),
          ]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(publish);
        }),
      { blocked: { entered, release } },
    );
  });
  it.effect("suppresses stale completion but sends a subsequent fresh failure", () =>
    runWorld((world) =>
      Effect.gen(function* () {
        world.update({ status: "completed", settledAt: new Date(NOW.getTime() - 10 * 60_000) });
        yield* world.sessionEvent();
        expect(deliveries(world)).toEqual([]);
        world.update({ status: "running", settledAt: null });
        yield* world.sessionEvent();
        world.update({ status: "failed", settledAt: NOW, summary: "check failed" });
        yield* world.sessionEvent();
        expect(deliveries(world)).toEqual([
          expected(["alice-first", "alice-last"], "billing-fix failed: check failed"),
        ]);
      }),
    ),
  );
  it.effect(
    "rings only the owner for new capture alerts even with a shared-control sender, once until recovery",
    () =>
      runWorld((world) =>
        Effect.gen(function* () {
          world.update({ sharedControlEnabledAt: NOW });
          world.turns([turnRow("running")]);
          world.update({ captureNotSavedAt: NOW, captureDrain: "stop", capturePending: 3 });
          yield* world.sessionEvent();
          yield* world.sessionEvent();
          expect(deliveries(world)).toEqual([
            expected(
              ["alice-first", "alice-last"],
              "billing-fix not saved · 3 pending · workspace kept",
            ),
          ]);
          expect(world.queried).toEqual([["alice"]]);
          world.update({ captureNotSavedAt: null, captureDrain: null, capturePending: null });
          yield* world.sessionEvent();
          world.update({
            captureFailingSince: new Date("2026-09-27T16:29:51.000Z"),
            captureFailingError: "EIO: tree/db.sqlite",
          });
          yield* world.sessionEvent();
          yield* world.sessionEvent();
          expect(deliveries(world)).toEqual([
            expected(
              ["alice-first", "alice-last"],
              "billing-fix not saved · 3 pending · workspace kept",
            ),
            expected(
              ["alice-first", "alice-last"],
              "billing-fix capture failing since 16:29:51 UTC · EIO: tree/db.sqlite",
            ),
          ]);
        }),
      ),
  );
  it.effect(
    "routes attention to the owner and visible shared sender with each recipient's settings",
    () =>
      runWorld((world) =>
        Effect.gen(function* () {
          world.update({ sharedControlEnabledAt: NOW });
          world.turns([turnRow("running")]);
          world.settings.set(
            "alice",
            new NotificationSettings({
              slackSessions: false,
              turnFinished: true,
              needsInput: false,
              failed: true,
            }),
          );
          world.update({ status: "waiting" });
          yield* world.sessionEvent();
          yield* world.sessionEvent();
          expect(deliveries(world)).toEqual([
            expected(["carol-phone"], "billing-fix is waiting on you"),
          ]);
          world.members.delete("carol");
          world.update({ status: "running" });
          yield* world.sessionEvent();
          yield* TestClock.adjust(ATTENTION_RERING_MS);
          world.update({ status: "waiting" });
          yield* world.sessionEvent();
          expect(world.sent).toHaveLength(1);
        }),
      ),
  );
  it.effect(
    "notifies only a watched fresh protocol turn, suppressing stale, cancelled and replayed ends",
    () =>
      runWorld((world) =>
        Effect.gen(function* () {
          world.turns([turnRow("completed", "replayed", "alice", NOW)]);
          yield* world.turnEvent();
          expect(deliveries(world)).toEqual([]);
          world.turns([turnRow("running", "fresh", "alice")]);
          yield* world.turnEvent();
          world.turns([turnRow("completed", "fresh", "alice", NOW)]);
          yield* world.turnEvent();
          yield* world.turnEvent();
          expect(deliveries(world)).toEqual([
            expected(["alice-first", "alice-last"], "billing-fix answered · fix the login"),
          ]);
          for (const [id, status, endedAt] of [
            ["stale", "completed", new Date(NOW.getTime() - 10 * 60_000)],
            ["cancelled", "cancelled", NOW],
          ] as const) {
            world.turns([turnRow("running", id, "alice")]);
            yield* world.turnEvent();
            world.turns([turnRow(status, id, "alice", endedAt)]);
            yield* world.turnEvent();
          }
          expect(world.sent).toHaveLength(1);
        }),
      ),
  );
  it.effect("survives malformed events and delivery failure without retrying the same phase", () =>
    runWorld(
      (world, events) =>
        Effect.gen(function* () {
          yield* events.publish("malformed");
          yield* events.publish(JSON.stringify({ type: "project", projectId: PROJECT }));
          world.update({ status: "waiting" });
          yield* world.sessionEvent();
          yield* world.sessionEvent();
          expect(world.sent).toHaveLength(1);
          expect(world.removed).toEqual([]);
          world.update({ status: "running" });
          yield* world.sessionEvent();
          world.update({ status: "waiting" });
          yield* world.sessionEvent();
          expect(deliveries(world)).toEqual([
            expected(["alice-first", "alice-last"], "billing-fix is waiting on you"),
            expected(["alice-first", "alice-last"], "billing-fix is waiting on you"),
          ]);
        }),
      { failure: true },
    ),
  );
  it.effect("rings attention at most once a minute however often the session flips", () =>
    runWorld((world) =>
      Effect.gen(function* () {
        const flip = Effect.gen(function* () {
          world.update({ status: "running" });
          yield* world.sessionEvent();
          world.update({ status: "waiting" });
          yield* world.sessionEvent();
        });
        yield* flip;
        expect(world.sent).toHaveLength(1);
        yield* TestClock.adjust("10 seconds");
        yield* flip;
        expect(world.sent).toHaveLength(1);
        yield* TestClock.adjust("51 seconds");
        yield* flip;
        expect(deliveries(world)).toEqual([
          expected(["alice-first", "alice-last"], "billing-fix is waiting on you"),
          expected(["alice-first", "alice-last"], "billing-fix is waiting on you"),
        ]);
      }),
    ),
  );
  it.effect(
    "rings nothing when a terminal agent finishes its turn, and rings once it asks for permission",
    () =>
      runWorld((world) =>
        Effect.gen(function* () {
          world.processes([terminalAgent(null)]);
          yield* world.sessionEvent();
          world.processes([terminalAgent("prompt")]);
          yield* world.sessionEvent();
          expect(world.sent).toEqual([]);
          world.processes([terminalAgent("permission", "Bash")]);
          yield* world.sessionEvent();
          expect(deliveries(world)).toEqual([
            expected(["alice-first", "alice-last"], "billing-fix is waiting on you"),
          ]);
        }),
      ),
  );
  it.effect("never delivers for a null owner or idle-stop housekeeping", () =>
    runWorld((world) =>
      Effect.gen(function* () {
        world.update({ ownerUserId: null, status: "waiting" });
        yield* world.sessionEvent();
        world.update({ ownerUserId: "alice", status: "running", idleStoppedAt: NOW });
        yield* world.sessionEvent();
        world.update({ status: "completed", settledAt: NOW });
        yield* world.sessionEvent();
        expect(deliveries(world)).toEqual([]);
      }),
    ),
  );
});
