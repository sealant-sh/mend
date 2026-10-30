import { request as httpRequest, createServer } from "node:http";
import * as net from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import { screensGroup } from "@mend/api-contracts";
import {
  makeUpgradeTicketsMemory,
  ScreensRepo,
  type TicketCredential,
  UpgradeTicketsRepo,
} from "@mend/db";
import { ScreenId, SealantWorkspaceId, ViewerConnectionId } from "@mend/domain";
import { DisplayNumber } from "@mend/domain/workbench";
import { type ScreenControlAnswer, Screens, type WatchEnd } from "@mend/sessions";
import { Effect, Layer, ManagedRuntime, PubSub, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { afterEach, describe, expect, it } from "vitest";

import {
  CAROL_SESSION_IN_SHARED_A,
  createTenancyWorld,
  type HarnessUser,
  ids,
} from "../../test/support/tenancy-harness.ts";
import { ProjectAccessLive } from "../access.ts";
import { type BudgetLimits, Budgets, DEFAULT_BUDGET_LIMITS, makeBudgets } from "../budgets.ts";
import { ConnectionRegistry, ConnectionRegistryLive } from "../connections.ts";
import { type BusSignal, EventBus } from "../events-bus.ts";
import { makeScreenWatchLayer } from "../screen-watch.ts";
import { AuthMiddlewareLive } from "./api-live.ts";
import { makeScreenSocketRoutes, ScreensGroupLive } from "./screens.ts";
import { scopeOf, UrlBearers } from "./upgrade-tickets.ts";

const SESSION = CAROL_SESSION_IN_SHARED_A;
const GREETING = "RFB 003.008\n";
const LEFT: WatchEnd = { _tag: "ViewerLeft" };

const changed = (connection: ViewerConnectionId, userId: string): ScreenControlAnswer => ({
  _tag: "Changed",
  next: { _tag: "Person", epoch: 1, userId, connection },
  releases: false,
  log: null,
});

const until = async (holds: () => boolean, what: string) => {
  const deadline = Date.now() + 5_000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The socket route and the screens routes over the two-organization world, sharing one watch. */
const startServer = async (limits: Partial<BudgetLimits> = {}) => {
  const world = await createTenancyWorld();
  const revoked = new Set<string>();
  const tickets = makeUpgradeTicketsMemory(Date.now, revoked);
  const pubsub = Effect.runSync(PubSub.unbounded<BusSignal>());
  const watched: Array<{ connection: string; mayTakeInput: boolean }> = [];
  const taken: Array<string> = [];
  const heartbeats: Array<string> = [];
  const lapses: Array<{ connection: string; reason: string }> = [];
  const screens = Layer.mock(Screens, {
    watch: (watcher, viewer) =>
      Effect.gen(function* () {
        watched.push({ connection: watcher.connection, mayTakeInput: watcher.mayTakeInput });
        yield* viewer.write(Buffer.from(GREETING, "latin1"));
        while ((yield* viewer.read) !== null) yield* Effect.void;
        return LEFT;
      }),
    take: (_session, userId, connection) =>
      Effect.sync(() => {
        taken.push(connection);
        return changed(connection, userId);
      }),
    handBack: () => Effect.succeed({ _tag: "Unchanged" }),
    heartbeat: (_session, connection) =>
      Effect.sync(() => {
        heartbeats.push(connection);
        return true;
      }),
    lapse: (_session, connection, reason) =>
      Effect.sync(() => {
        lapses.push({ connection, reason });
        return { _tag: "Unchanged" };
      }),
  });
  const screensRepo = Layer.mock(ScreensRepo, {
    ofSession: () =>
      Effect.succeed({
        id: ScreenId.make("screen-1"),
        sessionId: SESSION,
        workspaceId: SealantWorkspaceId.make("workspace-shared-a"),
        display: DisplayNumber.make(12),
        processId: null,
        life: { _tag: "Live", degraded: null, browserSandboxOff: false },
        input: { _tag: "AwaitingAgent", epoch: 0 },
      }),
    log: () =>
      Effect.succeed([
        {
          screenId: ScreenId.make("screen-1"),
          seq: 1,
          at: new Date("2026-10-30T10:00:00.000Z"),
          actor: { _tag: "Mend" },
          body: { _tag: "Started" },
          frame: null,
          checkpoint: null,
        },
      ]),
  });
  const dependencies = Layer.mergeAll(
    world.authLayer,
    world.accessLayers,
    screens,
    screensRepo,
    Layer.succeed(EventBus, { subscribe: PubSub.subscribe(pubsub) }),
    Layer.succeed(UpgradeTicketsRepo, tickets),
    Layer.succeed(UrlBearers, { mode: "refuse" }),
    Layer.succeed(Budgets, makeBudgets({ ...DEFAULT_BUDGET_LIMITS, ...limits })),
  );
  const shared = Layer.mergeAll(
    makeScreenWatchLayer({
      sweepEvery: "1 hour",
      passDeadline: "2 seconds",
      closeGrace: "200 millis",
    }),
    ConnectionRegistryLive,
  ).pipe(Layer.provideMerge(ProjectAccessLive), Layer.provideMerge(dependencies));
  const api = HttpApiBuilder.layer(HttpApi.make("mend").add(screensGroup).prefix("/api")).pipe(
    Layer.provide(ScreensGroupLive),
    Layer.provide(AuthMiddlewareLive),
  );
  const server = createServer();
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(Layer.merge(api, makeScreenSocketRoutes({ pingEvery: "100 millis" })), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provideMerge(shared),
      Layer.provide(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" })),
    ),
  );
  await runtime.runPromise(Effect.void);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const origin = `127.0.0.1:${address.port}`;
  const clients = new Set<WebSocket>();
  const sockets = new Set<net.Socket>();

  const ticketFor = (user: HarnessUser, credential: TicketCredential | null) =>
    Effect.runPromise(
      tickets.mint({
        userId: user,
        credential,
        target: "screen",
        scope: scopeOf("screen", { session: SESSION }),
      }),
    ).then(({ ticket }) => ticket);
  const pathOf = (ticket: string) =>
    `/api/screen-socket?${new URLSearchParams({ session: SESSION, ticket })}`;

  /** A browser's socket: the hello, then the relay's greeting. */
  const watch = async (
    user: HarnessUser,
    credential: TicketCredential | null = `session:${user}`,
  ) => {
    const ticket = await ticketFor(user, credential);
    const client = new WebSocket(`ws://${origin}${pathOf(ticket)}`);
    clients.add(client);
    client.binaryType = "arraybuffer";
    const frames: Array<string | Uint8Array> = [];
    const closed: { code: number; reason: string } = { code: 0, reason: "" };
    client.addEventListener("message", (event) => {
      frames.push(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data);
    });
    client.addEventListener("close", (event) => {
      closed.code = event.code;
      closed.reason = event.reason;
    });
    await until(() => frames.length >= 2 || closed.code !== 0, `${user}'s socket opened`);
    const [hello] = frames;
    const parsed: unknown = typeof hello === "string" ? JSON.parse(hello) : null;
    const connection =
      typeof parsed === "object" && parsed !== null && "connection" in parsed
        ? String(parsed.connection)
        : "";
    return { client, frames, closed, ticket, connection };
  };

  /** How an upgrade is answered: 101, or a refusal and its words, before anything is upgraded. */
  const upgrade = (path: string) =>
    new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
      const request = httpRequest(`http://${origin}${path}`, {
        agent: false,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
        },
      });
      request.on("upgrade", (response, socket) => {
        sockets.add(socket);
        resolve({ status: response.statusCode ?? 0, body: "" });
      });
      request.on("response", (response) => {
        let body = "";
        response.on("data", (chunk) => (body += String(chunk)));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      request.on("error", reject);
      request.end();
    });

  /** A client that upgrades and then sends nothing at all, its pongs included. */
  const silent = async (user: HarnessUser) => {
    const ticket = await ticketFor(user, `session:${user}`);
    const socket = net.connect(address.port, "127.0.0.1");
    sockets.add(socket);
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
    });
    socket.write(
      [
        `GET ${pathOf(ticket)} HTTP/1.1`,
        `Host: ${origin}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${Buffer.from("fedcba9876543210").toString("base64")}`,
        "",
        "",
      ].join("\r\n"),
    );
    /** The code of the server's close frame, once one arrived. */
    const closeCode = () => {
      let at = received.indexOf("\r\n\r\n");
      if (at < 0) return null;
      at += 4;
      while (at + 2 <= received.length) {
        const opcode = (received[at] ?? 0) & 0x0f;
        let length = (received[at + 1] ?? 0) & 0x7f;
        let start = at + 2;
        if (length === 126) {
          length = received.readUInt16BE(start);
          start += 2;
        }
        if (start + length > received.length) return null;
        if (opcode === 0x8) return received.readUInt16BE(start);
        at = start + length;
      }
      return null;
    };
    return { closeCode };
  };

  const post = (user: HarnessUser, path: string, body?: unknown) =>
    fetch(`http://${origin}/api/sessions/${SESSION}/screen${path}`, {
      method: body === undefined && path === "" ? "GET" : "POST",
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    world,
    revoked,
    watched,
    taken,
    heartbeats,
    lapses,
    watch,
    silent,
    upgrade,
    /** A fresh ticket's upgrade, as `user`. */
    upgradeAs: async (user: HarnessUser) =>
      upgrade(pathOf(await ticketFor(user, `session:${user}`))),
    pathOf,
    post,
    publish: (signal: BusSignal) => Effect.runPromise(PubSub.publish(pubsub, signal)),
    registry: () => runtime.runPromise(Effect.service(ConnectionRegistry)),
    close: async () => {
      for (const client of clients) client.close();
      for (const socket of sockets) socket.destroy();
      await runtime.dispose();
      await world.dispose();
    },
  };
};

let current: Awaited<ReturnType<typeof startServer>> | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});
const start = async (limits?: Partial<BudgetLimits>) => {
  current = await startServer(limits);
  return current;
};

const event = (shape: Extract<BusSignal, { kind: "event" }>["event"]): BusSignal => ({
  kind: "event",
  event: shape,
  payload: "{}",
});

describe("the screen socket", () => {
  it("opens once per screen ticket: its first frame names the connection, then RFB follows", async () => {
    const server = await start();
    const carol = await server.watch("carol");
    expect(carol.connection).toMatch(/^vc_[A-Za-z0-9_-]{22}$/);
    expect(JSON.parse(String(carol.frames[0]))).toEqual({
      type: "connection",
      connection: carol.connection,
    });
    expect(Buffer.from(carol.frames[1] ?? "").toString("latin1")).toBe(GREETING);
    const alice = await server.watch("alice");
    expect(server.watched).toEqual([
      { connection: carol.connection, mayTakeInput: true },
      { connection: alice.connection, mayTakeInput: false },
    ]);
    expect((await server.upgrade(server.pathOf(carol.ticket))).status).toBe(401);
  });

  it("refuses an account that cannot see the session, the session's owner included", async () => {
    const server = await start();
    expect((await server.upgradeAs("bob")).status).toBe(404);
    const carol = await server.watch("carol");
    server.world.setVisibility("shared-a", "private");
    expect((await server.upgradeAs("carol")).status).toBe(404);
    expect((await server.post("carol", "/take", { connection: carol.connection })).status).toBe(
      404,
    );
    expect((await server.post("carol", "/hand-back", {})).status).toBe(404);
    expect((await server.post("carol", "")).status).toBe(404);
    expect(server.taken).toEqual([]);
  });

  it("lets only the owner take over, and only on an open viewer of their own", async () => {
    const server = await start();
    const alice = await server.watch("alice");
    const carol = await server.watch("carol");
    const answer = async (user: HarnessUser, path: string, body?: unknown) => {
      const response = await server.post(user, path, body);
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await answer("alice", "/take", { connection: alice.connection })).toEqual({
      _tag: "Refused",
      why: "owner-only",
    });
    expect(await answer("alice", "/hand-back", {})).toEqual({ _tag: "Refused", why: "owner-only" });
    expect(await answer("carol", "/take", { connection: alice.connection })).toEqual({
      _tag: "NotWatching",
    });
    expect(await answer("carol", "/take", { connection: "vc_never-opened" })).toEqual({
      _tag: "NotWatching",
    });
    expect(server.taken).toEqual([]);
    expect(await answer("carol", "/take", { connection: carol.connection })).toEqual({
      _tag: "Changed",
      holder: { _tag: "Person", userId: "carol", taking: false },
    });
    expect(server.taken).toEqual([carol.connection]);
    carol.client.close();
    await until(
      () => server.lapses.some(({ connection }) => connection === carol.connection),
      "the closed viewer lapsed",
    );
    expect(server.lapses).toEqual([{ connection: carol.connection, reason: "disconnected" }]);
    expect(await answer("carol", "/take", { connection: carol.connection })).toEqual({
      _tag: "NotWatching",
    });
  });

  it("reads the screen for anyone who can see the session", async () => {
    const server = await start();
    const response = await server.post("alice", "");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      _tag: "Screen",
      display: 12,
      width: 1280,
      height: 800,
      life: { _tag: "Live", degraded: null, browserSandboxOff: false },
      holder: { _tag: "Agent", awaiting: true },
      since: "2026-10-30T10:00:00.000Z",
      ownerUserId: "carol",
    });
    expect((await server.post("bob", "")).status).toBe(404);
  });

  it("refuses the next viewer past an account's budget or a screen's, and stops none", async () => {
    const server = await start({ accountScreenViewers: 2, screenViewers: 3 });
    const open = [await server.watch("carol"), await server.watch("carol")];
    const overAccount = await server.upgradeAs("carol");
    expect(overAccount.status).toBe(429);
    expect(overAccount.body).toContain("2 open screen viewers for one account");
    open.push(await server.watch("alice"));
    const overScreen = await server.upgradeAs("alice");
    expect(overScreen.status).toBe(429);
    expect(overScreen.body).toContain("3 open viewers of one screen");
    expect(open.map(({ client }) => client.readyState)).toEqual([1, 1, 1]);
    expect(server.watched).toHaveLength(3);
  });

  it("closes a viewer whose project turns private, and leaves one who still sees it", async () => {
    const server = await start();
    const carol = await server.watch("carol");
    const alice = await server.watch("alice");
    server.world.setVisibility("shared-a", "private");
    await server.publish(event({ type: "project", projectId: ids("shared-a").project }));
    await until(() => carol.closed.code !== 0, "carol's viewer closed");
    expect(carol.closed).toEqual({ code: 1008, reason: "access revoked" });
    expect(server.lapses).toEqual([{ connection: carol.connection, reason: "revoked" }]);
    expect(alice.client.readyState).toBe(1);
  });

  it("closes a viewer whose device is revoked", async () => {
    const server = await start();
    const phone = await server.watch("carol", "device:carol-phone");
    const laptop = await server.watch("carol");
    server.revoked.add("device:carol-phone");
    await server.publish(event({ type: "user", userId: "carol", facet: "devices" }));
    await until(() => phone.closed.code !== 0, "the phone's viewer closed");
    expect(phone.closed).toEqual({ code: 1008, reason: "access revoked" });
    expect(laptop.client.readyState).toBe(1);
  });

  it("keeps watchers connected when shared control turns off", async () => {
    const server = await start();
    const alice = await server.watch("alice");
    const registry = await server.registry();
    const terminalClosed = { closed: false };
    const scope = Effect.runSync(Scope.make());
    await Effect.runPromise(
      registry
        .register(
          "alice",
          Effect.sync(() => {
            terminalClosed.closed = true;
          }),
          SESSION,
          "terminal",
        )
        .pipe(Scope.provide(scope)),
    );
    await server.publish(
      event({
        type: "shared-control-off",
        sessionId: SESSION,
        projectId: ids("shared-a").project,
        ownerUserId: "carol",
      }),
    );
    await until(() => terminalClosed.closed, "alice's terminal closed");
    expect(alice.client.readyState).toBe(1);
    expect(alice.closed.code).toBe(0);
  });

  it("keeps the lease of a holder whose client answers, and lapses and closes one that is silent", async () => {
    const server = await start();
    const carol = await server.watch("carol");
    await until(
      () => server.heartbeats.filter((each) => each === carol.connection).length >= 3,
      "the answering client's lease was renewed",
    );
    expect(carol.client.readyState).toBe(1);
    const silent = await server.silent("carol");
    await until(() => silent.closeCode() !== null, "the silent client was closed");
    expect(silent.closeCode()).toBe(4408);
    expect(server.lapses).toEqual([
      { connection: expect.stringMatching(/^vc_/), reason: "disconnected" },
    ]);
    expect(server.lapses[0]?.connection).not.toBe(carol.connection);
  });
});
