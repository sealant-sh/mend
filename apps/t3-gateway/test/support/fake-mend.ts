import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * A stand-in for Mend's API, speaking the routes the gateway calls in phase 0 with Mend's shapes:
 * `POST /api/pair` (`pairGroup.claim` in @mend/api-contracts), `GET /api/me/devices`
 * (`userDevicesGroup.list`) and `GET /api/harnesses/models` (`harnessModelsGroup.list`).
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
  }>;
  /** Every `authorization` header `GET /api/me/devices` saw. */
  readonly deviceChecks: ReadonlyArray<string | undefined>;
  /** Every `authorization` header `GET /api/harnesses/models` saw. */
  readonly modelReads: ReadonlyArray<string | undefined>;
  /** Make `GET /api/harnesses/models` answer 503 until set back. */
  readonly setModelsDown: (down: boolean) => void;
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

export const startFakeMend: Effect.Effect<FakeMend, never, Scope.Scope> = Effect.gen(function* () {
  const codes = new Map<string, { readonly user: FakeMendUser; spent: boolean }>();
  const tokens = new Map<string, { revoked: boolean }>();
  const claims: Array<FakeMend["claims"][number]> = [];
  const deviceChecks: Array<string | undefined> = [];
  const modelReads: Array<string | undefined> = [];
  let modelsDown = false;
  let devices = 0;

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
        const code = normalise(String(payload["code"]));
        const entry = codes.get(code);
        if (entry === undefined) return json(404, { _tag: "PairingCodeNotFound" });
        if (entry.spent) return json(410, { _tag: "PairingCodeSpent" });
        entry.spent = true;
        const token = `mdt_${randomBytes(16).toString("base64url")}`;
        tokens.set(token, { revoked: false });
        devices += 1;
        const name = String(payload["name"]);
        claims.push({ code, name, platform: String(payload["platform"]), token });
        return json(200, {
          token,
          url: { url: "http://127.0.0.1:3101", kind: "loopback" },
          user: entry.user,
          device: { id: `device-${devices}`, name },
        });
      }
      if (request.method === "GET" && request.url === "/api/me/devices") {
        const authorization = request.headers.authorization;
        deviceChecks.push(authorization);
        if (!accepted(authorization)) return json(401, { _tag: "Unauthorized" });
        return json(200, []);
      }
      if (request.method === "GET" && request.url === "/api/harnesses/models") {
        const authorization = request.headers.authorization;
        modelReads.push(authorization);
        if (!accepted(authorization)) return json(401, { _tag: "Unauthorized" });
        if (modelsDown) return json(503, { _tag: "ServiceUnavailable" });
        return json(200, MEND_MODEL_CATALOG);
      }
      return json(404, { _tag: "RouteNotFound" });
    })();
  });

  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
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
    deviceChecks,
    modelReads,
    setModelsDown: (down) => {
      modelsDown = down;
    },
  };
});
