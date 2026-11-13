import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { Effect, Layer, Option, Redacted } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SealantClients, SealantClientsLive } from "./client.ts";
import { SealantEnv } from "./config.ts";
import { SealantIdentityStore } from "./identity.ts";

const KEY = "boat_live_0123456789abcdefghij";
const ACCOUNT = "0b0a7c1e-4f3d-4a51-9d2e-1c8f6b7a9e30";

const wireAccount = (state: "active" | "removing" = "active") => ({
  boatAccountId: ACCOUNT,
  label: "Mend organization Acme",
  state,
  createdAt: "2026-11-13T10:00:00.000Z",
  keyRotatedAt: null,
});

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const requests: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> =
  [];
let next: Answer = { status: 201, body: wireAccount() };

let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://loopback");
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "GET",
        path: url.pathname,
        body: text.length === 0 ? null : JSON.parse(text),
      });
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
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
  requests.length = 0;
});

const run = <A, E>(use: (clients: SealantClients["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* SealantClients);
    }).pipe(
      Effect.result,
      Effect.provide(
        SealantClientsLive.pipe(
          Layer.provide(Layer.succeed(SealantEnv, { baseUrl, serviceKey: Option.none() })),
          Layer.provide(
            Layer.succeed(SealantIdentityStore, {
              user: () => Effect.succeed(null),
              sealantUserId: () => Effect.succeed(null),
              record: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );

const failureOf = async (answer: Answer) => {
  next = answer;
  const result = await run((clients) => clients.rotateBoatAccountKey(ACCOUNT, Redacted.make(KEY)));
  if (result._tag !== "Failure") throw new Error("expected a refusal");
  return result.failure;
};

describe("sealant's Boat accounts, through the SDK", () => {
  it("sends the key to sealant once, in the body, and answers the account without it", async () => {
    next = { status: 201, body: wireAccount() };
    const result = await run((clients) =>
      clients.createBoatAccount("Mend organization Acme", Redacted.make(KEY)),
    );
    expect(result._tag).toBe("Success");
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/boat-accounts",
        body: { label: "Mend organization Acme", apiKey: KEY },
      },
    ]);
    if (result._tag === "Success") {
      expect(result.success).toEqual({
        boatAccountId: ACCOUNT,
        label: "Mend organization Acme",
        state: "active",
        createdAt: new Date("2026-11-13T10:00:00.000Z"),
        keyRotatedAt: null,
        report: null,
      });
      expect(JSON.stringify(result.success)).not.toContain(KEY);
    }
  });

  it("reads a key that cannot see the account's VMs as a refusal with the count", async () => {
    const failure = await failureOf({
      status: 409,
      body: {
        _tag: "BoatAccountConflictError",
        message: "The new key cannot see 3 of the account's VMs or saved images.",
        code: "boat-key-cannot-see",
        unseen: 3,
      },
    });
    expect(failure).toMatchObject({
      _tag: "BoatAccountRefusal",
      reason: "cannot-see",
      unseen: 3,
      liveRuns: null,
      buildsInFlight: null,
    });
  });

  it("reads an account in use with both counts", async () => {
    next = {
      status: 409,
      body: {
        _tag: "BoatAccountConflictError",
        message: "The account has 2 runs and 1 image build.",
        code: "boat-account-in-use",
        liveRuns: 2,
        buildsInFlight: 1,
      },
    };
    const result = await run((clients) => clients.removeBoatAccount(ACCOUNT));
    expect(result._tag === "Failure" ? result.failure : null).toMatchObject({
      reason: "in-use",
      liveRuns: 2,
      buildsInFlight: 1,
    });
  });

  for (const [code, reason] of [
    ["boat-key-refused", "key-refused"],
    ["boat-key-unverified", "key-unverified"],
  ] as const) {
    it(`reads ${code} as ${reason}`, async () => {
      const failure = await failureOf({
        status: 422,
        body: { _tag: "BoatAccountKeyRefusedError", message: "Boat refused the key.", code },
      });
      expect(failure).toMatchObject({ _tag: "BoatAccountRefusal", reason });
    });
  }

  it("reads a key without every permission sealant needs as missing-permissions, naming them", async () => {
    const failure = await failureOf({
      status: 422,
      body: {
        _tag: "BoatAccountKeyRefusedError",
        message: "The key lacks Boat permissions sealant needs: sandbox.delete; nothing changed.",
        code: "boat-key-missing-permissions",
        missingPermissions: ["sandbox.delete"],
      },
    });
    expect(failure).toMatchObject({
      _tag: "BoatAccountRefusal",
      reason: "missing-permissions",
      missingPermissions: ["sandbox.delete"],
    });
  });

  it("reads a server without Boat as unavailable", async () => {
    const failure = await failureOf({
      status: 503,
      body: {
        _tag: "BoatAccountServiceUnavailableError",
        message: "This install serves no Boat.",
      },
    });
    expect(failure).toMatchObject({ _tag: "BoatAccountRefusal", reason: "unavailable" });
  });

  it("keeps any other failure as the platform's", async () => {
    const failure = await failureOf({
      status: 500,
      body: { _tag: "BoatAccountInternalServerError", message: "boom" },
    });
    expect(failure).toMatchObject({ _tag: "SealantPlatformError" });
  });
});
