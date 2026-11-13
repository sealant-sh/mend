import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MigratorLive, PgLive } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { MendKeysConfig, SecretCipherLive } from "@mend/store";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ExecutorIdentity, ExecutorIdentityLive } from "./executor-identity.ts";

const postgres = postgresTestConfig();
const database = `mend_executor_identity_${process.pid}_${Date.now()}`;
const databaseURL = new URL(postgres.adminUrl);
databaseURL.pathname = `/${database}`;
const admin = new Pool({ connectionString: postgres.adminUrl, connectionTimeoutMillis: 2000 });
const pool = new Pool({ connectionString: databaseURL.href });
const root = await mkdtemp(join(tmpdir(), "exrun-identity-test-"));
const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    DATABASE_URL: databaseURL.href,
    MEND_EXECUTOR_CALLBACK_HOST: "mend.test",
  }),
);
const live = () =>
  ExecutorIdentityLive.pipe(
    Layer.provide(SecretCipherLive.pipe(Layer.provide(MendKeysConfig.layerFor(root)))),
    Layer.provide(config),
  );
// Independent service instances and pools share only the persisted state, as separate servers do.
const first = ManagedRuntime.make(live());
const second = ManagedRuntime.make(live());
const org = "identity-fixture";
const account = "person-fixture";
const secret = Redacted.make(randomBytes(32).toString("base64url"));
const run = <A, E>(effect: Effect.Effect<A, E, ExecutorIdentity>) => first.runPromise(effect);
const call = (request: Request, other = false) =>
  (other ? second : first).runPromise(
    Effect.flatMap(ExecutorIdentity, (service) => service.handle(request)),
  );
let created = false;
let issuer: string;
let clientId: string;
const authorization = () => {
  const url = new URL(`${issuer}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://executor.localhost:4400/api/auth/callback/sso",
    scope: "openid email profile",
    state: randomBytes(20).toString("hex"),
    nonce: randomBytes(20).toString("hex"),
  }).toString();
  return url.href;
};
const request = (url: string, ticket?: string, cookie?: string) =>
  new Request(url, {
    headers: {
      Accept: "text/html",
      ...(ticket === undefined ? {} : { "x-mend-link-ticket": ticket }),
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
  });
const ticket = async (url: string, expired = false) => {
  const value = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO executor_identity.link_tickets(digest,organization_id,user_id,authorize_url,expires_at) VALUES($1,$2,$3,$4,now()+($5::int * interval '1 second'))",
    [createHash("sha256").update(value).digest("hex"), org, account, url, expired ? -1 : 30],
  );
  return value;
};

describe.skipIf(postgres.skip)("private Executor provider through migrated PostgreSQL", () => {
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    await Effect.runPromise(
      Layer.build(MigratorLive.pipe(Layer.provide(PgLive), Layer.provide(config))).pipe(
        Effect.scoped,
      ),
    );
    await pool.query(
      'INSERT INTO public."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Mend person\',\'real@example.invalid\',true,now(),now())',
      [account],
    );
    await pool.query("INSERT INTO public.organizations(id,name) VALUES($1,'Identity fixture')", [
      org,
    ]);
    await pool.query(
      "INSERT INTO public.organization_members(organization_id,user_id,role) VALUES($1,$2,'member')",
      [org, account],
    );
    const settings = await run(
      Effect.flatMap(ExecutorIdentity, (service) => service.prepare(org, secret)),
    );
    clientId = settings.clientId;
    issuer = settings.discovery.replace("/.well-known/openid-configuration", "");
  });
  afterAll(async () => {
    await first.dispose();
    await second.dispose();
    await pool.end();
    try {
      if (created) {
        // Pool.end() can resolve before its clients finish disconnecting from PostgreSQL.
        await vi.waitFor(
          async () => {
            const connections = await admin.query(
              "SELECT pid,application_name,state FROM pg_stat_activity WHERE datname=$1",
              [database],
            );
            expect(connections.rows).toEqual([]);
          },
          { timeout: 5000 },
        );
        await admin.query(`DROP DATABASE ${database}`);
      }
    } finally {
      await admin.end();
      await readdir(root);
      await rm(root, { recursive: true });
    }
  });
  it("uses synthetic verified identities, real stored sessions and signed tokens", async () => {
    const url = authorization();
    const returned = new URL(
      await run(
        Effect.flatMap(ExecutorIdentity, (service) => service.authorize(org, account, url)),
      ),
    );
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: Redacted.value(secret),
      redirect_uri: "http://executor.localhost:4400/api/auth/callback/sso",
      code: returned.searchParams.get("code") ?? "",
    });
    const response = await call(
      new Request(`${issuer}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      }),
    );
    expect(response.status).toBe(200);
    const answer = Schema.decodeUnknownSync(Schema.Struct({ id_token: Schema.String }))(
      await response.json(),
    );
    const encoded = answer.id_token.split(".")[1];
    expect(encoded).toBeDefined();
    const claims = Schema.decodeUnknownSync(
      Schema.Struct({ sub: Schema.String, email: Schema.String, email_verified: Schema.Boolean }),
    )(JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8")));
    expect(claims).toEqual({
      sub: account,
      email: `${account}@${org}.people.mend.invalid`,
      email_verified: true,
    });
    expect(
      (await pool.query('SELECT email FROM public."user" WHERE id=$1', [account])).rows[0]?.email,
    ).toBe("real@example.invalid");
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM executor_identity.session WHERE "userId"=$1',
          [account],
        )
      ).rows[0]?.n,
    ).toBeGreaterThan(0);
    const keysResponse = await call(new Request(`${issuer}/jwks`));
    expect(keysResponse.status).toBe(200);
    const keys = Schema.decodeUnknownSync(
      Schema.Struct({
        keys: Schema.Array(
          Schema.Struct({ kty: Schema.Literal("RSA"), n: Schema.String, e: Schema.String }),
        ),
      }),
    )(await keysResponse.json());
    const key = keys.keys[0];
    if (key === undefined) throw new Error("Provider did not publish its signing key");
    const parts = answer.id_token.split(".");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(parts[2] ?? "", "base64url"),
      ),
    ).toBe(true);
  });
  it("consumes a ticket once across independent servers, and rejects cookie fallback", async () => {
    const url = authorization();
    const value = await ticket(url);
    const responses = await Promise.all([
      call(request(url, value)),
      call(request(url, value), true),
    ]);
    expect(responses.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([302, 401]);
    const cookie = responses.find((r) => r.status === 302)?.headers.get("set-cookie") ?? "";
    expect((await call(request(authorization(), undefined, cookie))).status).toBe(401);
    expect((await call(request(url, value))).status).toBe(401);
  });
  it("spends mismatched and expired tickets, rechecks membership and bounds private routes", async () => {
    const url = authorization();
    const mismatch = await ticket(url);
    expect((await call(request(url + "&prompt=login", mismatch))).status).toBe(401);
    expect((await call(request(url, mismatch))).status).toBe(401);
    expect((await call(request(url, await ticket(url, true)))).status).toBe(401);
    const value = await ticket(url);
    await pool.query(
      "DELETE FROM public.organization_members WHERE organization_id=$1 AND user_id=$2",
      [org, account],
    );
    expect((await call(request(url, value))).status).toBe(401);
    await pool.query(
      "INSERT INTO public.organization_members(organization_id,user_id,role) VALUES($1,$2,'member')",
      [org, account],
    );
    expect((await call(new Request(`${issuer}/sign-up/email`, { method: "POST" }))).status).toBe(
      404,
    );
    expect((await call(new Request(`${issuer}/oauth2/register`, { method: "POST" }))).status).toBe(
      404,
    );
  });
  it("retains its sealed CA across servers and removes organization identities and tickets", async () => {
    const settings = await run(
      Effect.flatMap(ExecutorIdentity, (service) => service.prepare(org, secret)),
    );
    const other = await second.runPromise(
      Effect.flatMap(ExecutorIdentity, (service) => service.prepare(org, secret)),
    );
    expect(settings.ca).toBe(other.ca);
    const persisted = await pool.query("SELECT sealed_state FROM executor_identity.authority");
    expect(persisted.rows[0]?.sealed_state).not.toContain("PRIVATE KEY");
    await ticket(authorization());
    await run(Effect.flatMap(ExecutorIdentity, (service) => service.remove(org)));
    expect((await call(new Request(settings.discovery))).status).toBe(404);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM executor_identity.link_tickets")).rows[0]
        ?.n,
    ).toBe(0);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM executor_identity."user"')).rows[0]?.n,
    ).toBe(0);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM executor_identity.authority")).rows[0]?.n,
    ).toBe(1);
  });
});
