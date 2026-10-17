import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Deferred, Duration, Effect } from "effect";
import { afterEach, describe, expect } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * The event stream's lifecycle through the real `/api/events` route (docs/adr/0004, "Event stream
 * lifecycle"; the closing note of the public exposure findings).
 *
 * Every stream used to call `sql.listen` itself, and the shared connection's per-stream UNLISTEN
 * meant one closing browser silenced the rest. Streams now subscribe to one application-owned
 * fan-out. These tests hold that in place from the outside: whatever streams open, close, are
 * revoked or are refused, the one listen stream behind the bus is started once and never ended,
 * and nothing a stream held outlives it.
 */
let api: TenancyApi | null = null;
afterEach(async () => {
  await api?.dispose();
  api = null;
});

const sharedA = ids("shared-a");
const sessionEvent = {
  type: "session",
  sessionId: sharedA.session,
  projectId: sharedA.project,
} as const;
/**
 * A frame that is coming: waited for generously, since it returns the moment the frame arrives and
 * only a machine under load ever gets near the deadline.
 */
const arrives = (stream: { readonly next: (timeoutMs?: number) => Promise<string | null> }) =>
  stream.next(5_000);

const frame = (event: unknown) => `data: ${JSON.stringify(event)}`;

/** How long a test that expects silence listens for. */
const SILENCE_MS = 150;

/** Wait until the server has seen what the client did, up to a deadline: no fixed sleeps. */
const eventually = async (what: string, holds: () => Promise<boolean>) => {
  const deadline = Date.now() + 5_000;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error(`never observed: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const openStreams = (on: TenancyApi, user: "alice" | "bob" | "carol") =>
  on.openConnections(user, "event-stream");

describe("the event stream lifecycle", () => {
  it("one stream torn down with an event undelivered leaves the others receiving, and the listen untouched", async () => {
    const world = await createTenancyApi();
    api = world;
    const carol = await api.events("carol");
    const alice = await api.events("alice");
    const second = await api.events("carol");
    expect(api.listen).toEqual({ starts: 1, ends: 0 });

    const firstEvent = {
      ...sessionEvent,
      type: "session-progress" as const,
      sequence: "1",
      line: "before close",
    };
    const queuedEvent = { ...firstEvent, sequence: "2", line: "queued before close" };
    const afterEvent = { ...firstEvent, sequence: "3", line: "after close" };
    await api.notify(firstEvent);
    expect(await arrives(carol)).toBe(frame(firstEvent));
    // Torn down with an event published and not read by it. Whether the server was part-way
    // through writing that frame cannot be told from outside the process.
    await api.notify(queuedEvent);
    await carol.close();
    await eventually(
      "carol's first stream released",
      async () => (await openStreams(world, "carol")) === 1,
    );

    for (const stream of [alice, second]) {
      expect(await arrives(stream)).toBe(frame(firstEvent));
      expect(await arrives(stream)).toBe(frame(queuedEvent));
    }
    // Events published after the teardown still arrive, with their own sequence.
    await api.notify(afterEvent);
    expect(await arrives(alice)).toBe(frame(afterEvent));
    expect(await arrives(second)).toBe(frame(afterEvent));

    expect(api.listen).toEqual({ starts: 1, ends: 0 });
    expect(await api.openConnections("carol", "event-stream")).toBe(1);
    await alice.close();
    await second.close();
  });

  it("many streams opening and closing never restart or end the listen", async () => {
    const world = await createTenancyApi();
    api = world;
    for (let round = 0; round < 5; round += 1) {
      const streams = await Promise.all([
        api.events("carol"),
        api.events("alice"),
        api.events("bob"),
      ]);
      await api.notify(sessionEvent);
      await Promise.all(streams.map((stream) => stream.close()));
    }
    for (const user of ["carol", "alice", "bob"] as const) {
      await eventually(
        `${user}'s streams released`,
        async () => (await openStreams(world, user)) === 0,
      );
    }
    expect(api.listen).toEqual({ starts: 1, ends: 0 });
  });

  it.effect(
    "a stream closed the way removal closes it releases what it held, and other accounts' streams go on",
    () =>
      Effect.gen(function* () {
        // `closeConnectionsOf` is the registry call member removal makes (`connections.closeForUser`).
        // Removal itself, with its revocations, is member-removal.test.ts's.
        const clock = yield* Clock.clockWith(Effect.succeed);
        const graceSleeping = yield* Deferred.make<void>();
        // The route receives this clock; the test keeps the TestClock controller. A stream's
        // one-second revocation grace is the only one-second sleep the route asks for.
        const observedClock: Clock.Clock = {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeNanos: clock.currentTimeNanos,
          sleep: (duration) =>
            Duration.toMillis(duration) === 1_000
              ? Deferred.succeed(graceSleeping, undefined).pipe(
                  Effect.andThen(clock.sleep(duration)),
                )
              : clock.sleep(duration),
        };
        const world = yield* Effect.acquireRelease(
          Effect.promise(() => createTenancyApi({}, { effectClock: observedClock })),
          (fixture) => Effect.promise(() => fixture.dispose()),
        );
        const carol = yield* Effect.promise(() => world.events("carol"));
        const alice = yield* Effect.promise(() => world.events("alice"));
        expect(yield* Effect.promise(() => world.openConnections("carol", "event-stream"))).toBe(1);

        expect(yield* Effect.promise(() => world.closeConnectionsOf("carol"))).toBe(1);
        yield* Deferred.await(graceSleeping);
        yield* TestClock.adjust("1 second");
        yield* Effect.promise(() =>
          eventually(
            "carol's stream released",
            async () => (await openStreams(world, "carol")) === 0,
          ),
        );
        // The revoked stream ends: nothing more arrives on it.
        yield* Effect.promise(() => world.notify(sessionEvent));
        expect(yield* Effect.promise(() => carol.next(SILENCE_MS))).toBeNull();

        expect(yield* Effect.promise(() => arrives(alice))).toContain(sharedA.session);
        expect(world.listen).toEqual({ starts: 1, ends: 0 });
        yield* Effect.promise(() => carol.close());
        yield* Effect.promise(() => alice.close());
      }),
  );

  it("a removed account's stream says why it ended, even when the close comes first", async () => {
    // Removal closes the account's streams on the same bus event its page must hear. When the
    // close won, the page was refused before it heard why and landed on a plain sign-in
    // (RC 0.36.0-next.754, B-F1).
    const world = await createTenancyApi();
    api = world;
    const carol = await api.events("carol");
    const alice = await api.events("alice");

    expect(await api.closeConnectionsOf("carol")).toBe(1);
    // Nothing but the reason reaches a revoked stream.
    await api.notify(sessionEvent);
    await api.notify({ type: "user", userId: sharedA.session, facet: "access" });
    await api.notify({ type: "user", userId: "carol", facet: "access" });
    expect(await arrives(carol)).toBe('data: {"type":"user","userId":"carol","facet":"access"}');
    // Then the stream ends.
    expect(await carol.next(SILENCE_MS)).toBeNull();
    await eventually(
      "carol's stream released",
      async () => (await openStreams(world, "carol")) === 0,
    );

    expect(await arrives(alice)).toContain(sharedA.session);
    await carol.close();
    await alice.close();
  });

  it("a stream refused over the account's budget holds nothing and disturbs nothing", async () => {
    api = await createTenancyApi({ accountEventStreams: 1 });
    const open = await api.events("carol");
    const refused = await api.events("carol");
    expect(refused.status).toBe(429);
    expect(await api.openConnections("carol", "event-stream")).toBe(1);

    await api.notify(sessionEvent);
    expect(await arrives(open)).toContain(sharedA.session);
    expect(await refused.next(SILENCE_MS)).toBeNull();
    expect(api.listen).toEqual({ starts: 1, ends: 0 });
    await refused.close();
    await open.close();
  });

  it("an unauthenticated request subscribes to nothing", async () => {
    api = await createTenancyApi();
    const carol = await api.events("carol");
    const anonymous = await api.events(null);
    expect(anonymous.status).toBe(401);
    await api.notify(sessionEvent);
    expect(await arrives(carol)).toContain(sharedA.session);
    expect(api.listen).toEqual({ starts: 1, ends: 0 });
    await carol.close();
  });
});
