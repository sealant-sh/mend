import { PgClient } from "@effect/sql-pg";
import {
  accountOrganizationsGroup,
  invitationsGroup,
  operatorGroup,
  organizationGroup,
} from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import {
  AuditEventsRepoLive,
  DevicesRepoLive,
  InstanceRolesRepoLive,
  MemberRevocationsRepoLive,
  MendDBLive,
  migrations,
  OrganizationSettingsRepo,
  OrganizationsRepo,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  ResourceArchivesRepo,
  ServicesRepoLive,
  SessionControlEventsRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  SettingsRepo,
  SlackLinksRepoLive,
  UserEventsLive,
  UsersRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId } from "@mend/domain";
import { SealantClient } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { DeploymentConfig } from "@mend/store";
import { Context, Effect, Layer, ManagedRuntime, Option, Redacted, String as Str } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ProjectAccessLive } from "../access.ts";
import { ConnectionRegistry } from "../connections.ts";
import { MemberRemovalLive } from "../member-removal.ts";
import { SshKeyRevoker } from "../ssh-key-revocation.ts";
import { TenancyConfig } from "../tenancy.ts";
import { AuthMiddlewareLive } from "./api-live.ts";
import { OperatorGroupLive } from "./operator.ts";
import {
  AccountOrganizationsGroupLive,
  InvitationsGroupLive,
  OrganizationGroupLive,
} from "./organization.ts";

/**
 * Organization switching against PostgreSQL (docs/adr/0003, "Organization switching"): the real
 * memberships, sign-in pins, invitations, audit log and member removal, through the routes a
 * client calls. Each bearer is one Better Auth sign-in row, so a revoked sign-in is refused.
 *
 * - A: alice (owner), erin (owner), carol (member)
 * - B: bob (owner), erin (member; she joined A first)
 * - oscar operates the instance and belongs to no organization
 */

const postgres = postgresTestConfig();
const database = `mend_organization_switching_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(postgres.adminUrl);
databaseUrl.pathname = `/${database}`;

const A = OrganizationId.make("org-a");
const B = OrganizationId.make("org-b");

let tenancy: "single" | "multi" = "multi";
const effects: Array<string> = [];

const admin = (statement: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
      Effect.asVoid,
    ),
  );

const databaseLayer = MendDBLive.pipe(
  Layer.provideMerge(
    PgClient.layer({
      url: Redacted.make(databaseUrl.toString()),
      transformResultNames: Str.snakeToCamel,
      maxConnections: 8,
    }),
  ),
);

/** A bearer is a sign-in's token; the sign-in must stand and its account must not be deactivated. */
const authLayer = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      handler: () => Effect.succeed(new Response(null, { status: 404 })),
      issuePasswordReset: () => Effect.die("unused"),
      getSession: (headers: Headers) =>
        Effect.gen(function* () {
          const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
          const rows = yield* sql<{
            readonly sessionId: string;
            readonly userId: string;
            readonly name: string;
            readonly email: string;
          }>`
            SELECT s.id AS "sessionId", u.id AS "userId", u.name, u.email
              FROM "session" s JOIN "user" u ON u.id = s."userId"
             WHERE s.token = ${token} AND u."deactivatedAt" IS NULL`.pipe(Effect.orDie);
          const [row] = rows;
          return row === undefined
            ? Option.none()
            : Option.some({
                user: { id: row.userId, name: row.name, email: row.email },
                expiresAt: new Date("2030-01-01T00:00:00.000Z"),
                credential: `session:${row.sessionId}` as const,
              });
        }),
    };
  }),
);

const recorded = Layer.mergeAll(
  Layer.mock(SessionEngine, {
    launchUnderWay: () => false,
    windDownPerson: (userId, organizationId) =>
      Effect.sync(() => void effects.push(`windDown:${userId}:${organizationId}`)).pipe(
        Effect.as({ stopped: 0, retired: [], remaining: 0 }),
      ),
    reconcileHotSessions: () => Effect.void,
  }),
  Layer.mock(ConnectionRegistry, {
    closeForUser: (userId) =>
      Effect.sync(() => void effects.push(`closeAll:${userId}`)).pipe(Effect.as(0)),
    closeForMembership: (userId, organizationId) =>
      Effect.sync(() => void effects.push(`closeIn:${userId}:${organizationId}`)).pipe(
        Effect.as(0),
      ),
  }),
  Layer.mock(SshKeyRevoker, {
    attempt: (owed) =>
      Effect.sync(() => void effects.push(`sshKeys:${owed.userId}`)).pipe(
        Effect.as({ removed: 0, outstanding: 0 }),
      ),
  }),
  Layer.mock(ResourceArchivesRepo, {}),
  Layer.mock(SettingsRepo, {}),
  Layer.mock(OrganizationSettingsRepo, {}),
  Layer.mock(SealantClient, {}),
  Layer.succeed(TenancyConfig, {
    get mode() {
      return tenancy;
    },
    gate: Effect.succeed([]),
  }),
  Layer.succeed(DeploymentConfig, {
    mode: "local",
    sessionEndpoint: undefined,
    sessionStore: "captured",
  }),
);

const repos = Layer.mergeAll(
  OrganizationsRepoLive,
  AuditEventsRepoLive,
  UsersRepoLive,
  InstanceRolesRepoLive,
  ProjectsRepoLive,
  SessionsRepoLive,
  WorktreesRepoLive,
  WorktreeChangesRepoLive,
  SessionProcessesRepoLive,
  ServicesRepoLive,
  SessionControlEventsRepoLive,
  UserEventsLive,
  MemberRevocationsRepoLive.pipe(
    Layer.provideMerge(Layer.mergeAll(UsersRepoLive, DevicesRepoLive, SlackLinksRepoLive)),
  ),
).pipe(Layer.provideMerge(databaseLayer));

const dependencies = Layer.mergeAll(ProjectAccessLive, MemberRemovalLive, authLayer).pipe(
  Layer.provideMerge(Layer.mergeAll(repos, recorded)),
);

const api = HttpApi.make("mend")
  .add(organizationGroup)
  .add(accountOrganizationsGroup)
  .add(invitationsGroup)
  .add(operatorGroup)
  .prefix("/api");
const apiLayerWith = (auth: Auth["Service"]) =>
  HttpApiBuilder.layer(api).pipe(
    Layer.provide(
      Layer.mergeAll(
        OrganizationGroupLive,
        AccountOrganizationsGroupLive,
        InvitationsGroupLive,
        OperatorGroupLive,
      ),
    ),
    Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(Layer.succeed(Auth, auth)))),
    Layer.provide(HttpServer.layerServices),
  );

let runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<typeof dependencies>,
  Layer.Error<typeof dependencies>
>;
let web: {
  readonly handler: (request: Request, context: Context.Context<never>) => Promise<Response>;
  readonly dispose: () => Promise<void>;
} | null = null;

const query = <A>(
  statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, statement));

const call = async (bearer: string, method: string, path: string, body?: unknown) => {
  if (web === null) throw new Error("the API is not up");
  const context = await runtime.runPromise(Effect.context<Layer.Success<typeof dependencies>>());
  const headers = new Headers({ authorization: `Bearer ${bearer}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await web.handler(
    new Request(`http://api.internal${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    context,
  );
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
};

const field = (body: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null && key in value
        ? Reflect.get(value, key)
        : undefined,
    body,
  );

const activeOf = async (bearer: string) =>
  field((await call(bearer, "GET", "/api/organization")).body, "organization", "id") ?? null;

const membershipsOf = async (userId: string) =>
  (
    await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* OrganizationsRepo).memberships(userId);
      }),
    )
  )
    .map((membership) => `${membership.organization.id}:${membership.role}`)
    .toSorted();

const auditIn = (organizationId: OrganizationId) =>
  query(
    (sql) =>
      sql<{ readonly action: string; readonly actorUserId: string; readonly subjectId: string }>`
      SELECT action, actor_user_id AS "actorUserId", subject_id AS "subjectId"
        FROM audit_events WHERE organization_id = ${organizationId} ORDER BY created_at, id`,
  );

/** A fresh sign-in of `userId`: its token is its bearer. */
const signIn = (userId: string, token: string) =>
  query(
    (sql) =>
      sql`INSERT INTO "session" (id, "expiresAt", token, "userId")
          VALUES (${`s-${token}`}, now() + interval '1 day', ${token}, ${userId})`,
  );

const join = (organizationId: OrganizationId, userId: string, role: "owner" | "member") =>
  query(
    (sql) =>
      sql`INSERT INTO organization_members (organization_id, user_id, role)
          VALUES (${organizationId}, ${userId}, ${role})`,
  );

beforeAll(async () => {
  if (postgres.skip) return;
  await admin(`CREATE DATABASE ${database}`);
  runtime = ManagedRuntime.make(dependencies);
  await query((sql) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
        ([, migration]) => migration,
        { discard: true },
      );
      yield* sql`
        INSERT INTO "user" (id, name, email, "createdAt") VALUES
          ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z'),
          ('bob', 'Bob', 'bob@example.com', '2026-01-02T00:00:00Z'),
          ('carol', 'Carol', 'carol@example.com', '2026-01-03T00:00:00Z'),
          ('erin', 'Erin', 'erin@example.com', '2026-01-04T00:00:00Z'),
          ('oscar', 'Oscar', 'oscar@example.com', '2026-01-05T00:00:00Z'),
          ('gus', 'Gus', 'gus@example.com', '2026-01-06T00:00:00Z')`;
      yield* sql`INSERT INTO organizations (id, name) VALUES ('org-a', 'Acme'), ('org-b', 'Beta')`;
      yield* sql`INSERT INTO instance_roles (user_id, role) VALUES ('oscar', 'operator')`;
    }),
  );
  await join(A, "alice", "owner");
  await join(A, "erin", "owner");
  await join(A, "carol", "member");
  await join(B, "bob", "owner");
  // Joined after A, so a sign-in with no pin starts in A.
  await query(
    (sql) =>
      sql`INSERT INTO organization_members (organization_id, user_id, role, created_at)
          VALUES ('org-b', 'erin', 'member', now() + interval '1 minute')`,
  );
  for (const [userId, token] of [
    ["alice", "alice"],
    ["bob", "bob"],
    ["carol", "carol"],
    ["erin", "erin-web"],
    ["erin", "erin-cli"],
    ["oscar", "oscar"],
    ["gus", "gus"],
  ] as const) {
    await signIn(userId, token);
  }
  const auth = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Auth;
    }),
  );
  web = HttpRouter.toWebHandler(apiLayerWith(auth), { disableLogger: true });
}, 60_000);

afterAll(async () => {
  if (postgres.skip) return;
  await web?.dispose();
  await runtime.dispose();
  await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
});

beforeEach(() => {
  effects.length = 0;
  tenancy = "multi";
});

describe.skipIf(postgres.skip)("organization switching (PostgreSQL)", () => {
  it("each sign-in keeps its own organization: the web switches to B, the CLI stays in A", async () => {
    expect(await activeOf("erin-web")).toBe(A);
    expect(await activeOf("erin-cli")).toBe(A);
    const switched = await call("erin-web", "PUT", "/api/account/organizations/active", {
      organizationId: B,
    });
    expect([switched.status, field(switched.body, "role")]).toEqual([200, "member"]);
    expect(await activeOf("erin-web")).toBe(B);
    expect(await activeOf("erin-cli")).toBe(A);
    const listed = await call("erin-web", "GET", "/api/account/organizations");
    expect(
      Array.isArray(listed.body)
        ? listed.body.map((row: unknown) => [
            field(row, "organization", "name"),
            field(row, "role"),
            field(row, "active"),
          ])
        : listed.body,
    ).toEqual([
      ["Acme", "owner", false],
      ["Beta", "member", true],
    ]);
    // Owning A grants nothing in B: B's audit log and roster changes stay its owners'.
    expect((await call("erin-web", "GET", "/api/organization/audit")).status).toBe(404);
    expect((await call("erin-cli", "GET", "/api/organization/audit")).status).toBe(200);
    // Switching is personal: no organization's audit log records it.
    expect((await auditIn(A)).concat(await auditIn(B))).toEqual([]);
  });

  it("a new sign-in starts where the account switched last", async () => {
    await signIn("erin", "erin-phone");
    expect(await activeOf("erin-phone")).toBe(B);
  });

  it("switching to an organization the account is not in answers 404 and changes nothing", async () => {
    const refused = await call("bob", "PUT", "/api/account/organizations/active", {
      organizationId: A,
    });
    expect(refused.status).toBe(404);
    expect(await activeOf("bob")).toBe(B);
    expect(await membershipsOf("bob")).toEqual(["org-b:owner"]);
  });

  it("an invitation accepted by a signed-in member of A adds B, switches that sign-in, and makes no account", async () => {
    const minted = await call("bob", "POST", "/api/organization/invitations", { role: "member" });
    expect(minted.status).toBe(200);
    const token = String(field(minted.body, "token"));
    const accounts = await query((sql) => sql`SELECT count(*)::int AS n FROM "user"`);
    const accepted = await call("carol", "POST", "/api/invitations/accept", { token });
    expect([accepted.status, field(accepted.body, "organization", "id")]).toEqual([200, B]);
    expect(await membershipsOf("carol")).toEqual(["org-a:member", "org-b:member"]);
    expect(await activeOf("carol")).toBe(B);
    expect(await query((sql) => sql`SELECT count(*)::int AS n FROM "user"`)).toEqual(accounts);
    expect((await auditIn(B)).map((event) => `${event.action}:${event.subjectId}`)).toContain(
      "invitation.accepted:carol",
    );
    const again = await call("carol", "POST", "/api/invitations/accept", { token });
    expect([again.status, field(again.body, "state")]).toEqual([409, "accepted"]);
  });

  it("an email-bound invitation still refuses a signed-in account with another email", async () => {
    const minted = await call("bob", "POST", "/api/organization/invitations", {
      role: "member",
      email: "someone@example.com",
    });
    const token = String(field(minted.body, "token"));
    const refused = await call("alice", "POST", "/api/invitations/accept", { token });
    expect(refused.status).toBe(422);
    expect(await membershipsOf("alice")).toEqual(["org-a:owner"]);
  });

  it("the operator adds an existing account: recorded in that organization's log, and the operator reads nothing there", async () => {
    const added = await call("oscar", "POST", `/api/operator/organizations/${B}/members`, {
      email: "alice@example.com",
      role: "member",
    });
    expect(added.status).toBe(204);
    expect(await membershipsOf("alice")).toEqual(["org-a:owner", "org-b:member"]);
    expect(
      (await auditIn(B)).find(
        (event) => event.action === "member.added" && event.subjectId === "alice",
      ),
    ).toEqual({ action: "member.added", actorUserId: "oscar", subjectId: "alice" });
    expect(await membershipsOf("oscar")).toEqual([]);
    expect((await call("oscar", "GET", "/api/organization/members")).status).toBe(404);
    const twice = await call("oscar", "POST", `/api/operator/organizations/${B}/members`, {
      email: "alice@example.com",
      role: "owner",
    });
    expect(twice.status).toBe(422);
    const unknown = await call("oscar", "POST", `/api/operator/organizations/${B}/members`, {
      email: "nobody@example.com",
      role: "member",
    });
    expect(unknown.status).toBe(422);
    // Only the operator may: an owner of B is refused like anyone else.
    const byOwner = await call("bob", "POST", `/api/operator/organizations/${B}/members`, {
      email: "gus@example.com",
      role: "member",
    });
    expect(byOwner.status).toBe(404);
  });

  it("with MEND_TENANCY=single the operator cannot add anyone to another organization", async () => {
    tenancy = "single";
    const refused = await call("oscar", "POST", `/api/operator/organizations/${A}/members`, {
      email: "bob@example.com",
      role: "member",
    });
    expect(refused.status).toBe(422);
    expect(await membershipsOf("bob")).toEqual(["org-b:owner"]);
  });

  it("removal from A leaves B: the account, its sign-ins and its work in B go on", async () => {
    const removed = await call("alice", "DELETE", "/api/organization/members/erin");
    expect(removed.status).toBe(200);
    expect(await membershipsOf("erin")).toEqual(["org-b:member"]);
    // The CLI acted in A: its pin went with the membership, and it falls back to B.
    expect(await activeOf("erin-cli")).toBe(B);
    expect(await activeOf("erin-web")).toBe(B);
    expect(effects.toSorted()).toEqual(["closeIn:erin:org-a", "windDown:erin:org-a"]);
    const account = await query(
      (sql) => sql`SELECT "deactivatedAt" AS deactivated FROM "user" WHERE id = 'erin'`,
    );
    expect(account).toEqual([{ deactivated: null }]);
  });

  it("leaving is refused for the only organization and for its last owner, and recorded as leaving", async () => {
    const only = await call("erin-web", "DELETE", `/api/account/organizations/${B}`);
    expect([only.status, field(only.body, "message")]).toEqual([
      422,
      "This is your only organization. Ask one of its owners to remove you instead.",
    ]);
    await join(A, "bob", "member");
    const lastOwner = await call("bob", "DELETE", `/api/account/organizations/${B}`);
    expect(lastOwner.status).toBe(422);
    expect(await membershipsOf("bob")).toEqual(["org-a:member", "org-b:owner"]);
    const left = await call("bob", "DELETE", `/api/account/organizations/${A}`);
    expect(left.status).toBe(204);
    expect(await membershipsOf("bob")).toEqual(["org-b:owner"]);
    expect((await auditIn(A)).at(-1)).toEqual({
      action: "member.left",
      actorUserId: "bob",
      subjectId: "bob",
    });
    const stranger = await call("bob", "DELETE", `/api/account/organizations/${A}`);
    expect(stranger.status).toBe(404);
  });

  it("removal from the last organization still deactivates the account and ends its sign-ins", async () => {
    const removed = await call("bob", "DELETE", "/api/organization/members/erin");
    expect(removed.status).toBe(200);
    expect(await membershipsOf("erin")).toEqual([]);
    expect(effects).toContain("closeAll:erin");
    expect(effects).toContain("sshKeys:erin");
    expect((await call("erin-web", "GET", "/api/account/organizations")).status).toBe(401);
  });
});
