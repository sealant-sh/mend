import { createHash } from "node:crypto";

import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Auth, AuthLive, RegistrationPolicy } from "./auth.ts";

/**
 * Deactivated accounts lose every way in (docs/adr/0003-organizations-and-tenancy.md): browser
 * sessions, paired-device tokens and the static dev token. Runs against the dev Postgres
 * (`compose.dev.yaml`, :5434) in a throwaway database, and skips without one.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_auth_deactivation_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();

const admin = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2000 });
const reachable = await admin.query("SELECT 1").then(
  () => true,
  () => false,
);

const origin = "http://localhost:3105";
const network = makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)(origin), []);
const STATIC_TOKEN = "static-dev-token";
const DEVICE_TOKEN = "mdt_device";

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

const signedIn = (headers: Headers) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth;
      return Option.isSome(yield* auth.getSession(headers));
    }).pipe(Effect.provide(authLayer), Effect.scoped),
  );

const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

describe.skipIf(!reachable)("deactivated accounts", () => {
  let sessionToken = "";
  let scratch: Pool | undefined;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    scratch = new Pool({ connectionString: scratchUrl });
    // Better Auth's tables as migration 0001 creates them, plus the columns this test reads.
    await scratch.query(`
      CREATE TABLE "user" (
        "id" text PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL UNIQUE,
        "emailVerified" boolean NOT NULL DEFAULT false, "image" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deactivatedAt" timestamptz
      );
      CREATE TABLE "session" (
        "id" text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, "token" text NOT NULL UNIQUE,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "ipAddress" text, "userAgent" text,
        "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
      );
      CREATE TABLE "account" (
        "id" text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
        "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "accessToken" text, "refreshToken" text, "idToken" text,
        "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text,
        "password" text, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "verification" (
        "id" text PRIMARY KEY, "identifier" text NOT NULL, "value" text NOT NULL,
        "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE device_tokens (
        id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id), name text NOT NULL,
        platform text NOT NULL, token_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz
      );`);
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth;
        return yield* auth.handler(
          new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({
              email: "operator@example.invalid",
              password: "disposable-deactivation-password",
              name: "Operator",
            }),
          }),
        );
      }).pipe(Effect.provide(authLayer), Effect.scoped),
    );
    expect(response.status).toBe(200);
    sessionToken = response.headers.get("set-auth-token") ?? "";
    const { rows } = await scratch.query<{ id: string }>('SELECT id FROM "user" LIMIT 1');
    await scratch.query(
      "INSERT INTO device_tokens (id, user_id, name, platform, token_hash) VALUES ($1, $2, $3, $4, $5)",
      [
        "device-1",
        rows[0]?.id,
        "Phone",
        "ios",
        createHash("sha256").update(DEVICE_TOKEN).digest("hex"),
      ],
    );
  });

  afterAll(async () => {
    await scratch?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  });

  it("an active account is signed in by its session, its device and the static token", async () => {
    expect(sessionToken).not.toBe("");
    expect(await signedIn(bearer(sessionToken))).toBe(true);
    expect(await signedIn(bearer(DEVICE_TOKEN))).toBe(true);
    expect(await signedIn(bearer(STATIC_TOKEN))).toBe(true);
  });

  it("a deactivated account is refused on every path", async () => {
    await scratch?.query('UPDATE "user" SET "deactivatedAt" = now()');
    expect({
      session: await signedIn(bearer(sessionToken)),
      device: await signedIn(bearer(DEVICE_TOKEN)),
      static: await signedIn(bearer(STATIC_TOKEN)),
    }).toEqual({ session: false, device: false, static: false });
  });
});

afterAll(async () => {
  if (!reachable) await admin.end();
});
