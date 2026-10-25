import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import * as net from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import {
  makeUpgradeTicketsMemory,
  ServiceForwardsRepo,
  ServiceObservationsRepo,
  SessionControlEventsRepo,
  UpgradeTicketsRepo,
} from "@mend/db";
import { tunnelListener } from "@mend/network/tunnel-client";
import { ServiceHost, ServiceHostLive, SessionEngine, WorkspaceCaller } from "@mend/sessions";
import {
  adapterLayer,
  type DialScript,
  type FakeForward,
  fakeForward,
  type FakeWorkspaceSide,
  refusal,
  scriptedSealant,
  takeFirst,
  untilAborted,
} from "@mend/sessions/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyWorld, ids } from "../../test/support/tenancy-harness.ts";
import { ProjectAccessLive } from "../access.ts";
import { Budgets, DEFAULT_BUDGET_LIMITS, makeBudgets } from "../budgets.ts";
import { ConnectionRegistry, makeConnectionRegistry } from "../connections.ts";
import { SessionSteeringLive } from "../session-steering.ts";
import { ServiceTunnelRoutes } from "./service-tunnel.ts";
import { scopeOf, UrlBearers } from "./upgrade-tickets.ts";

/**
 * `/api/service-tunnel` byte for byte: a local TCP client, the CLI's `pumpConnection`, the real
 * route over a real HTTP server, the real forward adapter, and a bounded forward fixture where the
 * workspace's port would be. Alice owns `shared-a` and its TCP Service.
 */
const SERVICE = ids("shared-a").service;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const startTunnel = async (script: DialScript) => {
  const world = await createTenancyWorld();
  const tickets = makeUpgradeTicketsMemory();
  const sealant = scriptedSealant(script);
  const adapter = adapterLayer(sealant.layer, "refuse");
  const forwards = Layer.mock(ServiceForwardsRepo, { byId: () => Effect.succeed(null) });
  const host = ServiceHostLive.pipe(
    Layer.provide(
      Layer.mergeAll(adapter, sealant.layer, forwards, Layer.mock(ServiceObservationsRepo, {})),
    ),
  );
  const dependencies = Layer.mergeAll(
    world.authLayer,
    world.accessLayers,
    adapter,
    forwards,
    Layer.succeed(ConnectionRegistry, Effect.runSync(makeConnectionRegistry)),
    Layer.succeed(Budgets, makeBudgets(DEFAULT_BUDGET_LIMITS)),
    Layer.succeed(UpgradeTicketsRepo, tickets),
    Layer.succeed(UrlBearers, { mode: "refuse" }),
    Layer.mock(WorkspaceCaller, {
      observe: () => (self) => self,
      act: () => (self) => self,
      observeRun: () => (self) => self,
      observeRunStream: () => (self) => self,
    }),
    Layer.mock(SessionControlEventsRepo, { record: () => Effect.void }),
    Layer.mock(SessionEngine, { launchUnderWay: () => false }),
  );
  const authorization = SessionSteeringLive.pipe(
    Layer.provideMerge(ProjectAccessLive),
    Layer.provideMerge(dependencies),
  );
  const server = createServer();
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(ServiceTunnelRoutes.pipe(Layer.provide(authorization)), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provide(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" })),
      Layer.provideMerge(host),
    ),
  );
  await runtime.runPromise(Effect.void);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no API address");

  const tunnelUrl = async () => {
    const ticket = await Effect.runPromise(
      tickets.mint({
        userId: "alice",
        credential: null,
        target: "service-tunnel",
        scope: scopeOf("service-tunnel", { service: SERVICE }),
      }),
    );
    const params = new URLSearchParams({ service: SERVICE, ticket: ticket.ticket });
    return new URL(`ws://127.0.0.1:${address.port}/api/service-tunnel?${params}`);
  };

  // The CLI's listener, as `mend service connect` and attach tunnels bind it.
  const cliSockets: net.Socket[] = [];
  const closes: Array<{ readonly code: number; readonly reason: string }> = [];
  const local = tunnelListener(tunnelUrl, {
    onConnection: (socket) => cliSockets.push(socket),
    onClosed: (code, reason) => closes.push({ code, reason }),
  });
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  const localAddress = local.address();
  if (localAddress === null || typeof localAddress === "string") throw new Error("no local port");

  disposers.push(async () => {
    local.close();
    await runtime.dispose();
  });
  return {
    localPort: localAddress.port,
    apiPort: address.port,
    tunnelUrl,
    ledger: sealant.ledger,
    cliSockets,
    closes,
    serviceHost: (act: (host: ServiceHost["Service"]) => Effect.Effect<void>) =>
      runtime.runPromise(ServiceHost.use(act)),
  };
};

/** Reads every byte until the client's FIN, then answers with it in odd-sized pieces and a digest. */
const answerAfterFin = async (side: FakeWorkspaceSide) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of side.fromClient) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  await sleep(20);
  for (
    let offset = 0, step = 1;
    offset < body.length;
    offset += step, step = ((step * 7 + 13) % 70_000) + 1
  ) {
    await side.send(body.subarray(offset, offset + step));
  }
  await side.send(Buffer.from(`\ndigest ${createHash("sha256").update(body).digest("hex")}`));
  await side.end();
};

const exchange = (port: number, payload: Buffer, chunkSizes: ReadonlyArray<number>) =>
  new Promise<{ readonly received: Buffer; readonly error: string | null }>((resolve) => {
    const client = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let error: string | null = null;
    client.on("data", (chunk: Buffer) => chunks.push(chunk));
    client.on("error", (cause: NodeJS.ErrnoException) => {
      error = cause.code ?? cause.message;
    });
    client.on("close", () => resolve({ received: Buffer.concat(chunks), error }));
    let offset = 0;
    for (let i = 0; offset < payload.length; i++) {
      const size = chunkSizes[i % chunkSizes.length] ?? 1;
      client.write(payload.subarray(offset, offset + size));
      offset += size;
    }
    client.end();
  });

const holdOpen = async (port: number) => {
  const client = net.connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  let error: string | null = null;
  client.on("data", (chunk: Buffer) => chunks.push(chunk));
  client.on("error", (cause: NodeJS.ErrnoException) => {
    error = cause.code ?? cause.message;
  });
  const closed = new Promise<{ readonly received: string; readonly error: string | null }>(
    (resolve) =>
      client.on("close", () => resolve({ received: Buffer.concat(chunks).toString(), error })),
  );
  await once(client, "connect");
  return { client, received: () => Buffer.concat(chunks).toString(), closed };
};

const answerThenHold = () => {
  const workspace = Promise.withResolvers<FakeWorkspaceSide>();
  const script: DialScript = async () =>
    fakeForward(async (side) => {
      await takeFirst(side);
      await side.send(Buffer.from("before-stop"));
      workspace.resolve(side);
      return new Promise(() => undefined);
    }).forward;
  return { script, workspace: workspace.promise };
};

describe("the Service tunnel, byte for byte", () => {
  it("resets the local connection with the reason when the Service stops, though its process then ends cleanly", async () => {
    const { script, workspace } = answerThenHold();
    const { localPort, closes, serviceHost } = await startTunnel(script);
    const local = await holdOpen(localPort);
    local.client.write("hello");
    await until(() => local.received() === "before-stop", "the answer before the stop");
    await serviceHost((host) => host.stop(SERVICE));
    await (await workspace).end();
    expect(await local.closed).toEqual({ received: "before-stop", error: "ECONNRESET" });
    expect(closes).toEqual([{ code: 4410, reason: "service-stopping" }]);
  });

  it("resets the local connection with the reason when the Service restarts", async () => {
    const { script, workspace } = answerThenHold();
    const { localPort, closes, serviceHost } = await startTunnel(script);
    const local = await holdOpen(localPort);
    local.client.write("hello");
    await until(() => local.received() === "before-stop", "the answer before the restart");
    await serviceHost((host) => host.sever(SERVICE, "service-restarting"));
    await (await workspace).end();
    expect(await local.closed).toEqual({ received: "before-stop", error: "ECONNRESET" });
    expect(closes).toEqual([{ code: 4410, reason: "service-restarting" }]);
  });

  it("carries 1 MiB to the workspace and its answer back, with the client's FIN in between", async () => {
    const { localPort } = await startTunnel(async () => fakeForward(answerAfterFin).forward);
    const payload = Buffer.alloc(1 << 20);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 131 + (i >> 9)) & 0xff;
    const { received, error } = await exchange(localPort, payload, [1, 4096, 65_537, 333, 200_000]);
    expect(error).toBeNull();
    expect(received.length).toBe(payload.length + 72);
    expect(received.subarray(0, payload.length).equals(payload)).toBe(true);
    expect(received.subarray(payload.length).toString()).toBe(
      `\ndigest ${createHash("sha256").update(payload).digest("hex")}`,
    );
  });

  it("resets the local connection when the workspace resets mid-answer", async () => {
    const { localPort } = await startTunnel(
      async () =>
        fakeForward(async (side) => {
          await side.send(Buffer.from("partial answer"));
          await sleep(30);
          side.reset("target-error");
        }).forward,
    );
    const { received, error } = await exchange(
      localPort,
      Buffer.from("GET / HTTP/1.1\r\n\r\n"),
      [64],
    );
    expect(received.toString()).toBe("partial answer");
    expect(error).toBe("ECONNRESET");
  });

  it("closes with the refusal's code and name when the dial is refused, and the CLI hears both", async () => {
    const { tunnelUrl, localPort, closes } = await startTunnel(async () => {
      throw refusal("not-found", 404);
    });
    const ws = new WebSocket(await tunnelUrl());
    const [event] = await once(ws, "close");
    expect({ code: event.code, reason: event.reason }).toEqual({ code: 4404, reason: "not-found" });
    const { error } = await exchange(localPort, Buffer.from("hello"), [5]);
    expect(error).toBe("ECONNRESET");
    expect(closes).toEqual([{ code: 4404, reason: "not-found" }]);
  });

  it("delivers the answer of a workspace that ends during the client's upload, then a clean end", async () => {
    const body = Buffer.alloc(1 << 20, "x");
    const answer = Buffer.concat([
      Buffer.from(`HTTP/1.1 413 Payload Too Large\r\nContent-Length: ${body.length}\r\n\r\n`),
      body,
    ]);
    const { localPort } = await startTunnel(
      async () =>
        fakeForward(async (side) => {
          await takeFirst(side);
          await sleep(20);
          for (let offset = 0; offset < answer.length; offset += 16 * 1024) {
            void side.send(answer.subarray(offset, offset + 16 * 1024));
          }
          await side.end();
        }).forward,
    );
    const { received, error } = await exchange(localPort, Buffer.alloc(4 << 20, 9), [65_536]);
    expect(received.equals(answer)).toBe(true);
    expect(error).toBeNull();
  });

  it("resets the local connection after the answer when the workspace ends without taking what came before the client's FIN", async () => {
    const { localPort } = await startTunnel(
      async () =>
        fakeForward(async (side) => {
          void side.send(Buffer.from("answer"));
          await sleep(50);
          await side.end();
        }).forward,
    );
    const { received, error } = await exchange(localPort, Buffer.from("hello"), [5]);
    expect(received.toString()).toBe("answer");
    expect(error).toBe("ECONNRESET");
  });

  it("gives the dial up when the client closes after frames the dial holds back", async () => {
    let dialSignal: AbortSignal | null = null;
    const { tunnelUrl } = await startTunnel(async (_destination, signal) => {
      dialSignal = signal;
      return untilAborted(signal);
    });
    const ws = new WebSocket(await tunnelUrl());
    await once(ws, "open");
    await until(() => dialSignal !== null, "the dial");
    for (let i = 0; i < 4; i++) {
      ws.send(new Uint8Array(1024).fill(i));
      await sleep(15);
    }
    ws.close();
    await until(() => dialSignal?.aborted === true, "the dial to be given up");
  });

  it("resets the forward when the client closes while the workspace takes none of its upload", async () => {
    let forward: FakeForward | null = null;
    const { tunnelUrl } = await startTunnel(async () => {
      forward = fakeForward(() => new Promise(() => undefined));
      return forward.forward;
    });
    const ws = new WebSocket(await tunnelUrl());
    await once(ws, "open");
    await until(() => forward !== null, "the forward");
    for (let i = 0; i < 4; i++) {
      ws.send(new Uint8Array(1024).fill(i));
      await sleep(15);
    }
    ws.close();
    await until(() => forward?.closedByClient() === true, "the forward to be reset");
  });

  it("holds the local client back while the workspace takes nothing, instead of buffering its upload", async () => {
    const workspace = Promise.withResolvers<FakeWorkspaceSide>();
    const { localPort, cliSockets } = await startTunnel(
      async () =>
        fakeForward((side) => {
          workspace.resolve(side);
          return new Promise(() => undefined);
        }).forward,
    );
    const client = net.connect(localPort, "127.0.0.1");
    client.on("error", () => undefined);
    await once(client, "connect");
    const upload = 64 << 20;
    client.write(Buffer.alloc(upload, 3));
    await until(() => cliSockets.length === 1, "the CLI's side of the connection");
    const cli = cliSockets[0];
    if (cli === undefined) throw new Error("no CLI socket");
    let last = -1;
    while (cli.bytesRead !== last) {
      last = cli.bytesRead;
      await sleep(150);
    }
    expect(cli.isPaused()).toBe(true);
    expect(cli.bytesRead).toBeLessThan(upload / 2);
    client.resetAndDestroy();
    (await workspace.promise).reset("runtime-lost");
  });

  it("gives the dial up when the local client resets during it", async () => {
    let dialSignal: AbortSignal | null = null;
    const { localPort } = await startTunnel(async (_destination, signal) => {
      dialSignal = signal;
      return untilAborted(signal);
    });
    const client = net.connect(localPort, "127.0.0.1");
    client.on("error", () => undefined);
    await once(client, "connect");
    client.write("waiting");
    await until(() => dialSignal !== null, "the dial");
    client.resetAndDestroy();
    await until(() => dialSignal?.aborted === true, "the dial to be given up");
  });
});
