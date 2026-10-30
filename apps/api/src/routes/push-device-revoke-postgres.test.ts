import { PgClient } from "@effect/sql-pg";
import {
  devicesGroup,
  PairClaimResult,
  PairingView,
  pairGroup,
  userDevicesGroup,
} from "@mend/api-contracts";
import { Auth, AuthLive, RegistrationPolicy } from "@mend/auth";
import {
  DevicesRepo,
  DevicesRepoLive,
  MendDBLive,
  migrations,
  NotificationSettingsRepo,
  NotificationSettingsRepoLive,
  PushDevicesRepo,
  PushDevicesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { pushTargets } from "@mend/jobs";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import {
  ConfigProvider,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
  String as Str,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthMiddlewareLive, DevicesGroupLive } from "./api-live.ts";
import { DevicePairingLive } from "./devices.ts";

const postgres = postgresTestConfig();
const database = `mend_push_revoke_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(postgres.adminUrl);
databaseUrl.pathname = `/${database}`;
const origin = "http://localhost:3105";
const STATIC_TOKEN = "disposable-push-revoke-static-token";
const network = makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)(origin), []);
const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    DATABASE_URL: databaseUrl.toString(),
    BETTER_AUTH_SECRET: "disposable-push-revoke-test-secret-32-bytes",
    MEND_STATIC_TOKEN: STATIC_TOKEN,
  }),
);
const databaseLayer = MendDBLive.pipe(
  Layer.provideMerge(
    PgClient.layer({
      url: Redacted.make(databaseUrl.toString()),
      transformResultNames: Str.snakeToCamel,
      maxConnections: 4,
    }),
  ),
);
const runtime = ManagedRuntime.make(
  Layer.mergeAll(AuthLive, DevicesRepoLive, PushDevicesRepoLive, NotificationSettingsRepoLive).pipe(
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
const query = <A>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, statement));
const api = HttpApiBuilder.layer(
  HttpApi.make("mend").add(userDevicesGroup).add(pairGroup).add(devicesGroup).prefix("/api"),
).pipe(
  Layer.provide(DevicePairingLive),
  Layer.provide(DevicesGroupLive),
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(HttpServer.layerServices),
  Layer.provide(config),
);
let databaseCreated = false;
let send: (bearer: string, method: string, path: string, body?: unknown) => Promise<Response>;
let disposeApi: () => Promise<void> = async () => undefined;

const storedOf = (...tokens: ReadonlyArray<string>) =>
  query(
    (sql) => sql<{ readonly token: string }>`SELECT token FROM push_devices ORDER BY token`,
  ).then((rows) => rows.map((row) => row.token).filter((token) => tokens.includes(token)));

const notifiedTokens = (ownerUserId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const targets = yield* pushTargets(
        yield* PushDevicesRepo,
        yield* NotificationSettingsRepo,
        { ownerUserId, sharedControlEnabledAt: null },
        null,
        { kind: "finished", slackThread: null },
      );
      return targets.map((device) => device.token).toSorted();
    }),
  );

interface Account {
  readonly id: string;
  readonly browser: string;
}

const signUp = async (name: string): Promise<Account> => {
  const response = await runtime.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      return yield* auth.handler(
        new Request(`${origin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            email: `${name}@example.invalid`,
            name,
            password: "disposable-push-revoke-password",
          }),
        }),
      );
    }),
  );
  expect(response.status).toBe(200);
  const id = Schema.decodeUnknownSync(
    Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
  )(await response.json()).user.id;
  const browser = response.headers.get("set-auth-token");
  if (browser === null) throw new Error("signup did not issue a browser bearer");
  return { id, browser };
};

const pair = async (account: Account, name: string) => {
  const opened = await send(account.browser, "POST", "/me/devices/pairings");
  expect(opened.status).toBe(200);
  const pairing = Schema.decodeUnknownSync(PairingView)(await opened.json());
  const claimed = await send("", "POST", "/pair", { code: pairing.code, name, platform: "ios" });
  expect(claimed.status).toBe(200);
  return Schema.decodeUnknownSync(PairClaimResult)(await claimed.json());
};

const registerPush = (bearer: string, push: string) =>
  send(bearer, "POST", "/devices", { token: push, platform: "ios" });

const revoke = (account: Account, phone: PairClaimResult) =>
  send(account.browser, "DELETE", `/me/devices/${phone.device.id}`);

const holdTransaction = async (
  statement: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, SqlError>,
) => {
  const opened = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const committed = Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* statement(sql);
          opened.resolve();
          yield* Effect.promise(() => release.promise);
        }),
      );
    }).pipe(
      Effect.provide(
        PgClient.layer({ url: Redacted.make(databaseUrl.toString()), maxConnections: 1 }),
      ),
      Effect.scoped,
    ),
  );
  await Promise.race([opened.promise, committed]);
  return () => {
    release.resolve();
    return committed;
  };
};

const lockWaiters = async (count: number, settled: Promise<unknown>) => {
  let finished = false;
  const finish = () => {
    finished = true;
  };
  void settled.then(finish, finish);
  const deadline = performance.now() + 5_000;
  for (;;) {
    const [row] = await query(
      (sql) => sql<{ readonly waiting: number }>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = ${database} AND wait_event_type = 'Lock'`,
    );
    if (finished || (row?.waiting ?? 0) >= count) return;
    if (performance.now() >= deadline) throw new Error(`${count} lock waiters never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const withoutTriggers = (
  statement: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, SqlError>,
) =>
  query((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET LOCAL session_replication_role = replica`;
        yield* statement(sql);
      }),
    ),
  );

describe.skipIf(postgres.skip)(
  "a revoked device's push token, through real Auth and PostgreSQL",
  () => {
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
      const context = await runtime.runPromise(
        Effect.context<
          Auth | DevicesRepo | NetworkConfig | PushDevicesRepo | NotificationSettingsRepo
        >(),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(
        api.pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      );
      disposeApi = dispose;
      send = (bearer, method, path, body) =>
        handler(
          new Request(`${origin}/api${path}`, {
            method,
            headers: {
              ...(bearer === "" ? {} : { authorization: `Bearer ${bearer}` }),
              "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          context,
        );
    });

    afterAll(async () => {
      try {
        await disposeApi();
        await runtime.dispose();
      } finally {
        if (databaseCreated)
          await admin(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const deadline = performance.now() + 5_000;
              for (;;) {
                const rows =
                  yield* sql`SELECT pid FROM pg_stat_activity WHERE datname = ${database}`;
                if (rows.length === 0) break;
                if (performance.now() >= deadline)
                  return yield* Effect.die("push revoke fixture connections did not close");
                yield* Effect.sleep("10 millis");
              }
              yield* sql.unsafe(`DROP DATABASE ${database}`);
            }),
          );
      }
    });

    it("drops the token a paired phone registered once that phone is revoked, and stops ringing it", async () => {
      const owner = await signUp("push-owner");
      const revoked = await pair(owner, "Revoked phone");
      const kept = await pair(owner, "Kept phone");
      const revokedPush = "ExponentPushToken[revoked-phone-push]";
      const keptPush = "ExponentPushToken[kept-phone-push]";
      expect((await registerPush(revoked.token, revokedPush)).status).toBe(200);
      expect((await registerPush(kept.token, keptPush)).status).toBe(200);
      expect(await notifiedTokens(owner.id)).toEqual([keptPush, revokedPush].toSorted());

      expect((await revoke(owner, revoked)).status).toBe(200);
      expect((await send(revoked.token, "GET", "/me/devices")).status).toBe(401);

      expect.soft(await storedOf(revokedPush, keptPush)).toEqual([keptPush]);
      expect.soft(await notifiedTokens(owner.id)).toEqual([keptPush]);
    });

    it("takes a push token only from a paired phone, never a browser sign-in or the machine token", async () => {
      const operator = await signUp("push-operator");
      await query(
        (sql) =>
          sql`INSERT INTO instance_roles (user_id, role) VALUES (${operator.id}, 'operator')`,
      );
      const browserPush = "ExponentPushToken[browser-push]";
      const machinePush = "ExponentPushToken[machine-push]";

      expect((await registerPush(operator.browser, browserPush)).status).toBe(403);
      expect((await registerPush(STATIC_TOKEN, machinePush)).status).toBe(403);
      expect(await storedOf(browserPush, machinePush)).toEqual([]);
    });

    it("drops a token registered while the revoke waited on it", async () => {
      const owner = await signUp("push-race-register-first");
      const phone = await pair(owner, "Racing phone");
      const push = "ExponentPushToken[register-first]";

      const commit = await holdTransaction((sql) => sql`LOCK TABLE push_devices IN SHARE MODE`);
      const registering = registerPush(phone.token, push);
      await lockWaiters(1, registering);
      const revoking = revoke(owner, phone);
      await lockWaiters(2, revoking);
      await commit();

      expect((await registering).status).toBe(200);
      expect((await revoking).status).toBe(200);
      expect(await storedOf(push)).toEqual([]);
      expect(await notifiedTokens(owner.id)).toEqual([]);
    });

    it("refuses a token whose phone is revoked while it registers, and keeps none", async () => {
      const owner = await signUp("push-race-revoke-first");
      const phone = await pair(owner, "Racing phone");
      const first = "ExponentPushToken[revoke-first-a]";
      const second = "ExponentPushToken[revoke-first-b]";
      expect((await registerPush(phone.token, first)).status).toBe(200);

      const commit = await holdTransaction(
        (sql) => sql`UPDATE device_tokens SET revoked_at = now() WHERE id = ${phone.device.id}`,
      );
      const registering = registerPush(phone.token, second);
      await lockWaiters(1, registering);
      await commit();

      expect((await registering).status).toBe(401);
      expect(await storedOf(first, second)).toEqual([]);
      expect(await notifiedTokens(owner.id)).toEqual([]);
    });

    it("refuses a token whose account is deactivated while it registers, and keeps none", async () => {
      const leaving = await signUp("push-race-deactivate-first");
      const phone = await pair(leaving, "Racing phone");
      const first = "ExponentPushToken[deactivate-first-a]";
      const second = "ExponentPushToken[deactivate-first-b]";
      expect((await registerPush(phone.token, first)).status).toBe(200);

      const commit = await holdTransaction(
        (sql) => sql`UPDATE "user" SET "deactivatedAt" = now() WHERE id = ${leaving.id}`,
      );
      const registering = registerPush(phone.token, second);
      await lockWaiters(1, registering);
      await commit();

      expect((await registering).status).toBe(401);
      expect(await storedOf(first, second)).toEqual([]);
    });

    it("moves a token to the phone that registers it last, where the old phone's revoke cannot reach it", async () => {
      const first = await signUp("push-first-owner");
      const second = await signUp("push-second-owner");
      const firstPhone = await pair(first, "First phone");
      const secondPhone = await pair(second, "Second phone");
      const push = "ExponentPushToken[moving-push]";
      expect((await registerPush(firstPhone.token, push)).status).toBe(200);
      expect((await registerPush(secondPhone.token, push)).status).toBe(200);
      expect(await notifiedTokens(first.id)).toEqual([]);
      expect(await notifiedTokens(second.id)).toEqual([push]);

      expect((await revoke(first, firstPhone)).status).toBe(200);
      expect(await notifiedTokens(second.id)).toEqual([push]);

      expect((await revoke(second, secondPhone)).status).toBe(200);
      expect(await storedOf(push)).toEqual([]);
    });

    it("drops the tokens of an account whose devices are all revoked, and of an account deactivated", async () => {
      const bulk = await signUp("push-bulk-revoked");
      const pushes = ["ExponentPushToken[bulk-a]", "ExponentPushToken[bulk-b]"];
      for (const push of pushes) {
        expect((await registerPush((await pair(bulk, push)).token, push)).status).toBe(200);
      }
      await runtime.runPromise(
        Effect.flatMap(DevicesRepo, (devices) => devices.revokeAllForUser(bulk.id)),
      );
      expect(await storedOf(...pushes)).toEqual([]);

      const leaving = await signUp("push-deactivated");
      const leavingPush = "ExponentPushToken[deactivated]";
      expect((await registerPush((await pair(leaving, "Phone")).token, leavingPush)).status).toBe(
        200,
      );
      await query((sql) => sql`UPDATE "user" SET "deactivatedAt" = now() WHERE id = ${leaving.id}`);
      expect(await storedOf(leavingPush)).toEqual([]);
    });

    it("never rings a token left behind by a revoke or a deactivation that skipped the drop", async () => {
      const owner = await signUp("push-stale-revoked");
      const stale = await pair(owner, "Stale phone");
      const kept = await pair(owner, "Kept phone");
      const stalePush = "ExponentPushToken[stale-revoked]";
      const keptPush = "ExponentPushToken[stale-kept]";
      expect((await registerPush(stale.token, stalePush)).status).toBe(200);
      expect((await registerPush(kept.token, keptPush)).status).toBe(200);
      await withoutTriggers(
        (sql) => sql`UPDATE device_tokens SET revoked_at = now() WHERE id = ${stale.device.id}`,
      );
      expect(await storedOf(stalePush)).toEqual([stalePush]);
      expect(await notifiedTokens(owner.id)).toEqual([keptPush]);

      const leaving = await signUp("push-stale-deactivated");
      const leavingPush = "ExponentPushToken[stale-deactivated]";
      expect((await registerPush((await pair(leaving, "Phone")).token, leavingPush)).status).toBe(
        200,
      );
      await withoutTriggers(
        (sql) => sql`UPDATE "user" SET "deactivatedAt" = now() WHERE id = ${leaving.id}`,
      );
      expect(await storedOf(leavingPush)).toEqual([leavingPush]);
      expect(await notifiedTokens(leaving.id)).toEqual([]);
    });
  },
);
