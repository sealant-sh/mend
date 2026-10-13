import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  DeviceView,
  MintedDevice,
  PairClaimResult,
  PairingView,
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
  HttpApi.make("mend").add(userDevicesGroup).add(pairGroup).prefix("/api"),
).pipe(
  Layer.provide(DevicePairingLive),
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(HttpServer.layerServices),
);
let databaseCreated = false;

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
});
