import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { previewsGroup } from "@mend/api-contracts";
import { Auth, AuthLive, RegistrationPolicy } from "@mend/auth";
import {
  DevicesRepoLive,
  InstanceRolesRepoLive,
  MemberRevocationsRepoLive,
  MendDBLive,
  migrations,
  OrganizationsRepoLive,
  PreviewGrantsRepoLive,
  PreviewPreparationsRepo,
  PreviewPreparationsRepoLive,
  PreviewsRepo,
  PreviewsRepoLive,
  previewTicketScope,
  ProjectsRepoLive,
  PushDevicesRepoLive,
  ServicesRepo,
  ServicesRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  SlackLinksRepoLive,
  type TicketCredential,
  UpgradeTicketsRepo,
  UpgradeTicketsRepoLive,
  UserEventsLive,
  UsersRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId, PreviewId, PreviewLabel } from "@mend/domain";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import {
  ConfigProvider,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  References,
  Option,
  Schema,
  String as Str,
  Tracer,
} from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";

import { ProjectAccess, ProjectAccessLive } from "../../src/access.ts";
import { EventBusLive } from "../../src/events-bus.ts";
import { PreviewSetupConfig } from "../../src/preview-config.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "../../src/preview-gateway-settings.ts";
import {
  makePreviewIdentityLayer,
  PreviewConfig,
  PreviewIdentity,
} from "../../src/preview-identity.ts";
import { previewOriginOf, type PreviewRouting } from "../../src/preview-routing.ts";
import { publicNetworkPolicy } from "../../src/public-network-policy.ts";
import { AuthMiddlewareLive } from "../../src/routes/api-live.ts";
import { PreviewAuthRoutes } from "../../src/routes/preview-auth.ts";
import { PreviewsGroupLive } from "../../src/routes/previews.ts";
import { PREVIEW_REQUEST_SPAN, startPreviewListener } from "./preview-listener.ts";

export const postgres = postgresTestConfig();
export const database = `mend_preview_auth_${process.pid}_${Date.now()}_${randomBytes(4).toString("hex")}`;
export const databaseUrl = new URL(postgres.adminUrl);
databaseUrl.pathname = `/${database}`;
export const APP = "http://localhost:3105";
export const network = makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)(APP), []);
export const STATIC_TOKEN = "static-dev-token-for-preview-tests";
export const ROUTING: PreviewRouting = { mode: "domain-https", domain: "preview.test", port: 443 };
export const TIMING = {
  sweepEvery: "300 millis",
  passDeadline: "200 millis",
  admissionDeadline: "2 seconds",
  closeGrace: "100 millis",
  cleanupEvery: "1 hour",
} as const;

export const ORG_A = OrganizationId.make("org-a");
export const label = (first: string) => PreviewLabel.make(`${first}${"a".repeat(25)}`);
export const PREVIEWS = {
  shared: { id: PreviewId.make("pv-shared"), label: label("b"), project: "p-shared" },
  sibling: { id: PreviewId.make("pv-sibling"), label: label("c"), project: "p-shared" },
  carolsPrivate: { id: PreviewId.make("pv-carol"), label: label("d"), project: "p-carol" },
  visibility: { id: PreviewId.make("pv-vis"), label: label("e"), project: "p-vis" },
  served: { id: PreviewId.make("pv-served"), label: label("f"), project: "p-shared" },
} as const;
export type PreviewKey = keyof typeof PREVIEWS;
export const originOf = (key: PreviewKey) => {
  const origin = previewOriginOf(ROUTING, { label: PREVIEWS[key].label, tailnetPort: null });
  if (origin === null) throw new Error("a domain routing addresses every preview");
  return origin;
};
export const hostOf = (key: PreviewKey) => new URL(originOf(key)).host;

export const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    DATABASE_URL: databaseUrl.toString(),
    BETTER_AUTH_SECRET: "disposable-preview-auth-test-secret-32-bytes",
    MEND_STATIC_TOKEN: STATIC_TOKEN,
  }),
);
export const pg = PgClient.layer({
  url: Redacted.make(databaseUrl.toString()),
  transformResultNames: Str.snakeToCamel,
  maxConnections: 6,
});
export const databaseLayer = MendDBLive.pipe(Layer.provideMerge(pg));
export const repos = Layer.mergeAll(
  UpgradeTicketsRepoLive,
  PreviewGrantsRepoLive,
  PreviewsRepoLive.pipe(Layer.provide(NodeCrypto.layer)),
  DevicesRepoLive,
  ProjectsRepoLive,
  ServicesRepoLive,
  PreviewPreparationsRepoLive,
  UserEventsLive,
  MemberRevocationsRepoLive.pipe(
    Layer.provide(
      Layer.mergeAll(UsersRepoLive, DevicesRepoLive, PushDevicesRepoLive, SlackLinksRepoLive),
    ),
  ),
  ProjectAccessLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        InstanceRolesRepoLive,
        OrganizationsRepoLive,
        ProjectsRepoLive,
        ServicesRepoLive,
        SessionProcessesRepoLive,
        SessionsRepoLive,
        WorktreeChangesRepoLive,
        WorktreesRepoLive,
      ),
    ),
  ),
  EventBusLive,
).pipe(Layer.provideMerge(databaseLayer));
export const previewConfig = Layer.succeed(PreviewConfig, { appUrl: APP, routing: ROUTING });
export const previewSetup = Layer.succeed(PreviewSetupConfig, {
  setup: {
    _tag: "On",
    routing: ROUTING,
    gateway: { bind: "127.0.0.1", port: 443, ...PREVIEW_GATEWAY_DEFAULTS },
  },
});
export const previewsApi = HttpApiBuilder.layer(
  HttpApi.make("mend").add(previewsGroup).prefix("/api"),
).pipe(
  Layer.provide(PreviewsGroupLive),
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(HttpServer.layerServices),
);

export const statements: Array<string> = [];
export const inRequest = (span: Tracer.AnySpan): boolean =>
  span._tag === "Span" &&
  (span.name === PREVIEW_REQUEST_SPAN || Option.exists(span.parent, inRequest));
class StatementSpan extends Tracer.NativeSpan {
  override attribute(key: string, value: unknown) {
    if (key === "db.query.text" && inRequest(this)) statements.push(String(value));
    super.attribute(key, value);
  }
}
export const countingTracer = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({ span: (options) => new StatementSpan(options) }),
);
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    makePreviewIdentityLayer(TIMING).pipe(Layer.provideMerge(previewConfig)),
    previewSetup,
    AuthLive.pipe(
      Layer.provide(
        Layer.succeed(RegistrationPolicy, {
          decide: () => Effect.succeed({ kind: "bootstrap" }),
          registered: () => Effect.void,
        }),
      ),
    ),
  ).pipe(
    Layer.provideMerge(repos),
    Layer.provideMerge(Layer.succeed(NetworkConfig, network)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "All")),
    Layer.provideMerge(countingTracer),
    Layer.provide(config),
  ),
);
export const admin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );
export const query = <A>(run: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.orDie(run(sql))));

let databaseCreated = false;
let listener: Awaited<ReturnType<typeof startPreviewListener>>;
let handle: (request: Request) => Promise<Response>;
export const mend = (request: Request) => handle(request);
export const previewListenerPort = () => listener.port;
let disposeMend: () => Promise<void>;
export const printed: Array<string> = [];

export const authRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    yield* router.add("*", "/api/auth/*", (request) =>
      Effect.gen(function* () {
        const body = request.method === "POST" ? yield* Effect.orDie(request.text) : undefined;
        const response = yield* auth.handler(
          new Request(new URL(request.url, APP), {
            method: request.method,
            headers: new Headers(Object.entries(request.headers)),
            ...(body === undefined ? {} : { body }),
          }),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    );
  }),
);

export const appGet = (path: string, headers: Record<string, string> = {}) =>
  mend(new Request(`${APP}${path}`, { headers, redirect: "manual" }));

export interface Person {
  readonly userId: string;
  readonly cookie: string;
  readonly signInId: string;
}

export const signUp = async (email: string): Promise<Person> => {
  const response = await mend(
    new Request(`${APP}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ email, name: email, password: "disposable-preview-password" }),
    }),
  );
  expect(response.status).toBe(200);
  return personFrom(response);
};

export const signIn = async (email: string): Promise<Person> => {
  const response = await mend(
    new Request(`${APP}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ email, password: "disposable-preview-password" }),
    }),
  );
  expect(response.status).toBe(200);
  return personFrom(response);
};

export const personFrom = async (response: Response): Promise<Person> => {
  const account = Schema.decodeUnknownSync(
    Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
  )(await response.json());
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0] ?? "")
    .find((pair) => pair.startsWith("better-auth.session_token="));
  if (cookie === undefined) throw new Error("signing in set no session cookie");
  const [row] = await query(
    (sql) =>
      sql<{ readonly id: string }>`SELECT id FROM "session" WHERE "userId" = ${account.user.id}
      ORDER BY "createdAt" DESC LIMIT 1`,
  );
  if (row === undefined) throw new Error("signing in stored no sign-in");
  return { userId: account.user.id, cookie, signInId: row.id };
};

export const signOut = (person: Person) =>
  mend(
    new Request(`${APP}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: APP, cookie: person.cookie, "content-type": "application/json" },
      body: "{}",
    }),
  );

export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly body: string;
}

export const NAVIGATION = {
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
} as const;

export const atPreview = (
  key: PreviewKey | { readonly host: string },
  target: string,
  headers: Record<string, string | Array<string>> = {},
  method = "GET",
) =>
  new Promise<Reply>((resolve, reject) => {
    const host = typeof key === "string" ? hostOf(key) : key.host;
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: listener.port,
        path: target,
        method,
        headers: { host, ...headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

export const openStream = (key: PreviewKey, grant: string, path = "/events") =>
  new Promise<{
    readonly ended: Promise<void>;
    readonly isOpen: () => boolean;
    readonly close: () => void;
  }>((resolve, reject) => {
    let open = true;
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: listener.port,
        path,
        headers: { host: hostOf(key), cookie: `__Host-mend-preview=${grant}` },
      },
      (response) => {
        if (response.statusCode !== 200)
          return reject(new Error(`stream refused: ${response.statusCode}`));
        const ended = new Promise<void>((done) => {
          const finish = () => {
            open = false;
            done();
          };
          response.on("end", finish);
          response.on("close", finish);
          response.on("error", finish);
        });
        response.once("data", () =>
          resolve({ ended, isOpen: () => open, close: () => outgoing.destroy() }),
        );
      },
    );
    outgoing.on("error", () => (open = false));
    outgoing.end();
  });

export const within = <A>(promise: Promise<A>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms),
    ),
  ]);

export const locationOf = (reply: Reply) => {
  const location = reply.headers["location"];
  return typeof location === "string" ? location : "";
};

export const grantIn = (reply: Reply) => {
  const header = reply.headers["set-cookie"];
  const [cookie] = Array.isArray(header) ? header : [];
  const value = cookie?.split(";")[0]?.split("=")[1];
  if (value === undefined) throw new Error("the exchange set no grant cookie");
  return value;
};

export const signInToPreview = async (person: Person, key: PreviewKey, path = "/") => {
  const issued = await appGet(
    `/api/preview-auth?preview=${PREVIEWS[key].id}&path=${encodeURIComponent(path)}`,
    { cookie: person.cookie },
  );
  expect(issued.status).toBe(302);
  const location = issued.headers.get("location") ?? "";
  const exchanged = await atPreview(
    key,
    new URL(location).pathname + new URL(location).search,
    NAVIGATION,
  );
  expect(exchanged.status).toBe(303);
  return { issued, exchanged, grant: grantIn(exchanged) };
};

export const mintTicket = (input: {
  readonly userId: string;
  readonly credential: TicketCredential | null;
  readonly key: PreviewKey;
  readonly target?: "preview" | "tty";
}) =>
  runtime
    .runPromise(
      Effect.flatMap(UpgradeTicketsRepo, (tickets) =>
        tickets.mint({
          userId: input.userId,
          credential: input.credential,
          target: input.target ?? "preview",
          scope: previewTicketScope({
            previewId: PREVIEWS[input.key].id,
            origin: originOf(input.key),
          }),
        }),
      ),
    )
    .then((minted) => minted.ticket);

export const exchangeAt = (
  key: PreviewKey | { readonly host: string },
  ticket: string,
  extra = "",
) =>
  atPreview(key, `/__mend/auth?ticket=${encodeURIComponent(ticket)}&path=%2F${extra}`, NAVIGATION);

export const whoami = (key: PreviewKey, grant: string, headers: Record<string, string> = {}) =>
  atPreview(key, "/whoami", { cookie: `__Host-mend-preview=${grant}`, ...headers });

export const grantCount = () =>
  query(
    (sql) => sql<{ readonly count: number }>`SELECT count(*)::int AS count FROM preview_grants`,
  ).then((rows) => rows[0]?.count ?? -1);

export const previewTickets = () =>
  query(
    (sql) => sql<{ readonly count: number }>`SELECT count(*)::int AS count FROM upgrade_tickets
    WHERE target = 'preview'`,
  ).then((rows) => rows[0]?.count ?? -1);

export interface People {
  readonly alice: Person;
  readonly carol: Person;
  readonly bob: Person;
  readonly dave: Person;
}

export const setUpPreviewAuth = async (): Promise<People> => {
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: Array<unknown>) => {
      printed.push(
        args
          .map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg))))
          .join(" "),
      );
    });
  }
  await admin(
    Effect.gen(function* () {
      yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
    }),
  );
  databaseCreated = true;
  await runtime.runPromise(
    Effect.forEach(
      Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
      ([, migration]) => migration,
      { discard: true },
    ),
  );
  const context = await runtime.runPromise(
    Effect.context<
      | Auth
      | PreviewIdentity
      | PreviewSetupConfig
      | PreviewsRepo
      | ProjectAccess
      | ServicesRepo
      | PreviewPreparationsRepo
    >(),
  );
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(PreviewAuthRoutes, previewsApi, authRoute, publicNetworkPolicy(network)).pipe(
      Layer.provide(Layer.succeedContext(context)),
    ),
    { disableLogger: true },
  );
  handle = (request) => web.handler(request, context);
  disposeMend = web.dispose;
  listener = await startPreviewListener(runtime);
  const alice = await signUp("alice@example.com");
  const carol = await signUp("carol@example.com");
  const bob = await signUp("bob@example.com");
  const dave = await signUp("dave@example.com");
  await query((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO organizations (id, name) VALUES ('org-a', 'A'), ('org-b', 'B')`;
      yield* sql`INSERT INTO organization_members (organization_id, user_id, role) VALUES
        ('org-a', ${alice.userId}, 'owner'), ('org-a', ${carol.userId}, 'member'),
        ('org-a', ${dave.userId}, 'member'), ('org-b', ${bob.userId}, 'owner')`;
      yield* sql`INSERT INTO instance_roles (user_id, role) VALUES (${alice.userId}, 'operator')`;
      for (const [id, visibility, creator] of [
        ["p-shared", "shared", alice.userId],
        ["p-carol", "private", carol.userId],
        ["p-vis", "shared", alice.userId],
      ] as const) {
        yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id,
            visibility, created_by_user_id)
          VALUES (${id}, ${id}, ${`/store/${id}`}, 'main', 'org-a', ${visibility}, ${creator})`;
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${`wt-${id}`}, ${id}, ${id}, ${id}, ${`mend/${id}`}, 'abc')`;
      }
      for (const preview of Object.values(PREVIEWS)) {
        yield* sql`INSERT INTO previews (id, project_id, worktree_id, service_name, label)
          VALUES (${preview.id}, ${preview.project}, ${`wt-${preview.project}`},
            ${`web-${preview.id}`}, ${preview.label})`;
      }
    }),
  );
  return { alice, carol, bob, dave };
};

export const tearDownPreviewAuth = async () => {
  await listener?.close();
  await disposeMend?.();
  await runtime.dispose();
  if (databaseCreated) {
    await admin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(
          `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
        );
      }),
    );
  }
  vi.restoreAllMocks();
};
