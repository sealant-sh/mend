import {
  AuditEventsRepo,
  type NewAuditEvent,
  DevicesRepo,
  LastOwnerError,
  OrganizationsRepo,
  ProjectsRepo,
  PushDevicesRepo,
  SessionControlEventsRepo,
  SessionsRepo,
  SlackLinksRepo,
  type SshKeyRevocation,
  SshKeyRevocationsRepo,
  UserEvents,
  UsersRepo,
} from "@mend/db";
import { OrganizationId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { Organization, Session } from "@mend/domain/workbench";
import { SealantClients, SealantPlatformError } from "@mend/sealant";
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
import { SshKeyRevoker, SshKeyRevokerLive } from "./ssh-key-revocation.ts";

const ACME = OrganizationId.make("org-acme");
const PROJECT = ProjectId.make("project-acme");

const unreachable = () =>
  new SealantPlatformError({
    code: "UNREACHABLE",
    status: null,
    message: "platform down",
    cause: null,
  });

const keyView = (userId: string, sshKeyId: string) => ({
  sshKeyId,
  ownerUserId: `sealant-${userId}`,
  name: sshKeyId,
  algorithm: "ssh-ed25519",
  fingerprint: `SHA256:${sshKeyId}`,
  createdAt: "2026-10-01T00:00:00.000Z",
});

/**
 * A removal whose every effect is appended, in order, as `service.method:subject`. The platform
 * holds `keys` workspace SSH keys for each account; `failOnce` makes a key's next archive fail,
 * `listDown` makes listing fail. The revocation table is in memory: `removeMember` writes its row
 * as the real transaction does, held off until `makeDue` stands in for its lease running out.
 */
const removalWorld = (options: { readonly lastOwner?: boolean; readonly keys?: number } = {}) => {
  const effects: Array<string> = [];
  const audited: Array<NewAuditEvent> = [];
  const archiveCalls: Array<string> = [];
  const woundDown = Effect.runSync(Deferred.make<void>());
  const note = (entry: string) => Effect.sync(() => void effects.push(entry));
  const platform = {
    active: new Set(Array.from({ length: options.keys ?? 1 }, (_, index) => `key-${index}`)),
    failOnce: new Set<string>(),
    listDown: false,
  };
  const owed = new Map<string, SshKeyRevocation & { readonly due: boolean }>();
  const deps = Layer.mergeAll(
    Layer.mock(OrganizationsRepo, {
      removeMember: (organizationId, userId, revocation) =>
        options.lastOwner === true
          ? Effect.fail(new LastOwnerError({ organizationId: ACME }))
          : note(`organizations.removeMember:${userId}`).pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  owed.set(userId, {
                    userId,
                    organizationId,
                    actorUserId: revocation.actorUserId,
                    requestedAt: new Date(),
                    attempts: 0,
                    outstanding: null,
                    lastError: null,
                    due: false,
                  }),
                ),
              ),
            ),
    }),
    Layer.mock(SshKeyRevocationsRepo, {
      list: () => Effect.sync(() => [...owed.values()]),
      claimDue: () =>
        Effect.sync(() =>
          [...owed.values()]
            .filter((row) => row.due)
            .map((row) => {
              owed.set(row.userId, { ...row, due: false });
              return row;
            }),
        ),
      settle: (userId) =>
        note(`revocations.settle:${userId}`).pipe(
          Effect.tap(() => Effect.sync(() => owed.delete(userId))),
        ),
      defer: (userId, input) =>
        note(`revocations.defer:${userId}:${String(input.outstanding)}`).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              const row = owed.get(userId);
              if (row === undefined) return;
              owed.set(userId, {
                ...row,
                attempts: row.attempts + 1,
                outstanding: input.outstanding,
                lastError: input.lastError,
                due: false,
              });
            }),
          ),
        ),
    }),
    Layer.mock(UsersRepo, {
      deactivate: (userId) => note(`users.deactivate:${userId}`),
      revokeAuthSessions: (userId) => note(`users.revokeAuthSessions:${userId}`),
    }),
    Layer.mock(DevicesRepo, {
      revokeAllForUser: (userId) => note(`devices.revokeAllForUser:${userId}`).pipe(Effect.as(1)),
    }),
    Layer.mock(SessionControlEventsRepo, {
      record: (event) => note(`controlEvents.record:${event.kind}:${event.sessionId}`),
    }),
    Layer.mock(PushDevicesRepo, {
      removeAllForUser: (userId) => note(`pushDevices.removeAllForUser:${userId}`),
    }),
    Layer.mock(AuditEventsRepo, {
      record: (event) =>
        note(`audit.record:${event.action}:${event.subjectId}`).pipe(
          Effect.tap(() => Effect.sync(() => void audited.push(event))),
        ),
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
      // Every session of the organization's projects: Alice's shared one, which Carol steered.
      listForProject: (projectId) =>
        Effect.succeed([
          new Session({
            ...makeSession(
              SessionId.make("session-shared"),
              projectId,
              WorktreeId.make("worktree-acme"),
              "alice",
            ),
            status: "running",
            settledAt: null,
          }),
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
    Layer.mock(SealantClients, {
      connectedAccounts: () => ({
        list: () => Effect.die("not in this test"),
        connect: () => Effect.die("not in this test"),
        disconnect: () => Effect.die("not in this test"),
      }),
      sshKeys: (userId) => ({
        ensure: () => Effect.die("not in this test"),
        list: () =>
          Effect.suspend(() =>
            platform.listDown
              ? Effect.fail(unreachable())
              : Effect.succeed([...platform.active].map((id) => keyView(userId, id))),
          ),
        remove: (sshKeyId) =>
          Effect.suspend(() => {
            archiveCalls.push(sshKeyId);
            if (platform.failOnce.delete(sshKeyId)) return Effect.fail(unreachable());
            if (!platform.active.delete(sshKeyId)) return Effect.succeed(null);
            return note(`sshKeys.remove:${userId}:${sshKeyId}`).pipe(
              Effect.as(keyView(userId, sshKeyId)),
            );
          }),
      }),
    }),
    Layer.mock(SessionEngine, {
      launchUnderWay: () => false,
      cancelQueuedTurnsBy: (userId, sessionIds) =>
        note(`engine.cancelQueuedTurnsBy:${userId}:${sessionIds.length}`).pipe(Effect.as(0)),
      windDownPerson: (userId) =>
        note(`engine.windDownPerson:${userId}`).pipe(
          Effect.as({ stopped: 1, retired: [], remaining: 0 }),
        ),
      reconcileHotSessions: (projectId) =>
        note(`engine.reconcileHotSessions:${projectId}`).pipe(
          Effect.andThen(Deferred.succeed(woundDown, undefined)),
          Effect.asVoid,
        ),
    }),
  );
  const layer = MemberRemovalLive.pipe(Layer.provideMerge(SshKeyRevokerLive), Layer.provide(deps));
  const makeDue = (userId: string) => {
    const row = owed.get(userId);
    if (row !== undefined) owed.set(userId, { ...row, due: true });
  };
  return { effects, audited, archiveCalls, platform, owed, makeDue, woundDown, layer };
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

/** One pass of the worker's sweep over the same world, after the removal answered. */
const sweep = (world: ReturnType<typeof removalWorld>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SshKeyRevoker).sweep();
    }).pipe(Effect.provide(world.layer), Effect.scoped),
  );

describe("member removal (docs/adr/0003)", () => {
  it("revokes and unlinks Slack before it answers, then stops the account's sessions and drains the pools", async () => {
    const world = removalWorld();
    const exit = await remove(world);
    expect(exit).toEqual(Exit.succeed({ sshKeys: { removed: 1, outstanding: 0 } }));
    expect(world.owed.size).toBe(0);
    expect(world.effects).toEqual([
      "organizations.removeMember:carol",
      "sessions.disableSharedControlForOwner:carol",
      "controlEvents.record:shared-control-off:session-shared",
      // Carol's turns queued in anyone's session go (docs/adr/0016, decision 6).
      "engine.cancelQueuedTurnsBy:carol:1",
      "users.deactivate:carol",
      "users.revokeAuthSessions:carol",
      "devices.revokeAllForUser:carol",
      "pushDevices.removeAllForUser:carol",
      "audit.record:member.removed:carol",
      "slackLinks.unlink:T-acme:U-carol",
      "audit.record:slack.link_removed:carol",
      // The gateway refuses Carol's keys from the next connection on, and nothing stays owed.
      "sshKeys.remove:carol:key-0",
      "audit.record:ssh_key.removed:carol",
      "revocations.settle:carol",
      "userEvents.changed:carol:access",
      "connections.closeForUser:carol",
      "engine.windDownPerson:carol",
      `engine.reconcileHotSessions:${PROJECT}`,
    ]);
  });

  it("archives every key past a failure, tells the owner, and the sweep finishes after the membership is gone", async () => {
    const world = removalWorld({ keys: 101 });
    world.platform.failOnce.add("key-1");
    const exit = await remove(world);
    // One key the platform refused never stops the other hundred.
    expect(exit).toEqual(Exit.succeed({ sshKeys: { removed: 100, outstanding: 1 } }));
    expect(world.archiveCalls).toHaveLength(101);
    expect([...world.platform.active]).toEqual(["key-1"]);
    expect(world.audited.filter((event) => event.action === "ssh_key.removed")).toHaveLength(100);
    expect(world.audited.find((event) => event.action === "ssh_key.revocation_pending")).toEqual({
      organizationId: ACME,
      actorUserId: "alice",
      action: "ssh_key.revocation_pending",
      subjectType: "member",
      subjectId: "carol",
      data: { removed: 100, outstanding: 1 },
    });
    expect(world.owed.get("carol")).toMatchObject({ attempts: 1, outstanding: 1 });
    // Carol is signed out and gone from the organization whatever the platform said.
    expect(world.effects).toContain("users.revokeAuthSessions:carol");
    expect(world.effects).toContain("connections.closeForUser:carol");

    // Not due yet: the sweep leaves it alone.
    expect(await sweep(world)).toEqual([]);
    world.makeDue("carol");
    expect(await sweep(world)).toEqual([
      { userId: "carol", outcome: { removed: 1, outstanding: 0 } },
    ]);
    expect([...world.platform.active]).toEqual([]);
    expect(world.owed.size).toBe(0);
    expect(world.audited.at(-1)).toMatchObject({
      action: "ssh_key.removed",
      actorUserId: "alice",
      subjectId: "carol",
      data: { sshKeyId: "key-1", memberRemoved: true, attempt: 2 },
    });
  });

  it("removes the member when the platform cannot list their keys, and keeps trying until it can", async () => {
    const world = removalWorld({ keys: 3 });
    world.platform.listDown = true;
    const exit = await remove(world);
    expect(exit).toEqual(Exit.succeed({ sshKeys: { removed: 0, outstanding: null } }));
    expect(world.effects).toContain("users.revokeAuthSessions:carol");
    expect(
      world.audited.find((event) => event.action === "ssh_key.revocation_pending")?.data,
    ).toEqual({ removed: 0, outstanding: null });
    expect(world.owed.get("carol")).toMatchObject({ attempts: 1, outstanding: null });

    world.makeDue("carol");
    expect(await sweep(world)).toEqual([
      { userId: "carol", outcome: { removed: 0, outstanding: null } },
    ]);
    expect(world.owed.get("carol")).toMatchObject({ attempts: 2, lastError: "platform down" });

    world.platform.listDown = false;
    world.makeDue("carol");
    expect(await sweep(world)).toEqual([
      { userId: "carol", outcome: { removed: 3, outstanding: 0 } },
    ]);
    expect(world.platform.active.size).toBe(0);
    expect(world.owed.size).toBe(0);
  });

  it("refusing the last owner moves nothing", async () => {
    const world = removalWorld({ lastOwner: true });
    const exit = await remove(world);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(world.effects).toEqual([]);
    // No key of the owner who stays is owed or touched.
    expect(world.owed.size).toBe(0);
    expect(world.archiveCalls).toEqual([]);
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
