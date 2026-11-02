import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { observedWebHandler, serveObserved } from "@mend/network/http-observation";
import { AuthSessionId, EnvironmentId } from "@mend/t3-contracts";
import type { AuthEnvironmentScope } from "@mend/t3-contracts";
import { Clock, Context, Effect, Layer, Logger, Tracer } from "effect";
import { HttpClient, HttpClientResponse, HttpServer } from "effect/http";

import {
  AssetLimits,
  AssetRouteLive,
  DEFAULT_ASSET_LIMITS,
  AssetUrls,
  AssetUrlsLive,
} from "../../src/assets.ts";
import { GatewayAuthLive } from "../../src/auth.ts";
import { GatewayConfig } from "../../src/config.ts";
import { GatewayEnvironment, makeGatewayEnvironment } from "../../src/environment.ts";
import { GatewayCorsLive } from "../../src/http.ts";
import { Projections, type PersonHub } from "../../src/hub.ts";
import { MendClient, MendClientLive } from "../../src/mend-client.ts";
import { makeGatewayRpcHandlers } from "../../src/rpc.ts";
import {
  GatewayState,
  type GatewayStateError,
  openGatewayState,
  type StoredImage,
} from "../../src/state.ts";
import { emptyHub, testBearerSession } from "./stubs.ts";

export const ROOT = "/var/lib/mend/store/project-1/worktrees/wt-session-1";
interface RawFixture {
  bytes: Uint8Array;
  canonicalPath: string;
  revision?: string;
  identity?: string;
  status?: number;
  captureId?: string;
  size?: number;
  failAfter?: number;
  pulled?: number;
  cancelled?: boolean;
}

interface PageFixture {
  readonly document: string;
  readonly readers: Set<string>;
  frameUrl?: string;
  frameStatus?: number;
  viewStatus?: number;
  contentType?: string;
  frameStalls?: boolean;
  viewStalls?: boolean;
}

interface ProofFixture {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly readers: Set<string>;
  status?: number;
  headers?: Record<string, string>;
  failAfter?: number;
  stalled?: boolean;
  pulled?: number;
  cancelled?: boolean;
}

/** Real grants, auth, SQLite, Mend HTTP decoding and asset HTTP responses, served in memory and on Node. */
export const withAssetHarness = <A, E, R>(
  test: (fixture: AssetHarness, logs: string[]) => Effect.Effect<A, E, R>,
  limits: Partial<AssetLimits> = {},
  node = true,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* openGatewayState(":memory:");
      const rawFiles = new Map<string, RawFixture>();
      const goneWorktrees = new Set<string>();
      const revoked = new Set<string>();
      const refused = new Set<string>();
      const claims: { token: string }[] = [];
      const logs: string[] = [];
      const spans: Tracer.Span[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = Tracer.nativeTracer.span(options);
          spans.push(span);
          return span;
        },
      });
      const requests: { method: string; path: string; range: string | undefined }[] = [];
      const images = new Map<string, StoredImage>();
      const pages = new Map<string, PageFixture>();
      const proofs = new Map<string, ProofFixture>();
      const proofRequests: {
        method: string;
        path: string;
        range: string | undefined;
        authorization: string | undefined;
      }[] = [];
      const pageViews = new Map<string, { page: PageFixture; token: string }>();
      const pageRequests: { path: string; authorization: string | undefined }[] = [];
      let beforeRaw: (() => Effect.Effect<void>) | undefined;
      const clock = yield* Clock.Clock;
      const environment = makeGatewayEnvironment({
        environmentId: EnvironmentId.make("raw-test"),
        host: "127.0.0.1",
        label: "raw",
        statePath: ":memory:",
      });
      const transport = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (url.pathname.endsWith("/raw") && beforeRaw !== undefined) yield* beforeRaw();
          return yield* Effect.sync(() => {
            const token = (request.headers.authorization ?? "").slice(7);
            const reply = (
              status: number,
              body: BodyInit | null,
              headers: Record<string, string> = {},
            ) => HttpClientResponse.fromWeb(request, new Response(body, { status, headers }));
            if (url.pathname === "/api/me/devices")
              return reply(revoked.has(token) ? 401 : 200, "[]", {
                "content-type": "application/json",
              });
            if (url.pathname.startsWith("/api/pages/") || url.pathname === "/api/page-view") {
              pageRequests.push({
                path: url.pathname,
                authorization: request.headers.authorization,
              });
              if (url.pathname === "/api/page-view") {
                const view = pageViews.get(url.searchParams.get("view") ?? "");
                if (view === undefined || !view.page.readers.has(view.token))
                  return reply(404, null);
                if (view.page.viewStalls === true)
                  return reply(
                    200,
                    new ReadableStream({
                      start: (body) => body.enqueue(new TextEncoder().encode("<!doctype html>")),
                    }),
                    { "content-type": "text/html; charset=utf-8" },
                  );
                return reply(view.page.viewStatus ?? 200, view.page.document, {
                  "content-type": view.page.contentType ?? "text/html; charset=utf-8",
                  "content-security-policy": "sandbox allow-scripts allow-forms",
                });
              }
              if (revoked.has(token)) return reply(401, null);
              const page = pages.get(decodeURIComponent(url.pathname.split("/")[3] ?? ""));
              if (page === undefined || !page.readers.has(token)) return reply(404, null);
              if (page.frameStalls === true)
                return reply(
                  200,
                  new ReadableStream({
                    start: (body) => body.enqueue(new TextEncoder().encode('{"url":')),
                  }),
                  { "content-type": "application/json" },
                );
              const view = `private-view-${pageViews.size}`;
              pageViews.set(view, { page, token });
              return reply(
                page.frameStatus ?? 200,
                JSON.stringify({
                  url: page.frameUrl ?? `/api/page-view?view=${view}`,
                  expiresAt: new Date(now + 30 * 60_000).toISOString(),
                }),
                { "content-type": "application/json" },
              );
            }
            if (url.pathname.startsWith("/api/proof-artifacts/")) {
              proofRequests.push({
                method: request.method,
                path: url.pathname,
                range: request.headers.range,
                authorization: request.headers.authorization,
              });
              if (revoked.has(token)) return reply(401, null);
              const proof = proofs.get(decodeURIComponent(url.pathname.split("/")[3] ?? ""));
              if (proof === undefined || !proof.readers.has(token)) return reply(404, null);
              if (proof.status !== undefined) return reply(proof.status, null, proof.headers);
              let bytes = proof.bytes;
              let status = 200;
              const headers: Record<string, string> = { "content-type": proof.mimeType };
              const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
              if (request.method === "GET" && range !== null) {
                const start = range[1]
                  ? Number(range[1])
                  : Math.max(0, bytes.length - Number(range[2]));
                const end = range[1]
                  ? Math.min(Number(range[2] || bytes.length - 1), bytes.length - 1)
                  : bytes.length - 1;
                status = start >= bytes.length ? 416 : 206;
                headers["content-range"] =
                  status === 416
                    ? `bytes */${bytes.length}`
                    : `bytes ${start}-${end}/${bytes.length}`;
                bytes = status === 416 ? new Uint8Array() : bytes.slice(start, end + 1);
              }
              headers["content-length"] = String(bytes.length);
              Object.assign(headers, proof.headers);
              if (request.method === "HEAD" || status === 416) return reply(status, null, headers);
              let sent = 0;
              return reply(
                status,
                new ReadableStream<Uint8Array>(
                  {
                    pull(controller) {
                      if (proof.stalled === true) return;
                      if (proof.failAfter !== undefined && sent >= proof.failAfter) {
                        controller.error(new Error("proof blob missing (404)"));
                        return;
                      }
                      if (sent === bytes.length) return controller.close();
                      const chunk = bytes.subarray(sent, sent + 64 * 1024);
                      sent += chunk.length;
                      proof.pulled = sent;
                      controller.enqueue(chunk);
                    },
                    cancel() {
                      proof.cancelled = true;
                    },
                  },
                  { highWaterMark: 0 },
                ),
                headers,
              );
            }
            if (revoked.has(token)) return reply(401, null);
            const worktree = url.pathname.split("/")[3] ?? "";
            const path = url.searchParams.get("path") ?? "";
            requests.push({ method: request.method, path, range: request.headers.range });
            const capture = url.searchParams.get("capture");
            const file = rawFiles.get(
              `${worktree}/${path}${capture === null ? "" : `@${capture}`}`,
            );
            const within = url.searchParams.get("within") ?? "";
            if (
              file === undefined ||
              goneWorktrees.has(worktree) ||
              (within !== "" && !file.canonicalPath.startsWith(`${within}/`))
            )
              return reply(404, null);
            if (file.status !== undefined) return reply(file.status, null);
            let bytes = file.bytes;
            let status = 200;
            const headers: Record<string, string> = {
              "content-type": "application/octet-stream",
              "x-mend-file-path": encodeURIComponent(file.canonicalPath),
              "x-mend-file-revision": file.revision ?? "a".repeat(64),
              "x-mend-file-identity": file.identity ?? "c".repeat(64),
              ...(file.captureId === undefined ? {} : { "x-mend-capture-id": file.captureId }),
              "x-frame-options": "DENY",
              "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
            };
            const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
            if (request.method === "GET" && range !== null) {
              const start = Number(range[1]);
              const end = Math.min(Number(range[2] || bytes.length - 1), bytes.length - 1);
              status = start >= bytes.length ? 416 : 206;
              headers["content-range"] =
                status === 416
                  ? `bytes */${bytes.length}`
                  : `bytes ${start}-${end}/${bytes.length}`;
              bytes = status === 416 ? new Uint8Array() : bytes.slice(start, end + 1);
            }
            headers["content-length"] = String(file.size ?? bytes.length);
            if (request.method === "HEAD") return reply(status, null, headers);
            if (file.size !== undefined) {
              let sent = 0;
              const size = file.size;
              return reply(
                status,
                new ReadableStream<Uint8Array>(
                  {
                    pull(controller) {
                      if (file.failAfter !== undefined && sent >= file.failAfter) {
                        controller.error(new Error("upstream read failed"));
                        return;
                      }
                      if (sent === size) {
                        controller.close();
                        return;
                      }
                      const chunk = new Uint8Array(Math.min(64 * 1024, size - sent));
                      chunk.fill(17);
                      sent += chunk.length;
                      file.pulled = sent;
                      controller.enqueue(chunk);
                    },
                    cancel() {
                      file.cancelled = true;
                    },
                  },
                  { highWaterMark: 0 },
                ),
                headers,
              );
            }
            return reply(status, new Uint8Array(bytes), headers);
          });
        }),
      );
      const mend = MendClientLive.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, transport)),
        Layer.provide(
          Layer.succeed(GatewayConfig, {
            mendUrl: new URL("http://mend.internal"),
            host: "127.0.0.1",
            port: 0,
            statePath: ":memory:",
            label: "raw",
          }),
        ),
      );
      const projections = Layer.mock(Projections, {
        isDeviceRefused: (token) => refused.has(token),
        refuseDevice: (_user, token) =>
          Effect.gen(function* () {
            refused.add(token);
            yield* state
              .revokeSessionsForDevice(token, yield* Clock.currentTimeMillis)
              .pipe(Effect.orDie);
          }),
      });
      const services = yield* Layer.build(
        AssetUrlsLive.pipe(
          Layer.provideMerge(GatewayAuthLive),
          Layer.provideMerge(projections),
          Layer.provideMerge(mend),
          Layer.provideMerge(Layer.succeed(GatewayState, state)),
          Layer.provideMerge(Layer.succeed(GatewayEnvironment, environment)),
          Layer.provideMerge(Layer.succeed(AssetLimits, { ...DEFAULT_ASSET_LIMITS, ...limits })),
        ),
      );
      const urls = Context.get(services, AssetUrls);
      const client = Context.get(services, MendClient);
      const routes = Layer.mergeAll(AssetRouteLive, GatewayCorsLive).pipe(
        Layer.provide(Layer.succeedContext(services)),
        Layer.provideMerge(Layer.succeed(Tracer.Tracer, tracer)),
        Layer.provide(Layer.succeed(Clock.Clock, clock)),
        Layer.provideMerge(
          Logger.layer([
            Logger.make((options) => logs.push(String(Logger.formatJson.log(options)))),
          ]),
        ),
      );
      const app = observedWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)));
      const served = node
        ? yield* Layer.build(
            serveObserved(routes, { disableListenLog: true }).pipe(
              Layer.provideMerge(
                NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
              ),
            ),
          ).pipe(Effect.orDie)
        : undefined;
      const nodeOrigin =
        served === undefined
          ? ""
          : HttpServer.formatAddress(Context.get(served, HttpServer.HttpServer).address);
      yield* Effect.addFinalizer(() => Effect.promise(app.dispose));
      const http = HttpClient.make((request, url) =>
        Effect.promise(() =>
          app.handler(
            new Request(new URL(url.pathname + url.search, "http://gateway.internal"), {
              method: request.method,
              headers: request.headers,
            }),
            Context.make(Clock.Clock, clock),
          ),
        ).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
      );
      const fixture: AssetHarness = {
        workbench: { rawFiles, goneWorktrees, pages, proofs },
        proofRequests,
        pageRequests,
        client,
        claims,
        requests,
        revoke: (token) => revoked.add(token),
        pair: (code, scopes) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const session = {
              ...testBearerSession,
              sessionId: AuthSessionId.make(code),
              tokenHash: code,
              deviceToken: code,
              mendDeviceId: code,
              scopes: scopes ?? testBearerSession.scopes,
              issuedAt: now,
              expiresAt: now + 30 * 24 * 60 * 60_000,
            };
            claims.push({ token: code });
            yield* state.insertSession(session);
            const hub: PersonHub = {
              ...emptyHub,
              isRefused: (token) => refused.has(token),
              worktreeFileOf: (path, threadId) =>
                Effect.succeed(
                  threadId === "session-1" && path.startsWith(`${ROOT}/`)
                    ? {
                        projectId: "project-1",
                        sessionId: "session-1",
                        worktreeId: "worktree-session-1",
                        relativePath: path.slice(ROOT.length + 1),
                        workspaceMutation: null,
                      }
                    : null,
                ),
              locationOf: () =>
                Effect.succeed({
                  projectId: "project-1",
                  sessionId: null,
                  worktreeId: null,
                  branch: "main",
                  defaultBranch: "main",
                  baseRef: null,
                  changeId: null,
                  hasOrigin: false,
                  workspaceMutation: null,
                }),
              imageOf: (id) => images.get(id) ?? null,
              persistImages: (input) =>
                Effect.gen(function* () {
                  const kept = input.uploads.map((upload, index) => ({
                    id: `image-${index}`,
                    threadId: input.threadId,
                    messageId: input.messageId,
                    position: index,
                    name: upload.name,
                    mimeType: upload.mimeType,
                    sizeBytes: upload.sizeBytes,
                    placement: null,
                    bytes: Buffer.from(upload.dataUrl.split(",")[1] ?? "", "base64"),
                  }));
                  yield* state.saveImages(session.mendUser.id, kept, now).pipe(Effect.orDie);
                  for (const image of kept) images.set(image.id, image);
                  return kept;
                }),
            };
            return {
              rpc: makeGatewayRpcHandlers({
                environment,
                assetUrls: {
                  ...urls,
                  issue: (sessionId, subject) =>
                    urls.issue(sessionId, subject).pipe(Effect.withTracer(tracer)),
                },
                session,
                hub,
                clientAppVersion: undefined,
              }),
            };
          }),
        urls,
        spans,
        beforeRaw: (action) => {
          beforeRaw = action;
        },
        nodeOrigin,
        fetch: (url, init) =>
          Effect.promise(() =>
            app.handler(
              new Request(new URL(url, "http://gateway.internal"), init),
              Context.make(Clock.Clock, clock),
            ),
          ),
      };
      return yield* test(fixture, logs).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.mapRequest(http, (request) => ({
            ...request,
            url: new URL(request.url, "http://gateway.internal").toString(),
          })),
        ),
      );
    }),
  );

export interface AssetHarness {
  readonly workbench: {
    readonly rawFiles: Map<string, RawFixture>;
    readonly goneWorktrees: Set<string>;
    readonly pages: Map<string, PageFixture>;
    readonly proofs: Map<string, ProofFixture>;
  };
  readonly proofRequests: {
    method: string;
    path: string;
    range: string | undefined;
    authorization: string | undefined;
  }[];
  readonly pageRequests: { path: string; authorization: string | undefined }[];
  /** The gateway's own Mend client, over the in-memory Mend. */
  readonly client: MendClient["Service"];
  readonly claims: { token: string }[];
  readonly requests: { method: string; path: string; range: string | undefined }[];
  readonly revoke: (token: string) => void;
  readonly pair: (
    code: string,
    scopes?: readonly AuthEnvironmentScope[],
  ) => Effect.Effect<{ rpc: ReturnType<typeof makeGatewayRpcHandlers> }, GatewayStateError>;
  readonly urls: AssetUrls["Service"];
  readonly spans: readonly Tracer.Span[];
  readonly beforeRaw: (action: () => Effect.Effect<void>) => void;
  readonly fetch: (url: string, init?: RequestInit) => Effect.Effect<Response>;
  /** The same routes behind the Node HTTP adapter the gateway serves with, on a loopback port. */
  readonly nodeOrigin: string;
}
export const pairAssetClient = (fixture: AssetHarness, code: string) => fixture.pair(code);
