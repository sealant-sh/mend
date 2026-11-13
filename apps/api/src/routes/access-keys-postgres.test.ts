import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import {
  AuthMiddleware,
  accessKeysGroup,
  accountOrganizationsGroup,
  cliAuthGroup,
  NotFound,
  organizationGroup,
  pairGroup,
  projectsGroup,
  SessionNotSteerable,
  userDevicesGroup,
} from "@mend/api-contracts";
import { Auth, AuthLive, RegistrationPolicy } from "@mend/auth";
import {
  AccessKeysRepoLive,
  AgentConversationRepoLive,
  AuditEventsRepo,
  AuditEventsRepoLive,
  DevicesRepoLive,
  HotWorkspacesRepo,
  InstanceRolesRepoLive,
  MemberRevocationsRepoLive,
  MendDBLive,
  migrations,
  OrganizationSettingsRepo,
  OrganizationsRepo,
  OrganizationsRepoLive,
  ProjectsRepo,
  ProjectsRepoLive,
  ResourceArchivesRepo,
  ResourcesRepo,
  ServiceForwardsRepo,
  ServicesRepoLive,
  SessionControlEventsRepoLive,
  SessionProcessesRepoLive,
  SessionRepositoriesRepo,
  SessionsRepoLive,
  SettingsRepo,
  SlackLinksRepoLive,
  UpgradeTicketsRepo,
  UpgradeTicketsRepoLive,
  upgradeTicketScope,
  UserEventsLive,
  UserGitAccessRepoLive,
  UserGitAuthorRepoLive,
  UsersRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { type OrganizationId, ProjectId, SessionId } from "@mend/domain";
import { UNREAD } from "@mend/domain/runtime-support-fixtures";
import { JobRunner } from "@mend/jobs";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { SealantClient, workspaceRuntimesReportOf } from "@mend/sealant";
import { ResourceStatusReadsNone, SessionEngine, WorktreeReads } from "@mend/sessions";
import {
  AgentBridge,
  DeploymentConfig,
  MendKeys,
  makeSourcePolicy,
  SourcePolicy,
  Store,
  StoreConfig,
} from "@mend/store";
import {
  ConfigProvider,
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
  String as Str,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectAccessLive } from "../access.ts";
import { AdoptionsLive } from "../adoptions.ts";
import { Budgets, DEFAULT_BUDGET_LIMITS, makeBudgets } from "../budgets.ts";
import { ConnectionRegistry } from "../connections.ts";
import { errorBoundary } from "../error-boundary.ts";
import { GithubIdentity } from "../github-identity.ts";
import { MemberRemovalLive } from "../member-removal.ts";
import { ProjectCreationLive } from "../project-creation.ts";
import { Removal } from "../removal.ts";
import { SessionSteering, SessionSteeringLive } from "../session-steering.ts";
import { SshKeyRevoker } from "../ssh-key-revocation.ts";
import { TenancyConfig } from "../tenancy.ts";
import { AccessKeysGroupLive } from "./access-keys.ts";
import { AuthMiddlewareLive } from "./api-live.ts";
import { DevicePairingLive } from "./devices.ts";
import { Gh } from "./github.ts";
import { AccountOrganizationsGroupLive, OrganizationGroupLive } from "./organization.ts";
import { isUpgradeCaller, resolveUpgradeCaller } from "./upgrade-tickets.ts";
import { ProjectsGroupLive } from "./workbench.ts";

/**
 * Access keys (docs/adr/0023-access-keys.md) as an automation uses them: minted over HTTP by a
 * signed-in person, presented as `Authorization: Bearer mak_…` to the real Auth, PostgreSQL and
 * the real project access and steering rules.
 */

const postgres = postgresTestConfig();
const database = `mend_access_keys_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(postgres.adminUrl);
databaseUrl.pathname = `/${database}`;
const origin = "http://localhost:3105";
const network = makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)(origin), []);
const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    DATABASE_URL: databaseUrl.toString(),
    BETTER_AUTH_SECRET: "disposable-access-key-test-secret-32-bytes",
    MEND_STATIC_TOKEN: "",
  }),
);
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mend-access-keys-"));

const databaseLayer = MendDBLive.pipe(
  Layer.provideMerge(
    PgClient.layer({
      url: Redacted.make(databaseUrl.toString()),
      transformResultNames: Str.snakeToCamel,
      maxConnections: 6,
    }),
  ),
);
const repos = Layer.mergeAll(
  AccessKeysRepoLive,
  AgentConversationRepoLive,
  AuditEventsRepoLive,
  DevicesRepoLive,
  InstanceRolesRepoLive,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  UpgradeTicketsRepoLive,
  UserGitAccessRepoLive,
  UserGitAuthorRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
  SessionControlEventsRepoLive,
  UserEventsLive,
  MemberRevocationsRepoLive.pipe(
    Layer.provideMerge(Layer.mergeAll(UsersRepoLive, DevicesRepoLive, SlackLinksRepoLive)),
  ),
);
const unused = Layer.mergeAll(
  Layer.succeed(
    SourcePolicy,
    makeSourcePolicy({ profile: "operator", allowedHosts: [], resolve: async () => [] }),
  ),
  Layer.mock(AgentBridge, { socketPath: () => "/unused/agent.sock" }),
  Layer.mock(MendKeys, {}),
  Layer.mock(ServiceForwardsRepo, {}),
  Layer.mock(ResourcesRepo, {}),
  ResourceStatusReadsNone,
  Layer.mock(SessionEngine, {
    launchUnderWay: () => false,
    personLayoutPossible: () => Effect.succeed(false),
    reconcileHotSessions: () => Effect.void,
    windDownPerson: () => Effect.succeed({ stopped: 0, retired: [], remaining: 0 }),
  }),
  Layer.mock(ConnectionRegistry, {
    closeForUser: () => Effect.succeed(0),
    closeForMembership: () => Effect.succeed(0),
  }),
  Layer.mock(SshKeyRevoker, { attempt: () => Effect.succeed({ removed: 0, outstanding: 0 }) }),
  Layer.mock(ResourceArchivesRepo, {}),
  Layer.mock(OrganizationSettingsRepo, {}),
  Layer.mock(SettingsRepo, {}),
  workspaceRuntimesReportOf(UNREAD),
  Layer.mock(HotWorkspacesRepo, {}),
  Layer.mock(SealantClient, {}),
  Layer.mock(JobRunner, {}),
  Layer.mock(WorktreeReads, {}),
  Layer.mock(Gh, {}),
  Layer.mock(GithubIdentity, {}),
  Layer.mock(SessionRepositoriesRepo, { listForProject: () => Effect.succeed([]) }),
  Layer.mock(Removal, {}),
  Layer.succeed(DeploymentConfig, {
    mode: "local",
    sessionEndpoint: undefined,
    sessionStore: "captured",
  }),
  Layer.succeed(TenancyConfig, { mode: "single", gate: Effect.succeed([]) }),
);
const authLayer = AuthLive.pipe(
  Layer.provide(
    Layer.succeed(RegistrationPolicy, {
      decide: () => Effect.succeed({ kind: "bootstrap" }),
      registered: () => Effect.void,
    }),
  ),
);
const dependencies = Layer.mergeAll(
  Layer.succeed(Budgets, makeBudgets(DEFAULT_BUDGET_LIMITS)),
  SessionSteeringLive,
  ProjectCreationLive,
  AdoptionsLive,
  MemberRemovalLive,
).pipe(
  Layer.provideMerge(ProjectAccessLive),
  Layer.provideMerge(
    Layer.mergeAll(
      repos,
      unused,
      authLayer,
      Store.layer.pipe(Layer.provide(StoreConfig.layerFor(storeRoot))),
    ),
  ),
  Layer.provideMerge(Layer.succeed(NetworkConfig, network)),
  Layer.provideMerge(databaseLayer),
  Layer.provide(config),
);
type Services = Layer.Success<typeof dependencies>;
const runtime = ManagedRuntime.make(dependencies);

/** The gate `POST /api/sessions/:id/messages` passes before it reaches the engine. */
const steeringGroup = HttpApiGroup.make("steering")
  .add(
    HttpApiEndpoint.post("steer", "/steer/:id", {
      params: Schema.Struct({ id: SessionId }),
      error: [NotFound, SessionNotSteerable],
    }),
  )
  .middleware(AuthMiddleware);
const testApi = HttpApi.make("mend")
  .add(accessKeysGroup)
  .add(userDevicesGroup)
  .add(pairGroup)
  .add(cliAuthGroup)
  .add(projectsGroup)
  .add(steeringGroup)
  .add(organizationGroup)
  .add(accountOrganizationsGroup)
  .prefix("/api");
const SteeringGroupLive = HttpApiBuilder.group(testApi, "steering", (handlers) =>
  handlers.handle("steer", ({ params }) =>
    Effect.gen(function* () {
      yield* (yield* SessionSteering).session(params.id);
    }),
  ),
);
const api = Layer.mergeAll(
  HttpApiBuilder.layer(testApi).pipe(
    Layer.provide(
      Layer.mergeAll(
        AccessKeysGroupLive,
        DevicePairingLive,
        ProjectsGroupLive,
        SteeringGroupLive,
        OrganizationGroupLive,
        AccountOrganizationsGroupLive,
      ),
    ),
    Layer.provide(AuthMiddlewareLive),
  ),
  errorBoundary({ mode: "redacted" }),
).pipe(Layer.provide(HttpServer.layerServices));
const makeHandler = (context: Context.Context<Services>) =>
  HttpRouter.toWebHandler(api.pipe(Layer.provide(Layer.succeedContext(context))), {
    disableLogger: true,
  });
let web: ReturnType<typeof makeHandler> | undefined;

const inWorld = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
const admin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );
const sql = <A>(work: (client: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  inWorld(Effect.flatMap(SqlClient.SqlClient, work).pipe(Effect.orDie));

const call = async (
  bearer: string | null,
  method: "GET" | "POST" | "PUT" | "DELETE",
  route: string,
  body?: unknown,
  scheme = "Bearer",
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const context = await runtime.runPromise(Effect.context<Services>());
  if (web === undefined) throw new Error("the API is built in beforeAll");
  const headers = new Headers({ "content-type": "application/json" });
  if (bearer !== null) headers.set("authorization", `${scheme} ${bearer}`);
  const response = await web.handler(
    new Request(`${origin}/api${route}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    context,
  );
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
};

const SignedUp = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
const signUp = async (email: string, name: string) => {
  const response = await inWorld(
    Effect.flatMap(Auth, (auth) =>
      auth.handler(
        new Request(`${origin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email, name, password: "disposable-access-key-password" }),
        }),
      ),
    ),
  );
  expect(response.status).toBe(200);
  const account = Schema.decodeUnknownSync(SignedUp)(await response.json());
  const bearer = response.headers.get("set-auth-token");
  if (bearer === null) throw new Error("sign-up issued no bearer");
  return { id: account.user.id, bearer };
};

const WireKey = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  organizationId: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
});
const Created = Schema.Struct({ key: WireKey, secret: Schema.String });
const Listed = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));
const WireProjects = Schema.Array(Schema.Struct({ id: Schema.String }));

const createKey = async (signIn: string, name: string, expiresInDays: number | null = 90) => {
  const answer = await call(signIn, "POST", "/me/access-keys", { name, expiresInDays });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return Schema.decodeUnknownSync(Created)(answer.body);
};
const listedIds = async (bearer: string, route: "/me/access-keys" | "/me/devices") => {
  const answer = await call(bearer, "GET", route);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return Schema.decodeUnknownSync(Listed)(answer.body).map((row) => row.id);
};
const visibleProjects = async (bearer: string) => {
  const answer = await call(bearer, "GET", "/projects");
  if (answer.status !== 200) return answer.status;
  return Schema.decodeUnknownSync(WireProjects)(answer.body)
    .map((project) => project.id)
    .toSorted();
};
const signInAgain = async (email: string) => {
  const response = await inWorld(
    Effect.flatMap(Auth, (auth) =>
      auth.handler(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email, password: "disposable-access-key-password" }),
        }),
      ),
    ),
  );
  expect(response.status).toBe(200);
  const bearer = response.headers.get("set-auth-token");
  if (bearer === null) throw new Error("sign-in issued no bearer");
  return bearer;
};
const ActiveOrganization = Schema.Struct({ organization: Schema.Struct({ id: Schema.String }) });
const activeOf = async (bearer: string) => {
  const answer = await call(bearer, "GET", "/organization");
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return Schema.decodeUnknownSync(ActiveOrganization)(answer.body).organization.id;
};
const switchTo = async (bearer: string, organizationId: OrganizationId) => {
  const answer = await call(bearer, "PUT", "/account/organizations/active", { organizationId });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
};
const reads = async (bearer: string, ...keys: ReadonlyArray<string>) =>
  Object.fromEntries(
    await Promise.all(
      keys.map(
        async (key) =>
          [key, (await call(bearer, "GET", `/projects/${project(key)}`)).status] as const,
      ),
    ),
  );
const pinsOf = (userId: string) =>
  sql(
    (client) => client<{ readonly credential: string; readonly organizationId: string }>`
      SELECT credential, organization_id FROM credential_organizations
       WHERE user_id = ${userId} ORDER BY credential`,
  );
const keyPins = () =>
  sql(
    (client) =>
      client<{
        readonly credential: string;
      }>`SELECT credential FROM credential_organizations WHERE credential LIKE 'key:%'`,
  );

const auditOf = (organizationId: OrganizationId) =>
  inWorld(
    Effect.flatMap(AuditEventsRepo, (audit) =>
      audit.listForOrganization(organizationId, { beforeId: null, limit: 200 }),
    ),
  );

interface Person {
  readonly id: string;
  readonly bearer: string;
}
let ana: Person;
let ben: Person;
let cleo: Person;
let acme: OrganizationId;
let globex: OrganizationId;

const project = (key: string) => ProjectId.make(`project-${key}`);
const anaSession = SessionId.make("session-ana");
const cleoSession = SessionId.make("session-cleo");

describe.skipIf(postgres.skip)("access keys through real Auth and PostgreSQL", () => {
  beforeAll(async () => {
    await admin(
      Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(`CREATE DATABASE ${database}`)),
    );
    await inWorld(
      Effect.forEach(
        Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
        ([, migration]) => migration,
        { discard: true },
      ),
    );
    web = makeHandler(await runtime.runPromise(Effect.context<Services>()));
    ana = await signUp("ana@example.invalid", "Ana");
    ben = await signUp("ben@example.invalid", "Ben");
    cleo = await signUp("cleo@example.invalid", "Cleo");
    const orgs = await inWorld(
      Effect.gen(function* () {
        const organizations = yield* OrganizationsRepo;
        const home = yield* organizations.create("Acme", null);
        const elsewhere = yield* organizations.create("Globex", null);
        yield* organizations.addMember(home.id, ana.id, "owner", null);
        yield* organizations.addMember(home.id, ben.id, "member", null);
        yield* organizations.addMember(elsewhere.id, cleo.id, "owner", null);
        const projects = yield* ProjectsRepo;
        const rows = [
          { key: "a-shared", org: home.id, visibility: "shared", creator: ana.id },
          { key: "a-private-ana", org: home.id, visibility: "private", creator: ana.id },
          { key: "a-private-ben", org: home.id, visibility: "private", creator: ben.id },
          { key: "b-shared", org: elsewhere.id, visibility: "shared", creator: cleo.id },
        ] as const;
        for (const row of rows) {
          yield* projects.create({
            id: project(row.key),
            organizationId: row.org,
            visibility: row.visibility,
            createdByUserId: row.creator,
            name: row.key,
            originUrl: null,
            storePath: `/elsewhere/${row.key}/repo.git`,
            defaultBranch: "main",
            adoptedSha: null,
            gitAuthMode: "mend-key",
          });
        }
        return { home: home.id, elsewhere: elsewhere.id };
      }),
    );
    acme = orgs.home;
    globex = orgs.elsewhere;
    await sql((client) =>
      Effect.gen(function* () {
        for (const [session, key, owner] of [
          [anaSession, "a-shared", ana.id],
          [cleoSession, "b-shared", cleo.id],
        ] as const) {
          yield* client`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
            VALUES (${`wt-${session}`},${project(key)},'wt','wt','mend/wt','abc')`;
          yield* client`INSERT INTO agent_sessions
            (id,project_id,worktree_id,harness,worktree,branch,base_sha,owner_user_id)
            VALUES (${session},${project(key)},${`wt-${session}`},'claude','wt','mend/wt','abc',${owner})`;
        }
      }),
    );
  });

  afterAll(async () => {
    try {
      await web?.dispose();
      await runtime.dispose();
    } finally {
      await admin(
        Effect.flatMap(SqlClient.SqlClient, (client) =>
          client.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
        ),
      );
      fs.rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  it("works as a bearer on the API, as its person, in their organization only", async () => {
    const created = await createKey(ben.bearer, "ci-bot");
    expect(created.secret.startsWith(`mak_${created.key.id}_`)).toBe(true);
    expect(created.key).toMatchObject({ name: "ci-bot", organizationId: acme, lastUsedAt: null });
    expect(await visibleProjects(created.secret)).toEqual([
      project("a-private-ben"),
      project("a-shared"),
    ]);
    const otherProject = await call(created.secret, "GET", `/projects/${project("b-shared")}`);
    const otherSession = await call(created.secret, "POST", `/steer/${cleoSession}`);
    expect([otherProject.status, otherSession.status]).toEqual([404, 404]);
  });

  it("is refused once revoked, expired, deactivated, or its person leaves the organization", async () => {
    const revoked = await createKey(ben.bearer, "revoked");
    const expired = await createKey(ben.bearer, "expired");
    const departed = await createKey(cleo.bearer, "departed");
    for (const key of [revoked, expired, departed]) {
      expect(await visibleProjects(key.secret)).not.toBe(401);
    }

    expect((await call(ben.bearer, "DELETE", `/me/access-keys/${revoked.key.id}`)).status).toBe(
      200,
    );
    await sql(
      (client) =>
        client`UPDATE device_tokens SET expires_at = now() - interval '1 second' WHERE id = ${expired.key.id}`,
    );
    await sql(
      (client) =>
        client`DELETE FROM organization_members WHERE organization_id = ${globex} AND user_id = ${cleo.id}`,
    );
    expect({
      revoked: await visibleProjects(revoked.secret),
      expired: await visibleProjects(expired.secret),
      departed: await visibleProjects(departed.secret),
      // Expired keys stay listed until revoked, so their person sees why a job stopped.
      listed: (await listedIds(ben.bearer, "/me/access-keys")).includes(expired.key.id),
    }).toEqual({ revoked: 401, expired: 401, departed: 401, listed: true });
    await sql(
      (client) =>
        client`INSERT INTO organization_members (organization_id, user_id, role) VALUES (${globex}, ${cleo.id}, 'owner')`,
    );

    const deactivated = await signUp("dee@example.invalid", "Dee");
    await inWorld(
      Effect.flatMap(OrganizationsRepo, (organizations) =>
        organizations.addMember(acme, deactivated.id, "member", null),
      ),
    );
    const deesKey = await createKey(deactivated.bearer, "dee");
    expect(await visibleProjects(deesKey.secret)).not.toBe(401);
    await sql(
      (client) => client`UPDATE "user" SET "deactivatedAt" = now() WHERE id = ${deactivated.id}`,
    );
    expect(await visibleProjects(deesKey.secret)).toBe(401);
  });

  it("is proven by its whole form: a wrong secret, the bare secret or a URL never sign in", async () => {
    const created = await createKey(ben.bearer, "forms");
    const secret = created.secret.slice(`mak_${created.key.id}_`.length);
    const caller = (headers: Headers, url: string) =>
      inWorld(
        Effect.gen(function* () {
          return yield* resolveUpgradeCaller({
            auth: yield* Auth,
            tickets: yield* UpgradeTicketsRepo,
            organizations: yield* OrganizationsRepo,
            urlBearers: { mode: "accept" },
            headers,
            url: new URL(url),
            target: "tty",
          });
        }),
      );
    const inUrl = await caller(
      new Headers(),
      `${origin}/api/tty?session=s1&token=${encodeURIComponent(created.secret)}`,
    );
    const inHeader = await caller(
      new Headers({ authorization: `Bearer ${created.secret}` }),
      `${origin}/api/tty?session=s1`,
    );
    const signInPage = await inWorld(
      Effect.flatMap(Auth, (auth) =>
        auth.handler(
          new Request(`${origin}/api/auth/get-session`, {
            headers: { authorization: `Bearer ${created.secret}` },
          }),
        ),
      ),
    );
    expect({
      wrongSecret: await visibleProjects(`mak_${created.key.id}_${"A".repeat(43)}`),
      bareSecret: await visibleProjects(secret),
      anotherId: await visibleProjects(`mak_${crypto.randomUUID()}_${secret}`),
      lowerCaseScheme: (await call(created.secret, "GET", "/projects", undefined, "bearer")).status,
      inUrl: isUpgradeCaller(inUrl) ? "accepted" : inUrl.status,
      inHeader: isUpgradeCaller(inHeader) ? inHeader.credential : inHeader.status,
      signInPage: signInPage.status,
    }).toEqual({
      wrongSecret: 401,
      bareSecret: 401,
      anotherId: 401,
      lowerCaseScheme: 200,
      inUrl: 400,
      inHeader: `key:${created.key.id}`,
      signInPage: 401,
    });
  });

  it("steers another member's session only once its owner shares control", async () => {
    const created = await createKey(ben.bearer, "steer");
    const refused = await call(created.secret, "POST", `/steer/${anaSession}`);
    expect(refused).toMatchObject({ status: 403, body: { _tag: "SessionNotSteerable" } });
    await sql(
      (client) =>
        client`UPDATE agent_sessions SET shared_control_enabled_at = now(), shared_control_enabled_by_user_id = ${ana.id} WHERE id = ${anaSession}`,
    );
    const shared = await call(created.secret, "POST", `/steer/${anaSession}`);
    await sql(
      (client) =>
        client`UPDATE agent_sessions SET shared_control_enabled_at = NULL, shared_control_enabled_by_user_id = NULL WHERE id = ${anaSession}`,
    );
    expect(shared.status).toBe(204);
  });

  it("cannot create or manage credentials; a sign-in and a device can", async () => {
    const created = await createKey(ana.bearer, "refused");
    const minted = await call(ana.bearer, "POST", "/me/devices", {
      name: "phone",
      platform: "ios",
    });
    expect(minted.status).toBe(200);
    const device = Schema.decodeUnknownSync(
      Schema.Struct({ token: Schema.String, device: Schema.Struct({ id: Schema.String }) }),
    )(minted.body);
    const asKey = [
      await call(created.secret, "GET", "/me/access-keys"),
      await call(created.secret, "POST", "/me/access-keys", { name: "x", expiresInDays: null }),
      await call(created.secret, "DELETE", `/me/access-keys/${created.key.id}`),
      await call(created.secret, "POST", "/me/devices", { name: "x", platform: "other" }),
      await call(created.secret, "POST", "/me/devices/pairings"),
      await call(created.secret, "POST", "/me/cli-auth/ABCD-EFGH/approve"),
    ];
    expect(asKey.map((answer) => [answer.status, answer.body])).toEqual(
      asKey.map(() => [
        403,
        {
          _tag: "AccessKeyRefused",
          message:
            "An access key cannot create or manage credentials. Sign in to Mend, or use a CLI signed in with mend login.",
        },
      ]),
    );
    expect({
      signIn: (await call(ana.bearer, "GET", "/me/access-keys")).status,
      device: (await call(device.token, "GET", "/me/access-keys")).status,
      deviceApproves: (await call(device.token, "POST", "/me/cli-auth/ABCD-EFGH/approve")).status,
    }).toEqual({ signIn: 200, device: 200, deviceApproves: 404 });
    expect(await listedIds(ana.bearer, "/me/access-keys")).toContain(created.key.id);
  });

  it("lists keys and devices apart, never with a secret, and revokes neither as the other", async () => {
    const created = await createKey(ana.bearer, "apart", null);
    const minted = await call(ana.bearer, "POST", "/me/devices", {
      name: "tablet",
      platform: "android",
    });
    const deviceId = Schema.decodeUnknownSync(
      Schema.Struct({ device: Schema.Struct({ id: Schema.String }) }),
    )(minted.body).device.id;
    const keyList = await call(ana.bearer, "GET", "/me/access-keys");
    const keys = await listedIds(ana.bearer, "/me/access-keys");
    const devices = await listedIds(ana.bearer, "/me/devices");
    expect({
      keyListed: keys.includes(created.key.id),
      deviceInKeys: keys.includes(deviceId),
      deviceListed: devices.includes(deviceId),
      keyInDevices: devices.includes(created.key.id),
      secretInList: JSON.stringify(keyList.body).includes(created.secret.slice(-20)),
      revokeKeyAsDevice: (await call(ana.bearer, "DELETE", `/me/devices/${created.key.id}`)).status,
      revokeDeviceAsKey: (await call(ana.bearer, "DELETE", `/me/access-keys/${deviceId}`)).status,
      revokeOthersKey: (await call(ben.bearer, "DELETE", `/me/access-keys/${created.key.id}`))
        .status,
      stillWorks: Array.isArray(await visibleProjects(created.secret)),
    }).toEqual({
      keyListed: true,
      deviceInKeys: false,
      deviceListed: true,
      keyInDevices: false,
      secretInList: false,
      revokeKeyAsDevice: 404,
      revokeDeviceAsKey: 404,
      revokeOthersKey: 404,
      stillWorks: true,
    });
  });

  it("is refused a key when its person belongs to no organization", async () => {
    const loner = await signUp("loner@example.invalid", "Loner");
    const answer = await call(loner.bearer, "POST", "/me/access-keys", {
      name: "nowhere",
      expiresInDays: 30,
    });
    expect(answer).toMatchObject({ status: 409, body: { _tag: "AccessKeyNeedsOrganization" } });
  });

  it("is audited when created, used and revoked, and names itself beside what it did", async () => {
    const created = await createKey(ana.bearer, "audited", 30);
    for (let request = 0; request < 3; request++) {
      expect(Array.isArray(await visibleProjects(created.secret))).toBe(true);
    }
    // A minute later the stamp moves again; still within the hour, so no second `used` row.
    await sql(
      (client) =>
        client`UPDATE device_tokens SET last_used_at = now() - interval '2 minutes' WHERE id = ${created.key.id}`,
    );
    await visibleProjects(created.secret);
    const changed = await call(
      created.secret,
      "PUT",
      `/projects/${project("a-private-ana")}/visibility`,
      { visibility: "shared" },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await call(ana.bearer, "DELETE", `/me/access-keys/${created.key.id}`)).status).toBe(
      200,
    );
    const again = await createKey(ana.bearer, "again", 30);
    await visibleProjects(again.secret);
    await sql(
      (client) =>
        client`UPDATE device_tokens SET last_used_at = now() - interval '61 minutes' WHERE id = ${again.key.id}`,
    );
    await visibleProjects(again.secret);

    const events = await auditOf(acme);
    const about = (id: string) =>
      events
        .filter((event) => event.subjectId === id || event.accessKey?.id === id)
        .map((event) => ({
          action: event.action,
          actor: event.actorUserId,
          data: event.data,
          accessKey: event.accessKey,
        }))
        .toReversed();
    expect(about(created.key.id)).toEqual([
      { action: "access_key.created", actor: ana.id, data: { name: "audited" }, accessKey: null },
      {
        action: "access_key.used",
        actor: ana.id,
        data: { name: "audited" },
        accessKey: { id: created.key.id, name: "audited" },
      },
      {
        action: "project.visibility_changed",
        actor: ana.id,
        data: { visibility: "shared" },
        accessKey: { id: created.key.id, name: "audited" },
      },
      { action: "access_key.revoked", actor: ana.id, data: { name: "audited" }, accessKey: null },
    ]);
    expect(about(again.key.id).filter((event) => event.action === "access_key.used")).toHaveLength(
      2,
    );
    const stamped = await sql(
      (client) =>
        client<{
          readonly lastUsedAt: Date | null;
        }>`SELECT last_used_at FROM device_tokens WHERE id = ${created.key.id}`,
    );
    expect(stamped[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("ends the upgrade tickets it minted once revoked", async () => {
    const created = await createKey(ben.bearer, "tickets");
    const ticket = await inWorld(
      Effect.gen(function* () {
        const session = yield* (yield* Auth).getSession(
          new Headers({ authorization: `Bearer ${created.secret}` }),
        );
        if (Option.isNone(session)) return yield* Effect.die("the key did not sign in");
        const credential = session.value.credential;
        if (credential === undefined) return yield* Effect.die("the key named no credential");
        return yield* (yield* UpgradeTicketsRepo).mint({
          userId: session.value.user.id,
          target: "tty",
          scope: upgradeTicketScope({ session: "s1" }),
          credential,
        });
      }),
    );
    const spend = () =>
      inWorld(
        Effect.flatMap(UpgradeTicketsRepo, (tickets) =>
          tickets.consume({
            ticket: ticket.ticket,
            target: "tty",
            scope: upgradeTicketScope({ session: "s1" }),
            keep: true,
          }),
        ),
      );
    const before = await spend();
    expect((await call(ben.bearer, "DELETE", `/me/access-keys/${created.key.id}`)).status).toBe(
      200,
    );
    expect({ before: before?.credential, after: await spend() }).toEqual({
      before: `key:${created.key.id}`,
      after: null,
    });
  });
  describe("for an account in two organizations", () => {
    let fay: Person;
    let fayKey: string;

    beforeAll(async () => {
      fay = await signUp("fay@example.invalid", "Fay");
      await inWorld(
        Effect.gen(function* () {
          const organizations = yield* OrganizationsRepo;
          yield* organizations.addMember(acme, fay.id, "member", null);
          yield* organizations.addMember(globex, fay.id, "member", null);
        }),
      );
    });

    it("acts in the organization it was created in after the sign-in switches away", async () => {
      expect(await activeOf(fay.bearer)).toBe(acme);
      const created = await createKey(fay.bearer, "made-in-a");
      fayKey = created.secret;
      expect(created.key.organizationId).toBe(acme);
      await switchTo(fay.bearer, globex);
      const listed = await visibleProjects(created.secret);
      expect({
        signIn: await activeOf(fay.bearer),
        key: await activeOf(created.secret),
        listsA: Array.isArray(listed) && listed.includes(project("a-shared")),
        listsB: Array.isArray(listed) && listed.includes(project("b-shared")),
        reads: await reads(created.secret, "a-shared", "b-shared"),
        signInReads: await reads(fay.bearer, "a-shared", "b-shared"),
      }).toEqual({
        signIn: globex,
        key: acme,
        listsA: true,
        listsB: false,
        reads: { "a-shared": 200, "b-shared": 404 },
        signInReads: { "a-shared": 404, "b-shared": 200 },
      });
    });

    it("created in B acts in B wherever any sign-in is, and a new sign-in's pin never moves it", async () => {
      expect(await activeOf(fay.bearer)).toBe(globex);
      const created = await createKey(fay.bearer, "made-in-b");
      expect(created.key.organizationId).toBe(globex);
      await switchTo(fay.bearer, acme);
      const laptop = await signInAgain("fay@example.invalid");
      expect(await activeOf(laptop)).toBe(acme);
      await switchTo(laptop, globex);
      await switchTo(laptop, acme);
      expect({
        key: await activeOf(created.secret),
        reads: await reads(created.secret, "a-shared", "b-shared"),
        firstKey: await activeOf(fayKey),
      }).toEqual({ key: globex, reads: { "a-shared": 404, "b-shared": 200 }, firstKey: acme });
    });

    it("is refused listing, switching, leaving and joining organizations, and changes nothing", async () => {
      const invitation = await inWorld(
        Effect.gen(function* () {
          const organizations = yield* OrganizationsRepo;
          const initech = yield* organizations.create("Initech", null);
          return yield* organizations.createInvitation({
            organizationId: initech.id,
            role: "member",
            email: null,
            createdByUserId: ana.id,
            expiresAt: new Date(Date.now() + 86_400_000),
          });
        }),
      );
      const signedInBefore = await activeOf(fay.bearer);
      const pinsBefore = await pinsOf(fay.id);
      const asKey = [
        await call(fayKey, "GET", "/account/organizations"),
        await call(fayKey, "PUT", "/account/organizations/active", { organizationId: globex }),
        await call(fayKey, "DELETE", `/account/organizations/${acme}`),
        await call(fayKey, "POST", "/invitations/accept", { token: invitation.token }),
      ];
      const memberships = await inWorld(
        Effect.flatMap(OrganizationsRepo, (organizations) => organizations.memberships(fay.id)),
      );
      expect({
        answers: asKey.map((answer) => [answer.status, Reflect.get(Object(answer.body), "_tag")]),
        signIn: await activeOf(fay.bearer),
        pins: await pinsOf(fay.id),
        key: await activeOf(fayKey),
        memberships: memberships.map((held) => held.organization.id).toSorted(),
      }).toEqual({
        answers: asKey.map(() => [403, "AccessKeyRefused"]),
        signIn: signedInBefore,
        pins: pinsBefore,
        key: acme,
        memberships: [acme, globex].toSorted(),
      });
    });

    it("is never pinned, however many requests it makes", async () => {
      for (let request = 0; request < 3; request++) {
        await visibleProjects(fayKey);
        await activeOf(fayKey);
        await reads(fayKey, "a-shared");
      }
      expect(await keyPins()).toEqual([]);
    });

    it("removal from A revokes the A key; the B key, the sign-in and the device go on, and B's leaving takes the B key", async () => {
      const inA = await createKey(fay.bearer, "removed-with-a");
      await switchTo(fay.bearer, globex);
      const inB = await createKey(fay.bearer, "kept-in-b");
      await switchTo(fay.bearer, acme);
      const minted = await call(fay.bearer, "POST", "/me/devices", {
        name: "phone",
        platform: "ios",
      });
      const device = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(
        minted.body,
      ).token;
      expect(await activeOf(device)).toBe(acme);

      expect((await call(ana.bearer, "DELETE", `/organization/members/${fay.id}`)).status).toBe(
        200,
      );
      const revokedAt = (id: string) =>
        sql(
          (client) =>
            client<{
              readonly revokedAt: Date | null;
            }>`SELECT revoked_at FROM device_tokens WHERE id = ${id}`,
        ).then(([row]) => row?.revokedAt instanceof Date);
      expect({
        aKey: await visibleProjects(inA.secret),
        aKeyRevoked: await revokedAt(inA.key.id),
        bKey: await activeOf(inB.secret),
        signIn: await activeOf(fay.bearer),
        device: await activeOf(device),
      }).toEqual({ aKey: 401, aKeyRevoked: true, bKey: globex, signIn: globex, device: globex });

      await inWorld(
        Effect.flatMap(OrganizationsRepo, (organizations) =>
          organizations.addMember(acme, fay.id, "member", null),
        ),
      );
      expect(await visibleProjects(inA.secret)).toBe(401);

      expect((await call(fay.bearer, "DELETE", `/account/organizations/${globex}`)).status).toBe(
        204,
      );
      expect({
        bKey: await visibleProjects(inB.secret),
        bKeyRevoked: await revokedAt(inB.key.id),
        signIn: await activeOf(fay.bearer),
        device: await activeOf(device),
      }).toEqual({ bKey: 401, bKeyRevoked: true, signIn: acme, device: acme });
    });
  });
});
