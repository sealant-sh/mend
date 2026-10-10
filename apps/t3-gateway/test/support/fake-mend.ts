import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { FakeTty } from "./fake-tty.ts";
import { FakeWorkbench } from "./fake-workbench.ts";

/**
 * A stand-in for Mend's API, speaking the routes the gateway calls with Mend's shapes:
 * `POST /api/pair` (`pairGroup.claim` in @mend/api-contracts), `GET /api/me/devices`
 * (`userDevicesGroup.list`), `GET /api/harnesses/models` (`harnessModelsGroup.list`), and the
 * workbench routes and event stream of `workbench` (`fake-workbench.ts`).
 */
export interface FakeMend {
  readonly url: URL;
  /** Mint a pairing code for a person, as `POST /api/me/devices/pairings` would. */
  readonly addPairingCode: (code: string, user: FakeMendUser) => void;
  /** Revoke a device token, as `DELETE /api/me/devices/:id` would. */
  readonly revoke: (token: string) => void;
  readonly claims: ReadonlyArray<{
    readonly code: string;
    readonly name: string;
    readonly platform: string;
    readonly token: string;
    readonly deviceId: string;
  }>;
  /** Every `x-forwarded-for` header `POST /api/pair` saw, claimed or not. */
  readonly pairForwardedFor: ReadonlyArray<string | undefined>;
  /** Make `POST /api/pair` answer 429, as Mend's claim limiter does, until set back. */
  readonly setPairingRateLimited: (limited: boolean) => void;
  /** Every `authorization` header `GET /api/me/devices` saw. */
  readonly deviceChecks: ReadonlyArray<string | undefined>;
  /** Every `authorization` header `GET /api/harnesses/models` saw. */
  readonly modelReads: ReadonlyArray<string | undefined>;
  /** Make `GET /api/harnesses/models` answer 503 until set back. */
  readonly setModelsDown: (down: boolean) => void;
  /**
   * The connected accounts `GET /api/me/sealant` answers for everyone (Claude and Codex, active,
   * unless set), or null to answer 503 as Mend does when the platform is unreachable. `delayMs`
   * holds the answer back.
   */
  readonly setAccounts: (accounts: ReadonlyArray<FakeAccount> | null, delayMs?: number) => void;
  /** Projects, sessions and their conversations, and the SSE stream that reports them. */
  readonly workbench: FakeWorkbench;
  /** Shells, `tty` tickets and the `/api/tty` socket. */
  readonly tty: FakeTty;
}

/**
 * Mend's catalog as `GET /api/harnesses/models` answers it (the shape of `HarnessModelCatalog`,
 * values from apps/api/src/routes/harness-models.test.ts), plus a harness the gateway leaves out.
 */
export const MEND_MODEL_CATALOG = [
  {
    harness: "claude",
    models: [
      { id: "fable", label: "Fable", isDefault: true, efforts: null },
      { id: "opus", label: "Opus", isDefault: false, efforts: ["low", "medium", "high"] },
    ],
    defaultModel: "fable",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    fastCapable: false,
  },
  {
    harness: "codex",
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", isDefault: true, efforts: null },
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        isDefault: false,
        efforts: ["low", "medium", "high", "xhigh"],
      },
    ],
    defaultModel: "gpt-6.1-sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    fastCapable: true,
  },
  {
    harness: "opencode",
    models: [],
    defaultModel: null,
    efforts: ["low", "medium", "high"],
    fastCapable: false,
  },
] as const;

export interface FakeMendUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const normalise = (code: string) => code.toUpperCase().replaceAll(/[^0-9A-Z]/g, "");

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};

/** A connected account as `GET /api/me/sealant` answers it; named `default` unless said. */
export interface FakeAccount {
  readonly provider: string;
  readonly status: string;
  readonly name?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export const startFakeMend: Effect.Effect<FakeMend, never, Scope.Scope> = Effect.gen(function* () {
  const codes = new Map<string, { readonly user: FakeMendUser; spent: boolean }>();
  const tokens = new Map<string, { revoked: boolean; readonly userId: string }>();
  const claims: Array<FakeMend["claims"][number]> = [];
  const deviceChecks: Array<string | undefined> = [];
  const modelReads: Array<string | undefined> = [];
  const pairForwardedFor: Array<string | undefined> = [];
  let modelsDown = false;
  let accounts: ReadonlyArray<FakeAccount> | null = [
    { provider: "claude", status: "active" },
    { provider: "codex", status: "active" },
  ];
  let accountsDelayMs = 0;
  let pairingRateLimited = false;
  let devices = 0;
  const workbench = new FakeWorkbench();
  workbench.accountOf = (authorization) => {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    return token === undefined ? null : (tokens.get(token)?.userId ?? null);
  };

  const tty = new FakeTty(workbench);

  const accepted = (authorization: string | undefined) => {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const entry = token === undefined ? undefined : tokens.get(token);
    return entry !== undefined && !entry.revoked;
  };

  const server: Server = createServer((request, response) => {
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    void (async () => {
      if (request.method === "POST" && request.url === "/api/pair") {
        const payload = asRecord(JSON.parse(await readBody(request)));
        const forwarded = request.headers["x-forwarded-for"];
        pairForwardedFor.push(Array.isArray(forwarded) ? forwarded.join(", ") : forwarded);
        if (pairingRateLimited) {
          return json(429, { _tag: "PairingRateLimited", retryAfterSeconds: 42 });
        }
        const code = normalise(String(payload["code"]));
        const entry = codes.get(code);
        if (entry === undefined) return json(404, { _tag: "PairingCodeNotFound" });
        if (entry.spent) return json(410, { _tag: "PairingCodeSpent" });
        entry.spent = true;
        const token = `mdt_${randomBytes(16).toString("base64url")}`;
        tokens.set(token, { revoked: false, userId: entry.user.id });
        devices += 1;
        const name = String(payload["name"]);
        const deviceId = `device-${devices}`;
        claims.push({ code, name, platform: String(payload["platform"]), token, deviceId });
        return json(200, {
          token,
          url: { url: "http://127.0.0.1:3101", kind: "loopback" },
          user: entry.user,
          device: { id: deviceId, name },
        });
      }
      if (request.method === "GET" && request.url === "/api/me/devices") {
        const authorization = request.headers.authorization;
        deviceChecks.push(authorization);
        if (!accepted(authorization)) return json(401, { _tag: "Unauthorized" });
        return json(200, []);
      }
      if (request.method === "GET" && request.url === "/api/me/sealant") {
        if (!accepted(request.headers.authorization)) return json(401, { _tag: "Unauthorized" });
        if (accountsDelayMs > 0) await new Promise((done) => setTimeout(done, accountsDelayMs));
        if (accounts === null) return json(503, { _tag: "SealantUnavailable" });
        return json(200, {
          sealantUserId: "usr_fake",
          accounts: accounts.map((account, index) => ({
            id: `account-${index}`,
            provider: account.provider,
            name: account.name ?? "default",
            kind: "oauth-token",
            status: account.status,
            metadata: account.metadata ?? {},
            connectedAt: "2026-10-04T12:00:00.000Z",
            updatedAt: "2026-10-04T12:00:00.000Z",
            lastUsedAt: null,
          })),
        });
      }
      if (request.method === "GET" && request.url === "/api/harnesses/models") {
        const authorization = request.headers.authorization;
        modelReads.push(authorization);
        if (!accepted(authorization)) return json(401, { _tag: "Unauthorized" });
        if (modelsDown) return json(503, { _tag: "ServiceUnavailable" });
        return json(200, MEND_MODEL_CATALOG);
      }
      const terminal = await tty.route(
        request,
        response,
        async () => {
          const text = await readBody(request);
          return text === "" ? undefined : JSON.parse(text);
        },
        accepted(request.headers.authorization),
      );
      if (terminal) return;
      const routed = await workbench.route(
        request,
        response,
        async () => {
          const text = await readBody(request);
          return text === "" ? undefined : JSON.parse(text);
        },
        accepted(request.headers.authorization),
      );
      if (routed) return;
      return json(404, { _tag: "RouteNotFound" });
    })();
  });

  server.on("upgrade", tty.upgrade);
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        workbench.dropStreams();
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: new URL(`http://127.0.0.1:${port}`),
    addPairingCode: (code, user) => {
      codes.set(normalise(code), { user, spent: false });
    },
    revoke: (token) => {
      const entry = tokens.get(token);
      if (entry !== undefined) entry.revoked = true;
    },
    claims,
    pairForwardedFor,
    setPairingRateLimited: (limited) => {
      pairingRateLimited = limited;
    },
    deviceChecks,
    modelReads,
    setModelsDown: (down) => {
      modelsDown = down;
    },
    setAccounts: (next, delayMs = 0) => {
      accounts = next;
      accountsDelayMs = delayMs;
    },
    workbench,
    tty,
  };
});
