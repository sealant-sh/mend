import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { NodeHttpServer } from "@effect/platform-node";
import { gitKeysGroup } from "@mend/api-contracts";
import { Auth, createAuthHandler } from "@mend/auth";
import {
  ServiceForwardsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  SessionsRepo,
  UserEvents,
  UserGitAccessRepo,
} from "@mend/db";
import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { SealantClient } from "@mend/sealant";
import { AgentBridge, AgentBridgeLive, MendKeys, MendKeysConfig, MendKeysLive } from "@mend/store";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publicNetworkPolicy } from "./public-network-policy.ts";
import { AuthMiddlewareLive } from "./routes/api-live.ts";
import { WebSocketRoutes } from "./routes/websocket.ts";
import { GitKeysGroupLive } from "./routes/workbench.ts";

const network = makePublicNetwork(PublicOrigin.make("http://localhost:3105"), [
  PublicOrigin.make("http://mac-mini.local:3105"),
]);
const SessionResponse = Schema.NullOr(
  Schema.Struct({
    user: Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String }),
    session: Schema.Struct({ expiresAt: Schema.DateFromString }),
  }),
);
const decodeSession = Schema.decodeUnknownSync(SessionResponse);

const startServer = async () => {
  const root = await mkdtemp(join(tmpdir(), "mend-origin-"));
  const authHandler = createAuthHandler({
    network,
    secret: "test-secret-with-at-least-thirty-two-bytes",
  });
  const signedUp = await authHandler(
    new Request(`${network.appUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: network.appUrl },
      body: JSON.stringify({
        name: "Origin test",
        email: "origin@example.invalid",
        password: "disposable-network-password",
      }),
    }),
  );
  expect(signedUp.status).toBe(200);
  const cookie = signedUp.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const token = signedUp.headers.get("set-auth-token");
  if (!cookie || token === null) throw new Error("Better Auth did not issue test credentials");
  const session = decodeSession(
    await (
      await authHandler(
        new Request(`${network.appUrl}/api/auth/get-session`, { headers: { cookie } }),
      )
    ).json(),
  );
  if (session === null) throw new Error("Better Auth did not authenticate its cookie");
  const authLayer = Layer.succeed(Auth, {
    handler: (request) => Effect.promise(() => authHandler(request)),
    getSession: (headers) =>
      Effect.promise(async () => {
        const response = await authHandler(
          new Request(`${network.appUrl}/api/auth/get-session`, { headers }),
        );
        const found = decodeSession(await response.json());
        return found === null
          ? Option.none()
          : Option.some({ user: found.user, expiresAt: found.session.expiresAt });
      }),
  });
  const keysLayer = Layer.mergeAll(MendKeysLive, AgentBridgeLive).pipe(
    Layer.provide(Layer.succeed(MendKeysConfig, { root })),
  );
  // These capabilities must never run in rejected upgrade requests. Unimplemented
  // methods fail loudly; the successful bridge/key paths use real implementations.
  const unused = Layer.mergeAll(
    // Creating a key announces it on the event channel; with no database here the
    // announcement passes silently while every other database access stays a defect.
    Layer.mock(UserEvents, { changed: () => Effect.void }),
    Layer.mock(UserGitAccessRepo, {}),
    Layer.mock(SealantClient, {}),
    Layer.mock(SessionsRepo, {}),
    Layer.mock(SessionProcessesRepo, {}),
    Layer.mock(ServicesRepo, {}),
    Layer.mock(ServiceForwardsRepo, {}),
  );
  const api = HttpApiBuilder.layer(HttpApi.make("mend").add(gitKeysGroup).prefix("/api")).pipe(
    Layer.provide(GitKeysGroupLive),
    Layer.provide(AuthMiddlewareLive),
  );
  const server = createServer();
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(Layer.mergeAll(api, WebSocketRoutes, publicNetworkPolicy(network)), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(
      Layer.provide(unused),
      Layer.provide(authLayer),
      Layer.provideMerge(keysLayer),
      Layer.provide(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" })),
    ),
  );
  await runtime.runPromise(Effect.void);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No HTTP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sockets = new Set<Duplex>();
  const upgrade = (path: string, headers: Record<string, string>): Promise<number> =>
    new Promise((resolve, reject) => {
      const request = httpRequest(`${baseUrl}${path}`, {
        agent: false,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": randomBytes(16).toString("base64"),
          ...headers,
        },
      });
      request.on("upgrade", (response, socket) => {
        sockets.add(socket);
        resolve(response.statusCode ?? 0);
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
  return {
    cookie,
    token,
    baseUrl,
    upgrade,
    key: () => runtime.runPromise(Effect.flatMap(MendKeys, (keys) => keys.read(session.user.id))),
    bridge: () => runtime.runPromise(Effect.flatMap(AgentBridge, (bridge) => bridge.status())),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
};

describe("the API request-origin boundary over real HTTP and WebSocket handshakes", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server?.close();
  });

  it.each([
    "http://evil.invalid",
    "http://mac-mini.local:3106",
    "https://mac-mini.local:3105",
    "null",
    "",
    "http://localhost:3105, http://evil.invalid",
  ])("rejects a no-body cookie mutation from %s without creating a key", async (origin) => {
    const response = await fetch(`${server.baseUrl}/api/keys/git`, {
      method: "POST",
      headers: {
        cookie: server.cookie,
        origin,
        host: "localhost:3105",
        "x-forwarded-host": "localhost:3105",
        "x-forwarded-proto": "http",
      },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Origin not allowed");
    expect(await server.key()).toBeNull();
  });
  it.each(network.allowedOrigins)(
    "creates the real key with a no-body POST from %s",
    async (origin) => {
      const response = await fetch(`${server.baseUrl}/api/keys/git`, {
        method: "POST",
        headers: { cookie: server.cookie, origin },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(await response.json()).toMatchObject({ exists: true });
      expect(await server.key()).not.toBeNull();
    },
  );
  it("rejects cookies without Origin, even alongside a bearer token", async () => {
    const response = await fetch(`${server.baseUrl}/api/keys/git`, {
      method: "POST",
      headers: { cookie: server.cookie, authorization: `Bearer ${server.token}` },
    });
    expect(response.status).toBe(403);
    expect(await server.key()).toBeNull();
  });
  it("preserves a no-Origin bearer mutation but denies an explicit unlisted Origin", async () => {
    const headers = { authorization: `Bearer ${server.token}` };
    const denied = await fetch(`${server.baseUrl}/api/keys/git`, {
      method: "POST",
      headers: { ...headers, origin: "http://evil.invalid" },
    });
    expect(denied.status).toBe(403);
    expect(await server.key()).toBeNull();
    const allowed = await fetch(`${server.baseUrl}/api/keys/git`, { method: "POST", headers });
    expect(allowed.status).toBe(200);
    expect(await server.key()).not.toBeNull();
  });
  it("answers preflight before routing and still allows cookie-authenticated reads without Origin", async () => {
    const preflight = await fetch(`${server.baseUrl}/api/keys/git`, {
      method: "OPTIONS",
      headers: {
        origin: network.appUrl,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(network.appUrl);
    const read = await fetch(`${server.baseUrl}/api/keys/git`, {
      headers: { cookie: server.cookie },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ exists: false });
  });
  it.each(["/api/keys/bridge/ws", "/api/tty", "/api/service-tunnel"])(
    "denies actual upgrade attempts to %s before any data-plane work",
    async (path) => {
      expect(
        await server.upgrade(path, { cookie: server.cookie, origin: "http://evil.invalid" }),
      ).toBe(403);
      expect(await server.upgrade(path, { cookie: server.cookie })).toBe(403);
      expect(
        await server.upgrade(`${path}?token=${encodeURIComponent(server.token)}`, {
          origin: "null",
        }),
      ).toBe(403);
      expect((await server.bridge()).connected).toBe(false);
    },
  );
  it.each(["/api/keys/bridge/ws", "/api/tty", "/api/service-tunnel"])(
    "refuses ordinary GETs to %s before data-plane work",
    async (path) => {
      const response = await fetch(`${server.baseUrl}${path}`, {
        headers: { cookie: server.cookie },
      });
      expect(response.status).toBe(426);
      expect((await server.bridge()).connected).toBe(false);
    },
  );
  it.each(network.allowedOrigins)(
    "upgrades the real cookie-authenticated keys bridge from %s",
    async (origin) => {
      expect(
        await server.upgrade("/api/keys/bridge/ws?host=browser", { cookie: server.cookie, origin }),
      ).toBe(101);
      await expect.poll(async () => (await server.bridge()).clientName).toBe("browser");
    },
  );
  it("upgrades the real no-Origin query-token keys bridge and still rejects missing credentials", async () => {
    expect(await server.upgrade("/api/keys/bridge/ws", {})).toBe(401);
    expect(
      await server.upgrade(
        `/api/keys/bridge/ws?host=native&token=${encodeURIComponent(server.token)}`,
        {},
      ),
    ).toBe(101);
    await expect.poll(async () => (await server.bridge()).clientName).toBe("native");
  });
});
