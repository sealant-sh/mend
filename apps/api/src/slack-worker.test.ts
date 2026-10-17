import { SlackInstallsRepo, type SealedSlackInstall } from "@mend/db";
import { OrganizationId } from "@mend/domain";
import { SlackApiError } from "@mend/slack/client";
import { SlackSocket, type SlackEnvelope } from "@mend/slack/socket";
import { SecretCipher } from "@mend/store";
import { TestClock } from "@mend/test-ci/effect-vitest";
import { type Cause, Clock, Duration, Effect, Layer, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { SlackRunner } from "./slack-runner.ts";
import { makeSlackSockets, reconnectDelayMs } from "./slack-worker.ts";

const NOW = new Date("2026-09-23T10:00:00.000Z");

const installOf = (organization: string, appToken: string): SealedSlackInstall => ({
  organizationId: OrganizationId.make(`org-${organization}`),
  teamId: `T-${organization}`,
  teamName: organization,
  botUserId: "U-bot",
  appId: "A",
  sealedAppToken: `sealed:${appToken}`,
  sealedBotToken: "sealed:xoxb",
  webOrigin: "https://mend.test",
  settings: {
    defaultHarness: "claude",
    showAgentMessages: true,
    showDiffs: false,
    externalChannels: false,
    landAutomatically: true,
  },
  installedByUserId: "alice",
  createdAt: NOW,
  updatedAt: NOW,
});

/** A controlled Socket Mode callback, with registration and envelope acknowledgments. */
const sockets = Effect.gen(function* () {
  const attemptsReady = yield* Queue.unbounded<string>();
  const acknowledged = yield* Queue.unbounded<string>();
  const sleeping = yield* Queue.unbounded<{ readonly at: number; readonly ms: number }>();
  const clock = yield* Clock.clockWith(Effect.succeed);
  const installs: Array<SealedSlackInstall> = [];
  const attempts: Array<string> = [];
  const received: Array<string> = [];
  const acks: Array<string> = [];
  const refused = new Set<string>();
  const active = new Map<string, Queue.Queue<SlackEnvelope, SlackApiError | Cause.Done>>();
  const socket = SlackSocket.of({
    connect: (appToken) =>
      Stream.callback<SlackEnvelope, SlackApiError>((queue) =>
        Effect.gen(function* () {
          attempts.push(appToken);
          if (refused.has(appToken)) {
            yield* Queue.offer(attemptsReady, appToken);
            yield* Queue.fail(
              queue,
              new SlackApiError({
                method: "apps.connections.open",
                code: "invalid_auth",
                message: "An API error occurred: invalid_auth",
              }),
            );
          } else {
            active.set(appToken, queue);
            yield* Effect.addFinalizer(() => Effect.sync(() => void active.delete(appToken)));
            yield* Queue.offer(attemptsReady, appToken);
          }
        }),
      ),
  });
  // The supervisor receives this clock; the test retains the original TestClock controller.
  // Record its real sleep request, then delegate without replacing timers or elapsed-time reads.
  const observedClock: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.suspend(() => {
        Queue.offerUnsafe(sleeping, {
          at: clock.currentTimeMillisUnsafe(),
          ms: Duration.toMillis(duration),
        });
        return clock.sleep(duration);
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(SlackSocket, socket),
    Layer.mock(SlackInstallsRepo, { list: () => Effect.sync(() => [...installs]) }),
    Layer.succeed(SecretCipher, {
      encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext}`),
      decrypt: (sealed) => Effect.succeed(sealed.replace(/^sealed:/, "")),
    }),
    Layer.mock(SlackRunner, {
      receive: (organizationId, envelope) =>
        envelope.ack.pipe(
          Effect.andThen(
            Effect.sync(() => received.push(`${organizationId}:${envelope.envelopeId}`)),
          ),
          Effect.andThen(Queue.offer(acknowledged, envelope.envelopeId)),
          Effect.as(null),
        ),
    }),
  );
  const deliver = (appToken: string, envelopeId: string) => {
    const queue = active.get(appToken);
    if (queue === undefined) return false;
    return Queue.offerUnsafe(queue, {
      type: "events_api",
      envelopeId,
      body: {},
      retryAttempt: null,
      ack: Effect.sync(() => void acks.push(envelopeId)),
    });
  };
  const drop = (appToken: string) => {
    const queue = active.get(appToken);
    if (queue === undefined) throw new Error("No registered socket to close");
    Queue.endUnsafe(queue);
  };
  const fail = (appToken: string, code: string) => {
    const queue = active.get(appToken);
    if (queue === undefined) throw new Error("No registered socket to fail");
    return Queue.fail(
      queue,
      new SlackApiError({
        method: "apps.connections.open",
        code,
        message: `An API error occurred: ${code}`,
      }),
    );
  };
  return {
    installs,
    attempts,
    received,
    acks,
    refused,
    layer,
    observedClock,
    opened: () => [...active.keys()],
    nextAttempt: Queue.take(attemptsReady),
    nextAck: Queue.take(acknowledged),
    nextSleep: Queue.take(sleeping),
    deliver,
    drop,
    fail,
  };
});

describe("the worker's Slack sockets", () => {
  it("opens one socket per install, routes its envelopes, and follows replacement and removal", async () => {
    const world = await Effect.runPromise(sockets);
    world.installs.push(installOf("acme", "xapp-acme"), installOf("globex", "xapp-globex"));
    await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* makeSlackSockets;
        yield* manager.reconcile;
        expect([yield* world.nextAttempt, yield* world.nextAttempt].toSorted()).toEqual([
          "xapp-acme",
          "xapp-globex",
        ]);
        expect(world.opened().toSorted()).toEqual(["xapp-acme", "xapp-globex"]);
        yield* manager.reconcile;
        expect(world.attempts).toHaveLength(2);
        expect(world.deliver("xapp-acme", "e1")).toBe(true);
        expect(yield* world.nextAck).toBe("e1");
        expect(world.received).toEqual(["org-acme:e1"]);
        expect(world.acks).toEqual(["e1"]);
        world.installs.splice(0, 2, installOf("acme", "xapp-acme-2"));
        yield* manager.reconcile;
        expect(yield* world.nextAttempt).toBe("xapp-acme-2");
        expect(world.opened()).toEqual(["xapp-acme-2"]);
        expect(manager.open()).toEqual([OrganizationId.make("org-acme")]);
      }).pipe(Effect.scoped, Effect.provide(world.layer)),
    );
    expect(world.opened()).toEqual([]);
  });

  it.each(["close", "transient-error"] as const)(
    "reconnects short-lived sockets after %s at each ordinary backoff boundary",
    async (ending) => {
      let remaining: ReadonlyArray<string> = [];
      await Effect.runPromise(
        Effect.gen(function* () {
          const world = yield* sockets;
          world.installs.push(installOf("acme", "xapp-acme"));
          yield* Effect.gen(function* () {
            const manager = yield* makeSlackSockets;
            yield* manager.reconcile.pipe(Effect.provideService(Clock.Clock, world.observedClock));
            expect(yield* world.nextAttempt).toBe("xapp-acme");
            for (const [index, delay] of [1_000, 2_000, 4_000].entries()) {
              if (ending === "close") world.drop("xapp-acme");
              else yield* world.fail("xapp-acme", "ratelimited");
              const sleep = yield* world.nextSleep;
              expect(sleep.ms).toBe(delay);
              expect(world.opened()).toEqual([]);
              yield* TestClock.adjust(delay - 1);
              expect(world.attempts).toHaveLength(index + 1);
              yield* TestClock.adjust(1);
              expect(yield* world.nextAttempt).toBe("xapp-acme");
              expect(world.attempts).toHaveLength(index + 2);
              expect(world.opened()).toEqual(["xapp-acme"]);
            }
          }).pipe(Effect.scoped, Effect.provide(world.layer));
          remaining = world.opened();
        }).pipe(Effect.provide(TestClock.layer())),
      );
      expect(remaining).toEqual([]);
    },
  );

  it("waits five minutes after an actual token refusal, beyond ordinary reconnect, then retries exactly at the boundary", async () => {
    let remaining: ReadonlyArray<string> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const world = yield* sockets;
        world.installs.push(installOf("acme", "xapp-revoked"));
        world.refused.add("xapp-revoked");
        yield* Effect.gen(function* () {
          const manager = yield* makeSlackSockets;
          yield* manager.reconcile.pipe(Effect.provideService(Clock.Clock, world.observedClock));
          expect(yield* world.nextAttempt).toBe("xapp-revoked");
          const sleep = yield* world.nextSleep;
          yield* TestClock.adjust(1_001);
          expect(world.attempts).toEqual(["xapp-revoked"]);
          yield* TestClock.adjust(298_998);
          expect(world.attempts).toEqual(["xapp-revoked"]);
          expect(sleep).toEqual({ at: 0, ms: 300_000 });
          expect(manager.open()).toEqual([OrganizationId.make("org-acme")]);
          yield* TestClock.adjust(1);
          expect(yield* world.nextAttempt).toBe("xapp-revoked");
          expect(world.attempts).toEqual(["xapp-revoked", "xapp-revoked"]);
          expect((yield* world.nextSleep).ms).toBe(300_000);
        }).pipe(Effect.scoped, Effect.provide(world.layer));
        remaining = world.opened();
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(remaining).toEqual([]);
  });

  it("resets accumulated backoff after a connection stays healthy for sixty seconds", async () => {
    let remaining: ReadonlyArray<string> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const world = yield* sockets;
        world.installs.push(installOf("acme", "xapp-acme"));
        yield* Effect.gen(function* () {
          const manager = yield* makeSlackSockets;
          yield* manager.reconcile.pipe(Effect.provideService(Clock.Clock, world.observedClock));
          expect(yield* world.nextAttempt).toBe("xapp-acme");
          for (const delay of [1_000, 2_000]) {
            world.drop("xapp-acme");
            expect((yield* world.nextSleep).ms).toBe(delay);
            yield* TestClock.adjust(delay);
            expect(yield* world.nextAttempt).toBe("xapp-acme");
          }
          expect(world.deliver("xapp-acme", "healthy-envelope")).toBe(true);
          expect(yield* world.nextAck).toBe("healthy-envelope");
          yield* TestClock.adjust(60_000);
          world.drop("xapp-acme");
          expect(yield* world.nextSleep).toEqual({ at: 63_000, ms: 1_000 });
          yield* TestClock.adjust(999);
          expect(world.attempts).toHaveLength(3);
          yield* TestClock.adjust(1);
          expect(yield* world.nextAttempt).toBe("xapp-acme");
          expect(world.attempts).toHaveLength(4);
          expect(world.acks).toEqual(["healthy-envelope"]);
        }).pipe(Effect.scoped, Effect.provide(world.layer));
        remaining = world.opened();
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(remaining).toEqual([]);
  });

  it("backs off doubling to five minutes, and waits longest on a refused token", () => {
    expect([1, 2, 3, 4].map((failures) => reconnectDelayMs(failures, false))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    expect(reconnectDelayMs(20, false)).toBe(5 * 60_000);
    expect(reconnectDelayMs(1, true)).toBe(5 * 60_000);
  });
});
