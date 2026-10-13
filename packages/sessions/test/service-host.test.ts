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
import { ServiceHost, ServiceHostLive, validateServiceBindAddresses } from "@mend/sessions";
import type { Workspace, WorkspaceForward } from "@sealant/sdk";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

/**
 * The host side with real sockets and a fake platform: the forward is an
 * in-memory echo, so bytes written into the listener must come back out —
 * proving accept → dial → pump end to end without a workspace.
 */

process.env["MEND_SERVICE_PORT_MIN"] = "45710";
process.env["MEND_SERVICE_PORT_MAX"] = "45719";

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
