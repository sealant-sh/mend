import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { PgClient } from "@effect/sql-pg";
import { ExecutorRepo, ExecutorRepoLive, MendDBLive, migrations } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ExecutorFailure } from "../src/executor/failure.ts";
import { executorServiceManagement, type ServiceAccess } from "../src/executor/services.ts";

const postgres = postgresTestConfig();
const database = `mend_executor_services_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const db = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.href), maxConnections: 6 })),
);
const repos = ExecutorRepoLive.pipe(Layer.provideMerge(db));
const run = <A, E>(effect: Effect.Effect<A, E, ExecutorRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repos), Effect.scoped));
const organization = OrganizationId.make("service-org");
const callback = "http://localhost:3105/executor/service-callback";
const grant = {
  subject: "person",
  expiresAt: Date.now() + 3600000,
  accessToken: Redacted.make("fixture-service-grant"),
  refreshToken: Redacted.make("fixture-refresh-grant"),
};
let port = 0;
let completed = 0;
let submitted: unknown;
let destination: unknown;
let shared = false;
const app = {
  id: "app",
  name: "Fixture",
  requirements: {
    accounts: {
      service: {
        scope: "user",
        definition: {
          auth: {
            oauth: { type: "oauth2", label: "Sign in" },
            key: {
              type: "secrets",
              label: "API key",
              fields: {
                type: "object",
                properties: { apiKey: { type: "string", title: "API key" } },
                required: ["apiKey"],
              },
            },
          },
        },
      },
    },
  },
};
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const reply = (value: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.headers.authorization !== "Bearer fixture-service-grant") {
    res.writeHead(401);
    res.end("{}");
    return;
  }
  const path = (req.url ?? "").replace("/api/organizations/upstream", "");
  if (path === "/resources?view=available")
    return reply({
      apps: [
        {
          app,
          access: {
            audience: { kind: shared ? "everyone" : "private" },
            revision: "one",
            canUse: true,
            canManage: true,
          },
        },
      ],
      accounts: [],
    });
  if (path === "/apps/app/access") {
    if (req.method === "PATCH") shared = true;
    return reply({
      audience: { kind: shared ? "everyone" : "private" },
      revision: "one",
      canUse: true,
      canManage: true,
    });
  }
  if (path === "/apps/import" || path === "/apps/app") return reply(app);
  if (path === "/apps/app/accounts/user/service") return reply({ accounts: [] });
  if (path.endsWith("/connections")) {
    destination = JSON.parse(text);
    return reply({ id: "connection" });
  }
  if (path.endsWith("/oauth/start"))
    return reply({
      status: "redirect",
      authorizationUrl: "https://fixture.invalid/authorize?state=fixture-oauth-state",
      redirectUri: callback,
    });
  if (path.endsWith("/oauth/complete")) {
    completed++;
    return reply({ id: "account" });
  }
  if (path.endsWith("/submit")) {
    submitted = JSON.parse(text);
    return reply({ id: "account" });
  }
  res.writeHead(404);
  res.end("{}");
});
const management = Effect.gen(function* () {
  const repo = yield* ExecutorRepo;
  return executorServiceManagement({
    repo,
    appUrl: "http://localhost:3105",
    access: (_organization, actor, target) =>
      Effect.gen(function* () {
        if (target === "member" && actor !== "owner")
          return yield* new ExecutorFailure({ kind: "refused", message: "owner required" });
        const link = yield* repo.linkById("service-link");
        if (link === null)
          return yield* new ExecutorFailure({ kind: "refused", message: "link removed" });
        const selected: ServiceAccess = {
          configurationId: "config",
          linkId: link.id,
          executorOrganizationId: "upstream",
          target: `http://127.0.0.1:${port}`,
          grant,
        };
        return selected;
      }),
  });
});
let created = false;
describe.skipIf(postgres.skip)("service connections through HTTP and migrated PostgreSQL", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)).pipe(
        Effect.provide(admin),
        Effect.scoped,
      ),
    );
    created = true;
    await run(
      Effect.gen(function* () {
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO organizations (id,name) VALUES (${organization},'fixture')`;
        yield* sql`INSERT INTO organization_executors (organization_id,id,mode,url) VALUES (${organization},'config','mend-run','http://executor.localhost:4400')`;
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No HTTP fixture");
    port = address.port;
  });
  beforeEach(async () => {
    completed = 0;
    submitted = null;
    destination = null;
    shared = false;
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM executor_service_connections`;
        yield* sql`INSERT INTO executor_links (id,configuration_id,subject,state,sealed_credentials) VALUES ('service-link','config','person:person','active','fixture') ON CONFLICT (id) DO NOTHING`;
      }),
    );
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (created)
      await Effect.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`),
        ).pipe(Effect.provide(admin), Effect.scoped),
      );
  });
  const connect = (actor = "person", target: "person" | "member" = "person", method = "oauth") =>
    run(
      Effect.flatMap(management, (service) =>
        service.connectService(organization, actor, {
          target,
          service: "app",
          requirement: "service",
          method,
        }),
      ),
    );
  const finish = (actor = "person") =>
    run(
      Effect.flatMap(management, (service) =>
        service.finishService(organization, actor, {
          callbackUrl: Redacted.make(`${callback}?state=fixture-oauth-state&code=fixture-code`),
        }),
      ),
    );
  it("adds only the service chosen and shares the owner's import with everyone", async () => {
    await run(
      Effect.flatMap(management, (service) =>
        service.addService(organization, "owner", {
          target: "member",
          name: "Chosen",
          url: "https://fixture.invalid/mcp",
        }),
      ),
    );
    expect(shared).toBe(true);
    const directory = await run(
      Effect.flatMap(management, (service) => service.directory(organization, "person", "person")),
    );
    expect(directory.services[0]?.requirements[0]?.methods.map((method) => method.kind)).toEqual([
      "oauth",
      "fields",
    ]);
  });
  it("one callback wins across independent pools and a wrong actor cannot spend it", async () => {
    const result = await connect();
    expect(result.url).toContain("https://fixture.invalid/");
    expect(destination).toEqual({ destination: { kind: "personal" } });
    await expect(finish("another-person")).rejects.toThrow("belongs to another person");
    const results = await Promise.allSettled([finish(), finish()]);
    expect(results.filter((settled) => settled.status === "fulfilled")).toHaveLength(1);
    expect(completed).toBe(1);
  });
  it("refuses a removed link and deletes its pending connection", async () => {
    await connect();
    await run(Effect.flatMap(ExecutorRepo, (repo) => repo.deleteLink("service-link")));
    await expect(finish()).rejects.toThrow("already completed");
    expect(completed).toBe(0);
  });
  it("API-key fields go only to Executor and are discarded after submit", async () => {
    const result = await connect("person", "person", "key");
    expect(result.fields[0]?.secret).toBe(true);
    const id = result.id;
    if (id === null) throw new Error("No form connection");
    await run(
      Effect.flatMap(management, (service) =>
        service.submitService(organization, "person", {
          id,
          fields: Redacted.make({ apiKey: "synthetic-api-key" }),
        }),
      ),
    );
    expect(submitted).toEqual({ method: "key", fields: { apiKey: "synthetic-api-key" } });
    expect(
      await run(Effect.flatMap(ExecutorRepo, (repo) => repo.serviceConnection(id, "person"))),
    ).toBeNull();
  });
  it("a non-owner cannot start a shared account; an owner uses everyone's destination", async () => {
    await expect(connect("person", "member")).rejects.toThrow("owner required");
    await connect("owner", "member");
    expect(destination).toEqual({
      destination: { kind: "shared", audience: { kind: "everyone" } },
    });
  });
  it("an expired sign-in cannot exchange its code", async () => {
    await connect();
    await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`UPDATE executor_service_connections SET expires_at=now()-interval '1 second' WHERE state_hash=${createHash("sha256").update("fixture-oauth-state").digest("hex")}`,
      ),
    );
    await expect(finish()).rejects.toThrow("expired");
    expect(completed).toBe(0);
  });
});
