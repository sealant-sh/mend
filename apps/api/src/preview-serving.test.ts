import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Auth } from "@mend/auth";
import type { TicketCredential } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ForwardSessionOwner } from "@mend/sealant";
import { ResourceRuntimeNone } from "@mend/sessions";
import { SessionEngine, WorkspaceCaller } from "@mend/sessions";
import { Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type DigestAnswer, serveFixture } from "../test/fixtures/preview/apps.ts";
import {
  createPreviewDatabase,
  PREVIEW_WORKSPACE,
  type PreviewDatabase,
  previewReposLayer,
  SERVICES,
  signInRow,
} from "../test/support/preview-database.ts";
import { localForwards } from "../test/support/preview-forward.ts";
import { freePort, send } from "../test/support/preview-gateway-world.ts";
import { Budgets, DEFAULT_BUDGET_LIMITS, makeBudgets } from "./budgets.ts";
import { ConnectionRegistryLive } from "./connections.ts";
import { EventBusLive } from "./events-bus.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "./preview-gateway-settings.ts";
import { PreviewIdentity, PreviewIdentityLive } from "./preview-identity.ts";
import { servePreviews } from "./preview-serving.ts";
import { PreviewAuthRoutes } from "./routes/preview-auth.ts";

const postgres = postgresTestConfig();
const SIGNED_IN = "test-signed-in";

let database: PreviewDatabase | null = null;
beforeAll(async () => {
  if (!postgres.skip) database = await createPreviewDatabase("preview_serving");
});
afterAll(async () => {
  await database?.drop();
});

/** A Mend sign-in for each person who signed in: `<SIGNED_IN>=<userId>` stands for its cookie. */
const authFor = (credentials: ReadonlyMap<string, TicketCredential>) =>
  Layer.mock(Auth, {
    getSession: (headers) =>
      Effect.sync(() => {
        const userId = /test-signed-in=([a-z]+)/.exec(headers.get("cookie") ?? "")?.[1];
        const credential = userId === undefined ? undefined : credentials.get(userId);
        return userId === undefined || credential === undefined
          ? Option.none()
          : Option.some({
              user: { id: userId, email: `${userId}@example.com`, name: userId },
              expiresAt: new Date("2100-01-01T00:00:00Z"),
              credential,
            });
      }),
  });

const lendingToEveryone = Layer.mock(WorkspaceCaller, {
  observe: () => (self) => self,
  act: () => (self) => self,
  observeRun: () => (self) => self,
  observeRunStream: () => (self) => self,
  mayAct: () => Effect.void,
});

const NAVIGATION = {
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
} as const;

describe.skipIf(postgres.skip)("the API's HTTP tier with previews on", () => {
  it("builds one identity for the router and the gateway, and a ticket the router minted opens the preview", async () => {
    if (database === null) throw new Error("the database was not created");
    const { url, previews } = database;
    const app = await serveFixture("all");
    const routerPort = await freePort();
    const gatewayPort = await freePort();
    const forwards = localForwards([
      {
        workspaceId: PREVIEW_WORKSPACE,
        port: SERVICES.web.port,
        entry: { kind: "listen", localPort: app.port },
      },
    ]);
    let identities = 0;
    const counted = Layer.effect(
      PreviewIdentity,
      Effect.gen(function* () {
        identities += 1;
        return yield* PreviewIdentity;
      }),
    ).pipe(Layer.provide(PreviewIdentityLive));
    const repos = previewReposLayer(url);
    const credentials = new Map<string, TicketCredential>();

    const tier = servePreviews(
      HttpRouter.serve(PreviewAuthRoutes).pipe(
        Layer.provide(NodeHttpServer.layer(createServer, { port: routerPort })),
      ),
      {
        setup: {
          _tag: "On",
          routing: { mode: "loopback-http", port: gatewayPort },
          gateway: { bind: "127.0.0.1", port: gatewayPort, ...PREVIEW_GATEWAY_DEFAULTS },
        },
        appUrl: "http://localhost:3105",
        trustedProxies: [],
        identity: counted,
      },
    ).pipe(
      Layer.provide(ConnectionRegistryLive),
      Layer.provide(EventBusLive),
      Layer.provide(
        Layer.mergeAll(
          ResourceRuntimeNone,
          authFor(credentials),
          lendingToEveryone,
          forwards.layer,
          Layer.succeed(Budgets, makeBudgets(DEFAULT_BUDGET_LIMITS)),
          Layer.mock(SessionEngine, {
            ensurePreviewRunning: () => Effect.die("the preview is running"),
            launchUnderWay: () => false,
          }),
        ),
      ),
      Layer.provideMerge(repos),
    );

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(tier);
            credentials.set("carol", yield* signInRow("carol"));
            const issued = yield* Effect.promise(() =>
              send(routerPort, {
                host: "localhost:3105",
                path: `/api/preview-auth?preview=${previews.web.id}&path=%2Fhello`,
                headers: { cookie: `${SIGNED_IN}=carol` },
              }),
            );
            expect(issued.status, "the router mints a ticket for carol").toBe(302);
            const location = new URL(String(issued.headers.location));
            expect(location.origin, "and sends her to the web preview's own origin").toBe(
              `http://${previews.web.label}.localhost:${gatewayPort}`,
            );
            const exchanged = yield* Effect.promise(() =>
              send(gatewayPort, {
                host: location.host,
                path: `${location.pathname}${location.search}`,
                headers: NAVIGATION,
              }),
            );
            expect(exchanged.status, "the gateway spends the router's ticket").toBe(303);
            const grant = (exchanged.headers["set-cookie"] ?? [])[0]?.split(";")[0] ?? "";
            expect(grant, "and sets the grant cookie").toMatch(/^mend-preview=mpg_/);
            const opened = yield* Effect.promise(() =>
              send(gatewayPort, {
                host: location.host,
                path: "/hello",
                headers: { cookie: grant },
              }),
            );
            expect(opened.status, "the grant opens the preview").toBe(200);
            const answer: DigestAnswer = JSON.parse(opened.body);
            expect(answer.path, "the app answered the request carol made").toBe("/hello");
            const sql = yield* SqlClient.SqlClient;
            const [left] = yield* sql<{ readonly count: number }>`
              SELECT count(*)::int AS count FROM upgrade_tickets WHERE target = 'preview'`;
            const [granted] = yield* sql<{ readonly count: number }>`
              SELECT count(*)::int AS count FROM preview_grants`;
            expect(left?.count, "the ticket was spent").toBe(0);
            expect(granted?.count, "into one stored grant").toBe(1);
          }).pipe(Effect.provide(repos)),
        ),
      );
    } finally {
      await app.stop();
    }
    expect(identities, "the router and the gateway were given one identity").toBe(1);
    expect(forwards.dials.length, "one dial reached the app").toBe(1);
    expect(forwards.dials[0]?.requested, "bound to the attempt's platform session").toEqual({
      kind: "session",
      session: ForwardSessionOwner.make(`pty-${SERVICES.web.attemptId}`),
    });
  });
});
