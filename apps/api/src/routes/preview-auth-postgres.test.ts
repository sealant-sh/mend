import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

import { NodeCrypto } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { Auth, AuthLive, RegistrationPolicy } from "@mend/auth";
import {
  DevicesRepo,
  DevicesRepoLive,
  InstanceRolesRepoLive,
  MemberRevocationsRepo,
  MemberRevocationsRepoLive,
  MendDBLive,
  migrations,
  notifyEvent,
  OrganizationsRepoLive,
  PreviewGrantsRepoLive,
  PreviewsRepoLive,
  previewTicketScope,
  ProjectsRepo,
  ProjectsRepoLive,
  PushDevicesRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  SlackLinksRepoLive,
  type TicketCredential,
  UpgradeTicketsRepo,
  UpgradeTicketsRepoLive,
  UserEvents,
  UserEventsLive,
  UsersRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId, PreviewId, PreviewLabel, ProjectId } from "@mend/domain";
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
import { HttpRouter, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PREVIEW_REQUEST_SPAN, startPreviewListener } from "../../test/support/preview-listener.ts";
import { ProjectAccessLive } from "../access.ts";
import { EventBusLive } from "../events-bus.ts";
import { makePreviewIdentityLayer, PreviewConfig, PreviewIdentity } from "../preview-identity.ts";
import { previewOriginOf, type PreviewRouting } from "../preview-routing.ts";
import { publicNetworkPolicy } from "../public-network-policy.ts";
import { PreviewAuthRoutes } from "./preview-auth.ts";

const postgres = postgresTestConfig();
const database = `mend_preview_auth_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(postgres.adminUrl);
databaseUrl.pathname = `/${database}`;
const APP = "http://localhost:3105";
const network = makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)(APP), []);
const STATIC_TOKEN = "static-dev-token-for-preview-tests";
const ROUTING: PreviewRouting = { mode: "domain-https", domain: "preview.test", port: 443 };
const TIMING = {
  sweepEvery: "300 millis",
  passDeadline: "200 millis",
  admissionDeadline: "2 seconds",
  closeGrace: "100 millis",
  cleanupEvery: "1 hour",
} as const;

const ORG_A = OrganizationId.make("org-a");
const label = (first: string) => PreviewLabel.make(`${first}${"a".repeat(25)}`);
const PREVIEWS = {
  shared: { id: PreviewId.make("pv-shared"), label: label("b"), project: "p-shared" },
  sibling: { id: PreviewId.make("pv-sibling"), label: label("c"), project: "p-shared" },
  carolsPrivate: { id: PreviewId.make("pv-carol"), label: label("d"), project: "p-carol" },
  visibility: { id: PreviewId.make("pv-vis"), label: label("e"), project: "p-vis" },
} as const;
type PreviewKey = keyof typeof PREVIEWS;
const originOf = (key: PreviewKey) => {
  const origin = previewOriginOf(ROUTING, PREVIEWS[key]);
  if (origin === null) throw new Error("a domain routing addresses every preview");
  return origin;
};
const hostOf = (key: PreviewKey) => new URL(originOf(key)).host;

const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    DATABASE_URL: databaseUrl.toString(),
    BETTER_AUTH_SECRET: "disposable-preview-auth-test-secret-32-bytes",
    MEND_STATIC_TOKEN: STATIC_TOKEN,
  }),
);
const pg = PgClient.layer({
  url: Redacted.make(databaseUrl.toString()),
  transformResultNames: Str.snakeToCamel,
  maxConnections: 6,
});
const databaseLayer = MendDBLive.pipe(Layer.provideMerge(pg));
const repos = Layer.mergeAll(
  UpgradeTicketsRepoLive,
  PreviewGrantsRepoLive,
  PreviewsRepoLive.pipe(Layer.provide(NodeCrypto.layer)),
  DevicesRepoLive,
  ProjectsRepoLive,
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
const previewConfig = Layer.succeed(PreviewConfig, { appUrl: APP, routing: ROUTING });

const statements: Array<string> = [];
const inRequest = (span: Tracer.AnySpan): boolean =>
  span._tag === "Span" &&
  (span.name === PREVIEW_REQUEST_SPAN || Option.exists(span.parent, inRequest));
class StatementSpan extends Tracer.NativeSpan {
  override attribute(key: string, value: unknown) {
    if (key === "db.query.text" && inRequest(this)) statements.push(String(value));
    super.attribute(key, value);
  }
}
const countingTracer = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({ span: (options) => new StatementSpan(options) }),
);
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    makePreviewIdentityLayer(TIMING).pipe(Layer.provideMerge(previewConfig)),
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
const admin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );
const query = <A>(run: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.orDie(run(sql))));

let databaseCreated = false;
let listener: Awaited<ReturnType<typeof startPreviewListener>>;
let mend: (request: Request) => Promise<Response>;
let disposeMend: () => Promise<void>;
const printed: Array<string> = [];

const authRoute = HttpRouter.use((router) =>
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

const appGet = (path: string, headers: Record<string, string> = {}) =>
  mend(new Request(`${APP}${path}`, { headers, redirect: "manual" }));

interface Person {
  readonly userId: string;
  readonly cookie: string;
  readonly signInId: string;
}

const signUp = async (email: string): Promise<Person> => {
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

const signIn = async (email: string): Promise<Person> => {
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

const personFrom = async (response: Response): Promise<Person> => {
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

const signOut = (person: Person) =>
  mend(
    new Request(`${APP}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: APP, cookie: person.cookie, "content-type": "application/json" },
      body: "{}",
    }),
  );

interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly body: string;
}

const NAVIGATION = {
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
} as const;

const atPreview = (
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

const openStream = (key: PreviewKey, grant: string, path = "/events") =>
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

const within = <A>(promise: Promise<A>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms),
    ),
  ]);

const locationOf = (reply: Reply) => {
  const location = reply.headers["location"];
  return typeof location === "string" ? location : "";
};

const grantIn = (reply: Reply) => {
  const header = reply.headers["set-cookie"];
  const [cookie] = Array.isArray(header) ? header : [];
  const value = cookie?.split(";")[0]?.split("=")[1];
  if (value === undefined) throw new Error("the exchange set no grant cookie");
  return value;
};

const signInToPreview = async (person: Person, key: PreviewKey, path = "/") => {
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

const mintTicket = (input: {
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

const exchangeAt = (key: PreviewKey | { readonly host: string }, ticket: string, extra = "") =>
  atPreview(key, `/__mend/auth?ticket=${encodeURIComponent(ticket)}&path=%2F${extra}`, NAVIGATION);

const whoami = (key: PreviewKey, grant: string, headers: Record<string, string> = {}) =>
  atPreview(key, "/whoami", { cookie: `__Host-mend-preview=${grant}`, ...headers });

const grantCount = () =>
  query(
    (sql) => sql<{ readonly count: number }>`SELECT count(*)::int AS count FROM preview_grants`,
  ).then((rows) => rows[0]?.count ?? -1);

const previewTickets = () =>
  query(
    (sql) => sql<{ readonly count: number }>`SELECT count(*)::int AS count FROM upgrade_tickets
    WHERE target = 'preview'`,
  ).then((rows) => rows[0]?.count ?? -1);

let alice: Person;
let carol: Person;
let bob: Person;
let dave: Person;

describe.skipIf(postgres.skip)("signing in to a preview, against an HTTP fixture", () => {
  beforeAll(async () => {
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
    const context = await runtime.runPromise(Effect.context<Auth | PreviewIdentity>());
    const web = HttpRouter.toWebHandler(
      Layer.mergeAll(PreviewAuthRoutes, authRoute, publicNetworkPolicy(network)).pipe(
        Layer.provide(Layer.succeedContext(context)),
      ),
      { disableLogger: true },
    );
    mend = (request) => web.handler(request, context);
    disposeMend = web.dispose;
    listener = await startPreviewListener(runtime);
    alice = await signUp("alice@example.com");
    carol = await signUp("carol@example.com");
    bob = await signUp("bob@example.com");
    dave = await signUp("dave@example.com");
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
  }, 120_000);

  afterAll(async () => {
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
  });

  it("signs a person in end to end: a cookie GET, a ticket, an exchange, a grant per request", async () => {
    const issued = await appGet(
      `/api/preview-auth?preview=${PREVIEWS.shared.id}&path=${encodeURIComponent("/pricing?tab=2")}`,
      { cookie: carol.cookie },
    );
    expect(issued.status).toBe(302);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(issued.headers.get("referrer-policy")).toBe("no-referrer");
    const location = new URL(issued.headers.get("location") ?? "");
    expect(location.origin).toBe(originOf("shared"));
    expect(location.pathname).toBe("/__mend/auth");
    expect(location.searchParams.get("path")).toBe("/pricing?tab=2");

    const exchanged = await atPreview("shared", location.pathname + location.search, NAVIGATION);
    expect(exchanged.status).toBe(303);
    expect(exchanged.headers["location"]).toBe(
      `/__mend/signed-in?path=${encodeURIComponent("/pricing?tab=2")}`,
    );
    expect(exchanged.headers["referrer-policy"]).toBe("no-referrer");
    expect(exchanged.headers["cache-control"]).toBe("no-store");
    const [cookie] = exchanged.headers["set-cookie"] ?? [];
    const grant = grantIn(exchanged);
    expect(cookie).toBe(`__Host-mend-preview=${grant}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    const landed = await atPreview("shared", locationOf(exchanged), {
      ...NAVIGATION,
      cookie: `__Host-mend-preview=${grant}`,
    });
    expect(landed.status).toBe(303);
    expect(landed.headers["location"]).toBe("/pricing?tab=2");

    const me = await whoami("shared", grant);
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toEqual({
      userId: carol.userId,
      previewId: PREVIEWS.shared.id,
      origin: originOf("shared"),
    });
    const rows = await query(
      (sql) =>
        sql<{ readonly tokenHash: string; readonly userId: string; readonly credential: string }>`
        SELECT token_hash, user_id, credential FROM preview_grants
        WHERE token_hash = ${createHash("sha256").update(grant).digest("hex")}`,
    );
    expect(rows).toEqual([
      {
        tokenHash: createHash("sha256").update(grant).digest("hex"),
        userId: carol.userId,
        credential: `session:${carol.signInId}`,
      },
    ]);
  });

  it("opens for anyone who can see the project, and for no one else", async () => {
    const before = await previewTickets();
    const at = (person: Person | null, key: PreviewKey) =>
      appGet(
        `/api/preview-auth?preview=${PREVIEWS[key].id}&path=%2F`,
        person === null ? {} : { cookie: person.cookie },
      );
    expect((await at(bob, "shared")).status).toBe(404);
    expect((await at(alice, "carolsPrivate")).status).toBe(404);
    expect(
      (await appGet(`/api/preview-auth?preview=pv-unknown&path=%2F`, { cookie: carol.cookie }))
        .status,
    ).toBe(404);
    const signedOut = await at(null, "shared");
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent(`/preview-auth?preview=${PREVIEWS.shared.id}&path=%2F`)}`,
    );
    const bearer = await appGet(`/api/preview-auth?preview=${PREVIEWS.shared.id}&path=%2F`, {
      authorization: `Bearer ${STATIC_TOKEN}`,
    });
    expect(bearer.status).toBe(302);
    expect(bearer.headers.get("location")).toMatch(/^\/login\?next=/);
    expect(await previewTickets()).toBe(before);
    expect((await at(carol, "carolsPrivate")).status).toBe(302);
  });

  it("spends one ticket once, however many requests race for it", async () => {
    const ticket = await mintTicket({
      userId: carol.userId,
      credential: `session:${carol.signInId}`,
      key: "shared",
    });
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => exchangeAt("shared", ticket)),
    );
    expect(replies.map((reply) => reply.status).toSorted()).toEqual([
      303, 401, 401, 401, 401, 401, 401, 401,
    ]);
    const winner = replies.find((reply) => reply.status === 303);
    if (winner === undefined) throw new Error("no exchange won");
    const replay = await atPreview("shared", `/__mend/auth?ticket=${ticket}&path=%2F`, {
      ...NAVIGATION,
      cookie: `__Host-mend-preview=${grantIn(winner)}`,
    });
    expect(replay.status).toBe(401);
    expect(replay.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a ticket at another host or for another target, without spending it", async () => {
    const credential: TicketCredential = `session:${carol.signInId}`;
    const ticket = await mintTicket({ userId: carol.userId, credential, key: "shared" });
    const sibling = await exchangeAt("sibling", ticket);
    expect(sibling.status).toBe(401);
    const forged = await atPreview("sibling", `/__mend/auth?ticket=${ticket}&path=%2F`, {
      ...NAVIGATION,
      "x-forwarded-host": hostOf("shared"),
      forwarded: `host=${hostOf("shared")}`,
    });
    expect(forged.status).toBe(401);
    for (const host of [
      `${PREVIEWS.shared.label}.preview.test:8443`,
      `x.${PREVIEWS.shared.label}.preview.test`,
      `${PREVIEWS.shared.label}.preview.test.evil`,
      `${label("z")}.preview.test`,
    ]) {
      expect((await exchangeAt({ host }, ticket)).status, host).toBe(404);
    }
    const tty = await mintTicket({
      userId: carol.userId,
      credential,
      key: "shared",
      target: "tty",
    });
    expect((await exchangeAt("shared", tty)).status).toBe(401);
    expect(
      await runtime.runPromise(
        Effect.flatMap(UpgradeTicketsRepo, (tickets) =>
          tickets.consume({
            ticket: tty,
            target: "tty",
            scope: previewTicketScope({
              previewId: PREVIEWS.shared.id,
              origin: originOf("shared"),
            }),
          }),
        ),
      ),
    ).not.toBeNull();
    expect((await exchangeAt("shared", ticket)).status).toBe(303);
  });

  it("refuses a repeated or unknown parameter before anything is spent", async () => {
    const before = await previewTickets();
    for (const search of [
      `preview=${PREVIEWS.shared.id}&preview=${PREVIEWS.shared.id}`,
      `preview=${PREVIEWS.shared.id}&pr%65view=${PREVIEWS.sibling.id}`,
      `preview=${PREVIEWS.shared.id}&path=%2F&path=%2Fx`,
      `preview=${PREVIEWS.shared.id}&origin=${encodeURIComponent("https://evil.example")}`,
      `preview=${PREVIEWS.shared.id}&path=${encodeURIComponent("//evil.example/")}`,
      "path=%2F",
    ]) {
      expect(
        (await appGet(`/api/preview-auth?${search}`, { cookie: carol.cookie })).status,
        search,
      ).toBe(400);
    }
    expect(await previewTickets()).toBe(before);
    const ticket = await mintTicket({
      userId: carol.userId,
      credential: `session:${carol.signInId}`,
      key: "shared",
    });
    for (const search of [
      `ticket=${ticket}&ticket=${ticket}`,
      `ticket=${ticket}&tick%65t=${ticket}`,
      `path=%2F&ticket=${ticket}&path=%2Fother`,
      `ticket=${ticket}&path=${encodeURIComponent("https://evil.example/")}`,
      `ticket=${ticket}&path=${encodeURIComponent("/__mend/auth")}`,
      `ticket=${ticket}&preview=${PREVIEWS.sibling.id}`,
    ]) {
      expect((await atPreview("shared", `/__mend/auth?${search}`, NAVIGATION)).status, search).toBe(
        400,
      );
    }
    expect(
      (await atPreview("shared", `/__mend/auth?ticket=${ticket}`, NAVIGATION, "POST")).status,
    ).toBe(403);
    expect(
      (
        await atPreview(
          "shared",
          `/__mend/auth?ticket=${ticket}`,
          { origin: originOf("shared"), "sec-fetch-site": "same-origin" },
          "POST",
        )
      ).status,
    ).toBe(405);
    const exchanged = await exchangeAt("shared", ticket);
    expect(exchanged.status).toBe(303);
    const grant = grantIn(exchanged);
    const twice = await atPreview("shared", "/whoami", {
      cookie: [`__Host-mend-preview=${grant}`, `__Host-mend-preview=${grant}`],
    });
    expect(twice.status).toBe(400);
    const twoHosts = await new Promise<string>((resolve, reject) => {
      const socket = connect(listener.port, "127.0.0.1", () =>
        socket.write(
          `GET /whoami HTTP/1.1\r\nHost: ${hostOf("shared")}\r\nHost: ${hostOf("sibling")}\r\n` +
            `Cookie: __Host-mend-preview=${grant}\r\nConnection: close\r\n\r\n`,
        ),
      );
      let answer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (answer += chunk));
      socket.on("end", () => resolve(answer));
      socket.on("error", reject);
    });
    expect(twoHosts).toMatch(/^HTTP\/1\.1 400 /);
  });

  it("refuses a ticket minted without a credential, and a grant whose credential is another's", async () => {
    const devToken = await mintTicket({ userId: alice.userId, credential: null, key: "shared" });
    expect((await exchangeAt("shared", devToken)).status).toBe(401);
    expect((await exchangeAt("shared", devToken)).status).toBe(401);
    const forged = `mpg_${randomBytes(32).toString("base64url")}`;
    await query(
      (sql) =>
        sql`INSERT INTO preview_grants (token_hash, preview_id, origin, user_id, credential)
        VALUES (${createHash("sha256").update(forged).digest("hex")}, ${PREVIEWS.shared.id},
          ${originOf("shared")}, ${alice.userId}, ${`session:${carol.signInId}`})`,
    );
    expect((await whoami("shared", forged)).status).toBe(401);
    const rows = await query(
      (sql) =>
        sql<{ readonly count: number }>`SELECT count(*)::int AS count FROM preview_grants
        WHERE user_id = ${alice.userId} AND credential NOT LIKE 'session:%' AND credential NOT LIKE 'device:%'`,
    );
    expect(rows[0]?.count).toBe(0);
  });

  it("asks a navigation without a grant to sign in, and refuses every other request", async () => {
    const page = await atPreview("shared", "/pricing?tab=2", NAVIGATION);
    expect(page.status).toBe(302);
    expect(page.headers["location"]).toBe(
      `${APP}/preview-auth?preview=${PREVIEWS.shared.id}&path=${encodeURIComponent("/pricing?tab=2")}`,
    );
    const fetched = await atPreview("shared", "/api/data", {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    });
    expect(fetched.status).toBe(401);
    expect(fetched.headers["location"]).toBeUndefined();
    const { grant } = await signInToPreview(carol, "shared");
    expect((await whoami("shared", grant, { origin: originOf("sibling") })).status).toBe(403);
    expect(
      (await atPreview("shared", "/whoami", { cookie: `__Host-mend-preview=${grant}` }, "POST"))
        .status,
    ).toBe(403);
    expect((await whoami("sibling", grant)).status).toBe(401);
  });

  it("signing out ends the grant for new requests and closes its open stream", async () => {
    const session = await signIn("carol@example.com");
    const { grant } = await signInToPreview(session, "shared");
    const stream = await openStream("shared", grant);
    const signedOut = await signOut(session);
    expect(signedOut.status).toBe(200);
    expect((await whoami("shared", grant)).status).toBe(401);
    expect((await whoami("shared", grant, NAVIGATION)).status).toBe(302);
    await within(stream.ended, 3_000, "the stream ends after signing out");
  });

  it("a sign-out Better Auth failed to delete is completed, or reported as failed", async () => {
    const once = await signIn("carol@example.com");
    const { grant } = await signInToPreview(once, "shared");
    const stream = await openStream("shared", grant);
    await query((sql) =>
      Effect.gen(function* () {
        yield* sql.unsafe(`CREATE SEQUENCE IF NOT EXISTS sign_out_attempts`);
        yield* sql.unsafe(`CREATE OR REPLACE FUNCTION fail_first_sign_out() RETURNS trigger AS $$
          BEGIN
            IF nextval('sign_out_attempts') = 1 THEN RAISE EXCEPTION 'injected delete failure'; END IF;
            RETURN OLD;
          END $$ LANGUAGE plpgsql`);
        yield* sql.unsafe(`CREATE TRIGGER fail_first_sign_out BEFORE DELETE ON "session"
          FOR EACH ROW WHEN (OLD.id = '${once.signInId}') EXECUTE FUNCTION fail_first_sign_out()`);
      }),
    );
    const completed = await signOut(once);
    expect(completed.status).toBe(200);
    expect(await query((sql) => sql`SELECT id FROM "session" WHERE id = ${once.signInId}`)).toEqual(
      [],
    );
    expect((await whoami("shared", grant)).status).toBe(401);
    await within(stream.ended, 3_000, "the stream ends after a completed sign-out");

    const stuck = await signIn("carol@example.com");
    const kept = await signInToPreview(stuck, "shared");
    await query((sql) =>
      Effect.gen(function* () {
        yield* sql.unsafe(`CREATE OR REPLACE FUNCTION fail_every_sign_out() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'injected delete failure'; END $$ LANGUAGE plpgsql`);
        yield* sql.unsafe(`CREATE TRIGGER fail_every_sign_out BEFORE DELETE ON "session"
          FOR EACH ROW WHEN (OLD.id = '${stuck.signInId}') EXECUTE FUNCTION fail_every_sign_out()`);
      }),
    );
    const failed = await signOut(stuck);
    expect(failed.status).toBe(503);
    expect(failed.headers.getSetCookie()).toEqual([]);
    expect((await whoami("shared", kept.grant)).status).toBe(200);
    await query((sql) => sql.unsafe(`DROP TRIGGER fail_every_sign_out ON "session"`));
    expect((await signOut(stuck)).status).toBe(200);
    expect((await whoami("shared", kept.grant)).status).toBe(401);

    const suppressed = await signIn("carol@example.com");
    const held = await signInToPreview(suppressed, "shared");
    const heldStream = await openStream("shared", held.grant);
    await query((sql) =>
      Effect.gen(function* () {
        yield* sql.unsafe(`CREATE OR REPLACE FUNCTION suppress_sign_out() RETURNS trigger AS $$
          BEGIN RETURN NULL; END $$ LANGUAGE plpgsql`);
        yield* sql.unsafe(`CREATE TRIGGER suppress_sign_out BEFORE DELETE ON "session"
          FOR EACH ROW WHEN (OLD.id = '${suppressed.signInId}') EXECUTE FUNCTION suppress_sign_out()`);
      }),
    );
    const notDeleted = await signOut(suppressed);
    expect(notDeleted.status).toBe(503);
    expect(notDeleted.headers.getSetCookie()).toEqual([]);
    expect((await whoami("shared", held.grant)).status).toBe(200);
    await query((sql) => sql.unsafe(`DROP TRIGGER suppress_sign_out ON "session"`));
    expect((await signOut(suppressed)).status).toBe(200);
    expect((await whoami("shared", held.grant)).status).toBe(401);
    await within(heldStream.ended, 3_000, "the stream ends once the sign-out completes");
  });

  it("revoking a device ends that device's grant and stream, and leaves the sign-in's", async () => {
    const token = `mdt_${randomBytes(24).toString("base64url")}`;
    const device = await runtime.runPromise(
      Effect.flatMap(DevicesRepo, (devices) =>
        devices.create({
          userId: carol.userId,
          name: "phone",
          platform: "ios",
          tokenHash: createHash("sha256").update(token).digest("hex"),
        }),
      ),
    );
    const ticket = await mintTicket({
      userId: carol.userId,
      credential: `device:${device.id}`,
      key: "shared",
    });
    const phoneGrant = grantIn(await exchangeAt("shared", ticket));
    const laptop = await signIn("carol@example.com");
    const laptopGrant = (await signInToPreview(laptop, "shared")).grant;
    const phoneStream = await openStream("shared", phoneGrant);
    const laptopStream = await openStream("shared", laptopGrant);
    await runtime.runPromise(
      Effect.flatMap(DevicesRepo, (devices) => devices.revoke(carol.userId, device.id)),
    );
    await within(phoneStream.ended, 3_000, "the device's stream ends");
    expect((await whoami("shared", phoneGrant)).status).toBe(401);
    expect((await whoami("shared", laptopGrant)).status).toBe(200);
    expect(laptopStream.isOpen()).toBe(true);
    laptopStream.close();
  });

  it("removal from the organization ends every grant and stream of the person", async () => {
    const { grant } = await signInToPreview(dave, "shared");
    const stream = await openStream("shared", grant);
    await runtime.runPromise(
      Effect.gen(function* () {
        const removals = yield* MemberRevocationsRepo;
        yield* removals.beginRemoval({
          organizationId: ORG_A,
          userId: dave.userId,
          actorUserId: alice.userId,
          revocationLeaseMs: 60_000,
        });
        yield* (yield* UserEvents).changed(dave.userId, "access");
      }),
    );
    await within(stream.ended, 3_000, "the removed member's stream ends");
    expect((await whoami("shared", grant)).status).toBe(401);
  });

  it("losing the membership alone ends access, though the sign-in still stands", async () => {
    const { grant } = await signInToPreview(carol, "visibility");
    const stream = await openStream("visibility", grant);
    await query((sql) => sql`DELETE FROM organization_members WHERE user_id = ${carol.userId}`);
    expect((await whoami("visibility", grant)).status).toBe(401);
    await within(stream.ended, 3_000, "the stream ends at the sweep");
    await query(
      (sql) =>
        sql`INSERT INTO organization_members (organization_id, user_id, role) VALUES ('org-a', ${carol.userId}, 'member')`,
    );
    expect((await whoami("visibility", grant)).status).toBe(200);
  });

  it("a project made private ends the streams of those who lost it, and its creator keeps it", async () => {
    const creator = (await signInToPreview(alice, "visibility")).grant;
    const teammate = (await signInToPreview(carol, "visibility")).grant;
    const creatorStream = await openStream("visibility", creator);
    const teammateStream = await openStream("visibility", teammate);
    await runtime.runPromise(
      Effect.flatMap(ProjectsRepo, (projects) =>
        projects.setVisibility(ProjectId.make("p-vis"), "private"),
      ),
    );
    await within(teammateStream.ended, 3_000, "the teammate's stream ends");
    expect((await whoami("visibility", teammate)).status).toBe(404);
    expect((await whoami("visibility", teammate, NAVIGATION)).status).toBe(404);
    expect((await whoami("visibility", creator)).status).toBe(200);
    expect(creatorStream.isOpen()).toBe(true);
    const stalled = await openStream("visibility", creator, "/stall");
    await query(
      (sql) => sql`UPDATE previews SET worktree_id = NULL WHERE id = ${PREVIEWS.visibility.id}`,
    );
    await runtime.runPromise(
      Effect.flatMap(PgClient.PgClient, (client) =>
        notifyEvent(client, { type: "worktree", worktreeId: "wt-p-vis", projectId: "p-vis" }),
      ),
    );
    await within(
      Promise.all([creatorStream.ended, stalled.ended]),
      3_000,
      "the removed preview's streams end",
    );
    expect((await whoami("visibility", creator)).status).toBe(404);
  });

  it("a browser that does not keep the grant cookie is told so after one round", async () => {
    const tickets = await previewTickets();
    const grants = await grantCount();
    const page = await atPreview("shared", "/pricing", NAVIGATION);
    expect(page.status).toBe(302);
    const signInAt = new URL(locationOf(page));
    expect(signInAt.pathname).toBe("/preview-auth");
    const issued = await appGet(`/api/preview-auth${signInAt.search}`, { cookie: carol.cookie });
    expect(issued.status).toBe(302);
    const ticketAt = new URL(issued.headers.get("location") ?? "");
    const exchanged = await atPreview("shared", ticketAt.pathname + ticketAt.search, NAVIGATION);
    expect(exchanged.status).toBe(303);
    const dropped = await atPreview("shared", locationOf(exchanged), NAVIGATION);
    expect(dropped.status).toBe(400);
    expect(dropped.headers["location"]).toBeUndefined();
    expect(dropped.body).toMatch(/did not keep the preview's sign-in cookie/);
    expect(await previewTickets()).toBe(tickets);
    expect(await grantCount()).toBe(grants + 1);
  });

  it("never lets an encoded /__mend path reach the app", async () => {
    const { grant } = await signInToPreview(carol, "shared");
    expect((await whoami("shared", grant)).status).toBe(200);
    for (const target of ["/%5F%5Fmend/auth", "/%5f_mend/whoami", "/__m%65nd/x", "/%E0%A4%A"]) {
      const reply = await within(
        atPreview("shared", target, { cookie: `__Host-mend-preview=${grant}` }),
        2_000,
        `an answer for ${target}`,
      );
      expect(reply.status, target).toBe(404);
    }
  });

  it("admits a request with two statements: the preview row and the grant", async () => {
    const { grant } = await signInToPreview(carol, "shared");
    statements.length = 0;
    expect((await whoami("shared", grant)).status).toBe(200);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/from "previews"/i);
    expect(statements[1]).toMatch(/from "preview_grants"/i);
  });

  it("never prints a ticket or a grant", () => {
    const output = printed.join("\n");
    expect(output).not.toMatch(/mut_[A-Za-z0-9_-]{20}/);
    expect(output).not.toMatch(/mpg_[A-Za-z0-9_-]{20}/);
  });
});
