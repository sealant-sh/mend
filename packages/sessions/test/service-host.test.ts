import * as dgram from "node:dgram";
import { once } from "node:events";
import * as net from "node:net";

import { ServiceForwardsRepo, ServiceObservationsRepo } from "@mend/db";
import {
  SealantWorkspaceId,
  ServiceForwardId,
  ServiceId,
  ServiceObservationId,
} from "@mend/domain";
import { ServiceObservation } from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import {
  ServiceHost,
  ServiceHostLive,
  validateServiceBindAddresses,
  type ServiceStartInput,
} from "@mend/sessions";
import type { Workspace, WorkspaceForward } from "@sealant/sdk";
import { Clock, Context, Deferred, Duration, Effect, Exit, Layer, Scope, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { it as effectIt, TestClock } from "./effect-vitest.ts";

/**
 * The host side with real sockets and a fake platform: the forward is an
 * in-memory echo, so bytes written into the listener must come back out —
 * proving accept → dial → pump end to end without a workspace.
 */

let previousMin: string | undefined;
let previousMax: string | undefined;
beforeEach(async () => {
  previousMin = process.env["MEND_SERVICE_PORT_MIN"];
  previousMax = process.env["MEND_SERVICE_PORT_MAX"];
  const reservation = net.createServer();
  try {
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (address === null || typeof address === "string") throw new Error("no reserved test port");
    // Start at a kernel-selected port, with room for the real allocator to handle contention.
    process.env["MEND_SERVICE_PORT_MIN"] = String(address.port);
    process.env["MEND_SERVICE_PORT_MAX"] = String(Math.min(address.port + 99, 65535));
  } finally {
    if (reservation.listening) {
      const closed = once(reservation, "close");
      reservation.close();
      await closed;
    }
  }
});
afterEach(() => {
  if (previousMin === undefined) delete process.env["MEND_SERVICE_PORT_MIN"];
  else process.env["MEND_SERVICE_PORT_MIN"] = previousMin;
  if (previousMax === undefined) delete process.env["MEND_SERVICE_PORT_MAX"];
  else process.env["MEND_SERVICE_PORT_MAX"] = previousMax;
});

const echoForward = (): WorkspaceForward => {
  const pending: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const finish = () => {
    finished = true;
    wake?.();
  };
  return {
    // Echo: everything sent toward the workspace comes back as output.
    send: (bytes) => {
      pending.push(new Uint8Array(bytes));
      wake?.();
    },
    eof: finish,
    output: {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          for (;;) {
            const chunk = pending.shift();
            if (chunk !== undefined) return { done: false, value: chunk };
            if (finished) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        },
      }),
    },
    closed: new Promise<"end" | "closed">(() => {}),
    close: finish,
  };
};

const fakeWorkspace: Workspace = {
  id: "workspace-1",
  name: "fake",
  status: async () => "ready",
  runtimeDeadline: async () => null,
  runtime: async () => null,
  processUser: async () => "supported",
  sshAsRoot: async () => {},
  phase: async () => null,
  launch: undefined,
  recover: async () => new Promise(() => {}),
  captureDrain: async () => null,
  ready: async function () {
    return this;
  },
  harness: {
    run: async () => new Promise(() => {}),
    start: async () => new Promise(() => {}),
    session: async () => new Promise(() => {}),
  },
  exec: async () => new Promise(() => {}),
  bind: async () => [],
  capture: {
    flush: async () => new Promise(() => {}),
    status: async () => new Promise(() => {}),
    replan: async () => new Promise(() => {}),
  },
  sessions: {
    open: async () => new Promise(() => {}),
    get: async () => new Promise(() => {}),
    list: async () => [],
  },
  events: async function* () {},
  forward: async () => echoForward(),
  stop: async () => ({ state: "stopped" }),
  restart: async function () {
    return this;
  },
  expire: async () => undefined,
  image: async () => null,
  dotfiles: { apply: async () => new Promise(() => {}) },
  credentials: {
    put: async () => new Promise(() => {}),
    release: async () => new Promise(() => {}),
    list: async () => [],
  },
};

const sealantFakeLayer = Layer.succeed(SealantClient, {
  createWorkspace: () => Effect.die("not in test"),
  getWorkspace: () => Effect.succeed(fakeWorkspace),
  getRun: () => Effect.die("not in test"),
  runHarness: () => Effect.die("not in test"),
  startHarness: () => Effect.die("not in test"),
  startHarnessInWorkspace: () => Effect.die("not in test"),
  waitRun: () => Effect.die("not in test"),
  openSession: () => Effect.die("not in test"),
  forward: (workspace, port) => Effect.promise(() => workspace.forward(port)),
  stopWorkspace: () => Effect.die("not in test"),
  captureFlush: () => Effect.die("not in test"),
  captureStatus: () => Effect.succeed(null),
  runtimeDeadline: () => Effect.succeed(null),
  runtimeResourceId: () => Effect.succeed(null),
  launchedRuntime: () => Effect.succeed("unknown" as const),
  findWorkspaceByKey: () => Effect.succeed({ kind: "unsupported" as const }),
  fenceWorkspaceCreate: () => Effect.succeed({ kind: "unsupported" as const }),
  captureReplan: () => Effect.die("not in test"),
  expireWorkspace: () => Effect.die("not in test"),
  getSession: () => Effect.die("not in test"),
  sessionOutput: () => Effect.die("not in test"),
  exec: () => Effect.die("not in test"),
  bindWorkspace: () => Effect.succeed([]),
  diffCommits: () => Effect.die("not in test"),
  inferenceRespond: () => Effect.die("not in test"),
  recordStream: () => Stream.fromEffect(Effect.die("not in test")),
  recordTimeline: () => Stream.fromEffect(Effect.die("not in test")),
  recordCommands: () => Effect.die("not in test"),
  recordScrollback: () => Effect.die("not in test"),
  runChanges: () => Effect.die("not in test"),
  connectionCheck: () => Effect.die("not in test"),
  resolveWorkspacePackage: () => Effect.die("not in test"),
});

const forwardsStubLayer = Layer.succeed(ServiceForwardsRepo, {
  create: () => Effect.die("not in test"),
  createAndSelect: () => Effect.die("not in test"),
  byId: () => Effect.succeed(null),
  listForService: () => Effect.succeed([]),
  listOpen: () => Effect.succeed([]),
  markBound: () => Effect.void,
  markFailed: () => Effect.void,
  markClosed: () => Effect.void,
});

const observationsStubLayer = Layer.succeed(ServiceObservationsRepo, {
  record: (input) =>
    Effect.succeed(
      new ServiceObservation({
        id: ServiceObservationId.make(crypto.randomUUID()),
        ...input,
        error: input.error ?? null,
        firstObservedAt: new Date(),
        lastObservedAt: new Date(),
      }),
    ),
  latestForService: () => Effect.succeed(null),
  listForService: () => Effect.succeed([]),
});

const TestLayer = ServiceHostLive.pipe(
  Layer.provide(sealantFakeLayer),
  Layer.provide(Layer.mergeAll(forwardsStubLayer, observationsStubLayer)),
);

const SERVICE_ID = ServiceId.make("svc-1");
const FORWARD_ID = ServiceForwardId.make("forward-1");
const WORKSPACE_ID = SealantWorkspaceId.make("workspace-1");

describe("validateServiceBindAddresses", () => {
  const assigned = new Set(["10.0.0.8", "192.168.1.4", "fe80::1"]);

  it("accepts only assigned private or loopback literal addresses", () => {
    expect(
      validateServiceBindAddresses(
        ["127.0.0.1", "::1", "10.0.0.8", "192.168.1.4", "fe80::1%eth0"],
        assigned,
      ),
    ).toEqual({
      ok: true,
      addresses: ["127.0.0.1", "::1", "10.0.0.8", "192.168.1.4", "fe80::1%eth0"],
    });
  });

  it.each([
    [[], "contains no addresses"],
    [["0.0.0.0"], "Wildcard"],
    [["::"], "Wildcard"],
    [["8.8.8.8"], "Public"],
    [["10.0.0.9"], "not assigned"],
    [["localhost"], "not a literal IP address"],
    [["127.0.0.1", ""], "not a literal IP address"],
    [["127.0.0.1", "127.0.0.1"], "duplicated"],
    [["127.0.0.1", "8.8.8.8"], "Public"],
  ] as const)("rejects %j atomically", (addresses, message) => {
    const result = validateServiceBindAddresses(addresses, assigned);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(message);
  });
});

describe("ServiceHost", () => {
  it("accepts, dials a forward, and pumps bytes both ways", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* ServiceHost;
        const binding = yield* host.start({
          serviceId: SERVICE_ID,
          forwardId: FORWARD_ID,
          workspaceId: WORKSPACE_ID,
          workspacePort: 3000,
          protocol: "tcp",
          ownerUserId: null,
          bindAddresses: ["127.0.0.1"],
        });

        const echoed = yield* Effect.promise(async () => {
          const socket = net.connect(binding.hostPort, "127.0.0.1");
          await once(socket, "connect");
          socket.write("ping through the pump");
          socket.end(); // half-close: the echo must still drain back
          const chunks: Buffer[] = [];
          socket.on("data", (chunk) => chunks.push(chunk));
          await once(socket, "close");
          return Buffer.concat(chunks).toString();
        });
        expect(echoed).toBe("ping through the pump");

        yield* host.stop(SERVICE_ID);
        // The listener is gone: a fresh connect must be refused.
        const refused = yield* Effect.promise(
          () =>
            new Promise<boolean>((resolve) => {
              const socket = net.connect(binding.hostPort, "127.0.0.1");
              socket.once("error", () => resolve(true));
              socket.once("connect", () => {
                socket.destroy();
                resolve(false);
              });
            }),
        );
        expect(refused).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
    );
  });

  it("reuses the preferred host port on reconciliation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* ServiceHost;
        const first = yield* host.start({
          serviceId: SERVICE_ID,
          forwardId: FORWARD_ID,
          workspaceId: WORKSPACE_ID,
          workspacePort: 3000,
          protocol: "tcp",
          ownerUserId: null,
          bindAddresses: ["127.0.0.1"],
        });
        yield* host.stop(SERVICE_ID);
        const second = yield* host.start({
          serviceId: SERVICE_ID,
          forwardId: FORWARD_ID,
          workspaceId: WORKSPACE_ID,
          workspacePort: 3000,
          protocol: "tcp",
          ownerUserId: null,
          bindAddresses: ["127.0.0.1"],
          preferredHostPort: first.hostPort,
        });
        expect(second.hostPort).toBe(first.hostPort);
        yield* host.stop(SERVICE_ID);
      }).pipe(Effect.provide(TestLayer)),
    );
  });
});

// Each candidate is released independently; iterator startup observes attachment
// even when the implementation loses the queued packet.
const udpCandidate = () => {
  const dial = Promise.withResolvers<WorkspaceForward>();
  const attached = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<"closed">();
  const started = Promise.withResolvers<void>();
  const sent: string[] = [];
  const output: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let sentWake: (() => void) | undefined;
  const forward: WorkspaceForward = {
    send(bytes) {
      sent.push(Buffer.from(bytes).toString());
      sentWake?.();
    },
    eof() {},
    close() {
      finished = true;
      closed.resolve("closed");
      wake?.();
    },
    closed: closed.promise,
    output: {
      [Symbol.asyncIterator]() {
        attached.resolve();
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            for (;;) {
              const value = output.shift();
              if (value !== undefined) return { done: false, value };
              if (finished) return { done: true, value: undefined };
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = undefined;
            }
          },
        };
      },
    },
  };
  return {
    sent,
    attached: attached.promise,
    closed: closed.promise,
    started: started.promise,
    connect: () => {
      started.resolve();
      return dial.promise;
    },
    release: () => dial.resolve(forward),
    fail: () => dial.reject(new Error("candidate unavailable")),
    reply: (text: string) => {
      output.push(Buffer.from(text));
      wake?.();
    },
    waitForSent: async (count: number) => {
      while (sent.length < count) {
        await new Promise<void>((resolve) => {
          sentWake = resolve;
        });
        sentWake = undefined;
      }
    },
    dispose: () => {
      dial.resolve(forward);
      forward.close();
    },
  };
};

const udpTestLayer = (
  first: ReturnType<typeof udpCandidate>,
  second: ReturnType<typeof udpCandidate>,
  firstHost = "127.0.0.1",
) =>
  ServiceHostLive.pipe(
    Layer.provide(
      Layer.mock(SealantClient, {
        getWorkspace: () => Effect.succeed(fakeWorkspace),
        forward: (_workspace, _port, target) =>
          Effect.promise(() => (target === firstHost ? first : second).connect()),
      }),
    ),
    Layer.provide(Layer.mergeAll(forwardsStubLayer, observationsStubLayer)),
  );

describe("ServiceHost UDP candidates", () => {
  it.each(["127.0.0.1", "docker"])(
    "replays queued datagrams to both candidates when %s attaches first",
    async (firstHost) => {
      const first = udpCandidate();
      const second = udpCandidate();
      const layer = udpTestLayer(first, second, firstHost);
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const host = yield* ServiceHost;
            const binding = yield* host.start({
              serviceId: SERVICE_ID,
              forwardId: FORWARD_ID,
              workspaceId: WORKSPACE_ID,
              workspacePort: 3000,
              protocol: "udp",
              ownerUserId: null,
              bindAddresses: ["127.0.0.1"],
            });
            yield* Effect.promise(async () => {
              const socket = dgram.createSocket("udp4");
              try {
                socket.send("before either dial", binding.hostPort, "127.0.0.1");
                await Promise.all([first.started, second.started]);
                first.release();
                await first.attached;
                expect(first.sent).toEqual(["before either dial"]);
                socket.send("between dials", binding.hostPort, "127.0.0.1");
                await first.waitForSent(2);
                second.release();
                await second.attached;
                expect(second.sent).toEqual(["before either dial", "between dials"]);
                const reply = once(socket, "message");
                second.reply("answer");
                const [bytes] = await reply;
                expect(Buffer.isBuffer(bytes) && bytes.toString()).toBe("answer");
                await first.closed;
                socket.send("after reply", binding.hostPort, "127.0.0.1");
                await second.waitForSent(3);
                expect(first.sent).toEqual(["before either dial", "between dials"]);
                expect(second.sent).toEqual(["before either dial", "between dials", "after reply"]);
              } finally {
                socket.close();
              }
            });
          }).pipe(Effect.provide(layer)),
        );
      } finally {
        first.dispose();
        second.dispose();
      }
    },
  );
});

it.each(["reply", "stop", "restart"])("closes a late UDP candidate after %s", async (event) => {
  const first = udpCandidate();
  const second = udpCandidate();
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* ServiceHost;
        const binding = yield* host.start({
          serviceId: SERVICE_ID,
          forwardId: FORWARD_ID,
          workspaceId: WORKSPACE_ID,
          workspacePort: 3000,
          protocol: "udp",
          ownerUserId: null,
          bindAddresses: ["127.0.0.1"],
        });
        const socket = dgram.createSocket("udp4");
        try {
          yield* Effect.promise(async () => {
            socket.send("request", binding.hostPort, "127.0.0.1");
            await Promise.all([first.started, second.started]);
            first.release();
            await first.attached;
            if (event === "reply") {
              const reply = once(socket, "message");
              first.reply("response");
              await reply;
            }
          });
          if (event !== "reply") yield* host.stop(SERVICE_ID);
          if (event === "restart")
            yield* host.start({
              serviceId: SERVICE_ID,
              forwardId: FORWARD_ID,
              workspaceId: WORKSPACE_ID,
              workspacePort: 3000,
              protocol: "udp",
              ownerUserId: null,
              bindAddresses: ["127.0.0.1"],
            });
          yield* Effect.promise(async () => {
            second.release();
            expect(
              await Promise.race([
                second.closed.then(() => "closed"),
                second.attached.then(() => "attached"),
              ]),
            ).toBe("closed");
            expect(second.sent).toEqual([]);
          });
        } finally {
          socket.close();
        }
      }).pipe(Effect.provide(udpTestLayer(first, second))),
    );
  } finally {
    first.dispose();
    second.dispose();
  }
});

it("bounds UDP replay while continuing delivery to an attached candidate", async () => {
  const first = udpCandidate();
  const second = udpCandidate();
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* ServiceHost;
        const binding = yield* host.start({
          serviceId: SERVICE_ID,
          forwardId: FORWARD_ID,
          workspaceId: WORKSPACE_ID,
          workspacePort: 3000,
          protocol: "udp",
          ownerUserId: null,
          bindAddresses: ["127.0.0.1"],
        });
        yield* Effect.promise(async () => {
          const socket = dgram.createSocket("udp4");
          try {
            socket.send("packet-0", binding.hostPort, "127.0.0.1");
            await Promise.all([first.started, second.started]);
            first.release();
            await first.attached;
            for (let n = 1; n < 20; n++) {
              socket.send(`packet-${n}`, binding.hostPort, "127.0.0.1");
              await first.waitForSent(n + 1);
            }
            second.release();
            await second.attached;
            expect(first.sent).toEqual(Array.from({ length: 20 }, (_, n) => `packet-${n}`));
            expect(second.sent).toEqual(Array.from({ length: 16 }, (_, n) => `packet-${n}`));
            socket.send("live", binding.hostPort, "127.0.0.1");
            await Promise.all([first.waitForSent(21), second.waitForSent(17)]);
            expect(first.sent.at(-1)).toBe("live");
            expect(second.sent.at(-1)).toBe("live");
          } finally {
            socket.close();
          }
        });
      }).pipe(Effect.provide(udpTestLayer(first, second))),
    );
  } finally {
    first.dispose();
    second.dispose();
  }
});

it("delivers the queued UDP request when the other candidate fails to dial", async () => {
  const first = udpCandidate();
  const second = udpCandidate();
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* ServiceHost;
        const binding = yield* host.start({
          serviceId: SERVICE_ID,
          forwardId: FORWARD_ID,
          workspaceId: WORKSPACE_ID,
          workspacePort: 3000,
          protocol: "udp",
          ownerUserId: null,
          bindAddresses: ["127.0.0.1"],
        });
        yield* Effect.promise(async () => {
          const socket = dgram.createSocket("udp4");
          try {
            socket.send("request", binding.hostPort, "127.0.0.1");
            await Promise.all([first.started, second.started]);
            first.fail();
            second.release();
            await second.attached;
            expect(second.sent).toEqual(["request"]);
            const reply = once(socket, "message");
            second.reply("response");
            const [bytes] = await reply;
            expect(Buffer.isBuffer(bytes) && bytes.toString()).toBe("response");
          } finally {
            socket.close();
          }
        });
      }).pipe(Effect.provide(udpTestLayer(first, second))),
    );
  } finally {
    first.dispose();
    second.dispose();
  }
});

const tcpAccepts = (port: number) =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("error", (error) => {
          socket.destroy();
          if ("code" in error && error.code === "ECONNREFUSED") resolve(false);
          else reject(error);
        });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
      }),
  );

const clockStartInput: ServiceStartInput = {
  serviceId: SERVICE_ID,
  forwardId: FORWARD_ID,
  workspaceId: WORKSPACE_ID,
  workspacePort: 3000,
  protocol: "tcp",
  ownerUserId: null,
  bindAddresses: ["127.0.0.1"],
};

for (const correction of [
  { name: "backward", millis: -70_000 },
  { name: "forward", millis: 60_000 },
]) {
  effectIt.effect(`keeps the polling cadence when epoch time steps ${correction.name}`, () =>
    Effect.gen(function* () {
      const monotonic = yield* TestClock.testClockWith(Effect.succeed);
      let epochOffset = 0;
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => monotonic.currentTimeMillisUnsafe() + epochOffset,
        currentTimeMillis: Effect.sync(() => monotonic.currentTimeMillisUnsafe() + epochOffset),
        currentTimeNanosUnsafe: () => monotonic.currentTimeNanosUnsafe(),
        currentTimeNanos: monotonic.currentTimeNanos,
        sleep: (duration) => monotonic.sleep(duration),
      };
      const probes: bigint[] = [];
      const recordingForwards: Layer.Layer<ServiceForwardsRepo> = Layer.effect(
        ServiceForwardsRepo,
        Effect.map(ServiceForwardsRepo, (repo) => ({
          ...repo,
          byId: () =>
            Effect.sync(() => {
              probes.push(clock.currentTimeNanosUnsafe());
              // Correct wall time during a pass. Relative sleeps and nanoseconds
              // still use the independently advanced TestClock.
              if (probes.length === 2) epochOffset = correction.millis;
            }).pipe(Effect.andThen(Effect.never)),
        })),
      ).pipe(Layer.provide(forwardsStubLayer));
      const layer: Layer.Layer<ServiceHost> = ServiceHostLive.pipe(
        Layer.provide(sealantFakeLayer),
        Layer.provide(Layer.mergeAll(recordingForwards, observationsStubLayer)),
      );
      yield* Effect.gen(function* () {
        const host = yield* ServiceHost;
        yield* host.start(clockStartInput);
        yield* monotonic.adjust(19_999);
        expect(probes).toEqual([]);
        yield* monotonic.adjust(1);
        expect(probes).toEqual([20_000_000_000n]);
        yield* monotonic.adjust(20_000);
        expect(clock.currentTimeMillisUnsafe()).toBe(40_000 + correction.millis);
        expect(clock.currentTimeNanosUnsafe()).toBe(40_000_000_000n);
        expect(probes).toEqual([20_000_000_000n, 40_000_000_000n]);
        yield* monotonic.adjust(19_999);
        expect(probes).toEqual([20_000_000_000n, 40_000_000_000n]);
        yield* monotonic.adjust(1);
        expect(probes).toEqual([20_000_000_000n, 40_000_000_000n, 60_000_000_000n]);
        yield* monotonic.adjust(20_000);
        expect(probes).toEqual([
          20_000_000_000n,
          40_000_000_000n,
          60_000_000_000n,
          80_000_000_000n,
        ]);
      }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock));
    }),
  );
}

effectIt.effect("closes a missing forward at the first Clock supervisor interval", () =>
  Effect.gen(function* () {
    const host = yield* ServiceHost;
    const binding = yield* host.start(clockStartInput);
    expect(yield* tcpAccepts(binding.hostPort)).toBe(true);
    yield* TestClock.adjust(19_999);
    expect(yield* tcpAccepts(binding.hostPort)).toBe(true);
    yield* TestClock.adjust(1);
    expect(yield* tcpAccepts(binding.hostPort)).toBe(false);
  }).pipe(Effect.provide(TestLayer)),
);

effectIt.effect("stopping a service releases its port and cancels future Clock probes", () =>
  Effect.gen(function* () {
    const reads: ServiceForwardId[] = [];
    const recordingForwards: Layer.Layer<ServiceForwardsRepo> = Layer.effect(
      ServiceForwardsRepo,
      Effect.map(ServiceForwardsRepo, (repo) => ({
        ...repo,
        byId: (id: ServiceForwardId) =>
          Effect.sync(() => {
            reads.push(id);
            return null;
          }),
      })),
    ).pipe(Layer.provide(forwardsStubLayer));
    const layer: Layer.Layer<ServiceHost> = ServiceHostLive.pipe(
      Layer.provide(sealantFakeLayer),
      Layer.provide(Layer.mergeAll(recordingForwards, observationsStubLayer)),
    );
    yield* Effect.gen(function* () {
      const host = yield* ServiceHost;
      const binding = yield* host.start(clockStartInput);
      yield* host.stop(SERVICE_ID);
      expect(yield* tcpAccepts(binding.hostPort)).toBe(false);
      yield* TestClock.adjust("1 minute");
      expect(reads).toEqual([]);
    }).pipe(Effect.provide(layer));
  }),
);

effectIt.effect("a later Clock pass closes a missing forward while an older pass is blocked", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const reads: ServiceForwardId[] = [];
    const heldForwards: Layer.Layer<ServiceForwardsRepo> = Layer.effect(
      ServiceForwardsRepo,
      Effect.map(ServiceForwardsRepo, (repo) => ({
        ...repo,
        byId: (id: ServiceForwardId) =>
          Effect.gen(function* () {
            reads.push(id);
            if (reads.length === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            return null;
          }),
      })),
    ).pipe(Layer.provide(forwardsStubLayer));
    const layer: Layer.Layer<ServiceHost> = ServiceHostLive.pipe(
      Layer.provide(sealantFakeLayer),
      Layer.provide(Layer.mergeAll(heldForwards, observationsStubLayer)),
    );
    yield* Effect.gen(function* () {
      const host = yield* ServiceHost;
      const binding = yield* host.start(clockStartInput);
      yield* TestClock.adjust("20 seconds");
      yield* Deferred.await(firstStarted);
      expect(yield* tcpAccepts(binding.hostPort)).toBe(true);
      expect(yield* Deferred.isDone(releaseFirst)).toBe(false);
      yield* TestClock.adjust("20 seconds");
      expect(yield* tcpAccepts(binding.hostPort)).toBe(false);
      expect(reads).toEqual([FORWARD_ID, FORWARD_ID]);
      expect(yield* Deferred.isDone(releaseFirst)).toBe(false);
      yield* Deferred.succeed(releaseFirst, undefined);
    }).pipe(Effect.provide(layer));
  }),
);

effectIt.effect(
  "closing the ServiceHost scope releases its port and interrupts a blocked pass",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const heldForwards: Layer.Layer<ServiceForwardsRepo> = Layer.effect(
        ServiceForwardsRepo,
        Effect.map(ServiceForwardsRepo, (repo) => ({
          ...repo,
          byId: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        })),
      ).pipe(Layer.provide(forwardsStubLayer));
      const layer: Layer.Layer<ServiceHost> = ServiceHostLive.pipe(
        Layer.provide(sealantFakeLayer),
        Layer.provide(Layer.mergeAll(heldForwards, observationsStubLayer)),
      );
      const owner = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.succeed(undefined)));
      const context = yield* Layer.buildWithScope(layer, owner);
      const host = Context.get(context, ServiceHost);
      const binding = yield* host.start(clockStartInput);
      yield* TestClock.adjust("20 seconds");
      yield* Deferred.await(started);
      expect(yield* tcpAccepts(binding.hostPort)).toBe(true);
      expect(yield* Deferred.isDone(interrupted)).toBe(false);
      yield* Scope.close(owner, Exit.succeed(undefined));
      expect(yield* Deferred.isDone(interrupted)).toBe(true);
      expect(yield* tcpAccepts(binding.hostPort)).toBe(false);
    }),
);

for (const lagMillis of [5_000, 25_000]) {
  effectIt.effect(`a polling wake delayed by ${lagMillis}ms rearms from its actual start`, () =>
    Effect.gen(function* () {
      const monotonic = yield* TestClock.testClockWith(Effect.succeed);
      let delayed = false;
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => monotonic.currentTimeMillisUnsafe(),
        currentTimeMillis: monotonic.currentTimeMillis,
        currentTimeNanosUnsafe: () => monotonic.currentTimeNanosUnsafe(),
        currentTimeNanos: monotonic.currentTimeNanos,
        sleep: (duration) =>
          Effect.suspend(() => {
            // Deliver one timer late, as a stalled event loop could. Ordinary
            // TestClock.adjust visits each scheduled timer on time.
            if (!delayed && monotonic.currentTimeNanosUnsafe() >= 40_000_000_000n) {
              delayed = true;
              return monotonic.sleep(Duration.millis(Duration.toMillis(duration) + lagMillis));
            }
            return monotonic.sleep(duration);
          }),
      };
      const late = BigInt(60_000 + lagMillis) * 1_000_000n;
      const following = late + 20_000_000_000n;
      const probes: bigint[] = [];
      const recordingForwards: Layer.Layer<ServiceForwardsRepo> = Layer.effect(
        ServiceForwardsRepo,
        Effect.map(ServiceForwardsRepo, (repo) => ({
          ...repo,
          byId: () =>
            Effect.sync(() => {
              probes.push(clock.currentTimeNanosUnsafe());
            }).pipe(Effect.andThen(Effect.never)),
        })),
      ).pipe(Layer.provide(forwardsStubLayer));
      const layer: Layer.Layer<ServiceHost> = ServiceHostLive.pipe(
        Layer.provide(sealantFakeLayer),
        Layer.provide(Layer.mergeAll(recordingForwards, observationsStubLayer)),
      );
      yield* Effect.gen(function* () {
        const host = yield* ServiceHost;
        yield* host.start(clockStartInput);
        yield* monotonic.adjust(40_000);
        expect(probes).toEqual([20_000_000_000n, 40_000_000_000n]);
        yield* monotonic.adjust(19_999 + lagMillis);
        expect(probes).toEqual([20_000_000_000n, 40_000_000_000n]);
        yield* monotonic.adjust(1);
        expect(probes).toEqual([20_000_000_000n, 40_000_000_000n, late]);
        yield* monotonic.adjust(19_999);
        expect(probes).toEqual([20_000_000_000n, 40_000_000_000n, late]);
        yield* monotonic.adjust(1);
        expect(probes).toEqual([20_000_000_000n, 40_000_000_000n, late, following]);
      }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock));
    }),
  );
}
