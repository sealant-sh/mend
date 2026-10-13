import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepo,
  AuditEventsRepo,
  ChangeLandingsRepo,
  ProjectsRepo,
  SessionNotFoundError,
  SessionsRepo,
  SettingsRepo,
  SlackInstallsRepo,
  SlackThreadsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
  type NewAuditEvent,
} from "@mend/db";
import {
  AgentTurnId,
  ChangeId,
  ChangeLandingId,
  CheckpointId,
  defaultSettings,
  OrganizationId,
  ProjectId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { AgentTurn, Change, ChangeLanding, Project, Worktree } from "@mend/domain/workbench";
import { RequestIntentReader } from "@mend/inference";
import { Landing, type LandInput } from "@mend/landing";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { SessionEngine, WorkspaceGitHooks, WorktreeReads, WORKTREE_STAMP } from "@mend/sessions";
import { AgentBridge, makeSourcePolicy, MendKeys, SourcePolicy } from "@mend/store";
import { Cause, Deferred, Effect, Exit, Layer, Logger, Queue, Stream } from "effect";
import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";
import { describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { AutomaticLandingLive } from "./automatic-landing.ts";
import { OwnerLandingLive } from "./owner-landing.ts";

const BASE = Sha.make("a".repeat(40));
const unused = (): never => {
  throw new Error("unused automatic-landing fixture capability");
};
const makeSlot = (name: string) => {
  const now = new Date();
  const sessionId = SessionId.make(`session-${name}`);
  const projectId = ProjectId.make(`project-${name}`);
  const worktreeId = WorktreeId.make(`worktree-${name}`);
  const owner = `owner-${name}`;
  const session = makeSession(sessionId, projectId, worktreeId, owner);
  const project = new Project({
    ...makeProject({
      id: projectId,
      organizationId: OrganizationId.make(`org-${name}`),
      visibility: "shared",
      createdByUserId: owner,
      storePath: `/owned-fixture/${name}/repo.git`,
    }),
    originUrl: "git@github.com:fixture/project.git",
    autoLand: "on",
  });
  const worktree = new Worktree({
    id: worktreeId,
    projectId,
    name,
    directory: name,
    branch: `mend/${name}`,
    baseSha: BASE,
    baseRef: "main",
    createdAt: now,
    updatedAt: now,
  });
  const change = new Change({
    id: ChangeId.make(`change-${name}`),
    projectId,
    worktreeId,
    sessionId,
    branch: worktree.branch,
    baseSha: BASE,
    headSha: null,
    createdAt: now,
    updatedAt: now,
  });
  let turn = new AgentTurn({
    id: AgentTurnId.make(`turn-${name}`),
    sessionId,
    processId: SessionProcessId.make(`process-${name}`),
    ordinal: 0,
    author: owner,
    origin: "request",
    input: `fix ${name}`,
    status: "completed",
    providerTurnId: null,
    error: null,
    usage: null,
    intent: "change",
    intentSource: "read",
    createdAt: now,
    startedAt: now,
    endedAt: now,
  });
  return {
    session,
    project,
    worktree,
    change,
    owner,
    turn: () => turn,
    replace: (next: AgentTurn) => {
      turn = next;
    },
  };
};
type Slot = ReturnType<typeof makeSlot>;
interface EventRecord {
  readonly payload: string;
  readonly handled: Deferred.Deferred<void>;
}
const makeEvents = Effect.gen(function* () {
  const records = yield* Queue.unbounded<EventRecord, SqlError>();
  const ready = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const channels: Array<string> = [];
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
  ).pipe(Stream.ensuring(Deferred.succeed(closed, undefined)));
  const publish = (payload: string) =>
    Effect.gen(function* () {
      const handled = yield* Deferred.make<void>();
      yield* Queue.offer(records, { payload, handled });
      yield* Deferred.await(handled);
    }).pipe(Effect.timeout("2 seconds"));
  return { records, ready, closed, channels, stream, publish };
});
type Events = Effect.Success<typeof makeEvents>;
const makeWorld = Effect.fn(function* (events: Events, startup: boolean) {
  const a = makeSlot("a");
  const b = makeSlot("b");
  const slots = [a, b];
  const decisions = yield* Queue.unbounded<AgentTurn>();
  const reads = yield* Queue.unbounded<SessionId>();
  const flushStarted = yield* Deferred.make<void>();
  const flushRelease = yield* Deferred.make<void>();
  let flushExit: Exit.Exit<void> | undefined;
  const listenWarning = yield* Deferred.make<void>();
  const claimed = new Set<string>();
  const counts = new Map<SessionId, number>();
  const lands: Array<LandInput> = [];
  const audits: Array<NewAuditEvent> = [];
  const logs: Array<string> = [];
  let holdA = false;
  let failA = false;
  const bySession = (id: SessionId) => slots.find((slot) => slot.session.id === id);
  const dependencies = Layer.mergeAll(
    Logger.layer([
      Logger.make((options) => {
        const message = String(options.message);
        logs.push(message);
        if (message.includes("listen stream ended"))
          Deferred.doneUnsafe(listenWarning, Effect.void);
      }),
    ]),
    Layer.mock(PgClient.PgClient, {
      [PgClient.TypeId]: PgClient.TypeId,
      "~effect/sql/SqlClient": "~effect/sql/SqlClient",
      config: {},
      listen: (channel) => {
        events.channels.push(channel);
        return events.stream;
      },
      literal: unused,
      in: unused,
      insert: unused,
      update: unused,
      updateValues: unused,
      and: unused,
      or: unused,
      csv: unused,
      join: unused,
      onDialect: unused,
      onDialectOrElse: unused,
      withoutTransforms: unused,
      reactive: unused,
      json: unused,
    }),
    Layer.mock(AgentConversationRepo, {
      listTurns: (id) =>
        Effect.gen(function* () {
          counts.set(id, (counts.get(id) ?? 0) + 1);
          yield* Queue.offer(reads, id);
          if (failA && id === a.session.id) return yield* Effect.die("owned session read failed");
          const slot = bySession(id);
          return slot === undefined ? [] : [slot.turn()];
        }),
      hasPendingRequests: () => Effect.succeed(false),
      turnItems: () => Effect.succeed([]),
      claimTurnLanding: (id) =>
        Effect.sync(() => {
          const slot = slots.find((candidate) => candidate.turn().id === id);
          if (slot === undefined || claimed.has(id) || slot.turn().landing !== null) return null;
          claimed.add(id);
          return slot.turn();
        }),
      decideTurnLanding: (id, landing, landingId) =>
        Effect.gen(function* () {
          const slot = slots.find((candidate) => candidate.turn().id === id);
          if (slot === undefined) return yield* Effect.die("unknown fixture turn");
          const next = new AgentTurn({ ...slot.turn(), landing, landingId });
          slot.replace(next);
          yield* Queue.offer(decisions, next);
          return next;
        }),
    }),
    Layer.mock(SessionsRepo, {
      byId: (id) => {
        const slot = bySession(id);
        return slot === undefined
          ? Effect.fail(new SessionNotFoundError({ sessionId: id }))
          : Effect.succeed(slot.session);
      },
      listActive: () => Effect.succeed(startup ? [a.session] : []),
      listForWorktree: (id) =>
        Effect.succeed(slots.filter((slot) => slot.worktree.id === id).map((slot) => slot.session)),
    }),
    Layer.mock(ProjectsRepo, {
      byId: (id) =>
        Effect.sync(() => {
          const slot = slots.find((candidate) => candidate.project.id === id);
          if (slot === undefined) return unused();
          return slot.project;
        }),
    }),
    Layer.mock(SettingsRepo, { forOrganization: () => Effect.succeed(defaultSettings) }),
    Layer.mock(WorktreesRepo, {
      byId: (id) =>
        Effect.sync(() => {
          const slot = slots.find((candidate) => candidate.worktree.id === id);
          if (slot === undefined) return unused();
          return slot.worktree;
        }),
    }),
    Layer.mock(WorktreeChangesRepo, {
      byWorktree: (id) =>
        Effect.succeed(slots.find((slot) => slot.worktree.id === id)?.change ?? null),
    }),
    Layer.mock(ChangeLandingsRepo, { listForChange: () => Effect.succeed([]) }),
    Layer.mock(SlackThreadsRepo, {}),
    Layer.mock(SlackInstallsRepo, {}),
    Layer.mock(RequestIntentReader, {}),
    Layer.mock(WorkspaceGitHooks, {}),
    Layer.mock(WorktreeReads, {
      changedFiles: (projectId, worktreeId, base) =>
        Effect.sync(() => {
          expect(
            slots.some((slot) => slot.project.id === projectId && slot.worktree.id === worktreeId),
          ).toBe(true);
          expect(base).toBe(BASE);
          return {
            stamp: WORKTREE_STAMP,
            value: [{ path: "changed.ts", additions: 1, deletions: 0 }],
          };
        }),
    }),
    Layer.mock(SessionEngine, {
      launchUnderWay: () => false,
      flushCaptures: (id) =>
        Effect.gen(function* () {
          if (id === a.session.id && holdA) {
            yield* Effect.gen(function* () {
              yield* Deferred.succeed(flushStarted, undefined);
              yield* Deferred.await(flushRelease);
            }).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  flushExit = exit;
                }),
              ),
            );
          }
          return "flushed" as const;
        }),
    }),
    Layer.mock(Landing, {
      land: (input) =>
        Effect.sync(() => {
          lands.push(input);
          const slot = bySession(input.sessionId);
          if (slot === undefined) return unused();
          return {
            landing: new ChangeLanding({
              id: ChangeLandingId.make(`landing-${slot.owner}`),
              changeId: slot.change.id,
              sessionId: slot.session.id,
              projectId: slot.project.id,
              checkpointId: CheckpointId.make(`checkpoint-${slot.owner}`),
              checkpointRef: `refs/mend/${slot.owner}`,
              checkpointSha: BASE,
              commitSha: null,
              remoteBranch: slot.worktree.branch,
              pushedSha: BASE,
              trigger: "automatic",
              pullRequest: null,
              outcome: "pushed",
              message: null,
              userId: slot.owner,
              createdAt: new Date(),
            }),
            pullRequest: { _tag: "off" as const },
          };
        }),
    }),
    Layer.mock(AuditEventsRepo, {
      record: (event) =>
        Effect.sync(() => {
          audits.push(event);
        }),
    }),
    Layer.mock(ProjectAccess, { isOperator: () => Effect.succeed(false) }),
    // Recording Landing does not run its deferred Git environment or contact a remote.
    Layer.succeed(
      SourcePolicy,
      makeSourcePolicy({ profile: "operator", allowedHosts: [], resolve: async () => [] }),
    ),
    Layer.mock(MendKeys, {}),
    Layer.mock(AgentBridge, { socketPath: () => "/unused/agent.sock" }),
    Layer.succeed(NetworkConfig, makePublicNetwork(PublicOrigin.make("https://owned.invalid"), [])),
  );
  const layer = AutomaticLandingLive.pipe(
    Layer.provide(OwnerLandingLive.pipe(Layer.provideMerge(dependencies))),
  );
  return {
    a,
    b,
    decisions,
    reads,
    flushStarted,
    flushRelease,
    flushExit: () => flushExit,
    listenWarning,
    counts,
    lands,
    audits,
    logs,
    layer,
    hold: () => {
      holdA = true;
    },
    fail: () => {
      failA = true;
    },
    publish: (slot: Slot) =>
      events.publish(
        JSON.stringify({
          type: "agent-conversation",
          sessionId: slot.session.id,
          projectId: slot.project.id,
        }),
      ),
  };
});
type World = Effect.Success<ReturnType<typeof makeWorld>>;
const withWorld = <E>(
  startup: boolean,
  work: (world: World, events: Events) => Effect.Effect<void, E>,
  after?: (world: World) => void,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* makeEvents;
        yield* Effect.addFinalizer(() => Queue.shutdown(events.records));
        const world = yield* makeWorld(events, startup);
        yield* Effect.addFinalizer(() => Deferred.succeed(world.flushRelease, undefined));
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(world.layer);
            yield* Deferred.await(events.ready).pipe(Effect.timeout("2 seconds"));
            expect(events.channels).toEqual(["mend_events"]);
            yield* work(world, events);
          }),
        );
        expect(Deferred.isDoneUnsafe(events.closed)).toBe(true);
        after?.(world);
      }),
    ),
  );
const nextDecision = (world: World) =>
  Queue.take(world.decisions).pipe(Effect.timeout("2 seconds"));

describe("AutomaticLandingLive scoped event worker", () => {
  it("coalesces a burst for one held session while another lands independently", () =>
    withWorld(
      false,
      (world) =>
        Effect.gen(function* () {
          world.hold();
          yield* world.publish(world.a);
          yield* Deferred.await(world.flushStarted).pipe(Effect.timeout("2 seconds"));
          for (let index = 0; index < 4; index++) yield* world.publish(world.a);
          expect(world.counts.get(world.a.session.id)).toBe(1);
          yield* world.publish(world.b);
          expect((yield* nextDecision(world)).sessionId).toBe(world.b.session.id);
          expect(world.lands.map((input) => [input.sessionId, input.actorUserId])).toEqual([
            [world.b.session.id, "owner-b"],
          ]);
          yield* Deferred.succeed(world.flushRelease, undefined);
          expect((yield* nextDecision(world)).sessionId).toBe(world.a.session.id);
          // The third read is the coalesced look after the initial and post-flush reads.
          let reads = 0;
          while (reads < 3)
            if (
              (yield* Queue.take(world.reads).pipe(Effect.timeout("2 seconds"))) ===
              world.a.session.id
            )
              reads++;
        }),
      (world) => {
        expect(world.counts.get(world.a.session.id)).toBe(3);
        expect(world.lands.map((input) => [input.sessionId, input.actorUserId])).toEqual([
          [world.b.session.id, "owner-b"],
          [world.a.session.id, "owner-a"],
        ]);
        expect(world.audits.map((event) => [event.actorUserId, event.subjectId])).toEqual([
          ["owner-b", world.b.change.id],
          ["owner-a", world.a.change.id],
        ]);
      },
    ));

  it("sweeps an already ended fresh turn at startup and never lands it twice", () =>
    withWorld(
      true,
      (world) =>
        Effect.gen(function* () {
          expect((yield* nextDecision(world)).landing).toBe("attempted");
          yield* world.publish(world.a);
          expect(world.lands).toHaveLength(1);
          expect(world.a.turn()).toMatchObject({
            landing: "attempted",
            landingId: "landing-owner-a",
          });
        }),
      (world) => expect(world.lands).toHaveLength(1),
    ));

  it("isolates malformed and unrelated events before handling a valid turn event", () =>
    withWorld(false, (world, events) =>
      Effect.gen(function* () {
        yield* events.publish("not-json");
        yield* events.publish(JSON.stringify({ type: "project", projectId: world.a.project.id }));
        expect(world.counts.size).toBe(0);
        expect(world.logs.some((line) => line.includes("event handling failed"))).toBe(true);
        yield* world.publish(world.a);
        expect((yield* nextDecision(world)).sessionId).toBe(world.a.session.id);
        expect(world.lands).toHaveLength(1);
      }),
    ));

  it("isolates a failed session look while another session still lands", () =>
    withWorld(false, (world) =>
      Effect.gen(function* () {
        world.fail();
        yield* world.publish(world.a);
        yield* world.publish(world.b);
        expect((yield* nextDecision(world)).sessionId).toBe(world.b.session.id);
        expect(world.logs.some((line) => line.includes("session look failed"))).toBe(true);
        expect(world.lands.map((input) => input.sessionId)).toEqual([world.b.session.id]);
      }),
    ));

  it("interrupts owned pending capture work when the worker scope closes", () =>
    withWorld(
      false,
      (world) =>
        Effect.gen(function* () {
          world.hold();
          yield* world.publish(world.a);
          yield* Deferred.await(world.flushStarted).pipe(Effect.timeout("2 seconds"));
          expect(world.lands).toEqual([]);
        }),
      (world) => {
        const exit = world.flushExit();
        expect(exit).toBeDefined();
        expect(
          exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        ).toBe(true);
        expect(world.lands).toEqual([]);
      },
    ));

  it("logs an explicitly failed stream and finalizes its listener", () =>
    withWorld(
      false,
      (world, events) =>
        Effect.gen(function* () {
          yield* Queue.fail(
            events.records,
            new SqlError({
              reason: new ConnectionError({ cause: new Error("owned stream failure") }),
            }),
          );
          yield* Deferred.await(events.closed).pipe(Effect.timeout("2 seconds"));
          yield* Deferred.await(world.listenWarning).pipe(Effect.timeout("2 seconds"));
          // This controlled failure tests the worker's boundary only, not PostgreSQL reconnect behavior.
        }),
      (world) => expect(world.logs.some((line) => line.includes("listen stream ended"))).toBe(true),
    ));
});
