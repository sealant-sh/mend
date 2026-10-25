/**
 * Connecting an account through the REAL SDK against a stand-in control plane on loopback: which
 * account each connect asks Core to write.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { Effect, Layer, Option } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ConnectAccountInput } from "./accounts.ts";
import { SealantClients, SealantClientsLive } from "./client.ts";
import { SealantEnv } from "./config.ts";
import { SealantIdentityStore } from "./identity.ts";

interface Posted {
  readonly body: unknown;
}

const posted: Array<Posted> = [];
let accounts: ReadonlyArray<Record<string, unknown>> = [];
let defaultsFeature = true;

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
        features: { processUser: false, connectedAccountDefaults: defaultsFeature },
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
  defaultsFeature = true;
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
