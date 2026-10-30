import {
  AuditEventsRepo,
  type NewAuditEvent,
  LastOwnerError,
  OrganizationsRepo,
  MemberRevocationsRepo,
  ProjectsRepo,
  SessionControlEventsRepo,
  type SshKeyRevocation,
  SshKeyRevocationsRepo,
  UserEvents,
} from "@mend/db";
import { OrganizationId, ProjectId, SessionId } from "@mend/domain";
import { Organization } from "@mend/domain/workbench";
import { SealantClients, SealantPlatformError } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { TestClock } from "@mend/test-ci/effect-vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect";
import * as Context from "effect/Context";
import { Socket } from "effect/socket";
import { describe, expect, it } from "vitest";

import { makeProject } from "../test/support/tenancy-harness.ts";
import {
  ConnectionRegistry,
  ConnectionRegistryLive,
  guardSocket,
  makeConnectionRegistry,
} from "./connections.ts";
import { EventBus, makeEventBus } from "./events-bus.ts";
import { MemberRemoval, MemberRemovalLive } from "./member-removal.ts";
import {
  SSH_KEY_REVOCATION_LEASE,
  SshKeyFirstAttemptLimit,
  SshKeyRevoker,
  SshKeyRevokerLive,
} from "./ssh-key-revocation.ts";

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
 * `listDown` makes listing fail. The revocation table is in memory: `beginRemoval` records its aggregate outcome
 * as the real transaction does, held off until `makeDue` stands in for its lease running out.
 */
const removalWorld = (
  options: {
    readonly lastOwner?: boolean;
    readonly keys?: number;
    readonly failDelivery?: ReadonlyArray<string>;
  } = {},
) => {
  const effects: Array<string> = [];
  const audited: Array<NewAuditEvent> = [];
  const archiveCalls: Array<string> = [];
  const removalInputs: Array<Parameters<MemberRevocationsRepo["Service"]["beginRemoval"]>[0]> = [];
  const woundDown = Effect.runSync(Deferred.make<void>());
  const note = (entry: string) =>
    Effect.sync(() => void effects.push(entry)).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          options.failDelivery?.includes(entry) === true
            ? Effect.die(`delivery unavailable: ${entry}`)
            : Effect.void,
        ),
      ),
    );
  const platform: {
    readonly active: Set<string>;
    readonly failOnce: Set<string>;
    listDown: boolean;
    /** While set, listing waits on it: the platform holding its answer. */
    listHeld: Deferred.Deferred<void> | null;
    readonly listAsked: Deferred.Deferred<void>;
  } = {
    active: new Set(Array.from({ length: options.keys ?? 1 }, (_, index) => `key-${index}`)),
    failOnce: new Set<string>(),
    listDown: false,
    listHeld: null,
    listAsked: Effect.runSync(Deferred.make<void>()),
  };
  let revocations = 0;
  const owed = new Map<string, SshKeyRevocation & { readonly due: boolean }>();
  const deps = Layer.mergeAll(
    Layer.mock(MemberRevocationsRepo, {
      beginRemoval: (input) =>
        options.lastOwner === true
          ? Effect.fail(new LastOwnerError({ organizationId: ACME }))
          : Effect.gen(function* () {
              yield* note(`revocations.beginRemoval:${input.userId}`);
              removalInputs.push(input);
              revocations += 1;
              const revocationId = `revocation-${revocations}`;
              const requestedAt = new Date();
              owed.set(input.userId, {
                id: revocationId,
                userId: input.userId,
                organizationId: input.organizationId,
                actorUserId: input.actorUserId,
                requestedAt,
                attempts: 0,
                outstanding: null,
                lastError: null,
                due: false,
              });
              return {
                ...input,
                revocationId,
                requestedAt,
                unshared: [{ id: SessionId.make("session-shared"), projectId: PROJECT }],
                queuedSessions: [{ id: SessionId.make("session-shared"), projectId: PROJECT }],
                linkedSlackFacts: [{ teamId: "T-acme", slackUserId: `U-${input.userId}` }],
              };
            }),
      announce: (removed) => note(`revocations.announce:${removed.userId}`),
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
      // Fenced by the obligation's id, as the real statements are.
      settle: (id) =>
        note(`revocations.settle:${id}`).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              for (const row of owed.values()) if (row.id === id) owed.delete(row.userId);
            }),
          ),
        ),
      defer: (id, input) =>
        note(`revocations.defer:${id}:${String(input.outstanding)}`).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              const row = [...owed.values()].find((candidate) => candidate.id === id);
              if (row === undefined) return;
              owed.set(row.userId, {
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
    Layer.mock(SessionControlEventsRepo, {
      record: (event) => note(`controlEvents.record:${event.kind}:${event.sessionId}`),
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
    Layer.mock(SealantClients, {
      connectedAccounts: () => ({
        list: () => Effect.die("not in this test"),
        connect: () => Effect.die("not in this test"),
        disconnect: () => Effect.die("not in this test"),
      }),
      sshKeys: (userId) => ({
        ensure: () => Effect.die("not in this test"),
        list: () =>
          Deferred.succeed(platform.listAsked, undefined).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                platform.listHeld === null ? Effect.void : Deferred.await(platform.listHeld),
              ),
            ),
            Effect.andThen(
              Effect.suspend(() =>
                platform.listDown
                  ? Effect.fail(unreachable())
                  : Effect.succeed([...platform.active].map((id) => keyView(userId, id))),
              ),
            ),
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
  return {
    effects,
    removalInputs,
    audited,
    archiveCalls,
    platform,
    owed,
    makeDue,
    woundDown,
    layer,
  };
};

const CAROL = { organizationId: ACME, userId: "carol", actorUserId: "alice" };

const remove = (
  world: ReturnType<typeof removalWorld>,
  firstAttemptLimit: Duration.Duration = Duration.seconds(15),
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const removal = yield* MemberRemoval;
      const exit = yield* removal.remove(CAROL).pipe(Effect.exit);
      if (Exit.isSuccess(exit)) yield* Deferred.await(world.woundDown);
      return exit;
    }).pipe(
      Effect.provideService(SshKeyFirstAttemptLimit, firstAttemptLimit),
      Effect.provide(world.layer),
      Effect.scoped,
    ),
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
    expect(world.removalInputs).toEqual([
      {
        ...CAROL,
        revocationLeaseMs: Duration.toMillis(SSH_KEY_REVOCATION_LEASE),
      },
    ]);
    expect(world.effects[0]).toBe("revocations.beginRemoval:carol");
    // Durable revocation precedes every notice; background cleanup is dispatched independently.
    const afterward = [
      "connections.closeForUser:carol",
      "engine.windDownPerson:carol",
      `engine.reconcileHotSessions:${PROJECT}`,
      "userEvents.changed:carol:access",
      "revocations.announce:carol",
      "controlEvents.record:shared-control-off:session-shared",
      "audit.record:member.removed:carol",
      "audit.record:slack.link_removed:carol",
      "sshKeys.remove:carol:key-0",
      "audit.record:ssh_key.removed:carol",
      "revocations.settle:revocation-1",
    ];
    expect(world.effects.slice(1).toSorted()).toEqual(afterward.toSorted());
    expect(world.effects.indexOf("audit.record:member.removed:carol")).toBeLessThan(
      world.effects.indexOf("sshKeys.remove:carol:key-0"),
    );
  });

  it("answers successfully and attempts each postcommit delivery when the others fail", async () => {
    const failed = [
      "userEvents.changed:carol:access",
      "revocations.announce:carol",
      "controlEvents.record:shared-control-off:session-shared",
      "audit.record:member.removed:carol",
      "audit.record:slack.link_removed:carol",
      "audit.record:ssh_key.revocation_pending:carol",
    ];
    const world = removalWorld({ failDelivery: failed });
    world.platform.listDown = true;
    const exit = await remove(world);
    expect(exit).toEqual(Exit.succeed({ sshKeys: { removed: 0, outstanding: null } }));
    for (const entry of failed) expect(world.effects).toContain(entry);
    expect(world.effects).toContain("connections.closeForUser:carol");
    expect(world.effects).toContain("engine.windDownPerson:carol");
    expect(world.owed.has("carol")).toBe(true);
  });

  it("a platform holding its answer never delays Mend's own revocation; past the limit the removal answers and the sweep finishes", async () => {
    const world = removalWorld({ keys: 2 });
    world.platform.listHeld = Effect.runSync(Deferred.make<void>());
    const exit = await remove(world, Duration.millis(50));
    expect(exit).toEqual(Exit.succeed({ sshKeys: { removed: 0, outstanding: null } }));
    expect(world.effects).toContain("connections.closeForUser:carol");
    expect(world.effects).toContain("engine.windDownPerson:carol");
    expect(world.effects.filter((entry) => entry.includes("ssh"))).toEqual([
      "audit.record:ssh_key.revocation_pending:carol",
    ]);
    // Still owed under the remover's lease; once it runs out, the sweep takes it.
    expect(world.owed.get("carol")).toMatchObject({ id: "revocation-1", attempts: 0 });
    world.platform.listHeld = null;
    world.makeDue("carol");
    expect(await sweep(world)).toEqual([
      { userId: "carol", outcome: { removed: 2, outstanding: 0 } },
    ]);
    expect(world.owed.size).toBe(0);
  });

  it("an interrupted removal loses no Mend-side revocation, and the sweep archives the keys", async () => {
    const world = removalWorld();
    world.platform.listHeld = Effect.runSync(Deferred.make<void>());
    await Effect.runPromise(
      Effect.gen(function* () {
        const removal = yield* MemberRemoval;
        const removing = yield* Effect.forkChild(removal.remove(CAROL));
        yield* Deferred.await(world.platform.listAsked);
        yield* Fiber.interrupt(removing);
        yield* Deferred.await(world.woundDown);
      }).pipe(Effect.provide(world.layer), Effect.scoped),
    );
    expect(world.effects).toContain("userEvents.changed:carol:access");
    expect(world.effects).toContain("connections.closeForUser:carol");
    expect(world.effects).toContain("engine.windDownPerson:carol");
    expect([...world.platform.active]).toEqual(["key-0"]);
    world.platform.listHeld = null;
    world.makeDue("carol");
    expect(await sweep(world)).toEqual([
      { userId: "carol", outcome: { removed: 1, outstanding: 0 } },
    ]);
    expect(world.platform.active.size).toBe(0);
    expect(world.owed.size).toBe(0);
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
    expect(world.effects[0]).toBe("revocations.beginRemoval:carol");
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
    expect(world.effects[0]).toBe("revocations.beginRemoval:carol");
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

// A later event's close callback acknowledges that the registry finished preceding signals.
const processed = (registry: ConnectionRegistry["Service"], source: Queue.Queue<string>) =>
  Effect.gen(function* () {
    const acknowledged = yield* Deferred.make<void>();
    yield* registry.register(
      "event-marker",
      Deferred.succeed(acknowledged, undefined).pipe(Effect.asVoid),
    );
    yield* Queue.offer(
      source,
      JSON.stringify({ type: "user", userId: "event-marker", facet: "access" }),
    );
    yield* Deferred.await(acknowledged);
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
          const open = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          );
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
          yield* processed(registry, source);
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
          const closedCarol = yield* Deferred.make<void>();
          const source = yield* Queue.unbounded<string>();
          let attempts = 0;
          // The connection drops only once the registry listens and both accounts are connected.
          const listen = Stream.unwrap(
            Effect.sync(() => {
              attempts++;
              return attempts === 1
                ? Stream.fromEffect(Deferred.await(lost)).pipe(
                    Stream.flatMap(() => Stream.fail("connection lost")),
                  )
                : Stream.fromQueue(source);
            }),
          );
          const registry = yield* buildRegistry(listen, new Set(["alice"]));
          const log: Array<string> = [];
          yield* registry.register(
            "carol",
            Effect.sync(() => void log.push("carol")).pipe(
              Effect.andThen(Deferred.succeed(closedCarol, undefined)),
            ),
          );
          yield* registry.register(
            "alice",
            Effect.sync(() => void log.push("alice")),
          );
          yield* Deferred.succeed(lost, undefined);
          yield* Deferred.await(closedCarol);
          yield* TestClock.adjust("1 second");
          yield* processed(registry, source);
          return log;
        }),
      ).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds")),
    );
    expect(closed).toEqual(["carol"]);
  });

  it("keeps closing on later events after one signal could not be handled", async () => {
    const closed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lost = yield* Deferred.make<void>();
          const resyncRead = yield* Deferred.make<void>();
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
                Layer.mock(OrganizationsRepo, {
                  membershipOf: () =>
                    Deferred.succeed(resyncRead, undefined).pipe(
                      Effect.andThen(Effect.die("db down")),
                    ),
                }),
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
          yield* Deferred.await(resyncRead);
          yield* TestClock.adjust("1 second");
          const afterResync = [...log];
          yield* Queue.offer(
            source,
            JSON.stringify({ type: "user", userId: "carol", facet: "access" }),
          );
          yield* processed(registry, source);
          return { afterResync, log };
        }),
      ).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds")),
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
          yield* processed(registry, source);
          return log;
        }),
      ),
    );
    expect(closed).toEqual(["carol:s1"]);
  });

  it("turning shared control off leaves the session's screen viewers watching, and each counts on its screen", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Queue.unbounded<string>();
          const registry = yield* buildRegistry(
            Stream.fromQueue(source),
            new Set(["alice", "carol"]),
          );
          const log: Array<string> = [];
          const note = (entry: string) => Effect.sync(() => void log.push(entry));
          yield* registry.register("carol", note("carol:terminal"), "s1", "terminal");
          yield* registry.register("carol", note("carol:screen"), "s1", "screen");
          yield* registry.register("alice", note("alice:screen"), "s1", "screen");
          yield* registry.register("carol", note("carol:screen:s2"), "s2", "screen");
          yield* Queue.offer(
            source,
            JSON.stringify({
              type: "shared-control-off",
              sessionId: "s1",
              projectId: "p1",
              ownerUserId: "alice",
            }),
          );
          yield* processed(registry, source);
          return {
            log,
            onS1: yield* registry.countOnSession("s1", "screen"),
            carols: yield* registry.countFor("carol", "screen"),
          };
        }),
      ),
    );
    expect(result).toEqual({ log: ["carol:terminal"], onS1: 2, carols: 2 });
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
