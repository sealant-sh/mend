import {
  AuditEventsRepo,
  DevicesRepo,
  LastOwnerError,
  OrganizationsRepo,
  ProjectsRepo,
  PushDevicesRepo,
  SessionsRepo,
  UserEvents,
  UsersRepo,
} from "@mend/db";
import { OrganizationId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { Organization } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { Deferred, Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import * as Context from "effect/Context";
import { describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { ConnectionRegistry, ConnectionRegistryLive } from "./connections.ts";
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
  it("revokes before it answers, then stops the account's sessions and drains the pools", async () => {
    const world = removalWorld();
    const exit = await remove(world);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(world.effects).toEqual([
      "organizations.removeMember:carol",
      "users.deactivate:carol",
      "users.revokeAuthSessions:carol",
      "devices.revokeAllForUser:carol",
      "pushDevices.removeAllForUser:carol",
      "audit.record:member.removed:carol",
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
});
