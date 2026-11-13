import * as http from "node:http";
import type { AddressInfo } from "node:net";

import {
  BOAT_KEY_REQUIRED_PERMISSIONS,
  missingBoatKeyPermissions,
  permissionsTheCommandLacks,
} from "@mend/domain/workbench";
import { BOAT_FAILURE_KINDS } from "@sealant/sdk";
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

/**
 * Core 0.40.0-next.872's `BOAT_REQUIRED_PERMISSIONS`: the values of `BOAT_OPERATION_PERMISSIONS`
 * in `packages/workspaces/src/runtime/boat/api.ts` at sealant 2af5257ecf. Core does not export the
 * list; it reaches Mend only inside each report. On a Core pin, copy it again from that file.
 */
const CORE_REQUIRED_PERMISSIONS = [
  "sandbox.create",
  "sandbox.read",
  "exec",
  "file.write",
  "host",
  "sandbox.stop",
  "sandbox.resume",
  "sandbox.delete",
  "snapshot.write",
  "snapshot.read",
];

/** A report as Core 872 sends it: ISO dates, absent optional facts. */
const wireReport = {
  observedAt: "2026-11-13T14:02:00.000Z",
  organization: "acme-boat",
  identity: { observed: true, accountId: "acct_123", login: "acme-ci", accountStatus: "active" },
  keyKind: { observed: true, kind: "organization" },
  wallet: { observed: true, kind: "organization", organizationName: "acme-boat" },
  requiredPermissions: CORE_REQUIRED_PERMISSIONS,
  permissions: {
    observed: false,
    reason: "refused",
    boat: {
      kind: "refused",
      retryable: false,
      operation: "verify",
      status: 403,
      code: "forbidden",
      requestId: "req_1",
    },
  },
  expiry: { observed: false, reason: "refused" },
  start: {
    observed: true,
    canStart: false,
    blockedReason: "Wallet empty.",
    runningVms: 0,
    allowedVms: 3,
  },
  snapshots: { observed: true, used: 10, included: 10 },
};

describe("Mend's list of Boat permissions", () => {
  it("is the list Core 872 needs, so the page's command never asks for less", () => {
    expect([...BOAT_KEY_REQUIRED_PERMISSIONS].toSorted()).toEqual(
      [...CORE_REQUIRED_PERMISSIONS].toSorted(),
    );
    expect(permissionsTheCommandLacks(CORE_REQUIRED_PERMISSIONS)).toEqual([]);
  });

  it("judges a key by Core's list as well as Mend's", () => {
    expect(missingBoatKeyPermissions([...BOAT_KEY_REQUIRED_PERMISSIONS], ["sandbox.fork"])).toEqual(
      ["sandbox.fork"],
    );
    expect(permissionsTheCommandLacks(["sandbox.fork"])).toEqual(["sandbox.fork"]);
  });

  it("knows Core's failure kinds", () => {
    expect(BOAT_FAILURE_KINDS).toContain("key-expired");
  });
});

describe("Core's Boat accounts, through the SDK", () => {
  it("reads Core's report on a key in Mend's shape: dates, nulls, Boat's reason", async () => {
    next = { status: 200, body: { items: [{ ...wireAccount(), report: wireReport }] } };
    const result = await run((clients) => clients.listBoatAccounts());
    if (result._tag !== "Success") throw new Error("expected the list");
    expect(result.success[0]?.report).toEqual({
      observedAt: new Date("2026-11-13T14:02:00.000Z"),
      organization: "acme-boat",
      identity: {
        observed: true,
        accountId: "acct_123",
        login: "acme-ci",
        displayName: null,
        serviceAccount: null,
        accountStatus: "active",
      },
      keyKind: { observed: true, kind: "organization" },
      wallet: {
        observed: true,
        kind: "organization",
        organizationId: null,
        organizationName: "acme-boat",
        role: null,
      },
      requiredPermissions: CORE_REQUIRED_PERMISSIONS,
      permissions: {
        observed: false,
        reason: "refused",
        boat: {
          kind: "refused",
          retryable: false,
          operation: "verify",
          status: 403,
          code: "forbidden",
          message: null,
          requestId: "req_1",
          permission: null,
          retryAfterSeconds: null,
          retryAt: null,
          billingUrl: null,
        },
      },
      expiry: { observed: false, reason: "refused", boat: null },
      start: {
        observed: true,
        canStart: false,
        blockedReason: "Wallet empty.",
        billingStatus: null,
        runningVms: 0,
        allowedVms: 3,
      },
      snapshots: { observed: true, used: 10, included: 10 },
    });
  });

  it("reads an account from a Core without reports as having none", async () => {
    next = { status: 200, body: { items: [wireAccount()] } };
    const result = await run((clients) => clients.listBoatAccounts());
    expect(result._tag === "Success" ? result.success[0]?.report : "failed").toBeNull();
  });

  it("checks a key again through Core's check, and answers the new report", async () => {
    next = { status: 200, body: { ...wireAccount(), report: wireReport } };
    const result = await run((clients) => clients.checkBoatAccount(ACCOUNT));
    expect(requests).toEqual([
      { method: "POST", path: `/v1/boat-accounts/${ACCOUNT}/check`, body: null },
    ]);
    expect(result._tag === "Success" ? result.success.report?.snapshots : null).toEqual({
      observed: true,
      used: 10,
      included: 10,
    });
  });

  it("keeps Boat's reason on a check Boat did not answer", async () => {
    next = {
      status: 422,
      body: {
        _tag: "BoatAccountKeyRefusedError",
        message:
          "Boat did not answer whether it accepts the key; the last report was kept. Try again.",
        code: "boat-key-unverified",
        boat: {
          kind: "rate-limited",
          retryable: true,
          code: "rate_limited",
          retryAfterSeconds: 30,
        },
      },
    };
    const result = await run((clients) => clients.checkBoatAccount(ACCOUNT));
    expect(result._tag === "Failure" ? result.failure : null).toMatchObject({
      _tag: "BoatAccountRefusal",
      reason: "key-unverified",
      boat: { kind: "rate-limited", retryAfterSeconds: 30, requestId: null },
    });
  });

  it("sends the key to Core once, in the body, and answers the account without it", async () => {
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

  it("reads a key without every permission Core needs as missing-permissions, naming them", async () => {
    const failure = await failureOf({
      status: 422,
      body: {
        _tag: "BoatAccountKeyRefusedError",
        message: "The key lacks Boat permissions Core needs: sandbox.delete; nothing changed.",
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
