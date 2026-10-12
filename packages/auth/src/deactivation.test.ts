import { createHash } from "node:crypto";

import { MigratorLive, PgLive } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Auth, AuthLive, PASSWORD_RESET_TTL_MS, RegistrationPolicy } from "./auth.ts";

/**
 * Deactivated accounts lose every way in (docs/adr/0003-organizations-and-tenancy.md): browser
 * sessions, paired-device tokens and the static dev token. Runs against a fully migrated throwaway
 * PostgreSQL database. See postgresTestConfig for local opt-out.
 */
const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
const SCRATCH_DB = `mend_auth_deactivation_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();

const admin = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2000 });
const scratch = new Pool({ connectionString: scratchUrl });
let databaseCreated = false;

const origin = "http://localhost:3105";
const network = makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)(origin), []);
const STATIC_TOKEN = "static-dev-token";
const DEVICE_TOKEN = "mdt_device";
const OLD_PASSWORD = "disposable-deactivation-password";
const NEW_PASSWORD = "a-new-disposable-password";

const authLayer = AuthLive.pipe(
  Layer.provide(Layer.succeed(NetworkConfig, network)),
  Layer.provide(
    Layer.succeed(RegistrationPolicy, {
      decide: () => Effect.succeed({ kind: "bootstrap" }),
      registered: () => Effect.void,
    }),
  ),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        DATABASE_URL: scratchUrl,
        BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-bytes",
        MEND_STATIC_TOKEN: STATIC_TOKEN,
      }),
    ),
  ),
);

const runAuth = <A>(effect: Effect.Effect<A, never, Auth>) =>
  Effect.runPromise(effect.pipe(Effect.provide(authLayer), Effect.scoped));

/** The signed-in account's email, or null when the headers sign nobody in. */
const signedInAs = (headers: Headers) =>
  runAuth(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const session = yield* auth.getSession(headers);
      return Option.isSome(session) ? session.value.user.email : null;
    }),
  );

const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

const postAuth = (route: string, body: object) =>
  runAuth(
    Effect.gen(function* () {
      const auth = yield* Auth;
      return yield* auth.handler(
        new Request(`${origin}/api/auth/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify(body),
        }),
      );
    }),
  );

const issueReset = (userId: string) =>
  runAuth(
    Effect.gen(function* () {
      const auth = yield* Auth;
      return yield* auth.issuePasswordReset(userId);
    }),
  );

const reset = (token: string) => postAuth("reset-password", { token, newPassword: NEW_PASSWORD });
const signIn = (email: string, password: string) => postAuth("sign-in/email", { email, password });

const createdAccount = async (email: string, name: string) => {
  const response = await postAuth("sign-up/email", { email, password: OLD_PASSWORD, name });
  expect(response.status).toBe(200);
  const body = Schema.decodeUnknownSync(
    Schema.Struct({ user: Schema.Struct({ id: Schema.String, email: Schema.String }) }),
  )(await response.json());
  expect(body.user.email).toBe(email);
  const token = response.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");
  return { id: body.user.id, email, token };
};

describe.skipIf(postgres.skip)("deactivation and password reset in migrated Postgres", () => {
  let operator: Awaited<ReturnType<typeof createdAccount>>;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    databaseCreated = true;
    await Effect.runPromise(
      Layer.build(
        MigratorLive.pipe(
          Layer.provide(PgLive),
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ DATABASE_URL: scratchUrl })),
          ),
        ),
      ).pipe(Effect.scoped),
    );
  });

  beforeEach(async () => {
    // Each case starts active, with its own live credentials, regardless of test order.
    await scratch.query('TRUNCATE "user", "verification" CASCADE');
    operator = await createdAccount("operator@example.invalid", "Operator");
    await scratch.query("INSERT INTO instance_roles (user_id, role) VALUES ($1, 'operator')", [
      operator.id,
    ]);
    // An older account that is not the operator: the static token must not act as it.
    await scratch.query(
      `INSERT INTO "user" (id, name, email, "createdAt") VALUES ('older', 'Older', 'older@example.invalid', '2020-01-01T00:00:00Z')`,
    );
    await scratch.query(
      "INSERT INTO device_tokens (id, user_id, name, platform, token_hash) VALUES ($1, $2, $3, $4, $5)",
      [
        "device-1",
        operator.id,
        "Phone",
        "ios",
        createHash("sha256").update(DEVICE_TOKEN).digest("hex"),
      ],
    );
  });

  afterEach(() => vi.useRealTimers());

  it("an active account is signed in by its session, its device and the static token", async () => {
    expect(await signedInAs(bearer(operator.token))).toBe(operator.email);
    expect(await signedInAs(bearer(DEVICE_TOKEN))).toBe(operator.email);
    expect(await signedInAs(bearer(STATIC_TOKEN))).toBe(operator.email);
  });

  it("a deactivated account is refused on every path", async () => {
    // Positive controls in this case prove these credentials worked before deactivation.
    expect(await signedInAs(bearer(operator.token))).toBe(operator.email);
    expect(await signedInAs(bearer(DEVICE_TOKEN))).toBe(operator.email);
    expect(await signedInAs(bearer(STATIC_TOKEN))).toBe(operator.email);
    await scratch.query(`UPDATE "user" SET "deactivatedAt" = now() WHERE id = $1`, [operator.id]);
    expect({
      session: await signedInAs(bearer(operator.token)),
      device: await signedInAs(bearer(DEVICE_TOKEN)),
      static: await signedInAs(bearer(STATIC_TOKEN)),
    }).toEqual({ session: null, device: null, static: null });
  });

  it("a handed-over reset link sets a new password once and signs the account out", async () => {
    const account = await createdAccount("reset@example.invalid", "Reset account");
    expect(await signedInAs(bearer(account.token))).toBe(account.email);
    const issued = await issueReset(account.id);
    const newer = await issueReset(account.id);
    // Only the newest link works, and spending an older link cannot end a live session.
    const superseded = await reset(issued.token);
    expect(superseded.status).toBe(400);
    await expect(superseded.json()).resolves.toMatchObject({ code: "INVALID_TOKEN" });
    expect(await signedInAs(bearer(account.token))).toBe(account.email);
    expect((await reset(newer.token)).status).toBe(200);
    // The old bearer no longer authenticates, in addition to the old session rows being gone.
    const sessions = await scratch.query<{ count: string }>(
      `SELECT count(*) AS count FROM "session" WHERE "userId" = $1`,
      [account.id],
    );
    expect(sessions.rows[0]?.count).toBe("0");
    expect(await signedInAs(bearer(account.token))).toBeNull();
    expect((await reset(newer.token)).status).toBe(400);
    expect(issued.token).not.toBe(newer.token);

    const oldPassword = await signIn(account.email, OLD_PASSWORD);
    expect(oldPassword.status).toBe(401);
    await expect(oldPassword.json()).resolves.toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    const newPassword = await signIn(account.email, NEW_PASSWORD);
    expect(newPassword.status).toBe(200);
    await expect(newPassword.json()).resolves.toMatchObject({
      user: { id: account.id, email: account.email },
    });
    const newToken = newPassword.headers.get("set-auth-token") ?? "";
    expect(newToken).not.toBe("");
    expect(newToken).not.toBe(account.token);
    expect(await signedInAs(bearer(newToken))).toBe(account.email);
  });

  it.each([
    { offset: -1, accepted: true },
    { offset: 1, accepted: false },
  ])(
    "a reset link $offset ms from its configured expiry is accepted: $accepted",
    async ({ offset, accepted }) => {
      const account = await createdAccount("expiry@example.invalid", "Expiry account");
      expect(await signedInAs(bearer(account.token))).toBe(account.email);
      // Auth and Better Auth use Date directly. Only Date is faked; pool and I/O timers stay real.
      vi.useFakeTimers({ toFake: ["Date"] });
      const issuedAt = new Date("2030-01-01T00:00:00.000Z").getTime();
      vi.setSystemTime(issuedAt);
      const issued = await issueReset(account.id);
      expect(issued.expiresAt.getTime()).toBe(issuedAt + PASSWORD_RESET_TTL_MS);
      const stored = await scratch.query<{ expiresAt: Date }>(
        `SELECT "expiresAt" FROM "verification" WHERE identifier = $1`,
        [`reset-password:${issued.token}`],
      );
      expect(stored.rows[0]?.expiresAt.getTime()).toBe(issued.expiresAt.getTime());
      vi.setSystemTime(issuedAt + PASSWORD_RESET_TTL_MS + offset);
      const response = await reset(issued.token);
      expect(response.status).toBe(accepted ? 200 : 400);
      if (accepted) {
        expect((await signIn(account.email, NEW_PASSWORD)).status).toBe(200);
        expect((await signIn(account.email, OLD_PASSWORD)).status).toBe(401);
      } else {
        await expect(response.json()).resolves.toMatchObject({ code: "INVALID_TOKEN" });
        expect((await signIn(account.email, OLD_PASSWORD)).status).toBe(200);
        expect((await signIn(account.email, NEW_PASSWORD)).status).toBe(401);
      }
    },
  );
});

afterAll(async () => {
  await scratch.end();
  if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.end();
});
