import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { screensGroup } from "@mend/api-contracts";
import {
  makeScreensMemory,
  makeUpgradeTicketsMemory,
  ScreensRepo,
  type TicketCredential,
  UpgradeTicketsRepo,
} from "@mend/db";
import { ScreenId, SealantWorkspaceId, SessionProcessId, ViewerConnectionId } from "@mend/domain";
import { DisplayNumber } from "@mend/domain/workbench";
import {
  ForwardAdapterLive,
  type ScreenControlAnswer,
  ScreenHost,
  Screens,
  ScreensLive,
  screenWorkersLayer,
  type WatchEnd,
} from "@mend/sessions";
import {
  dockerReady,
  makeScreenWorld,
  screenSealantLayer,
  startXvnc,
  type Xvnc,
} from "@mend/sessions/testing";
import { BlobStoreFsLive } from "@mend/store";
import { Deferred, Effect, Layer, ManagedRuntime, PubSub, Redacted, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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

const pathOf = (ticket: string, session: string = SESSION) =>
  `/api/screen-socket?${new URLSearchParams({ session, ticket })}`;

interface ServerOptions {
  /** The real Screens and its store in place of the recording mock. */
  readonly screens?: Layer.Layer<Screens | ScreensRepo>;
  /** The first `n` credential checks wait until all `n` have arrived, so admissions overlap. */
  readonly together?: number;
  /** The mock's heartbeat lease: a holder not renewed within it lapses as `lease-lapsed`. */
  readonly leaseMs?: number;
}

/** The socket route and the screens routes over the two-organization world, sharing one watch. */
const startServer = async (limits: Partial<BudgetLimits> = {}, options: ServerOptions = {}) => {
  const world = await createTenancyWorld();
  const revoked = new Set<string>();
  const memory = makeUpgradeTicketsMemory(Date.now, revoked);
  const arrived = Effect.runSync(Deferred.make<void>());
  let arrivals = 0;
  const tickets: UpgradeTicketsRepo["Service"] = {
    ...memory,
    credentialStands: (credential) =>
      Effect.gen(function* () {
        if (options.together !== undefined && arrivals < options.together) {
          arrivals += 1;
          if (arrivals === options.together) yield* Deferred.succeed(arrived, undefined);
          yield* Deferred.await(arrived);
        }
        return yield* memory.credentialStands(credential);
      }),
  };
  const pubsub = Effect.runSync(PubSub.unbounded<BusSignal>());
  const watched: Array<{ connection: string; mayTakeInput: boolean }> = [];
  const taken: Array<string> = [];
  const heartbeats: Array<string> = [];
  const lapses: Array<{ connection: string; reason: string }> = [];
  const leases = new Map<string, ReturnType<typeof setTimeout>>();
  const renew = (connection: string) => {
    clearTimeout(leases.get(connection));
    if (options.leaseMs === undefined) return;
    const lapsed = () => {
      if (lapses.some((each) => each.connection === connection)) return;
      lapses.push({ connection, reason: "lease-lapsed" });
    };
    leases.set(connection, setTimeout(lapsed, options.leaseMs));
  };
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
        renew(connection);
        return changed(connection, userId);
      }),
    handBack: () => Effect.succeed({ _tag: "Unchanged" }),
    heartbeat: (_session, connection) =>
      Effect.sync(() => {
        heartbeats.push(connection);
        if (leases.has(connection)) renew(connection);
        return true;
      }),
    lapse: (_session, connection, reason) =>
      Effect.sync(() => {
        clearTimeout(leases.get(connection));
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
    lastLoggedAt: (_id, bodies) =>
      Effect.succeed(bodies.includes("Started") ? new Date("2026-10-30T10:00:00.000Z") : null),
  });
  const dependencies = Layer.mergeAll(
    world.authLayer,
    world.accessLayers,
    options.screens ?? Layer.merge(screens, screensRepo),
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

  const ticketFor = (
    user: HarnessUser,
    credential: TicketCredential | null,
    session: string = SESSION,
  ) =>
    Effect.runPromise(
      tickets.mint({
        userId: user,
        credential,
        target: "screen",
        scope: scopeOf("screen", { session }),
      }),
    ).then(({ ticket }) => ticket);

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
    /** The payload of the server's first frame with `opcode`, once one arrived. */
    const frameOf = (wanted: number) => {
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
        if (opcode === wanted) return received.subarray(start, start + length);
        at = start + length;
      }
      return null;
    };
    /** The code of the server's close frame, once one arrived. */
    const closeCode = () => frameOf(0x8)?.readUInt16BE(0) ?? null;
    /** The connection its hello named, once it arrived. */
    const connection = () => {
      const hello = frameOf(0x1);
      if (hello === null) return null;
      const parsed: unknown = JSON.parse(hello.toString("utf8"));
      return typeof parsed === "object" && parsed !== null && "connection" in parsed
        ? String(parsed.connection)
        : null;
    };
    return { closeCode, connection };
  };

  const post = (user: HarnessUser, path: string, body?: unknown) =>
    fetch(`http://${origin}/api/sessions/${SESSION}/screen${path}`, {
      method: body === undefined && path === "" ? "GET" : "POST",
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    world,
    ticketFor,
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
      for (const lease of leases.values()) clearTimeout(lease);
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
const start = async (limits?: Partial<BudgetLimits>, options?: ServerOptions) => {
  current = await startServer(limits, options);
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
      holder: { _tag: "Person", userId: "carol", connection: carol.connection, taking: false },
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

  it("answers a session the caller cannot see as a missing one, however full its screen", async () => {
    const server = await start({ screenViewers: 1 });
    await server.watch("carol");
    expect((await server.upgradeAs("alice")).status, "the screen is full").toBe(429);
    const hidden = await server.upgradeAs("bob");
    const missing = "s-missing";
    const absent = await server.upgrade(
      server.pathOf(await server.ticketFor("bob", "session:bob", missing), missing),
    );
    expect(hidden).toEqual({ status: 404, body: "unknown session" });
    expect(absent).toEqual(hidden);
  });

  it("lets exactly an account's budget of simultaneous viewers through", async () => {
    const arriving = 32;
    const server = await start({}, { together: arriving });
    const tickets = await Promise.all(
      Array.from({ length: arriving }, () => server.ticketFor("carol", "session:carol")),
    );
    const answers = await Promise.all(
      tickets.map((ticket) => server.upgrade(server.pathOf(ticket))),
    );
    const statuses = answers.map(({ status }) => status);
    expect(statuses.filter((status) => status === 101)).toHaveLength(8);
    expect(statuses.filter((status) => status === 429)).toHaveLength(arriving - 8);
    expect(
      await Effect.runPromise(
        Effect.flatMap(Effect.promise(server.registry), (registry) =>
          registry.countOnSession(SESSION, "screen"),
        ),
      ),
    ).toBe(8);
  });

  it("lets exactly a screen's budget of simultaneous viewers through, across accounts", async () => {
    const each = 16;
    const server = await start({ accountScreenViewers: 12 }, { together: 2 * each });
    const tickets = await Promise.all(
      (["carol", "alice"] as const).flatMap((user) =>
        Array.from({ length: each }, () =>
          server.ticketFor(user, `session:${user}`).then((ticket) => ({ user, ticket })),
        ),
      ),
    );
    const answers = await Promise.all(
      tickets.map(async ({ user, ticket }) => ({
        user,
        status: (await server.upgrade(server.pathOf(ticket))).status,
      })),
    );
    const opened = answers.filter(({ status }) => status === 101);
    expect(opened).toHaveLength(16);
    for (const user of ["carol", "alice"]) {
      expect(opened.filter((answer) => answer.user === user).length).toBeLessThanOrEqual(12);
    }
    expect(answers.filter(({ status }) => status === 429)).toHaveLength(2 * each - 16);
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

  it("lapses a silent holder as disconnected before its lease of two pings could", async () => {
    const server = await start({}, { leaseMs: 200 });
    const silent = await server.silent("carol");
    await until(() => silent.connection() !== null, "the silent client's hello");
    const connection = silent.connection() ?? "";
    expect(await (await server.post("carol", "/take", { connection })).json()).toMatchObject({
      _tag: "Changed",
    });
    await until(() => silent.closeCode() !== null, "the silent holder was closed");
    expect(silent.closeCode()).toBe(4408);
    await until(() => server.lapses.length > 0, "the holder lapsed");
    expect(server.lapses[0]).toEqual({ connection, reason: "disconnected" });
  });
});

/** RFB over a watcher's socket after its hello frame, as noVNC speaks it. */
const rfbOf = (viewer: Awaited<ReturnType<Awaited<ReturnType<typeof startServer>>["watch"]>>) => {
  let next = 1;
  let buffered = Buffer.alloc(0);
  const take = async (count: number) => {
    await until(() => {
      for (; next < viewer.frames.length; next++) {
        const frame = viewer.frames[next];
        if (typeof frame !== "string" && frame !== undefined) {
          buffered = Buffer.concat([buffered, frame]);
        }
      }
      return buffered.length >= count || viewer.closed.code !== 0;
    }, `${count} bytes of RFB`);
    if (buffered.length < count) throw new Error(`the viewer closed with ${viewer.closed.code}`);
    const taken = buffered.subarray(0, count);
    buffered = buffered.subarray(count);
    return taken;
  };
  const send = (bytes: Uint8Array<ArrayBuffer>) => viewer.client.send(bytes);
  return {
    /** Through ServerInit, then 32-bit pixels in Raw. */
    hello: async () => {
      expect((await take(12)).toString("latin1")).toBe(GREETING);
      send(Buffer.from(GREETING, "latin1"));
      expect([...(await take(2))]).toEqual([1, 1]);
      send(Uint8Array.of(1));
      expect((await take(4)).readUInt32BE(0)).toBe(0);
      send(Uint8Array.of(1));
      const init = await take(24);
      expect([init.readUInt16BE(0), init.readUInt16BE(2)]).toEqual([1280, 800]);
      await take(init.readUInt32BE(20));
      send(Uint8Array.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]));
      send(Uint8Array.of(2, 0, 0, 1, 0, 0, 0, 0));
    },
    /** The colour at one point of a full, fresh frame: everything sent before it went through. */
    colourAt: async (at: { readonly x: number; readonly y: number }) => {
      send(Uint8Array.of(3, 0, 0, 0, 0, 0, 1280 >> 8, 1280 & 0xff, 800 >> 8, 800 & 0xff));
      const header = await take(4);
      expect(header[0], "a FramebufferUpdate").toBe(0);
      let colour: ReadonlyArray<number> | null = null;
      for (let rect = 0; rect < header.readUInt16BE(2); rect++) {
        const head = await take(12);
        const [x, y, w, h] = [0, 2, 4, 6].map((offset) => head.readUInt16BE(offset));
        if (x === undefined || y === undefined || w === undefined || h === undefined) break;
        const pixels = await take(w * h * 4);
        if (at.x < x || at.y < y || at.x >= x + w || at.y >= y + h) continue;
        const offset = ((at.y - y) * w + (at.x - x)) * 4;
        colour = [pixels[offset + 2] ?? -1, pixels[offset + 1] ?? -1, pixels[offset] ?? -1];
      }
      return colour;
    },
    pointer: (x: number, y: number) => {
      const moved = Buffer.alloc(6);
      moved[0] = 5;
      moved.writeUInt16BE(x, 2);
      moved.writeUInt16BE(y, 4);
      send(moved);
    },
  };
};

describe.skipIf(!dockerReady)(
  "the screen socket, against TigerVNC Xvnc and the real Screens",
  () => {
    let xvnc: Xvnc | undefined;
    const blobs = mkdtempSync(join(tmpdir(), "mend-screen-socket-blobs-"));
    const passwords = { full: "socket-full", viewOnly: "socket-view" };
    beforeAll(() => {
      xvnc = startXvnc(`mend-screen-socket-${process.pid}-${Date.now()}`);
      xvnc.signWith(passwords.full, passwords.viewOnly);
    }, 660_000);
    afterAll(() => {
      xvnc?.remove();
      rmSync(blobs, { recursive: true, force: true });
    });

    const x = (command: string) => {
      if (xvnc === undefined) throw new Error("no Xvnc");
      return xvnc.x(command);
    };
    const pointer = () =>
      x("xdotool getmouselocation")
        .match(/x:(\d+) y:(\d+)/)
        ?.slice(1)
        .join(",");

    /** Carol's session's screen, live in a store of its own, dialled over TCP to the test's Xvnc. */
    const realScreens = async () => {
      const world = makeScreenWorld();
      world.xvncPort = xvnc?.port ?? 0;
      const repo = makeScreensMemory();
      const screen = await Effect.runPromise(
        repo.reserve({ sessionId: SESSION, workspaceId: SealantWorkspaceId.make("ws-1") }),
      );
      await Effect.runPromise(
        repo.setLife(screen.id, {
          life: { _tag: "Live", degraded: null, browserSandboxOff: false },
          processId: SessionProcessId.make("screen-process"),
        }),
      );
      const host = Layer.mock(ScreenHost, {
        ownerOf: () => Effect.succeed("carol"),
        passwords: () =>
          Effect.succeed({
            full: Redacted.make(passwords.full),
            viewOnly: Redacted.make(passwords.viewOnly),
          }),
        rekey: () => Effect.succeed(true),
        ptyOf: () => Effect.succeed("pty-screen-process"),
        turnOf: () => Effect.succeed(null),
      });
      return ScreensLive.pipe(
        Layer.provide(host),
        Layer.provide(ForwardAdapterLive.pipe(Layer.provide(screenSealantLayer(world)))),
        Layer.provide(BlobStoreFsLive(blobs)),
        Layer.provide(screenWorkersLayer(new URL("../screen-worker.ts", import.meta.url))),
        Layer.provideMerge(Layer.succeed(ScreensRepo, repo)),
      );
    };

    it("shows every watcher the screen, moves nothing for a watcher's input, and the owner's only while they hold it", async () => {
      const server = await start({}, { screens: await realScreens() });
      const alice = await server.watch("alice");
      const carol = await server.watch("carol");
      const watcher = rfbOf(alice);
      const owner = rfbOf(carol);
      await watcher.hello();
      await owner.hello();
      // Booting over the live screen opens its hand, which first puts the pointer at 0,0.
      await until(() => pointer() === "0,0", "the hand's boot reset the pointer");
      x("xsetroot -solid '#3366cc'; xdotool mousemove 100 100");
      expect(await watcher.colourAt({ x: 10, y: 10 })).toEqual([0x33, 0x66, 0xcc]);
      expect(await owner.colourAt({ x: 10, y: 10 })).toEqual([0x33, 0x66, 0xcc]);

      watcher.pointer(250, 250);
      owner.pointer(300, 300);
      await watcher.colourAt({ x: 10, y: 10 });
      await owner.colourAt({ x: 10, y: 10 });
      expect(pointer(), "no one holds the input yet").toBe("100,100");

      const took = await server.post("carol", "/take", { connection: carol.connection });
      expect(await took.json()).toMatchObject({
        _tag: "Changed",
        holder: { _tag: "Person", userId: "carol" },
      });
      owner.pointer(400, 300);
      await until(() => pointer() === "400,300", "the holder's pointer moved");
      watcher.pointer(250, 250);
      await watcher.colourAt({ x: 10, y: 10 });
      await owner.colourAt({ x: 10, y: 10 });
      expect(pointer(), "a watcher moves nothing while the owner holds it").toBe("400,300");

      const handed = await server.post("carol", "/hand-back", {});
      expect(await handed.json()).toMatchObject({ _tag: "Changed" });
      owner.pointer(500, 500);
      await owner.colourAt({ x: 10, y: 10 });
      expect(pointer(), "the owner moves nothing once handed back").toBe("400,300");
      expect([alice.closed.code, carol.closed.code]).toEqual([0, 0]);
    }, 120_000);
  },
);
