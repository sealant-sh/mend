import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { EndpointUrl } from "@mend/domain/endpoint-url";
import { Effect, Layer, Option, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ConnectAccountInput } from "./accounts.ts";
import { SealantClients, SealantClientsLive } from "./client.ts";
import { SealantEnv } from "./config.ts";
import { SealantIdentityStore } from "./identity.ts";

interface Posted {
  readonly body: unknown;
}

const posted: Array<Posted> = [];
const chosen: Array<{ readonly provider: string; readonly body: unknown }> = [];
let accounts: ReadonlyArray<Record<string, unknown>> = [];
let defaultsFeature = true;
let keysFeature = false;
let endpointsFeature = false;

const wireAccount = (name: string, isDefault: boolean | undefined) => ({
  connectedAccountId: `cacc_${name}`,
  ownerUserId: "su-maria",
  provider: "claude",
  name,
  kind: "oauth-token",
  status: "active",
  metadata: {},
  connectedAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  lastUsedAt: null,
  lastSyncedAt: null,
  credential: {
    accessExpiresAt: null,
    refreshExpiresAt: null,
    lastRefreshAt: null,
    lastRefreshOutcome: null,
  },
  ...(isDefault === undefined ? {} : { isDefault }),
});

const answer = (method: string, path: string, body: unknown) => {
  if (method === "GET" && path === "/") {
    return {
      status: 200,
      body: {
        name: "sealant",
        version: "0.40.0",
        docsPath: "/docs",
        openApiPath: "/openapi.json",
        features: {
          processUser: false,
          connectedAccountDefaults: defaultsFeature,
          connectedAccountLoginClass: keysFeature,
          connectedAccountApiKeys: keysFeature,
          connectedAccountEndpoints: endpointsFeature,
        },
      },
    };
  }
  if (method === "GET" && path === "/v1/connected-accounts") {
    return { status: 200, body: { items: accounts } };
  }
  if (method === "POST" && path === "/v1/connected-accounts") {
    posted.push({ body });
    return { status: 201, body: accounts[0] ?? wireAccount("default", true) };
  }
  const archive = /^\/v1\/connected-accounts\/([^/]+)$/.exec(path);
  if (method === "DELETE" && archive !== null) {
    const removed = accounts.find((account) => account["connectedAccountId"] === archive[1]);
    return { status: 200, body: { ...removed, status: "archived", isDefault: false } };
  }
  const defaults = /^\/v1\/connected-accounts\/defaults\/([^/]+)$/.exec(path);
  if (method === "PUT" && defaults !== null) {
    chosen.push({ provider: defaults[1] ?? "", body });
    return { status: 200, body: accounts[0] };
  }
  return { status: 404, body: { _tag: "NotFound", message: `${method} ${path}` } };
};

let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://loopback");
      const text = Buffer.concat(chunks).toString("utf8");
      const answered = answer(
        req.method ?? "GET",
        url.pathname,
        text.length === 0 ? null : JSON.parse(text),
      );
      res.writeHead(answered.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answered.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  posted.length = 0;
  chosen.length = 0;
  defaultsFeature = true;
  keysFeature = false;
  endpointsFeature = false;
});

const connect = (input: Omit<ConnectAccountInput, "secret">) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clients = yield* SealantClients;
      return yield* clients
        .connectedAccounts("maria")
        .connect({ ...input, secret: "sk-ant-oat01-fake" });
    }).pipe(
      Effect.provide(
        SealantClientsLive.pipe(
          Layer.provide(Layer.succeed(SealantEnv, { baseUrl, serviceKey: Option.none() })),
          Layer.provide(
            Layer.succeed(SealantIdentityStore, {
              user: (userId) =>
                Effect.succeed({ id: userId, email: `${userId}@mend.test`, name: userId }),
              sealantUserId: (userId) => Effect.succeed(`su-${userId}`),
              record: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );

const target = () => {
  const body = posted.at(-1)?.body;
  if (typeof body !== "object" || body === null) return null;
  return {
    name: "name" in body ? body.name : undefined,
    accountId: "accountId" in body ? body.accountId : undefined,
    makeDefault: "makeDefault" in body ? body.makeDefault : undefined,
  };
};

const sentField = (field: string): unknown => {
  const body = posted.at(-1)?.body;
  return typeof body === "object" && body !== null && field in body
    ? Object.entries(body).find(([key]) => key === field)?.[1]
    : undefined;
};

const sentLogin = () => {
  const body = posted.at(-1)?.body;
  return typeof body === "object" && body !== null && "login" in body ? body.login : undefined;
};

describe("connecting an account, as Core is asked to write it", () => {
  it("reconnects the chosen login by the default selector when it is named work", async () => {
    accounts = [wireAccount("default", false), wireAccount("work", true)];
    await connect({ provider: "claude" });
    expect(target()).toEqual({ name: "default", accountId: undefined, makeDefault: undefined });
  });

  it("replaces a row's own account by its id", async () => {
    accounts = [wireAccount("default", false), wireAccount("work", true)];
    await connect({ provider: "claude", accountId: "cacc_work" });
    expect(target()).toEqual({ name: undefined, accountId: "cacc_work", makeDefault: undefined });
  });

  it("chooses an only account nobody chose", async () => {
    accounts = [wireAccount("work", false)];
    await connect({ provider: "claude" });
    expect(target()).toEqual({ name: undefined, accountId: "cacc_work", makeDefault: true });
  });

  it("sends nothing when several are held and none is chosen, and says what to do", async () => {
    accounts = [wireAccount("work", false), wireAccount("home", false)];
    await expect(connect({ provider: "claude" })).rejects.toMatchObject({
      code: "connected-account-ambiguous",
      status: 409,
      message:
        "No Claude login chosen: Mend holds 2 of yours, and sessions use only the chosen one. Remove the others with mend connect claude --remove <name>, or Disconnect them in Settings → Connected accounts, then connect the one left again to choose it.",
    });
    expect(posted).toEqual([]);
  });

  it("sends no target for a first connect", async () => {
    accounts = [];
    await connect({ provider: "claude" });
    expect(target()).toEqual({ name: undefined, accountId: undefined, makeDefault: undefined });
  });

  it("targets by name on a Core that cannot choose a default", async () => {
    defaultsFeature = false;
    accounts = [wireAccount("default", undefined), wireAccount("backup", undefined)];
    await connect({ provider: "claude", accountId: "cacc_default" });
    expect(target()).toEqual({ name: "default", accountId: undefined, makeDefault: undefined });
    await connect({ provider: "claude" });
    expect(target()).toEqual({ name: undefined, accountId: undefined, makeDefault: undefined });
  });
});

describe("connecting an API key", () => {
  it("sends the class and the default choice, names no account, and keeps the class Core answers", async () => {
    keysFeature = true;
    accounts = [{ ...wireAccount("api-key", true), login: { kind: "api-key", suffix: "a1b2" } }];
    const saved = await connect({ provider: "claude", login: "api-key", makeDefault: true });
    expect(saved.login).toEqual({ kind: "api-key", suffix: "a1b2" });
    expect(sentLogin()).toBe("api-key");
    expect(target()).toEqual({ name: undefined, accountId: undefined, makeDefault: true });
  });

  it("reconnects a subscription beside a key without naming the chosen default", async () => {
    keysFeature = true;
    accounts = [wireAccount("default", false), wireAccount("api-key", true)];
    await connect({ provider: "claude", login: "subscription" });
    expect(sentLogin()).toBe("subscription");
    expect(target()).toEqual({ name: undefined, accountId: undefined, makeDefault: undefined });
  });

  it("sends nothing to a Core that cannot run sessions on a key, and says so", async () => {
    accounts = [];
    await expect(connect({ provider: "codex", login: "api-key" })).rejects.toMatchObject({
      code: "connected-account-api-keys-unsupported",
      status: 400,
      message: expect.stringContaining("does not run sessions on an API key yet"),
    });
    expect(posted).toEqual([]);
  });

  it("leaves the class off for a Core that predates it, as connects were before", async () => {
    accounts = [];
    await connect({ provider: "claude", login: "subscription" });
    expect(sentLogin()).toBeUndefined();
  });
});

const disconnect = (id: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clients = yield* SealantClients;
      return yield* clients.connectedAccounts("maria").disconnect(id);
    }).pipe(
      Effect.provide(
        SealantClientsLive.pipe(
          Layer.provide(Layer.succeed(SealantEnv, { baseUrl, serviceKey: Option.none() })),
          Layer.provide(
            Layer.succeed(SealantIdentityStore, {
              user: (userId) =>
                Effect.succeed({ id: userId, email: `${userId}@mend.test`, name: userId }),
              sealantUserId: (userId) => Effect.succeed(`su-${userId}`),
              record: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );

describe("disconnecting the chosen login", () => {
  it("chooses the one login of that provider left", async () => {
    accounts = [wireAccount("api-key", true), wireAccount("default", false)];
    await disconnect("cacc_api-key");
    expect(chosen).toEqual([
      {
        provider: "claude",
        body: { ownerUserId: "su-maria", connectedAccountId: "cacc_default" },
      },
    ]);
  });

  it("chooses none when several are left, so the person picks", async () => {
    accounts = [
      wireAccount("api-key", true),
      wireAccount("work", false),
      wireAccount("home", false),
    ];
    await disconnect("cacc_api-key");
    expect(chosen).toEqual([]);
  });

  it("chooses none when the login removed was not the chosen one", async () => {
    accounts = [wireAccount("api-key", false), wireAccount("default", true)];
    await disconnect("cacc_api-key");
    expect(chosen).toEqual([]);
  });

  it("chooses none when the one left was refused, or on a Core that cannot choose", async () => {
    accounts = [
      wireAccount("api-key", true),
      { ...wireAccount("default", false), status: "invalid" },
    ];
    await disconnect("cacc_api-key");
    defaultsFeature = false;
    accounts = [wireAccount("api-key", true), wireAccount("default", false)];
    await disconnect("cacc_api-key");
    expect(chosen).toEqual([]);
  });
});

describe("connecting a key to an endpoint", () => {
  const endpoint = Schema.decodeSync(EndpointUrl)("http://gateway.internal:8080/v1");

  it("sends the endpoint with the key and keeps the host Core answers on the login", async () => {
    keysFeature = true;
    endpointsFeature = true;
    accounts = [
      {
        ...wireAccount("api-key", true),
        login: { kind: "api-key", suffix: "ceho", endpointHost: "gateway.internal:8080" },
      },
    ];
    const saved = await connect({ provider: "claude", login: "api-key", endpoint });
    expect(sentField("endpoint")).toBe("http://gateway.internal:8080/v1");
    expect(sentLogin()).toBe("api-key");
    expect(saved.login).toEqual({
      kind: "api-key",
      suffix: "ceho",
      endpointHost: "gateway.internal:8080",
    });
  });

  it("sends nothing to a Core that cannot keep an endpoint, and says so", async () => {
    keysFeature = true;
    accounts = [];
    await expect(connect({ provider: "codex", login: "api-key", endpoint })).rejects.toMatchObject({
      code: "connected-account-endpoints-unsupported",
      status: 400,
      message: expect.stringContaining("cannot send a key's requests to an endpoint yet"),
    });
    expect(posted).toEqual([]);
  });

  it("sends no endpoint for a key without one, so a reconnect removes it", async () => {
    keysFeature = true;
    endpointsFeature = true;
    accounts = [];
    await connect({ provider: "claude", login: "api-key" });
    expect(sentField("endpoint")).toBeUndefined();
  });
});
