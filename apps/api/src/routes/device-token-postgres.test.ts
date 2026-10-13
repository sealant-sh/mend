import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  CliAuthApproved,
  CliAuthRequestView,
  CliAuthStartView,
  DeviceView,
  MintedDevice,
  PairClaimResult,
  PairingView,
  cliAuthGroup,
  pairGroup,
  userDevicesGroup,
} from "@mend/api-contracts";
import { Auth, AuthLive, RegistrationPolicy } from "@mend/auth";
import { DevicesRepo, DevicesRepoLive, MendDBLive, migrations } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import {
  ConfigProvider,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
  String as Str,
} from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthMiddlewareLive } from "./api-live.ts";
import { DevicePairingLive } from "./devices.ts";

const postgres = postgresTestConfig();
const database = `mend_device_token_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(postgres.adminUrl);
databaseUrl.pathname = `/${database}`;
const origin = "http://localhost:3105";
const network = makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)(origin), []);
const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    DATABASE_URL: databaseUrl.toString(),
    BETTER_AUTH_SECRET: "disposable-device-token-test-secret-32-bytes",
    MEND_STATIC_TOKEN: "",
  }),
);
const databaseLayer = MendDBLive.pipe(
  Layer.provideMerge(
    PgClient.layer({
      url: Redacted.make(databaseUrl.toString()),
      transformResultNames: Str.snakeToCamel,
      maxConnections: 2,
    }),
  ),
);
const runtime = ManagedRuntime.make(
  Layer.mergeAll(AuthLive, DevicesRepoLive).pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(Layer.succeed(NetworkConfig, network)),
    Layer.provide(
      Layer.succeed(RegistrationPolicy, {
        decide: () => Effect.succeed({ kind: "bootstrap" }),
        registered: () => Effect.void,
      }),
    ),
    Layer.provide(config),
  ),
);
const admin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );
const api = HttpApiBuilder.layer(
  HttpApi.make("mend").add(userDevicesGroup).add(pairGroup).add(cliAuthGroup).prefix("/api"),
).pipe(
  Layer.provide(DevicePairingLive),
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(HttpServer.layerServices),
  Layer.provide(config),
);
let databaseCreated = false;

const makePairingApi = async () => {
  const context = await runtime.runPromise(Effect.context<Auth | DevicesRepo | NetworkConfig>());
  const { handler, dispose } = HttpRouter.toWebHandler(
    api.pipe(Layer.provide(Layer.succeedContext(context))),
    { disableLogger: true },
  );
  const request = (token: string | null, method: string, path: string, body?: unknown) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    return handler(
      new Request(`${origin}/api${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      context,
    );
  };
  const signup = async (email: string) => {
    const response = await runtime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth;
        return yield* auth.handler(
          new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({
              email,
              name: "Lifecycle owner",
              password: "disposable-device-lifecycle-password",
            }),
          }),
        );
      }),
    );
    expect(response.status).toBe(200);
    const account = Schema.decodeUnknownSync(
      Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
    )(await response.json());
    const token = response.headers.get("set-auth-token");
    if (token === null) throw new Error("signup did not issue a browser bearer");
    return { userId: account.user.id, token };
  };
  return { request, signup, dispose };
};

const withPairingApi = async <A>(
  body: (fixture: Awaited<ReturnType<typeof makePairingApi>>) => Promise<A>,
) => {
  const fixture = await makePairingApi();
  try {
    return await body(fixture);
  } finally {
    await fixture.dispose();
  }
};

const refusal = async (response: Response, status: number, tag: string) => {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ _tag: tag });
};

const cliRows = (userCode: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`
        SELECT device_code_hash, approved_by, denied_at, collected_at
        FROM cli_auth_requests WHERE user_code = ${userCode}`;
    }),
  );

const devicesOf = (userId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`
        SELECT id, name, platform, token_hash, revoked_at
        FROM device_tokens WHERE user_id = ${userId} ORDER BY name`;
    }),
  );

describe.skipIf(postgres.skip)("API-minted device tokens through real Auth and PostgreSQL", () => {
  beforeAll(async () => {
    await admin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${database}`);
      }),
    );
    databaseCreated = true;
    await runtime.runPromise(
      Effect.forEach(
        Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
        ([, migration]) => migration,
      ),
    );
  });

  afterAll(async () => {
    try {
      await runtime.dispose();
    } finally {
      if (databaseCreated)
        await admin(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // Auth's pg pool can report disposal just before its idle sockets disconnect.
            const deadline = performance.now() + 5_000;
            for (;;) {
              const rows = yield* sql`SELECT pid FROM pg_stat_activity WHERE datname = ${database}`;
              if (rows.length === 0) break;
              if (performance.now() >= deadline)
                return yield* Effect.die("device token fixture connections did not close");
              yield* Effect.sleep("10 millis");
            }
            yield* sql.unsafe(`DROP DATABASE ${database}`);
          }),
        );
    }
  });

  it.each(["manual", "pairing"] as const)(
    "authenticates two %s tokens independently and revokes only the selected device",
    async (mode) => {
      const context = await runtime.runPromise(
        Effect.context<Auth | DevicesRepo | NetworkConfig>(),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(
        api.pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      );
      try {
        const signup = await runtime.runPromise(
          Effect.gen(function* () {
            const auth = yield* Auth;
            return yield* auth.handler(
              new Request(`${origin}/api/auth/sign-up/email`, {
                method: "POST",
                headers: { origin, "content-type": "application/json" },
                body: JSON.stringify({
                  email: `${mode}@example.invalid`,
                  name: "Device owner",
                  password: "disposable-token-parity-password",
                }),
              }),
            );
          }),
        );
        expect(signup.status).toBe(200);
        const account = Schema.decodeUnknownSync(
          Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
        )(await signup.json());
        const browserToken = signup.headers.get("set-auth-token");
        if (browserToken === null) throw new Error("signup did not issue a browser bearer");
        const send = (token: string, method = "GET", path = "/me/devices", body?: unknown) =>
          handler(
            new Request(`${origin}/api${path}`, {
              method,
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            context,
          );
        const minted: Array<{ readonly token: string; readonly deviceId: string }> = [];
        for (const name of ["Phone", "Laptop"]) {
          if (mode === "manual") {
            const response = await send(browserToken, "POST", "/me/devices", {
              name,
              platform: "other",
            });
            expect(response.status).toBe(200);
            const device = Schema.decodeUnknownSync(MintedDevice)(await response.json());
            minted.push({ token: device.token, deviceId: device.device.id });
          } else {
            const opened = await send(browserToken, "POST", "/me/devices/pairings");
            expect(opened.status).toBe(200);
            const pairing = Schema.decodeUnknownSync(PairingView)(await opened.json());
            // The pairing code alone authorizes this public request; no browser credential follows it.
            const claimed = await handler(
              new Request(`${origin}/api/pair`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code: pairing.code, name, platform: "android" }),
              }),
            );
            expect(claimed.status).toBe(200);
            const device = Schema.decodeUnknownSync(PairClaimResult)(await claimed.json());
            expect(device.user.id).toBe(account.user.id);
            minted.push({ token: device.token, deviceId: device.device.id });
          }
        }
        const [phone, laptop] = minted;
        if (phone === undefined || laptop === undefined)
          throw new Error("two devices were not minted");
        expect(phone.token).not.toBe(laptop.token);
        for (const device of minted) {
          const session = await runtime.runPromise(
            Effect.gen(function* () {
              const auth = yield* Auth;
              return yield* auth.getSession(
                new Headers({ authorization: `Bearer ${device.token}` }),
              );
            }),
          );
          expect(Option.isSome(session)).toBe(true);
          if (Option.isNone(session)) throw new Error("API token did not authenticate");
          expect(session.value.user.id).toBe(account.user.id);
          expect(session.value.credential).toBe(`device:${device.deviceId}`);
          const rows = await runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql`SELECT user_id, token_hash FROM device_tokens WHERE id = ${device.deviceId}`;
            }),
          );
          expect(rows).toEqual([
            {
              userId: account.user.id,
              tokenHash: createHash("sha256").update(device.token).digest("hex"),
            },
          ]);
          const listed = await send(device.token);
          expect(listed.status).toBe(200);
          const devices = Schema.decodeUnknownSync(Schema.Array(DeviceView))(await listed.json());
          expect(devices.map((entry) => entry.id).toSorted()).toEqual(
            minted.map((entry) => entry.deviceId).toSorted(),
          );
        }
        expect((await send(`${phone.token}changed`)).status).toBe(401);
        expect((await send(browserToken, "DELETE", `/me/devices/${phone.deviceId}`)).status).toBe(
          200,
        );
        expect((await send(phone.token)).status).toBe(401);
        const remaining = await send(laptop.token);
        expect(remaining.status).toBe(200);
        expect(
          Schema.decodeUnknownSync(Schema.Array(DeviceView))(await remaining.json()).map(
            (entry) => entry.id,
          ),
        ).toEqual([laptop.deviceId]);
      } finally {
        await dispose();
      }
    },
  );

  it("opens, approves and collects a CLI credential once, authenticates it, and revokes only it", async () => {
    await withPairingApi(async ({ request, signup }) => {
      const owner = await signup("cli-lifecycle@example.invalid");
      const other = await signup("cli-other@example.invalid");
      const opened = await request(null, "POST", "/cli/auth", {
        name: "  Work laptop  ",
        client: "vscode",
      });
      expect(opened.status).toBe(200);
      const start = Schema.decodeUnknownSync(CliAuthStartView)(await opened.json());
      expect(start.deviceCode).toMatch(/^mdc_[A-Za-z0-9_-]{43}$/);
      expect(start.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
      expect(start.verifyPath).toBe(
        `/authorize?code=${start.code.slice(0, 4)}-${start.code.slice(4)}`,
      );
      expect(start.intervalSeconds).toBe(2);
      expect(start.expiresIn).toBeGreaterThan(0);
      expect(start.expiresIn).toBeLessThanOrEqual(600);
      expect(await cliRows(start.code)).toEqual([
        {
          deviceCodeHash: createHash("sha256").update(start.deviceCode).digest("hex"),
          approvedBy: null,
          deniedAt: null,
          collectedAt: null,
        },
      ]);
      const pollBody = { deviceCode: start.deviceCode };
      const pending = await request(null, "POST", "/cli/auth/token", pollBody);
      expect(pending.status).toBe(200);
      expect(await pending.json()).toEqual({ status: "pending" });
      expect(await devicesOf(owner.userId)).toEqual([]);
      await refusal(
        await request(null, "POST", `/me/cli-auth/${start.code}/approve`),
        401,
        "Unauthorized",
      );
      await refusal(
        await request(null, "POST", `/me/cli-auth/${start.code}/deny`),
        401,
        "Unauthorized",
      );
      await refusal(
        await request(null, "POST", "/cli/auth/token", {
          deviceCode: `${start.deviceCode}changed`,
        }),
        404,
        "CliAuthNotFound",
      );
      await refusal(
        await request(null, "POST", "/cli/auth/token", { deviceCode: start.code }),
        404,
        "CliAuthNotFound",
      );
      const grouped = `${start.code.slice(0, 4)}-${start.code.slice(4)}`.toLowerCase();
      const preview = await request(owner.token, "GET", `/me/cli-auth/${grouped}`);
      expect(preview.status).toBe(200);
      const view = Schema.decodeUnknownSync(CliAuthRequestView)(await preview.json());
      expect(view).toMatchObject({ code: start.code, name: "Work laptop", client: "vscode" });
      const approved = await request(owner.token, "POST", `/me/cli-auth/${grouped}/approve`);
      expect(approved.status).toBe(200);
      expect(Schema.decodeUnknownSync(CliAuthRequestView)(await approved.json())).toMatchObject({
        code: start.code,
        name: "Work laptop",
        client: "vscode",
      });
      expect(await devicesOf(owner.userId)).toEqual([]);
      expect(await cliRows(start.code)).toEqual([
        {
          deviceCodeHash: createHash("sha256").update(start.deviceCode).digest("hex"),
          approvedBy: owner.userId,
          deniedAt: null,
          collectedAt: null,
        },
      ]);
      await refusal(
        await request(owner.token, "POST", `/me/cli-auth/${start.code}/approve`),
        410,
        "CliAuthSpent",
      );
      const collected = await request(null, "POST", "/cli/auth/token", pollBody);
      expect(collected.status).toBe(200);
      const credential = Schema.decodeUnknownSync(CliAuthApproved)(await collected.json());
      expect(credential.user).toEqual({
        id: owner.userId,
        name: "Lifecycle owner",
        email: "cli-lifecycle@example.invalid",
      });
      expect(credential.device.name).toBe("Work laptop");
      expect(credential.token).toMatch(/^mdt_[A-Za-z0-9_-]{43}$/);
      const [collectedRow] = await cliRows(start.code);
      expect(collectedRow).toMatchObject({ approvedBy: owner.userId, deniedAt: null });
      expect(collectedRow?.collectedAt).toBeInstanceOf(Date);
      const stored = await devicesOf(owner.userId);
      expect(stored).toEqual([
        {
          id: credential.device.id,
          name: "Work laptop",
          platform: "cli",
          tokenHash: createHash("sha256").update(credential.token).digest("hex"),
          revokedAt: null,
        },
      ]);
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth;
          return yield* auth.getSession(
            new Headers({ authorization: `Bearer ${credential.token}` }),
          );
        }),
      );
      if (Option.isNone(session)) throw new Error("collected token did not authenticate");
      expect(session.value.user.id).toBe(owner.userId);
      expect(session.value.credential).toBe(`device:${credential.device.id}`);
      const listed = await request(credential.token, "GET", "/me/devices");
      expect(listed.status).toBe(200);
      expect(
        Schema.decodeUnknownSync(Schema.Array(DeviceView))(await listed.json()).map(
          (row) => row.id,
        ),
      ).toEqual([credential.device.id]);
      await refusal(await request(null, "POST", "/cli/auth/token", pollBody), 410, "CliAuthSpent");
      expect(await devicesOf(owner.userId)).toEqual(stored);
      const foreign = await request(other.token, "DELETE", `/me/devices/${credential.device.id}`);
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual({ _tag: "NotFound", id: credential.device.id });
      expect((await request(credential.token, "GET", "/me/devices")).status).toBe(200);
      const controlResponse = await request(owner.token, "POST", "/me/devices", {
        name: "Control phone",
        platform: "android",
      });
      expect(controlResponse.status).toBe(200);
      const control = Schema.decodeUnknownSync(MintedDevice)(await controlResponse.json());
      expect(
        (await request(owner.token, "DELETE", `/me/devices/${credential.device.id}`)).status,
      ).toBe(200);
      await refusal(await request(credential.token, "GET", "/me/devices"), 401, "Unauthorized");
      const remaining = await request(control.token, "GET", "/me/devices");
      expect(remaining.status).toBe(200);
      expect(
        Schema.decodeUnknownSync(Schema.Array(DeviceView))(await remaining.json()).map(
          (row) => row.id,
        ),
      ).toEqual([control.device.id]);
    });
  });

  it("denies an actual CLI request without issuing a credential and refuses later decisions", async () => {
    await withPairingApi(async ({ request, signup }) => {
      const owner = await signup("cli-denied@example.invalid");
      const opened = await request(null, "POST", "/cli/auth", {
        name: "Denied machine",
        client: "cli",
      });
      expect(opened.status).toBe(200);
      const start = Schema.decodeUnknownSync(CliAuthStartView)(await opened.json());
      const denied = await request(owner.token, "POST", `/me/cli-auth/${start.code}/deny`);
      expect(denied.status).toBe(200);
      expect(Schema.decodeUnknownSync(CliAuthRequestView)(await denied.json())).toMatchObject({
        code: start.code,
        name: "Denied machine",
        client: "cli",
      });
      await refusal(
        await request(null, "POST", "/cli/auth/token", { deviceCode: start.deviceCode }),
        403,
        "CliAuthDenied",
      );
      for (const suffix of ["", "/approve", "/deny"]) {
        await refusal(
          await request(
            owner.token,
            suffix === "" ? "GET" : "POST",
            `/me/cli-auth/${start.code}${suffix}`,
          ),
          410,
          "CliAuthSpent",
        );
      }
      const [row] = await cliRows(start.code);
      expect(row).toMatchObject({ approvedBy: null, collectedAt: null });
      expect(row?.deniedAt).toBeInstanceOf(Date);
      expect(await devicesOf(owner.userId)).toEqual([]);
    });
  });

  it.each(["pending", "approved"] as const)(
    "expires a genuinely opened %s CLI request before collection without issuing a credential",
    async (state) => {
      await withPairingApi(async ({ request, signup }) => {
        const owner = await signup(`cli-expired-${state}@example.invalid`);
        const opened = await request(null, "POST", "/cli/auth", {
          name: "Expired machine",
          client: "cli",
        });
        expect(opened.status).toBe(200);
        const start = Schema.decodeUnknownSync(CliAuthStartView)(await opened.json());
        if (state === "approved") {
          const approval = await request(owner.token, "POST", `/me/cli-auth/${start.code}/approve`);
          expect(approval.status).toBe(200);
        }
        // Native Date owns expiry in the real repository. Arrange only this issued row's deadline,
        // not the route transition or a global clock; every decision below uses the actual route.
        const changed = await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`UPDATE cli_auth_requests SET expires_at = now() - interval '1 minute' WHERE user_code = ${start.code} RETURNING user_code`;
          }),
        );
        expect(changed).toEqual([{ userCode: start.code }]);
        for (const suffix of ["", "/approve", "/deny"]) {
          await refusal(
            await request(
              owner.token,
              suffix === "" ? "GET" : "POST",
              `/me/cli-auth/${start.code}${suffix}`,
            ),
            410,
            "CliAuthSpent",
          );
        }
        await refusal(
          await request(null, "POST", "/cli/auth/token", { deviceCode: start.deviceCode }),
          410,
          "CliAuthSpent",
        );
        expect(await cliRows(start.code)).toEqual([
          {
            deviceCodeHash: createHash("sha256").update(start.deviceCode).digest("hex"),
            approvedBy: state === "approved" ? owner.userId : null,
            deniedAt: null,
            collectedAt: null,
          },
        ]);
        expect(await devicesOf(owner.userId)).toEqual([]);
        await refusal(
          await request(owner.token, "GET", "/me/cli-auth/NOSUCHXX"),
          404,
          "CliAuthNotFound",
        );
      });
    },
  );

  it("claims an actual pairing only once and distinguishes expired and unknown codes", async () => {
    await withPairingApi(async ({ request, signup }) => {
      const owner = await signup("pair-lifecycle@example.invalid");
      await refusal(await request(null, "POST", "/me/devices/pairings"), 401, "Unauthorized");
      const opened = await request(owner.token, "POST", "/me/devices/pairings");
      expect(opened.status).toBe(200);
      const pairing = Schema.decodeUnknownSync(PairingView)(await opened.json());
      const claimBody = {
        code: pairing.code.toLowerCase(),
        name: "  Paired phone  ",
        platform: "ios",
      };
      const claimed = await request(null, "POST", "/pair", claimBody);
      expect(claimed.status).toBe(200);
      const credential = Schema.decodeUnknownSync(PairClaimResult)(await claimed.json());
      expect(credential.user.id).toBe(owner.userId);
      expect(credential.device.name).toBe("Paired phone");
      expect(credential.url).toBe(origin);
      await refusal(await request(null, "POST", "/pair", claimBody), 410, "PairingCodeSpent");
      const next = await request(owner.token, "POST", "/me/devices/pairings");
      expect(next.status).toBe(200);
      const expired = Schema.decodeUnknownSync(PairingView)(await next.json());
      const changed = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`UPDATE pairing_codes SET expires_at = now() - interval '1 minute' WHERE code = ${expired.code} RETURNING code`;
        }),
      );
      expect(changed).toEqual([{ code: expired.code }]);
      await refusal(
        await request(null, "POST", "/pair", { ...claimBody, code: expired.code }),
        410,
        "PairingCodeSpent",
      );
      await refusal(
        await request(null, "POST", "/pair", { ...claimBody, code: "NOSUCHXX" }),
        404,
        "PairingCodeNotFound",
      );
      expect((await devicesOf(owner.userId)).map((row) => row.id)).toEqual([credential.device.id]);
    });
  });
});
