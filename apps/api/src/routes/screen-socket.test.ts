import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeHttpServer } from "@effect/platform-node";
import { ScreenRtcAnswer, screensGroup } from "@mend/api-contracts";
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
  ForwardAdapter,
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
  connect,
  type Xvnc,
} from "@mend/sessions/testing";
import { BlobStoreFsLive } from "@mend/store";
import { Deferred, Effect, Layer, ManagedRuntime, PubSub, Redacted, Schema, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
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
import { type ScreenRtc, makeScreenRtcLayer } from "../screen-rtc.ts";
import { ScreenVideoSourceLive } from "../screen-video-source.ts";
import { makeScreenWatchLayer } from "../screen-watch.ts";
import { AuthMiddlewareLive } from "./api-live.ts";
import { makeScreenSocketRoutes, ScreensGroupLive } from "./screens.ts";
import { scopeOf, UrlBearers } from "./upgrade-tickets.ts";

declare global {
  interface Window {
    ScreenRtcClient: {
      openScreenRtc: (
        video: HTMLVideoElement,
        session: string,
        events: { watching: (connection: string) => void; fallback: () => void },
      ) => { setHeld: (held: boolean) => void; close: () => void };
    };
  }
}

const SESSION = CAROL_SESSION_IN_SHARED_A;
const GREETING = "RFB 003.008\n";
const LEFT: WatchEnd = { _tag: "ViewerLeft" };

const changed = (connection: ViewerConnectionId, userId: string): ScreenControlAnswer => ({
  _tag: "Changed",
  next: { _tag: "Person", epoch: 1, userId, connection },
  releases: false,
  log: null,
});

const until = async (holds: () => boolean, what: string, ms = 5_000) => {
  const deadline = Date.now() + ms;
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
  readonly rtc?: Layer.Layer<
    ScreenRtc,
    never,
    Screens | ScreensRepo | import("../screen-watch.ts").ScreenWatch | Budgets | ConnectionRegistry
  >;
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
  const rtc: NonNullable<ServerOptions["rtc"]> =
    options.rtc ??
    makeScreenRtcLayer({ port: 3140, host: "127.0.0.1" }).pipe(
      Layer.provide(
        ScreenVideoSourceLive.pipe(
          Layer.provide(Layer.merge(Layer.mock(ScreenHost, {}), Layer.mock(ForwardAdapter, {}))),
        ),
      ),
    );
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
      Layer.provide(rtc),
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
    origin: `http://${origin}`,
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
      processId: null,
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
      xvnc = startXvnc(`handback-socket-${process.pid}-${Date.now()}`);
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

describe("screen RTC admission", () => {
  it("answers an unseen session exactly like a missing one before the viewer budget", async () => {
    const server = await start({ screenViewers: 1 });
    await server.watch("alice");
    const unseen = await server.post("bob", "/rtc", { offer: "unused" });
    const absent = await fetch(`${server.origin}/api/sessions/absent/screen/rtc`, {
      method: "POST",
      headers: { authorization: "Bearer bob", "content-type": "application/json" },
      body: JSON.stringify({ offer: "unused" }),
    });
    expect([unseen.status, absent.status]).toEqual([404, 404]);
    expect(await unseen.json()).toMatchObject({ _tag: "NotFound" });
    expect(await absent.json()).toMatchObject({ _tag: "NotFound" });
  });

  it("shares both screen-viewer ceilings with socket viewers before negotiating or dialling", async () => {
    const server = await start({ accountScreenViewers: 1, screenViewers: 1 });
    await server.watch("alice");
    const account = await server.post("alice", "/rtc", { offer: "unused" });
    expect(account.status).toBe(429);
    expect(await account.json()).toMatchObject({ budget: "accountScreenViewers" });
    const screen = await server.post("carol", "/rtc", { offer: "unused" });
    expect(screen.status).toBe(429);
    expect(await screen.json()).toMatchObject({ budget: "screenViewers" });
    expect(server.watched).toHaveLength(1);
  });
});

const rtcInput = (page: import("playwright-core").Page, pixelX: number, pixelY: number) =>
  page.evaluate(
    ({ x, y }) => {
      document.dispatchEvent(new CustomEvent("rtc-input", { detail: { x, y, buttons: 0 } }));
    },
    { x: pixelX, y: pixelY },
  );

const freeUdpPort = () =>
  new Promise<number>((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });

const chromiumPath = process.env.CHROMIUM_PATH ?? chromium.executablePath();

describe.skipIf(!dockerReady || !existsSync(chromiumPath))(
  "screen RTC with real Xvnc, ffmpeg, the API and Chromium",
  () => {
    let xvnc: Xvnc;
    let browser: Browser;
    let clientScript = "";
    const encoderPorts = new Map<number, number>();
    const proxies: Array<net.Server> = [];
    const container = `handback-video-${process.pid}`;
    const blobs = mkdtempSync(join(tmpdir(), "task2-rtc-blobs-"));
    beforeAll(async () => {
      const bundledClient = await build({
        entryPoints: [
          fileURLToPath(new URL("../../../web/src/lib/screen-rtc.ts", import.meta.url)),
        ],
        bundle: true,
        platform: "browser",
        format: "iife",
        globalName: "ScreenRtcClient",
        write: false,
      });
      clientScript = bundledClient.outputFiles?.[0]?.text ?? "";
      xvnc = startXvnc(container);
      for (const [mouse, port] of [
        [1, 7900],
        [0, 8100],
      ] as const)
        xvnc.start(
          "sh",
          "-c",
          `while :; do ffmpeg -nostdin -loglevel error -fflags nobuffer -f x11grab -draw_mouse ${mouse} -framerate 30 -video_size 1280x800 -i :0 -c:v libx264 -threads 2 -preset ultrafast -tune zerolatency -profile:v baseline -level:v 3.1 -pix_fmt yuv420p -vf scale=out_color_matrix=bt709 -colorspace bt709 -color_primaries bt709 -color_trc bt709 -g 30 -keyint_min 30 -bf 0 -x264-params aud=1:repeat-headers=1 -f h264 "tcp://0.0.0.0:${port}?listen=1"; sleep 0.2; done`,
        );
      const address = execFileSync(
        "docker",
        ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container],
        { encoding: "utf8" },
      ).trim();
      for (const port of [7900, 8100]) {
        const proxy = net.createServer((client) => {
          const upstream = net.connect(port, address);
          upstream.on("error", () => client.destroy());
          client.on("error", () => upstream.destroy());
          client.on("close", () => upstream.destroy());
          client.pipe(upstream).pipe(client);
        });
        proxies.push(proxy);
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        const proxyAddress = proxy.address();
        if (proxyAddress === null || typeof proxyAddress === "string")
          throw new Error("no encoder proxy");
        encoderPorts.set(port, proxyAddress.port);
      }
      browser = await chromium.launch({
        executablePath: chromiumPath,
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
      });
    }, 660_000);
    afterAll(async () => {
      await browser?.close();
      for (const proxy of proxies) proxy.close();
      xvnc?.remove();
      rmSync(blobs, { recursive: true, force: true });
    });

    it("decodes 1280x800 at 30fps, shares one upstream/UDP port, and only the holder moves Xvnc", async () => {
      const repo = makeScreensMemory();
      const screen = await Effect.runPromise(
        repo.reserve({ sessionId: SESSION, workspaceId: SealantWorkspaceId.make("rtc-workspace") }),
      );
      await Effect.runPromise(
        repo.setLife(screen.id, {
          life: { _tag: "Live", degraded: null, browserSandboxOff: false },
          processId: SessionProcessId.make("rtc-process"),
        }),
      );
      const host = Layer.mock(ScreenHost, {
        ownerOf: () => Effect.succeed("carol"),
        passwords: () =>
          Effect.succeed({ full: Redacted.make("handpass"), viewOnly: Redacted.make("handpass") }),
        rekey: () => Effect.succeed(true),
        ptyOf: () => Effect.succeed("rtc-pty"),
        turnOf: () => Effect.succeed(null),
      });
      let videoDials = 0;
      let videoCloses = 0;
      const videoPorts: Array<number> = [];
      const forwards = Layer.mock(ForwardAdapter, {
        open: (target, options) =>
          Effect.gen(function* () {
            expect(options.purpose).toBe("screen");
            expect(target.binding).toEqual({ kind: "session", session: "rtc-pty" });
            const encoder = target.port >= 7900;
            if (encoder) {
              videoDials++;
              videoPorts.push(target.port - screen.display);
            }
            const pipe = yield* Effect.acquireRelease(
              Effect.promise(() =>
                connect(
                  encoder ? (encoderPorts.get(target.port - screen.display) ?? 0) : xvnc.port,
                ),
              ),
              (opened) =>
                Effect.sync(() => {
                  opened.cut();
                  if (encoder) videoCloses++;
                }),
            );
            return {
              bytes: pipe.bytes,
              record: {
                kind: "ready",
                dialId: "rtc-test",
                purpose: "screen",
                workspaceId: target.workspaceId,
                port: target.port,
                requested: target.binding,
                lookupMs: 0,
                attempts: [],
                totalMs: 0,
                arrival: { route: "loopback", proof: target.binding },
              },
            };
          }),
      });
      const deps = Layer.mergeAll(host, forwards, Layer.succeed(ScreensRepo, repo));
      const screens = ScreensLive.pipe(
        Layer.provide(deps),
        Layer.provide(BlobStoreFsLive(blobs)),
        Layer.provide(screenWorkersLayer(new URL("../screen-worker.ts", import.meta.url))),
      );
      const udp = await freeUdpPort();
      const server = await start(
        {},
        {
          screens: screens.pipe(Layer.provideMerge(Layer.succeed(ScreensRepo, repo))),
          rtc: makeScreenRtcLayer({ port: udp, host: "localhost" }).pipe(
            Layer.provide(ScreenVideoSourceLive.pipe(Layer.provide(deps))),
          ),
        },
      );
      const ownerContext = await browser.newContext({
        extraHTTPHeaders: { authorization: "Bearer carol" },
      });
      const watcherContext = await browser.newContext({
        extraHTTPHeaders: { authorization: "Bearer alice" },
      });
      const owner = await ownerContext.newPage();
      const watcher = await watcherContext.newPage();
      const open = async (page: import("playwright-core").Page) => {
        await page.goto(`${server.origin}/api/sessions/${SESSION}/screen`);
        return page.evaluate(async (session) => {
          document.body.innerHTML =
            '<video autoplay muted playsinline width="1280" height="800"></video>';
          const video = document.querySelector("video");
          if (video === null) throw new Error("missing video");
          const peer = new RTCPeerConnection({ iceServers: [] });
          const track = peer.addTransceiver("video", { direction: "recvonly" });
          track.setCodecPreferences(
            RTCRtpReceiver.getCapabilities("video")?.codecs.filter(
              (codec) => codec.mimeType === "video/H264",
            ) ?? [],
          );
          const channel = peer.createDataChannel("input");
          peer.ontrack = (received) => {
            video.srcObject = new MediaStream([received.track]);
            void video.play();
          };
          await peer.setLocalDescription(await peer.createOffer());
          if (peer.iceGatheringState !== "complete")
            await new Promise<void>((resolve) =>
              peer.addEventListener("icegatheringstatechange", () => {
                if (peer.iceGatheringState === "complete") resolve();
              }),
            );
          const response = await fetch(`/api/sessions/${session}/screen/rtc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ offer: peer.localDescription?.sdp }),
          });
          const result: unknown = await response.json();
          if (
            !response.ok ||
            result === null ||
            typeof result !== "object" ||
            !("answer" in result) ||
            typeof result.answer !== "string" ||
            !("connection" in result)
          )
            throw new Error(JSON.stringify(result));
          await peer.setRemoteDescription({ type: "answer", sdp: result.answer });
          const timer = setInterval(() => {
            if (channel.readyState === "open") channel.send("ping");
          }, 2500);
          // DOM event handlers let the test drive the real channel without exposing peer internals.
          document.addEventListener("rtc-input", (message) => {
            if (message instanceof CustomEvent) channel.send(JSON.stringify(message.detail));
          });
          document.addEventListener("rtc-close", () => {
            clearInterval(timer);
            peer.close();
          });
          return { connection: String(result.connection), answer: result.answer };
        }, SESSION);
      };
      try {
        await owner.goto(`${server.origin}/api/sessions/${SESSION}/screen`);
        await owner.addScriptTag({ content: clientScript });
        const ownerResponse = owner.waitForResponse((response) =>
          response.url().endsWith("/screen/rtc"),
        );
        const ownerConnection = await owner.evaluate(
          (session) =>
            new Promise<string>((resolve, reject) => {
              document.body.innerHTML =
                '<video autoplay muted playsinline width="1280" height="800"></video>';
              const video = document.querySelector("video");
              if (video === null) {
                reject(new Error("missing video"));
                return;
              }
              const view = window.ScreenRtcClient.openScreenRtc(video, session, {
                watching: resolve,
                fallback: () => reject(new Error("RTC client fell back")),
              });
              document.addEventListener("rtc-held", (message) => {
                if (message instanceof CustomEvent) view.setHeld(message.detail === true);
              });
              document.addEventListener("rtc-input", (message) => {
                if (!(message instanceof CustomEvent)) return;
                const detail: unknown = message.detail;
                if (
                  detail === null ||
                  typeof detail !== "object" ||
                  !("x" in detail) ||
                  !("y" in detail) ||
                  typeof detail.x !== "number" ||
                  typeof detail.y !== "number"
                )
                  return;
                const rect = video.getBoundingClientRect();
                video.dispatchEvent(
                  new PointerEvent("pointermove", {
                    clientX: rect.left + detail.x,
                    clientY: rect.top + detail.y,
                  }),
                );
              });
              document.addEventListener("rtc-close", view.close);
            }),
          SESSION,
        );
        const carol = Schema.decodeUnknownSync(ScreenRtcAnswer)(await (await ownerResponse).json());
        expect(ownerConnection).toBe(carol.connection);
        const alice = await open(watcher);
        for (const answer of [carol.answer, alice.answer]) {
          const candidates = answer.split("\n").filter((line) => line.startsWith("a=candidate:"));
          expect(candidates.length).toBeGreaterThan(0);
          expect(
            candidates.every((candidate) => candidate.includes(` 127.0.0.1 ${udp} typ host`)),
          ).toBe(true);
        }
        for (const page of [owner, watcher])
          await page.waitForFunction(() => document.querySelector("video")?.videoWidth === 1280, {
            timeout: 15_000,
          });
        const frames = await owner.evaluate(async () => {
          const video = document.querySelector("video");
          if (video === null) throw new Error("missing video");
          const before = video.getVideoPlaybackQuality().totalVideoFrames;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return video.getVideoPlaybackQuality().totalVideoFrames - before;
        });
        expect(frames).toBeGreaterThanOrEqual(20);
        expect(videoDials).toBe(1);
        const registry = await server.registry();
        expect(await Effect.runPromise(registry.countOnSession(SESSION, "screen"))).toBe(2);
        const pointer = () =>
          xvnc
            .x("xdotool getmouselocation")
            .match(/x:(\d+) y:(\d+)/)
            ?.slice(1)
            .join(",");
        xvnc.x("xdotool mousemove 100 100");
        await rtcInput(owner, 300, 300);
        await rtcInput(watcher, 250, 250);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(pointer()).toBe("100,100");
        // Measure actual decoded-frame gaps across both switches for both existing viewers.
        for (const page of [owner, watcher])
          await page.evaluate(() => {
            const video = document.querySelector("video");
            if (video === null) throw new Error("missing video");
            const canvas = document.createElement("canvas");
            canvas.width = 1280;
            canvas.height = 800;
            const context = canvas.getContext("2d");
            if (context === null) throw new Error("missing canvas context");
            let previous = performance.now();
            video.dataset.maxGap = "0";
            video.dataset.frames = "0";
            const decoded = (now: number) => {
              video.dataset.maxGap = String(Math.max(Number(video.dataset.maxGap), now - previous));
              video.dataset.frames = String(Number(video.dataset.frames) + 1);
              previous = now;
              if (video.dataset.handBackFrames !== undefined) {
                context.drawImage(video, 0, 0);
                const rgb = Array.from(context.getImageData(10, 10, 1, 1).data).slice(0, 3);
                video.dataset.handBackFrames += `${rgb.join(",")};`;
              }
              video.requestVideoFrameCallback(decoded);
            };
            video.requestVideoFrameCallback(decoded);
          });
        const decodedAfterSwitch = async () => {
          for (const page of [owner, watcher]) {
            const before = await page.evaluate(() =>
              Number(document.querySelector("video")?.dataset.frames),
            );
            await page.waitForFunction(
              (count) => Number(document.querySelector("video")?.dataset.frames) >= count + 5,
              before,
            );
            expect(
              await page.evaluate(() => Number(document.querySelector("video")?.dataset.maxGap)),
            ).toBeLessThan(1000);
          }
        };
        const paint = async (colour: string, expected: Array<number>) => {
          xvnc.x(`xsetroot -solid '${colour}'`);
          for (const page of [owner, watcher])
            await page.waitForFunction(
              (rgbExpected) => {
                const video = document.querySelector("video");
                if (video === null) return false;
                const canvas = document.createElement("canvas");
                canvas.width = 1280;
                canvas.height = 800;
                const context = canvas.getContext("2d");
                if (context === null) return false;
                context.drawImage(video, 0, 0);
                const rgb = context.getImageData(10, 10, 1, 1).data;
                return rgbExpected.every((value, i) => Math.abs(value - (rgb[i] ?? 0)) < 25);
              },
              expected,
              { polling: 10, timeout: 5000 },
            );
        };
        await paint("#e02030", [224, 32, 48]);
        const took = await server.post("carol", "/take", { connection: carol.connection });
        expect(await took.json()).toMatchObject({
          _tag: "Changed",
          holder: { _tag: "Person", connection: carol.connection },
        });
        await owner.evaluate(() =>
          document.dispatchEvent(new CustomEvent("rtc-held", { detail: true })),
        );
        await rtcInput(owner, 400, 300);
        await until(() => pointer() === "400,300", "holder moved the Xvnc pointer");
        await rtcInput(watcher, 250, 250);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(pointer()).toBe("400,300");
        expect(
          await (await server.post("alice", "/take", { connection: alice.connection })).json(),
        ).toMatchObject({ _tag: "Refused", why: "owner-only" });
        await until(
          () => videoDials === 2 && videoCloses === 1,
          "no-pointer encoder replaced the pointer encoder",
        );
        await decodedAfterSwitch();
        // Let the disconnected pointer listener restart while the screen is still red.
        await new Promise((resolve) => setTimeout(resolve, 500));
        await paint("#20d040", [32, 208, 64]);
        for (const page of [owner, watcher])
          await page.evaluate(() => {
            const video = document.querySelector("video");
            if (video === null) throw new Error("missing video");
            video.dataset.handBackFrames = "";
          });
        await server.post("carol", "/hand-back", {});
        await owner.evaluate(() =>
          document.dispatchEvent(new CustomEvent("rtc-held", { detail: false })),
        );
        await rtcInput(owner, 500, 500);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(pointer()).toBe("400,300");
        await until(
          () => videoDials === 3 && videoCloses === 2,
          "pointer encoder returned after hand back",
        );
        await decodedAfterSwitch();
        for (const page of [owner, watcher]) {
          const samples = await page.evaluate(() =>
            (document.querySelector("video")?.dataset.handBackFrames ?? "")
              .split(";")
              .filter(Boolean)
              .map((rgb) => rgb.split(",").map(Number)),
          );
          expect(samples.length).toBeGreaterThanOrEqual(5);
          expect(
            samples.filter((rgb) =>
              [224, 32, 48].every((value, i) => Math.abs(value - (rgb[i] ?? 0)) < 25),
            ),
            "no decoded frame after hand back may show the pre-take-over red screen",
          ).toEqual([]);
        }
        expect(videoPorts).toEqual([7900, 8100, 7900]);
        const latencies: Array<number> = [];
        for (const colour of ["#e02030", "#20d040", "#3050e0"]) {
          const started = performance.now();
          xvnc.x(`xsetroot -solid '${colour}'`);
          const expected = [1, 3, 5].map((offset) =>
            Number.parseInt(colour.slice(offset, offset + 2), 16),
          );
          await owner.waitForFunction(
            (rgbExpected) => {
              const video = document.querySelector("video");
              if (video === null) return false;
              const canvas = document.createElement("canvas");
              canvas.width = 1280;
              canvas.height = 800;
              const context = canvas.getContext("2d");
              if (context === null) return false;
              context.drawImage(video, 0, 0);
              const rgb = context.getImageData(10, 10, 1, 1).data;
              return rgbExpected.every((value, i) => Math.abs(value - (rgb[i] ?? 0)) < 25);
            },
            expected,
            { polling: 10, timeout: 5000 },
          );
          latencies.push(Math.round(performance.now() - started));
        }
        console.log(
          JSON.stringify({
            screenRtc: {
              width: 1280,
              framesIn2s: frames,
              fps: frames / 2,
              latencyMs: latencies,
              udp,
              upstreams: videoDials,
            },
          }),
        );
        await owner.evaluate(() => document.dispatchEvent(new Event("rtc-close")));
        await ownerContext.close();
        expect(videoCloses, "watcher still holds the upstream").toBe(2);
        // A visibility loss closes the remaining RTC viewer through the same access recheck.
        server.revoked.add("session:alice");
        await server.publish(event({ type: "user", userId: "alice", facet: "access" }));
        await until(() => videoCloses === 3, "last RTC viewer released the encoder", 15_000);
        await expect
          .poll(() => Effect.runPromise(registry.countOnSession(SESSION, "screen")))
          .toBe(0);
      } finally {
        await ownerContext.close();
        await watcherContext.close();
      }
    }, 55_000);
    it("falls back when RTC is unavailable, or has not connected within five seconds", async () => {
      for (const unavailable of [true, false]) {
        const page = await browser.newPage();
        try {
          await page.route("http://127.0.0.1/**", async (route) => {
            if (route.request().url().endsWith("/screen/rtc")) {
              if (unavailable)
                await route.fulfill({
                  status: 503,
                  contentType: "application/json",
                  body: '{"_tag":"ScreenRtcUnavailable"}',
                });
              return;
            }
            await route.fulfill({
              contentType: "text/html",
              body: "<video muted autoplay playsinline></video>",
            });
          });
          await page.goto("http://127.0.0.1/");
          await page.addScriptTag({ content: clientScript });
          const elapsed = await page.evaluate(
            () =>
              new Promise<number>((resolve, reject) => {
                const video = document.querySelector("video");
                if (video === null) {
                  reject(new Error("missing video"));
                  return;
                }
                const began = performance.now();
                window.ScreenRtcClient.openScreenRtc(video, "screen-test", {
                  watching: () => reject(new Error("unexpected video")),
                  fallback: () => resolve(performance.now() - began),
                });
              }),
          );
          if (unavailable) expect(elapsed).toBeLessThan(5000);
          else expect(elapsed).toBeGreaterThanOrEqual(4900);
          expect(elapsed).toBeLessThan(6500);
        } finally {
          await page.close();
        }
      }
    }, 20_000);
  },
);
