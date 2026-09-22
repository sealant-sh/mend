import {
  AuditEventsRepo,
  DevicesRepo,
  LastOwnerError,
  OrganizationsRepo,
  ProjectsRepo,
  PushDevicesRepo,
  SessionControlEventsRepo,
  SessionsRepo,
  SlackLinksRepo,
  UserEvents,
  UsersRepo,
} from "@mend/db";
import { OrganizationId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { Organization } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { Deferred, Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import * as Context from "effect/Context";
import { Socket } from "effect/unstable/socket";
import { describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import {
  ConnectionRegistry,
  ConnectionRegistryLive,
  guardSocket,
  makeConnectionRegistry,
} from "./connections.ts";
import { EventBus, makeEventBus } from "./events-bus.ts";
import { MemberRemoval, MemberRemovalLive } from "./member-removal.ts";

const ACME = OrganizationId.make("org-acme");
const PROJECT = ProjectId.make("project-acme");

/** A removal whose every effect is appended, in order, as `service.method:subject`. */
const removalWorld = (options: { readonly lastOwner?: boolean } = {}) => {
  const effects: Array<string> = [];
  const woundDown = Effect.runSync(Deferred.make<void>());
  const note = (entry: string) => Effect.sync(() => void effects.push(entry));
  const layer = MemberRemovalLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrganizationsRepo, {
          removeMember: (_organizationId, userId) =>
            options.lastOwner === true
              ? Effect.fail(new LastOwnerError({ organizationId: ACME }))
              : note(`organizations.removeMember:${userId}`),
        }),
        Layer.mock(UsersRepo, {
          deactivate: (userId) => note(`users.deactivate:${userId}`),
          revokeAuthSessions: (userId) => note(`users.revokeAuthSessions:${userId}`),
        }),
        Layer.mock(DevicesRepo, {
          revokeAllForUser: (userId) =>
            note(`devices.revokeAllForUser:${userId}`).pipe(Effect.as(1)),
        }),
        Layer.mock(SessionControlEventsRepo, {
          record: (event) => note(`controlEvents.record:${event.kind}:${event.sessionId}`),
        }),
        Layer.mock(PushDevicesRepo, {
          removeAllForUser: (userId) => note(`pushDevices.removeAllForUser:${userId}`),
        }),
        Layer.mock(AuditEventsRepo, {
          record: (event) => note(`audit.record:${event.action}:${event.subjectId}`),
        }),
        Layer.mock(UserEvents, {
          changed: (userId, facet) => note(`userEvents.changed:${userId}:${facet}`),
        }),
        Layer.mock(ConnectionRegistry, {
          closeForUser: (userId) => note(`connections.closeForUser:${userId}`).pipe(Effect.as(0)),
        }),
        Layer.mock(SessionsRepo, {
          disableSharedControlForOwner: (userId) =>
            note(`sessions.disableSharedControlForOwner:${userId}`).pipe(
              Effect.as([SessionId.make("session-shared")]),
            ),
          listUnsettledForOwner: (userId) =>
            Effect.succeed([
              makeSession(
                SessionId.make(`session-${userId}`),
                PROJECT,
                WorktreeId.make("worktree-acme"),
                userId,
              ),
            ]),
        }),
        Layer.mock(ProjectsRepo, {
          listForOrganization: (organizationId) =>
            Effect.succeed([
              makeProject({
                id: PROJECT,
                organizationId,
                visibility: "shared",
                createdByUserId: "alice",
                storePath: "/store/project-acme/repo.git",
              }),
            ]),
        }),
        Layer.mock(SlackLinksRepo, {
          listForUser: (userId) =>
            Effect.succeed([
              {
                organizationId: ACME,
                teamId: "T-acme",
                slackUserId: `U-${userId}`,
                userId,
                createdAt: new Date(),
              },
            ]),
          unlink: (teamId, slackUserId) =>
            note(`slackLinks.unlink:${teamId}:${slackUserId}`).pipe(Effect.as(null)),
        }),
        Layer.mock(SessionEngine, {
          stop: (sessionId) => note(`engine.stop:${sessionId}`),
          reconcileHotSessions: (projectId) =>
            note(`engine.reconcileHotSessions:${projectId}`).pipe(
              Effect.andThen(Deferred.succeed(woundDown, undefined)),
              Effect.asVoid,
            ),
        }),
      ),
    ),
  );
  return { effects, woundDown, layer };
};

const remove = (world: ReturnType<typeof removalWorld>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const removal = yield* MemberRemoval;
      const exit = yield* removal
        .remove({ organizationId: ACME, userId: "carol", actorUserId: "alice" })
        .pipe(Effect.exit);
      if (Exit.isSuccess(exit)) yield* Deferred.await(world.woundDown);
      return exit;
    }).pipe(Effect.provide(world.layer), Effect.scoped),
  );

describe("member removal (docs/adr/0003)", () => {
  it("revokes and unlinks Slack before it answers, then stops the account's sessions and drains the pools", async () => {
    const world = removalWorld();
    const exit = await remove(world);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(world.effects).toEqual([
      "organizations.removeMember:carol",
      "sessions.disableSharedControlForOwner:carol",
      "controlEvents.record:shared-control-off:session-shared",
      "users.deactivate:carol",
      "users.revokeAuthSessions:carol",
      "devices.revokeAllForUser:carol",
      "pushDevices.removeAllForUser:carol",
      "audit.record:member.removed:carol",
      "slackLinks.unlink:T-acme:U-carol",
      "audit.record:slack.link_removed:carol",
      "userEvents.changed:carol:access",
      "connections.closeForUser:carol",
      "engine.stop:session-carol",
      `engine.reconcileHotSessions:${PROJECT}`,
    ]);
  });

  it("refusing the last owner moves nothing", async () => {
    const world = removalWorld({ lastOwner: true });
    const exit = await remove(world);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(world.effects).toEqual([]);
  });
});

describe("the connection registry", () => {
  const membersOnly = (members: ReadonlySet<string>) =>
    Layer.mock(OrganizationsRepo, {
      membershipOf: (userId) =>
        Effect.succeed(
          members.has(userId)
            ? {
                organization: new Organization({
                  id: ACME,
                  name: "Acme",
                  createdByUserId: null,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                }),
                role: "member" as const,
                joinedAt: new Date(),
              }
            : null,
        ),
    });

  /** Built in the caller's scope, so the registry's event fiber lives as long as the test. */
  const buildRegistry = <E>(listen: Stream.Stream<string, E>, members: ReadonlySet<string>) =>
    Layer.build(
      ConnectionRegistryLive.pipe(
        Layer.provide(Layer.effect(EventBus, makeEventBus(listen))),
        Layer.provide(membersOnly(members)),
      ),
    ).pipe(Effect.map((built) => Context.get(built, ConnectionRegistry)));

  it("closes an account's open connections on its access event, and none that already ended", async () => {
    const closed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Queue.unbounded<string>();
          const registry = yield* buildRegistry(
            Stream.fromQueue(source),
            new Set(["alice", "carol"]),
          );
          const log: Array<string> = [];
          const open = yield* Scope.make();
          const ended = yield* Scope.make();
          yield* registry
            .register(
              "carol",
              Effect.sync(() => void log.push("carol:terminal")),
            )
            .pipe(Scope.provide(open));
          yield* registry
            .register(
              "carol",
              Effect.sync(() => void log.push("carol:ended")),
            )
            .pipe(Scope.provide(ended));
          yield* registry
            .register(
              "alice",
              Effect.sync(() => void log.push("alice:events")),
            )
            .pipe(Scope.provide(open));
          yield* Scope.close(ended, Exit.void);
          yield* Queue.offer(
            source,
            JSON.stringify({ type: "user", userId: "carol", facet: "access" }),
          );
          yield* Effect.sleep("30 millis");
          return log;
        }),
      ),
    );
    expect(closed).toEqual(["carol:terminal"]);
  });

  it("after a lost listen connection, closes whoever no longer belongs to an organization", async () => {
    const closed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lost = yield* Deferred.make<void>();
          // The connection drops only once the registry listens and both accounts are connected.
          const listen = Stream.fromEffect(Deferred.await(lost)).pipe(
            Stream.flatMap(() => Stream.fail("connection lost")),
          );
          const registry = yield* buildRegistry(listen, new Set(["alice"]));
          const log: Array<string> = [];
          yield* registry.register(
            "carol",
            Effect.sync(() => void log.push("carol")),
          );
          yield* registry.register(
            "alice",
            Effect.sync(() => void log.push("alice")),
          );
          yield* Deferred.succeed(lost, undefined);
          yield* Effect.sleep("30 millis");
          return log;
        }),
      ),
    );
    expect(closed).toEqual(["carol"]);
  });

  it("keeps closing on later events after one signal could not be handled", async () => {
    const closed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lost = yield* Deferred.make<void>();
          const source = yield* Queue.unbounded<string>();
          // The first listen drops once carol is connected (a resync whose membership read dies);
          // the bus reconnects and the second listen carries events.
          let attempts = 0;
          const listen = Stream.unwrap(
            Effect.sync(() => {
              attempts += 1;
              return attempts === 1
                ? Stream.fromEffect(Deferred.await(lost)).pipe(
                    Stream.flatMap(() => Stream.fail("connection lost")),
                  )
                : Stream.fromQueue(source);
            }),
          );
          const built = yield* Layer.build(
            ConnectionRegistryLive.pipe(
              Layer.provide(Layer.effect(EventBus, makeEventBus(listen))),
              Layer.provide(
                Layer.mock(OrganizationsRepo, { membershipOf: () => Effect.die("db down") }),
              ),
            ),
          );
          const registry = Context.get(built, ConnectionRegistry);
          const log: Array<string> = [];
          yield* registry.register(
            "carol",
            Effect.sync(() => void log.push("carol")),
          );
          yield* Deferred.succeed(lost, undefined);
          // The bus waits a second before listening again.
          yield* Effect.sleep("1200 millis");
          const afterResync = [...log];
          yield* Queue.offer(
            source,
            JSON.stringify({ type: "user", userId: "carol", facet: "access" }),
          );
          yield* Effect.sleep("30 millis");
          return { afterResync, log };
        }),
      ),
    );
    expect(closed).toEqual({ afterResync: [], log: ["carol"] });
  });

  it("turning shared control off closes the other accounts' sockets on that session only", async () => {
    const closed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Queue.unbounded<string>();
          const registry = yield* buildRegistry(
            Stream.fromQueue(source),
            new Set(["alice", "carol"]),
          );
          const log: Array<string> = [];
          const note = (entry: string) => Effect.sync(() => void log.push(entry));
          yield* registry.register("alice", note("alice:s1"), "s1");
          yield* registry.register("carol", note("carol:s1"), "s1");
          yield* registry.register("carol", note("carol:s2"), "s2");
          yield* registry.register("carol", note("carol:events"));
          yield* Queue.offer(
            source,
            JSON.stringify({
              type: "shared-control-off",
              sessionId: "s1",
              projectId: "p1",
              ownerUserId: "alice",
            }),
          );
          yield* Effect.sleep("30 millis");
          return log;
        }),
      ),
    );
    expect(closed).toEqual(["carol:s1"]);
  });

  it("a guarded socket drops input once revoked, and closes at once if the account is gone", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* makeConnectionRegistry;
          const frames: Array<number> = [];
          const write = (event: Socket.CloseEvent) =>
            Effect.sync(() => void frames.push(event.code));
          const live = yield* guardSocket(registry, "carol", write, Effect.succeed(true));
          const before = live.revoked();
          yield* registry.closeForUser("carol");
          const gone = yield* guardSocket(registry, "dave", write, Effect.succeed(false));
          return { before, after: live.revoked(), gone: gone.revoked(), frames };
        }),
      ),
    );
    expect(result).toEqual({ before: false, after: true, gone: true, frames: [1008, 1008] });
  });
});
