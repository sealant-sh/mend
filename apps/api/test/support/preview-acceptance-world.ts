import * as http from "node:http";
import { fileURLToPath } from "node:url";

import { PreviewsRepo } from "@mend/db";
import { PreviewId, SessionProcessId } from "@mend/domain";
import {
  type PreviewStartRequest,
  PreviewStartRefusal,
  previewStartId,
  serviceStartCorrelation,
} from "@mend/domain/workbench";
import { PreviewStartRefused, SessionEngine, WorkspaceCaller } from "@mend/sessions";
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Schema, Scope } from "effect";
import { SqlClient } from "effect/sql";

import { Budgets, DEFAULT_BUDGET_LIMITS, makeBudgets } from "../../src/budgets.ts";
import { ConnectionRegistryLive } from "../../src/connections.ts";
import { EventBusLive } from "../../src/events-bus.ts";
import {
  PREVIEW_GATEWAY_DEFAULTS,
  type PreviewGatewaySettings,
} from "../../src/preview-gateway.ts";
import {
  makePreviewIdentityLayer,
  PREVIEW_TIMING,
  PreviewConfig,
  PreviewIdentity,
  PreviewIdentityLive,
} from "../../src/preview-identity.ts";
import { previewOriginOf, type PreviewRouting } from "../../src/preview-routing.ts";
import { servePreviews } from "../../src/preview-serving.ts";
import { type RunningFixture, spawnFixture } from "../fixtures/preview/apps.ts";
import {
  type KeptPreview,
  PREVIEW_WORKSPACE,
  previewReposLayer,
  SERVICE_KEYS,
  type ServiceKey,
  SERVICES,
  signInRow,
} from "./preview-database.ts";
import { localForwards } from "./preview-forward.ts";
import { type SampledChild, spawnSampled } from "./preview-memory.ts";

/**
 * The preview gateway for acceptance tests, built as production builds it (`servePreviews` with
 * `PreviewIdentityLive`, `PreviewTargetsLive`, the real event bus, connection registry and
 * repositories over a seeded Postgres, and `ForwardAdapterLive` over TCP forwards), in this
 * process or in a child (`preview-gateway-child.ts`). Two parts stand in for what needs a live
 * Sealant workspace: the engine's request-triggered start, which spawns the Service's fixture on
 * its local port after a delay and records its attempt as the engine would, and the lending check,
 * which lends every act. Nothing here imports vitest, so a child Node can load it.
 */

export const APP_URL = "https://mend.acceptance.test";

const FixtureKind = Schema.Literals(["digest", "download", "sse", "websocket", "cookies", "all"]);

const Start = Schema.Union([
  Schema.TaggedStruct("Fixture", { fixture: FixtureKind, delayMs: Schema.Number }),
  Schema.TaggedStruct("Never", {}),
  Schema.TaggedStruct("Refuse", { reason: PreviewStartRefusal }),
]);
export type GatewayStart = typeof Start.Type;

const Routing = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("loopback-http"), port: Schema.Number }),
  Schema.Struct({
    mode: Schema.Literal("domain-https"),
    domain: Schema.String,
    port: Schema.Number,
  }),
]);

export const AcceptanceGatewayOptions = Schema.Struct({
  databaseUrl: Schema.String,
  routing: Routing,
  /** The gateway's listen port on 127.0.0.1. */
  port: Schema.Number,
  startHoldMs: Schema.optional(Schema.Number),
  /** A streaming cap on one body; absent is none. */
  bodyCapBytes: Schema.optional(Schema.Number),
  /** Each Service's workspace port, as this local port on 127.0.0.1. */
  localPorts: Schema.Struct({ web: Schema.Number, docs: Schema.Number }),
  /** The negative control: forwards that read their TCP socket eagerly into memory. */
  unbounded: Schema.optional(Schema.Boolean),
  /** What a request-triggered start of each Service does; absent refuses `no-recorded-command`. */
  starts: Schema.optional(
    Schema.Struct({ web: Schema.optional(Start), docs: Schema.optional(Start) }),
  ),
});
export type AcceptanceGatewayOptions = typeof AcceptanceGatewayOptions.Type;

export const decodeAcceptanceGatewayOptions = Schema.decodeUnknownSync(
  Schema.fromJsonString(AcceptanceGatewayOptions),
);

const lendingToEveryone = Layer.mock(WorkspaceCaller, {
  observe: () => (self) => self,
  act: () => (self) => self,
  observeRun: () => (self) => self,
  observeRunStream: () => (self) => self,
  mayAct: () => Effect.void,
});

export interface AcceptanceGateway {
  readonly port: number;
  /** Every start the gateway asked of the engine, in order. */
  readonly starts: ReadonlyArray<PreviewStartRequest>;
  /** The opens the forward adapter made, per (workspace, port). */
  readonly opens: () => number;
}

const recordAttempt = (key: ServiceKey, request: PreviewStartRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = SERVICES[key];
    const attemptId = SessionProcessId.make(`att-${key}-request-${Date.now()}`);
    yield* sql`INSERT INTO session_processes (id, session_id, sealant_workspace_id, kind, status,
        service_id, attempt_ordinal, argv, sealant_session_id, launch_correlation_id, created_at)
      VALUES (${attemptId}, 's-1', ${PREVIEW_WORKSPACE}, 'service', 'running', ${service.id},
        (SELECT coalesce(max(attempt_ordinal), 0) + 1 FROM session_processes
          WHERE service_id = ${service.id}),
        '["npm", "run", "dev"]'::jsonb, ${`pty-${attemptId}`},
        ${serviceStartCorrelation(service.id, previewStartId(request))}, now())`;
    yield* sql`UPDATE services SET current_attempt_id = ${attemptId} WHERE id = ${service.id}`;
    return attemptId;
  }).pipe(Effect.orDie);

/** Builds the gateway in the current scope; it listens until the scope closes. */
export const acceptanceGateway = (
  options: AcceptanceGatewayOptions,
  onStart: (request: PreviewStartRequest) => void = () => undefined,
): Effect.Effect<AcceptanceGateway, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const repos = yield* Layer.build(previewReposLayer(options.databaseUrl));
    const forwards = localForwards(
      SERVICE_KEYS.map((key) => ({
        workspaceId: PREVIEW_WORKSPACE,
        port: SERVICES[key].port,
        entry: { kind: "listen", localPort: options.localPorts[key] },
      })),
      { unbounded: options.unbounded === true },
    );
    const asked: Array<PreviewStartRequest> = [];
    const running: Array<RunningFixture> = [];
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.all(running.map((fixture) => fixture.stop()))),
    );

    const startFor = (
      request: PreviewStartRequest,
    ): Effect.Effect<SessionProcessId, PreviewStartRefused> =>
      Effect.gen(function* () {
        asked.push(request);
        onStart(request);
        const preview = yield* Effect.flatMap(PreviewsRepo, (previews) =>
          previews.byId(request.previewId),
        );
        const key = SERVICE_KEYS.find((candidate) => candidate === preview?.serviceName);
        const start = key === undefined ? undefined : options.starts?.[key];
        if (key === undefined || start === undefined) {
          return yield* new PreviewStartRefused({ reason: "no-recorded-command" });
        }
        switch (start._tag) {
          case "Never":
            return yield* Effect.never;
          case "Refuse":
            return yield* new PreviewStartRefused({ reason: start.reason });
          case "Fixture": {
            yield* Effect.sleep(start.delayMs);
            running.push(
              yield* Effect.promise(() => spawnFixture(start.fixture, options.localPorts[key])),
            );
            return yield* recordAttempt(key, request);
          }
        }
      }).pipe(Effect.provideContext(repos));

    const settings: PreviewGatewaySettings = {
      bind: "127.0.0.1",
      port: options.port,
      startHoldMs: options.startHoldMs ?? PREVIEW_GATEWAY_DEFAULTS.startHoldMs,
      bodyCap:
        options.bodyCapBytes === undefined
          ? { _tag: "Unlimited" }
          : { _tag: "Capped", bytes: options.bodyCapBytes },
      limits: PREVIEW_GATEWAY_DEFAULTS.limits,
    };
    yield* Layer.build(
      servePreviews(Layer.empty, {
        setup: { _tag: "On", routing: options.routing, gateway: settings },
        appUrl: APP_URL,
        identity: PreviewIdentityLive,
      }).pipe(
        Layer.provide(ConnectionRegistryLive),
        Layer.provide(EventBusLive),
        Layer.provide(
          Layer.mergeAll(
            lendingToEveryone,
            forwards.layer,
            Layer.succeed(Budgets, makeBudgets(DEFAULT_BUDGET_LIMITS)),
            Layer.mock(SessionEngine, {
              ensurePreviewRunning: startFor,
              launchUnderWay: () => false,
            }),
          ),
        ),
        Layer.provide(Layer.succeedContext(repos)),
      ),
    );
    return { port: options.port, starts: asked, opens: () => forwards.opens.length };
  });

/** Mints sign-in tickets as `/api/preview-auth` does, over the same database. */
export interface PreviewSignIn {
  /** The `/__mend/auth` URL that signs `userId` in to the Service's preview, then opens `path`. */
  readonly authUrl: (userId: string, key: ServiceKey, path?: string) => Promise<string>;
  readonly originOf: (previewId: PreviewId) => string;
  /** Applies `userId`'s Stop to the Service's preview, as the engine records a person's Stop. */
  readonly stop: (key: ServiceKey, userId: string) => Promise<void>;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SqlClient.SqlClient | PreviewsRepo>,
  ) => Promise<A>;
  readonly dispose: () => Promise<void>;
}

export const previewSignIn = (
  databaseUrl: string,
  routing: PreviewRouting,
  previews: Readonly<Record<ServiceKey, KeptPreview>>,
): PreviewSignIn => {
  const runtime = ManagedRuntime.make(
    makePreviewIdentityLayer(PREVIEW_TIMING).pipe(
      Layer.provideMerge(Layer.succeed(PreviewConfig, { appUrl: APP_URL, routing })),
      Layer.provide(EventBusLive),
      Layer.provideMerge(previewReposLayer(databaseUrl)),
    ),
  );
  const originOf = (previewId: PreviewId) => {
    const preview = SERVICE_KEYS.map((key) => previews[key]).find((p) => p.id === previewId);
    const origin = preview === undefined ? null : previewOriginOf(routing, preview);
    if (origin === null) throw new Error(`the routing addresses no preview ${previewId}`);
    return origin;
  };
  return {
    authUrl: (userId, key, path = "/") =>
      runtime.runPromise(
        Effect.gen(function* () {
          const credential = yield* signInRow(userId);
          const identity = yield* PreviewIdentity;
          const issued = yield* identity.issueTicket({
            previewId: previews[key].id,
            opener: { userId, credential },
          });
          return `${issued.origin}/__mend/auth?ticket=${encodeURIComponent(Redacted.value(issued.ticket))}&path=${encodeURIComponent(path)}`;
        }),
      ),
    originOf,
    stop: (key, userId) =>
      runtime.runPromise(
        Effect.flatMap(PreviewsRepo, (repo) =>
          repo.changeControl(previews[key].id, { _tag: "Stop", by: userId, at: new Date() }),
        ).pipe(Effect.asVoid),
      ),
    run: (effect) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
};

const NAVIGATION = {
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
} as const;

/**
 * Follows `authUrl` on the gateway at 127.0.0.1:`port` as a browser's navigation would, and
 * answers the grant cookie it set, as a `Cookie` header pair.
 */
export const grantCookieAt = (port: number, authUrl: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const url = new URL(authUrl);
    const outgoing = http.request({
      host: "127.0.0.1",
      port,
      path: `${url.pathname}${url.search}`,
      headers: { host: url.host, ...NAVIGATION },
      agent: false,
    });
    outgoing.on("error", reject);
    outgoing.on("response", (response) => {
      response.resume();
      const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
      if (response.statusCode !== 303 || cookie === undefined) {
        reject(new Error(`the exchange answered ${response.statusCode} without a grant`));
      } else resolve(cookie);
    });
    outgoing.end();
  });

const CHILD = fileURLToPath(new URL("./preview-gateway-child.ts", import.meta.url));

export interface GatewayChild {
  readonly sampled: SampledChild;
  /** Every start the child's gateway asked of the engine, as the child reported it. */
  readonly starts: () => ReadonlyArray<PreviewStartRequest>;
}

const StartLine = Schema.fromJsonString(
  Schema.Struct({
    start: Schema.Struct({
      previewId: Schema.String,
      revision: Schema.Number,
      sourceAttemptId: Schema.String,
      deadline: Schema.Number,
    }),
  }),
);
const startOf = Schema.decodeUnknownOption(StartLine);

/**
 * The same gateway in a child Node whose memory `spawnSampled` samples every `intervalMs`: the
 * child is the API process the memory tests bound. Resolves once it listens.
 */
export const spawnGateway = async (
  options: AcceptanceGatewayOptions,
  intervalMs = 100,
): Promise<GatewayChild> => {
  const sampled = spawnSampled(CHILD, [JSON.stringify(options)], { intervalMs });
  const starts: Array<PreviewStartRequest> = [];
  let partial = "";
  sampled.child.stdout?.on("data", (text: string) => {
    const lines = `${partial}${text}`.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const read = startOf(line);
      if (read._tag === "Some") {
        const { previewId, revision, sourceAttemptId, deadline } = read.value.start;
        starts.push({
          previewId: PreviewId.make(previewId),
          revision,
          sourceAttemptId: SessionProcessId.make(sourceAttemptId),
          deadline,
        });
      }
    }
  });
  try {
    await sampled.line((line) => line.startsWith('{"port"'));
  } catch (error) {
    await sampled.stop();
    throw error;
  }
  return { sampled, starts: () => starts };
};

/** The same gateway in this process, until `close`. */
export const startGateway = async (
  options: AcceptanceGatewayOptions,
): Promise<AcceptanceGateway & { readonly close: () => Promise<void> }> => {
  const scope = Effect.runSync(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  try {
    const gateway = await Effect.runPromise(acceptanceGateway(options).pipe(Scope.provide(scope)));
    return { ...gateway, close };
  } catch (error) {
    await close();
    throw error;
  }
};
