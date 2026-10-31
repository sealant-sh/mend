import { NotFound } from "@mend/api-contracts";
import {
  makeUpgradeTicketsMemory,
  type PreviewGrantSecret,
  PreviewGrantsRepo,
  type PreviewGrantSubject,
  previewTicketScope,
  PreviewsRepo,
  type TicketCredential,
  UpgradeTicketsRepo,
} from "@mend/db";
import { OrganizationId, PreviewId, PreviewLabel, ProjectId, WorktreeId } from "@mend/domain";
import { canSeeProject, type Preview, type Viewer } from "@mend/domain/workbench";
import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Redacted,
  References,
  type Scope,
} from "effect";

import { makeProject } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { type BusSignal, EventBus } from "./events-bus.ts";
import {
  makePreviewIdentityLayer,
  PREVIEW_TIMING,
  PreviewConfig,
  PreviewIdentity,
  PreviewPoolFull,
  type PreviewViewer,
  type SignedInAccount,
} from "./preview-identity.ts";
import { previewOriginOf, type PreviewRouting } from "./preview-routing.ts";

const ORG = OrganizationId.make("org-a");
const PROJECT = ProjectId.make("p-shared");
const PREVIEW = PreviewId.make("pv-1");
const LABEL = PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa");
const ROUTING: PreviewRouting = { mode: "domain-https", domain: "preview.test", port: 443 };
const kept: Preview = {
  id: PREVIEW,
  label: LABEL,
  serviceName: "web",
  projectId: PROJECT,
  worktreeId: WorktreeId.make("wt-1"),
  state: "kept",
};
const NEXT: Preview = {
  ...kept,
  id: PreviewId.make("pv-2"),
  label: PreviewLabel.make("baaaaaaaaaaaaaaaaaaaaaaaaa"),
  serviceName: "docs",
};
const addressed = previewOriginOf(ROUTING, { label: LABEL, tailnetPort: null });
if (addressed === null) throw new Error("a domain routing addresses every preview");
const ORIGIN = addressed;

interface Hold {
  readonly gate: Deferred.Deferred<void>;
  readonly uninterruptible: boolean;
}

const wait = (hold: Hold) =>
  hold.uninterruptible
    ? Effect.uninterruptible(Deferred.await(hold.gate))
    : Deferred.await(hold.gate);

/** Below 8 steps the runtime stalls the test itself; 40 spans the writer's start several times. */
const FEWEST_STEPS_BEFORE_YIELD = 8;
const MOST_STEPS_BEFORE_YIELD = 40;

const connectionLost = () => Effect.die("connection lost");

const makeWorld = () => {
  const revoked = new Set<string>();
  const members = new Map<string, Viewer>([
    ["alice", { userId: "alice", organizationId: ORG, role: "owner" }],
    ["carol", { userId: "carol", organizationId: ORG, role: "member" }],
  ]);
  const project: { visibility: "shared" | "private" } = { visibility: "shared" };
  const grants = new Map<
    string,
    { readonly previewId: string; readonly origin: string; readonly subject: PreviewGrantSubject }
  >();
  const reads = {
    standing: 0,
    byLabel: 0,
    byId: 0,
    resolveByLabel: 0,
    projectAs: 0,
    assignTailnetPort: 0,
  };
  /** The tailnet port each preview holds. */
  const pool = new Map<PreviewId, number>();
  const reusedPorts = new Set<number>();
  const touchCalls: Array<ReadonlyArray<PreviewId>> = [];
  /** Previews whose port went unused past the renewal age. */
  const unusedPorts = new Set<PreviewId>();
  const renewals: Array<readonly [port: number, id: PreviewId]> = [];
  /** A reclaim that commits just before the next renewal gives the port to this preview. */
  const reclaim: { before: PreviewId | null } = { before: null };
  const FULL_UNTIL = new Date("2026-10-30T14:05:00Z");
  const store: { latency: Duration.Input; hold: Hold | null; holdAfter: Map<number, Hold> } = {
    latency: 0,
    hold: null,
    holdAfter: new Map(),
  };
  let counter = 0;
  const tickets = makeUpgradeTicketsMemory(() => 0, revoked);

  const grantsRepo: PreviewGrantsRepo["Service"] = {
    create: ({ subject, previewId, origin }) =>
      Effect.sync(() => {
        const secret = `mpg_${String(++counter).padStart(43, "0")}`;
        grants.set(secret, { previewId, origin, subject });
        return Redacted.make(secret);
      }),
    standing: (keys) =>
      Effect.gen(function* () {
        const call = ++reads.standing;
        if (store.hold !== null) yield* wait(store.hold);
        yield* Effect.sleep(store.latency);
        const answers = keys.map((key) => {
          const found = grants.get(Redacted.value(key.grant));
          if (
            found === undefined ||
            found.previewId !== key.previewId ||
            found.origin !== key.origin ||
            revoked.has(found.subject.credential)
          ) {
            return null;
          }
          const member = members.get(found.subject.userId);
          return {
            subject: found.subject,
            previewKept: true,
            membership:
              member === undefined
                ? null
                : { organizationId: member.organizationId, role: member.role },
            project: {
              organizationId: ORG,
              visibility: project.visibility,
              createdByUserId: "alice",
            },
          };
        });
        const after = store.holdAfter.get(call);
        if (after !== undefined) yield* wait(after);
        return answers;
      }),
    cleanup: () => Effect.succeed(0),
  };

  const previewsRepo: PreviewsRepo["Service"] = {
    ensureForWorktree: () => Effect.die("unused"),
    readForWorktree: () => Effect.die("unused"),
    ensureNamed: () => Effect.die("unused"),
    resolveById: () => Effect.die("unused"),
    resolveByLabel: (label) =>
      Effect.sync(() => {
        reads.resolveByLabel += 1;
        return label === LABEL
          ? { preview: kept, binding: { _tag: "Unbound", reason: "no-live-attempt" } }
          : null;
      }),
    byLabel: (label) =>
      Effect.sync(() => {
        reads.byLabel += 1;
        return label === LABEL ? kept : null;
      }),
    byId: (id) =>
      Effect.sync(() => {
        reads.byId += 1;
        return id === PREVIEW ? kept : id === NEXT.id ? NEXT : null;
      }),
    controlOf: () => Effect.die("unused"),
    changeControl: () => Effect.die("unused"),
    nextControlSeq: () => Effect.die("unused"),
    previewOfService: () => Effect.die("unused"),
    gatewaySnapshot: () => Effect.die("unused"),
    gatewaySnapshots: () => Effect.die("unused"),
    assignTailnetPort: (id, ports) =>
      Effect.sync(() => {
        reads.assignTailnetPort += 1;
        const held = pool.get(id);
        if (held !== undefined && ports.includes(held)) return { _tag: "Assigned", port: held };
        const taken = new Set(pool.values());
        const free = ports.find((port) => !taken.has(port));
        if (free === undefined)
          return { _tag: "PoolFull", size: ports.length, nextFreeAt: FULL_UNTIL };
        pool.set(id, free);
        return { _tag: "Assigned", port: free };
      }),
    tailnetPorts: (ids) =>
      Effect.sync(
        () =>
          new Map(
            ids.flatMap((id): Array<[PreviewId, number]> => {
              const port = pool.get(id);
              return port === undefined ? [] : [[id, port]];
            }),
          ),
      ),
    byTailnetPort: (port) =>
      Effect.sync(() => {
        const holder = [...pool].find(([, held]) => held === port)?.[0];
        const preview = holder === PREVIEW ? kept : holder === NEXT.id ? NEXT : null;
        return preview === null ? null : { preview, renewDue: unusedPorts.has(preview.id) };
      }),
    renewTailnetPort: (port, id) =>
      Effect.sync(() => {
        if (reclaim.before !== null) {
          pool.delete(id);
          pool.set(reclaim.before, port);
          reclaim.before = null;
        }
        if (pool.get(id) !== port) return "Moved";
        unusedPorts.delete(id);
        renewals.push([port, id]);
        return "Renewed";
      }),
    touchTailnetPorts: (ids) =>
      Effect.sync(() => {
        touchCalls.push(ids);
      }),
    tailnetPortReused: (port, id) =>
      Effect.sync(() => pool.get(id) === port && reusedPorts.has(port)),
  };

  const access = Layer.mock(ProjectAccess, {
    projectAs: (userId, id) =>
      Effect.suspend(() => {
        reads.projectAs += 1;
        const viewer = members.get(userId);
        const row = makeProject({
          id: PROJECT,
          organizationId: ORG,
          visibility: project.visibility,
          createdByUserId: "alice",
          storePath: "/store/p-shared",
        });
        return viewer !== undefined && id === PROJECT && canSeeProject(row, viewer)
          ? Effect.succeed(row)
          : Effect.fail(new NotFound({ id }));
      }),
  });

  const gate = (uninterruptible: boolean) =>
    Effect.map(Deferred.make<void>(), (made): Hold => ({ gate: made, uninterruptible }));

  return {
    revoked,
    members,
    project,
    pool,
    reusedPorts,
    touchCalls,
    unusedPorts,
    renewals,
    reclaim,
    FULL_UNTIL,
    reads,
    store,
    tickets,
    grantsRepo,
    previewsRepo,
    access,
    hold: (options?: { readonly uninterruptible?: boolean }) =>
      Effect.map(gate(options?.uninterruptible === true), (hold) => {
        store.hold = hold;
        return Effect.sync(() => {
          store.hold = null;
        }).pipe(Effect.andThen(Deferred.succeed(hold.gate, undefined)));
      }),
    holdRead: (nth: number) =>
      Effect.map(gate(false), (hold) => {
        store.holdAfter.set(reads.standing + nth, hold);
        return Deferred.succeed(hold.gate, undefined);
      }),
    grantFor: (userId: string, credential: TicketCredential) =>
      grantsRepo.create({ subject: { userId, credential }, previewId: PREVIEW, origin: ORIGIN }),
  };
};

type World = ReturnType<typeof makeWorld>;

const identityIn = (world: World, routing: () => PreviewRouting = () => ROUTING) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<BusSignal>();
    const context = yield* Layer.build(
      makePreviewIdentityLayer(PREVIEW_TIMING).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(PreviewConfig, {
              appUrl: "https://mend.test",
              get routing() {
                return routing();
              },
            }),
            Layer.succeed(PreviewGrantsRepo, world.grantsRepo),
            Layer.succeed(PreviewsRepo, world.previewsRepo),
            Layer.succeed(UpgradeTicketsRepo, world.tickets),
            Layer.succeed(EventBus, { subscribe: PubSub.subscribe(pubsub) }),
            world.access,
          ),
        ),
      ),
    );
    const publish = (signal: BusSignal) => PubSub.publish(pubsub, signal);
    return { identity: Context.get(context, PreviewIdentity), publish };
  });

const openStream = (options?: { readonly stallClose?: boolean }) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<PreviewViewer>();
    const closed = yield* Deferred.make<void>();
    const write = (admitted: PreviewViewer): Effect.Effect<undefined, never, Scope.Scope> =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(closed, undefined).pipe(
            Effect.andThen(options?.stallClose === true ? Effect.never : Effect.void),
          ),
        );
        yield* Deferred.succeed(started, admitted);
        return yield* Effect.never;
      });
    return { started, closed, write };
  });

const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

const signIn = (world: World, userId: string, id: string) =>
  Effect.map(world.grantFor(userId, `session:${id}`), (grant) => ({
    grant,
    credential: `session:${id}` as const,
  }));

const serve = (
  identity: PreviewIdentity["Service"],
  grant: PreviewGrantSecret | null,
  stream: Effect.Success<ReturnType<typeof openStream>>,
) => Effect.forkChild(identity.withViewer({ origin: ORIGIN, grant }, stream.write));

const accessEvent = (userId: string): BusSignal => ({
  kind: "event",
  event: { type: "user", userId, facet: "access" },
  payload: "{}",
});

const failureOf = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E> | undefined) =>
  exit === undefined
    ? undefined
    : Exit.findErrorOption(exit).pipe((error) => (error._tag === "Some" ? error.value : undefined));

const failureTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E> | undefined) =>
  exit === undefined
    ? "open"
    : Exit.isSuccess(exit)
      ? "done"
      : (failureOf(exit)?._tag ?? (Exit.hasInterrupts(exit) ? "interrupted" : "defect"));

describe("preview identity: what one request costs", () => {
  it.effect("admits a request with one preview row and one grant read, and no binding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world);
        const stream = yield* openStream();
        const fiber = yield* serve(identity, (yield* signIn(world, "carol", "c-1")).grant, stream);
        expect((yield* Deferred.await(stream.started)).viewer).toEqual({
          userId: "carol",
          organizationId: ORG,
          role: "member",
        });
        expect(world.reads).toEqual({
          standing: 1,
          byLabel: 1,
          byId: 0,
          resolveByLabel: 0,
          projectAs: 0,
          assignTailnetPort: 0,
        });
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
});

describe("preview identity: open streams end when access does", () => {
  it.effect(
    "a sign-in that ends right after a sweep, with no event, closes at the next sweep",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = makeWorld();
          const { identity } = yield* identityIn(world);
          const { grant, credential } = yield* signIn(world, "carol", "carol-1");
          const stream = yield* openStream();
          const fiber = yield* serve(identity, grant, stream);
          yield* Deferred.await(stream.started);
          yield* TestClock.adjust("50 seconds");
          yield* settle;
          expect(fiber.pollUnsafe()).toBeUndefined();
          world.revoked.add(credential);
          yield* TestClock.adjust("49 seconds");
          yield* settle;
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust("1 second");
          const exit = yield* Fiber.await(fiber);
          expect(failureTag(exit)).toBe("PreviewAccessEnded");
          expect(yield* Deferred.isDone(stream.closed)).toBe(true);
          expect(yield* Clock.currentTimeMillis).toBe(100_000);
        }),
      ),
  );

  it.effect(
    "hundreds of streams on a few grants outlast a slow database, and a revoked grant's close in time",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = makeWorld();
          const { identity } = yield* identityIn(world);
          world.store.latency = "1 second";
          const signIns = yield* Effect.forEach(Array.from({ length: 4 }), (_, index) =>
            signIn(world, "carol", `carol-tab-${index}`),
          );
          const streams = yield* Effect.forEach(Array.from({ length: 400 }), (_, index) =>
            Effect.gen(function* () {
              const stream = yield* openStream();
              const owner = signIns[index % signIns.length];
              if (owner === undefined) return yield* Effect.die("four sign-ins");
              return { owner, fiber: yield* serve(identity, owner.grant, stream) };
            }),
          );
          yield* TestClock.adjust("1 second");
          yield* settle;
          const before = world.reads.standing;
          yield* TestClock.adjust("49 seconds");
          yield* settle;
          yield* TestClock.adjust("1 second");
          yield* settle;
          expect(world.reads.standing - before).toBe(1);
          expect(streams.filter(({ fiber }) => fiber.pollUnsafe() !== undefined)).toEqual([]);

          const lost = signIns[0];
          if (lost === undefined) return yield* Effect.die("four sign-ins");
          world.revoked.add(lost.credential);
          yield* TestClock.adjust("50 seconds");
          yield* settle;
          const ended = streams.filter(({ fiber }) => fiber.pollUnsafe() !== undefined);
          expect(ended.length).toBe(100);
          expect(ended.every(({ owner }) => owner === lost)).toBe(true);
          expect(
            ended.map(({ fiber }) => {
              const error = failureOf(fiber.pollUnsafe());
              return error?._tag === "PreviewAccessEnded" ? error.reason : error?._tag;
            }),
          ).toEqual(ended.map(() => "access-ended"));
        }),
      ),
  );

  it.effect("a recheck the database never answers closes every stream at the pass deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world);
        const streams = yield* Effect.forEach(Array.from({ length: 20 }), (_, index) =>
          Effect.gen(function* () {
            const { grant } = yield* signIn(world, "carol", `carol-${index}`);
            const stream = yield* openStream();
            const fiber = yield* serve(identity, grant, stream);
            yield* Deferred.await(stream.started);
            return fiber;
          }),
        );
        yield* world.hold();
        yield* TestClock.adjust("50 seconds");
        yield* TestClock.adjust("4999 millis");
        yield* settle;
        expect(streams.map((fiber) => failureTag(fiber.pollUnsafe()))).toEqual(
          streams.map(() => "open"),
        );
        yield* TestClock.adjust("1 millis");
        yield* settle;
        yield* TestClock.adjust("1 second");
        const exits = yield* Effect.forEach(streams, Fiber.await);
        expect(
          exits.map((exit) => {
            const error = failureOf(exit);
            return error?._tag === "PreviewAccessEnded" ? error.reason : error?._tag;
          }),
        ).toEqual(streams.map(() => "admission-unavailable"));
        expect(yield* Clock.currentTimeMillis).toBeLessThanOrEqual(56_000);
      }),
    ),
  );

  it.effect("a recheck stuck where interruption cannot reach still closes at the deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world);
        const stream = yield* openStream();
        const fiber = yield* serve(identity, (yield* signIn(world, "carol", "c-1")).grant, stream);
        yield* Deferred.await(stream.started);
        const release = yield* world.hold({ uninterruptible: true });
        yield* Effect.addFinalizer(() => release);
        yield* TestClock.adjust("55 seconds");
        yield* settle;
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(failureTag(fiber.pollUnsafe())).toBe("PreviewAccessEnded");
        expect(yield* Deferred.isDone(stream.closed)).toBe(true);
        const refused = yield* Effect.forkChild(
          identity.withViewer(
            { origin: ORIGIN, grant: (yield* signIn(world, "carol", "c-2")).grant },
            stream.write,
          ),
        );
        yield* TestClock.adjust("5 seconds");
        expect(failureTag(yield* Fiber.await(refused))).toBe("PreviewUnavailable");
        expect(yield* Clock.currentTimeMillis).toBe(61_000);
      }),
    ),
  );

  it("the production timing ends a stream within the ADR's 60 seconds of losing access", () => {
    const worst = [
      PREVIEW_TIMING.sweepEvery,
      PREVIEW_TIMING.passDeadline,
      PREVIEW_TIMING.closeGrace,
    ].reduce<Duration.Duration>(
      (sum, part) => Duration.sum(sum, Duration.fromInputUnsafe(part)),
      Duration.zero,
    );
    expect(Duration.toMillis(worst)).toBeLessThan(60_000);
  });

  it.effect("a pass the database holds to its deadline does not push the next sweep back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world);
        const held = yield* openStream();
        const heldFiber = yield* serve(
          identity,
          (yield* signIn(world, "carol", "c-held")).grant,
          held,
        );
        yield* Deferred.await(held.started);
        const release = yield* world.hold();
        yield* TestClock.adjust("55 seconds");
        yield* settle;
        expect(failureTag(yield* Fiber.await(heldFiber))).toBe("PreviewAccessEnded");
        yield* release;
        const later = yield* openStream();
        const { grant, credential } = yield* signIn(world, "carol", "c-later");
        const laterFiber = yield* serve(identity, grant, later);
        yield* Deferred.await(later.started);
        world.revoked.add(credential);
        yield* TestClock.adjust("44999 millis");
        yield* settle;
        expect(laterFiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 millis");
        expect(failureTag(yield* Fiber.await(laterFiber))).toBe("PreviewAccessEnded");
        expect(yield* Clock.currentTimeMillis).toBe(100_000);
      }),
    ),
  );

  it.effect("a client leaving a stream whose close stalls is released within the grace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world);
        const stalled = yield* openStream({ stallClose: true });
        const fiber = yield* serve(
          identity,
          (yield* signIn(world, "carol", "c-gone")).grant,
          stalled,
        );
        yield* Deferred.await(stalled.started);
        const leaving = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* settle;
        expect(leaving.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(leaving);
        expect(yield* Deferred.isDone(stalled.closed)).toBe(true);
        expect(yield* Clock.currentTimeMillis).toBe(1_000);
      }),
    ),
  );

  it.effect("a client leaving the moment its response starts never leaves the writer running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world);
        const { grant } = yield* signIn(world, "carol", "c-leaving");
        const leftRunning: Array<number> = [];
        for (let budget = FEWEST_STEPS_BEFORE_YIELD; budget < MOST_STEPS_BEFORE_YIELD; budget++) {
          const stream = yield* openStream();
          const request: { fiber: Fiber.Fiber<void, unknown> | null } = { fiber: null };
          const leaves = (admitted: PreviewViewer) =>
            Effect.sync(() => request.fiber?.interruptUnsafe()).pipe(
              Effect.andThen(stream.write(admitted)),
            );
          request.fiber = yield* Effect.forkChild(
            identity
              .withViewer({ origin: ORIGIN, grant }, leaves)
              .pipe(Effect.provideService(References.MaxOpsBeforeYield, budget)),
          );
          yield* Fiber.await(request.fiber);
          yield* settle;
          const started = yield* Deferred.isDone(stream.started);
          if (started && !(yield* Deferred.isDone(stream.closed))) leftRunning.push(budget);
        }
        expect(leftRunning).toEqual([]);
      }),
    ),
  );

  it.effect("a writer whose close stalls is cut off after one second, and others still close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity, publish } = yield* identityIn(world);
        const stalled = yield* openStream({ stallClose: true });
        const ordinary = yield* openStream();
        const first = yield* signIn(world, "carol", "carol-stall");
        const second = yield* signIn(world, "carol", "carol-other");
        const stalledFiber = yield* serve(identity, first.grant, stalled);
        const ordinaryFiber = yield* serve(identity, second.grant, ordinary);
        yield* Deferred.await(stalled.started);
        yield* Deferred.await(ordinary.started);
        world.members.delete("carol");
        yield* publish(accessEvent("carol"));
        yield* settle;
        expect(yield* Deferred.isDone(stalled.closed)).toBe(true);
        expect(failureTag(stalledFiber.pollUnsafe())).toBe("open");
        yield* TestClock.adjust("1 second");
        expect(failureTag(yield* Fiber.await(stalledFiber))).toBe("PreviewAccessEnded");
        expect(failureTag(yield* Fiber.await(ordinaryFiber))).toBe("PreviewAccessEnded");
        expect(yield* Clock.currentTimeMillis).toBe(1_000);
      }),
    ),
  );

  it.effect("losing the membership ends open streams and refuses new requests as such", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity, publish } = yield* identityIn(world);
        const { grant } = yield* signIn(world, "carol", "carol-member");
        const stream = yield* openStream();
        const fiber = yield* serve(identity, grant, stream);
        yield* Deferred.await(stream.started);
        world.members.delete("carol");
        yield* publish(accessEvent("carol"));
        expect(failureTag(yield* Fiber.await(fiber))).toBe("PreviewAccessEnded");
        const again = yield* openStream();
        const refused = yield* Effect.flip(
          identity.withViewer({ origin: ORIGIN, grant }, again.write),
        );
        expect(refused._tag === "PreviewNoIdentity" && refused.reason).toBe("membership-ended");
      }),
    ),
  );

  it.effect(
    "a project made private closes the streams of those who lost it, not its creator's",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = makeWorld();
          const { identity, publish } = yield* identityIn(world);
          const creator = yield* openStream();
          const teammate = yield* openStream();
          const creatorFiber = yield* serve(
            identity,
            (yield* signIn(world, "alice", "alice-1")).grant,
            creator,
          );
          const teammateFiber = yield* serve(
            identity,
            (yield* signIn(world, "carol", "carol-1")).grant,
            teammate,
          );
          yield* Deferred.await(creator.started);
          yield* Deferred.await(teammate.started);
          world.project.visibility = "private";
          yield* publish({
            kind: "event",
            event: { type: "project", projectId: PROJECT },
            payload: "{}",
          });
          expect(failureTag(yield* Fiber.await(teammateFiber))).toBe("PreviewAccessEnded");
          yield* TestClock.adjust("120 seconds");
          yield* settle;
          expect(creatorFiber.pollUnsafe()).toBeUndefined();
          expect(yield* Clock.currentTimeMillis).toBe(120_000);
        }),
      ),
  );

  it.effect("a device revoked closes that device's streams at once and leaves its sign-in's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity, publish } = yield* identityIn(world);
        const phone = yield* openStream();
        const laptop = yield* openStream();
        const phoneFiber = yield* serve(
          identity,
          yield* world.grantFor("carol", "device:phone"),
          phone,
        );
        const laptopFiber = yield* serve(
          identity,
          (yield* signIn(world, "carol", "c-1")).grant,
          laptop,
        );
        yield* Deferred.await(phone.started);
        yield* Deferred.await(laptop.started);
        world.revoked.add("device:phone");
        yield* publish({
          kind: "event",
          event: { type: "user", userId: "carol", facet: "devices" },
          payload: "{}",
        });
        expect(failureTag(yield* Fiber.await(phoneFiber))).toBe("PreviewAccessEnded");
        yield* settle;
        expect(laptopFiber.pollUnsafe()).toBeUndefined();
        expect(yield* Clock.currentTimeMillis).toBe(0);
      }),
    ),
  );

  it.effect(
    "a revocation between the first read and the registration never starts the writer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = makeWorld();
          const { identity, publish } = yield* identityIn(world);
          const { grant, credential } = yield* signIn(world, "carol", "carol-race");
          const stream = yield* openStream();
          const release = yield* world.holdRead(1);
          const fiber = yield* serve(identity, grant, stream);
          yield* settle;
          world.revoked.add(credential);
          yield* publish(accessEvent("carol"));
          yield* settle;
          yield* release;
          yield* settle;
          expect(yield* Deferred.isDone(stream.started)).toBe(false);
          expect(failureTag(yield* Fiber.await(fiber))).toBe("PreviewNoIdentity");
        }),
      ),
  );

  it.effect("a late allow cannot reopen a stream a concurrent recheck closed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity, publish } = yield* identityIn(world);
        const { grant, credential } = yield* signIn(world, "carol", "carol-late");
        const stream = yield* openStream();
        const releaseFirst = yield* world.holdRead(1);
        const releaseSecond = yield* world.holdRead(2);
        const fiber = yield* serve(identity, grant, stream);
        yield* settle;
        yield* publish(accessEvent("someone-else"));
        yield* settle;
        yield* releaseFirst;
        yield* settle;
        expect(world.reads.standing).toBe(2);
        world.revoked.add(credential);
        yield* publish(accessEvent("carol"));
        yield* settle;
        expect(world.reads.standing).toBe(3);
        yield* releaseSecond;
        expect(failureTag(yield* Fiber.await(fiber))).toBe("PreviewNoIdentity");
        expect(yield* Deferred.isDone(stream.started)).toBe(false);
      }),
    ),
  );
});

describe("preview identity: tailnet ports", () => {
  const hostname = "mend-preview.tail1234.ts.net";
  const tailnet: PreviewRouting = { mode: "tailnet-https", hostname, ports: [20001, 20002] };
  const opener: SignedInAccount = { userId: "carol", credential: "session:carol-1" };

  it.effect("a preview gets its port when it is first opened, and the same one after", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world, () => tailnet);
        expect(world.pool.size, "nothing is assigned before an open").toBe(0);
        const first = yield* identity.issueTicket({ previewId: PREVIEW, opener });
        const again = yield* identity.issueTicket({ previewId: PREVIEW, opener });
        const next = yield* identity.issueTicket({ previewId: NEXT.id, opener });
        expect(first.origin).toBe(`https://${hostname}:20001`);
        expect(again.origin).toBe(first.origin);
        expect(next.origin).toBe(`https://${hostname}:20002`);
        expect(world.pool).toEqual(
          new Map([
            [PREVIEW, 20001],
            [NEXT.id, 20002],
          ]),
        );
      }),
    ),
  );

  it.effect("opening a preview when every port holds one says how many the set has", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world, () => ({ ...tailnet, ports: [20001] }));
        yield* identity.issueTicket({ previewId: PREVIEW, opener });
        const full = yield* Effect.flip(identity.issueTicket({ previewId: NEXT.id, opener }));
        expect(full).toEqual(new PreviewPoolFull({ size: 1, nextFreeAt: world.FULL_UNTIL }));
      }),
    ),
  );

  it.effect("a grant for the port's earlier preview opens nothing on its next one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world, () => tailnet);
        const { origin } = yield* identity.issueTicket({ previewId: PREVIEW, opener });
        const grant = yield* world.grantsRepo.create({
          subject: opener,
          previewId: PREVIEW,
          origin,
        });
        const before = yield* openStream();
        const opened = yield* Effect.forkChild(
          identity.withViewer({ origin, grant }, before.write),
        );
        expect((yield* Deferred.await(before.started)).preview.id).toBe(PREVIEW);
        yield* Fiber.interrupt(opened);
        world.pool.delete(PREVIEW);
        world.pool.set(NEXT.id, 20001);
        const after = yield* openStream();
        const refused = yield* Effect.flip(identity.withViewer({ origin, grant }, after.write));
        expect(refused._tag === "PreviewNoIdentity" && refused.reason).toBe("invalid-grant");
        expect(yield* Deferred.isDone(after.started)).toBe(false);
      }),
    ),
  );

  it.effect("an open stream on a port that passes on closes at the next pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world, () => tailnet);
        const { origin } = yield* identity.issueTicket({ previewId: PREVIEW, opener });
        const grant = yield* world.grantsRepo.create({
          subject: opener,
          previewId: PREVIEW,
          origin,
        });
        const stream = yield* openStream();
        const fiber = yield* Effect.forkChild(identity.withViewer({ origin, grant }, stream.write));
        yield* Deferred.await(stream.started);
        world.pool.set(PREVIEW, 20002);
        yield* TestClock.adjust("50 seconds");
        const ended = failureOf(yield* Fiber.await(fiber));
        expect(ended?._tag === "PreviewAccessEnded" && ended.reason).toBe("access-ended");
      }),
    ),
  );

  it.effect(
    "a stream whose port moved closes at once as access ended, while another grant's read stalls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = makeWorld();
          const { identity, publish } = yield* identityIn(world, () => ({
            ...tailnet,
            ports: [20001, 20002, 20003],
          }));
          const held = yield* Effect.forEach([PREVIEW, NEXT.id], (previewId) =>
            Effect.gen(function* () {
              const { origin } = yield* identity.issueTicket({ previewId, opener });
              const grant = yield* world.grantsRepo.create({ subject: opener, previewId, origin });
              const stream = yield* openStream();
              const fiber = yield* Effect.forkChild(
                identity.withViewer({ origin, grant }, stream.write),
              );
              yield* Deferred.await(stream.started);
              return { stream, fiber };
            }),
          );
          const [moved, stalled] = held;
          if (moved === undefined || stalled === undefined) throw new Error("two streams opened");
          const release = yield* world.hold();
          world.pool.set(PREVIEW, 20003);
          yield* publish(accessEvent("carol"));
          yield* settle;
          expect(
            yield* Deferred.isDone(moved.stream.closed),
            "the moved port is decided before the grant read answers",
          ).toBe(true);
          const ended = failureOf(yield* Fiber.await(moved.fiber));
          expect(ended?._tag === "PreviewAccessEnded" && ended.reason).toBe("access-ended");
          expect(yield* Deferred.isDone(stalled.stream.closed), "the other waits on its read").toBe(
            false,
          );
          yield* TestClock.adjust("5 seconds");
          const undecided = failureOf(yield* Fiber.await(stalled.fiber));
          expect(undecided?._tag === "PreviewAccessEnded" && undecided.reason).toBe(
            "admission-unavailable",
          );
          yield* release;
        }),
      ),
  );

  it.effect("an open connection keeps its port in use, and its close is the port's last use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world, () => tailnet);
        const { origin } = yield* identity.issueTicket({ previewId: PREVIEW, opener });
        const grant = yield* world.grantsRepo.create({
          subject: opener,
          previewId: PREVIEW,
          origin,
        });
        const open = Effect.gen(function* () {
          const stream = yield* openStream();
          const fiber = yield* Effect.forkChild(
            identity.withViewer({ origin, grant }, stream.write),
          );
          yield* Deferred.await(stream.started);
          return fiber;
        });
        const brief = yield* open;
        expect(world.touchCalls.flat()).toEqual([]);
        yield* Fiber.interrupt(brief);
        yield* Effect.yieldNow;
        expect(world.touchCalls.flat(), "a connection's close is its port's use").toEqual([
          PREVIEW,
        ]);
        const held = yield* open;
        yield* TestClock.adjust("50 seconds");
        yield* TestClock.adjust("50 seconds");
        expect(world.touchCalls.flat(), "and each pass while one is open").toEqual([
          PREVIEW,
          PREVIEW,
          PREVIEW,
        ]);
        yield* Fiber.interrupt(held);
        yield* Effect.yieldNow;
        expect(world.touchCalls.length, "a close just after a pass stamped it adds no write").toBe(
          3,
        );
      }),
    ),
  );

  it.effect(
    "a connection to a preview whose port went unused renews the port before it is served, and one renewed lately writes nothing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = makeWorld();
          const { identity } = yield* identityIn(world, () => ({ ...tailnet, ports: [20001] }));
          const { origin } = yield* identity.issueTicket({ previewId: PREVIEW, opener });
          const grant = yield* world.grantsRepo.create({
            subject: opener,
            previewId: PREVIEW,
            origin,
          });
          const servedAfter: Array<ReadonlyArray<readonly [number, PreviewId]>> = [];
          const serveOnce = identity.withViewer({ origin, grant }, () =>
            Effect.sync(() => {
              servedAfter.push([...world.renewals]);
              return undefined;
            }),
          );
          world.unusedPorts.add(PREVIEW);
          yield* serveOnce;
          yield* serveOnce;
          expect(
            servedAfter,
            "renewed before the first was served; the second wrote nothing",
          ).toEqual([[[20001, PREVIEW]], [[20001, PREVIEW]]]);

          world.unusedPorts.add(PREVIEW);
          world.reclaim.before = NEXT.id;
          const refused = yield* Effect.flip(serveOnce);
          expect(
            refused._tag === "PreviewNoIdentity" && [refused.reason, refused.previewId],
            "the port went to another preview first: sign in again",
          ).toEqual(["port-moved", PREVIEW]);
          expect(servedAfter, "and nothing was served").toHaveLength(2);
        }),
      ),
  );

  it.effect(
    "the first open of a preview on a reused port asks the browser to clear the port's storage, and no later one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = makeWorld();
          const { identity } = yield* identityIn(world, () => tailnet);
          const exchange = (presented: PreviewGrantSecret | null) =>
            Effect.gen(function* () {
              const issued = yield* identity.issueTicket({ previewId: PREVIEW, opener });
              return yield* identity.exchangeTicket({
                origin: issued.origin,
                ticket: issued.ticket,
                presented,
              });
            });
          const fresh = yield* exchange(null);
          expect(fresh.clearSiteData, "a port no preview held before").toBe(false);
          world.reusedPorts.add(20001);
          const earlier = yield* world.grantsRepo.create({
            subject: opener,
            previewId: NEXT.id,
            origin: fresh.origin,
          });
          const first = yield* exchange(earlier);
          expect(first.clearSiteData, "the browser held only the earlier preview's grant").toBe(
            true,
          );
          expect((yield* exchange(null)).clearSiteData, "a browser with no grant").toBe(true);
          expect(
            (yield* exchange(first.grant)).clearSiteData,
            "a browser already signed in to this preview",
          ).toBe(false);
        }),
      ),
  );

  it.effect("a preview whose port left the set gets one of the set at its next open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        world.pool.set(PREVIEW, 20009);
        const { identity } = yield* identityIn(world, () => tailnet);
        const { origin } = yield* identity.issueTicket({ previewId: PREVIEW, opener });
        expect(origin, "the next open reassigns it within the set").toBe(
          `https://${hostname}:20001`,
        );
      }),
    ),
  );
});

describe("preview identity: tickets", () => {
  it.effect("a ticket minted without a credential is spent and yields no grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world);
        const scope = previewTicketScope({ previewId: PREVIEW, origin: ORIGIN });
        const minted = yield* world.tickets.mint({
          userId: "alice",
          credential: null,
          target: "preview",
          scope,
        });
        const ticket = Redacted.make(minted.ticket);
        const refused = yield* Effect.flip(
          identity.exchangeTicket({ origin: ORIGIN, ticket, presented: null }),
        );
        const replay = yield* Effect.flip(
          identity.exchangeTicket({ origin: ORIGIN, ticket, presented: null }),
        );
        expect(
          [refused, replay].map((error) => error._tag === "PreviewNoIdentity" && error.reason),
        ).toEqual(["credential-required", "invalid-ticket"]);
      }),
    ),
  );

  it.effect("an opener who cannot see the project gets no ticket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn(world);
        world.project.visibility = "private";
        const refused = yield* Effect.flip(
          identity.issueTicket({
            previewId: PREVIEW,
            opener: { userId: "carol", credential: "session:carol-1" },
          }),
        );
        const issued = yield* identity.issueTicket({
          previewId: PREVIEW,
          opener: { userId: "alice", credential: "session:alice-1" },
        });
        expect(refused._tag).toBe("PreviewNotFound");
        expect(issued.origin).toBe(ORIGIN);
      }),
    ),
  );

  it.effect("storage that dies answers that admission is unavailable, never a defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = makeWorld();
        const { identity } = yield* identityIn({
          ...world,
          previewsRepo: { ...world.previewsRepo, byLabel: connectionLost, byId: connectionLost },
        });
        const stream = yield* openStream();
        const admitted = yield* Effect.exit(
          identity.withViewer({ origin: ORIGIN, grant: null }, stream.write),
        );
        const issued = yield* Effect.exit(
          identity.issueTicket({
            previewId: PREVIEW,
            opener: { userId: "alice", credential: "session:alice-1" },
          }),
        );
        expect([failureTag(admitted), failureTag(issued)]).toEqual([
          "PreviewUnavailable",
          "PreviewUnavailable",
        ]);
      }),
    ).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
  );
});
