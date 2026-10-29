import { PgClient } from "@effect/sql-pg";
import {
  AuthMiddleware,
  CurrentUser,
  PageFrame,
  pageViewGroup,
  pagesGroup,
} from "@mend/api-contracts";
import {
  InstanceRolesRepoLive,
  MendDBLive,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  ServicesRepoLive,
  SessionPagesRepo,
  SessionPagesRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
  migrations,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { SessionId } from "@mend/domain";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectAccess, ProjectAccessLive } from "../access.ts";
import { pageViewKeyOf, pageViewTokensOf, PageViewTokens } from "../page-view-tokens.ts";
import { apiResponseHeaders } from "../response-headers.ts";
import { PageViewGroupLive, PagesGroupLive } from "./pages.ts";

const postgres = postgresTestConfig();
const database = `mend_page_http_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const db = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.toString()) })),
);
const repos = Layer.mergeAll(
  InstanceRolesRepoLive,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  ServicesRepoLive,
  SessionPagesRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
).pipe(Layer.provideMerge(db));
const services = Layer.mergeAll(
  Layer.succeed(PageViewTokens, pageViewTokensOf(pageViewKeyOf("pages-postgres-test-secret"))),
  ProjectAccessLive,
).pipe(Layer.provideMerge(repos));
const runtime = ManagedRuntime.make(services);
const auth = Layer.succeed(AuthMiddleware, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = request.headers["authorization"]?.slice("Bearer ".length) ?? "outsider";
    return yield* Effect.provideService(httpEffect, CurrentUser, {
      user: { id, name: id, email: `${id}@test.invalid` },
      expiresAt: new Date(Date.now() + 60_000),
    });
  }),
);
const api = HttpApi.make("mend").add(pagesGroup).add(pageViewGroup).prefix("/api");
const routes = Layer.mergeAll(
  HttpApiBuilder.layer(api).pipe(
    Layer.provide(Layer.mergeAll(PagesGroupLive, PageViewGroupLive)),
    Layer.provide(auth),
  ),
  apiResponseHeaders,
);
const app = routes.pipe(Layer.provide(services), Layer.provide(HttpServer.layerServices));
const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
let created = false;
const request = async (path: string, account?: string) =>
  handler(
    new Request(new URL(path, "http://mend.test"), {
      headers: {
        host: "mend.test",
        ...(account === undefined ? {} : { authorization: `Bearer ${account}` }),
      },
    }),
    await runtime.runPromise(Effect.context<PageViewTokens | ProjectAccess | SessionPagesRepo>()),
  );

describe.skipIf(postgres.skip)("page frame access against Postgres", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
      }).pipe(Effect.provide(admin), Effect.scoped),
    );
    created = true;
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        for (const id of ["page-owner", "page-reader", "outsider"]) {
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES (${id}, ${id}, ${`${id}@test.invalid`}, NOW())`;
        }
        yield* sql`INSERT INTO organization_members (organization_id,user_id,role)
        SELECT id, 'page-owner', 'owner' FROM organizations LIMIT 1`;
        yield* sql`INSERT INTO organization_members (organization_id,user_id,role)
        SELECT id, 'page-reader', 'member' FROM organizations LIMIT 1`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id,visibility)
        VALUES ('p-http-page','Pages','/store/pages.git','main',(SELECT id FROM organizations LIMIT 1),'page-owner','shared')`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
        VALUES ('wt-http-page','p-http-page','Pages','pages','mend/pages','abc')`;
        yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status)
        VALUES ('s-http-page','p-http-page','wt-http-page','page-owner','claude','pages','mend/pages','abc','completed')`;
      }),
    );
  });
  afterAll(async () => {
    await dispose();
    await runtime.dispose();
    if (created)
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* SqlClient.SqlClient).unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
        }).pipe(Effect.provide(admin), Effect.scoped),
      );
  });

  it("serves the stored page and refuses the next load after membership removal", async () => {
    const page = await runtime.runPromise(
      Effect.flatMap(SessionPagesRepo, (pages) =>
        pages.publish({
          sessionId: SessionId.make("s-http-page"),
          callKey: "frame",
          accountId: "page-owner",
          title: "Membership",
          height: 400,
          html: "<p>Stored in Postgres</p>",
        }),
      ),
    );
    expect((await request(`/api/pages/${page.id}/frame?appearance=dark`, "outsider")).status).toBe(
      404,
    );
    const response = await request(`/api/pages/${page.id}/frame?appearance=dark`, "page-reader");
    expect(response.status).toBe(200);
    const frame = Schema.decodeUnknownSync(PageFrame)(await response.json());
    const document = await request(frame.url);
    expect(document.status).toBe(200);
    expect(await document.text()).toContain("<p>Stored in Postgres</p>");
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient)`DELETE FROM organization_members WHERE user_id='page-reader'`;
      }),
    );
    expect((await request(frame.url)).status).toBe(404);
    expect(
      (await request(`/api/pages/${page.id}/frame?appearance=dark`, "page-reader")).status,
    ).toBe(404);
    expect(
      (await request(`/api/pages/${page.id}/frame?appearance=dark`, "page-owner")).status,
    ).toBe(200);
  });

  it("frames a page from its metadata, never reading its body", async () => {
    const page = await runtime.runPromise(
      Effect.flatMap(SessionPagesRepo, (pages) =>
        pages.publish({
          sessionId: SessionId.make("s-http-page"),
          callKey: "metadata-only",
          accountId: "page-owner",
          title: "Metadata",
          height: 400,
          html: `<p>${"x".repeat(400_000)}</p>`,
        }),
      ),
    );
    const bodiless = Layer.effect(
      SessionPagesRepo,
      Effect.gen(function* () {
        const pages = yield* SessionPagesRepo;
        return {
          ...pages,
          byId: () => Effect.die(new Error("the frame route read the page's body")),
        };
      }),
    );
    const framing = HttpRouter.toWebHandler(
      routes.pipe(
        Layer.provide(bodiless),
        Layer.provide(services),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    );
    try {
      const framed = await framing.handler(
        new Request(new URL(`/api/pages/${page.id}/frame?appearance=dark`, "http://mend.test"), {
          headers: { host: "mend.test", authorization: "Bearer page-owner" },
        }),
        await runtime.runPromise(
          Effect.context<PageViewTokens | ProjectAccess | SessionPagesRepo>(),
        ),
      );
      expect(framed.status).toBe(200);
      expect(await framed.text()).not.toContain("xxxx");
    } finally {
      await framing.dispose();
    }
  });
});
