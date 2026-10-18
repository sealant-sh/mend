import { createServer, request as httpRequest, type IncomingMessage } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { cliAuthGroup, AuthMiddleware, Unauthorized } from "@mend/api-contracts";
import { DevicesRepo, CliAuthRequest } from "@mend/db";
import { makePublicNetwork, PublicOrigin, NetworkConfig } from "@mend/network";
import { Cause, Effect, Layer, ManagedRuntime } from "effect";
import {
  HttpRouter,
  HttpServerError,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BUDGET_LIMITS, makeBudgets, type BudgetLimits } from "./budgets.ts";
import { apiMiddleware } from "./http-middleware.ts";
import {
  bodyBudgetFor,
  boundedWebRequest,
  isSignInAttempt,
  presentedCredentials,
  requestBudgets,
} from "./request-budgets.ts";
import { DevicePairingLive } from "./routes/devices.ts";

/**
 * MEND-05 (docs/adr/0004, "Budgets"): every refusal here happens before the route runs, which the
 * `reached` counter proves. A refused request reaches nothing.
 */
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

const read = (request: HttpServerRequest.HttpServerRequest) =>
  request.text.pipe(Effect.map((text) => HttpServerResponse.text(text)));

const serve = (limits: Partial<BudgetLimits>, trustedProxies: ReadonlyArray<string> = []) => {
  const reached: Array<string> = [];
  const bodies: Array<number | string> = [];
  const invitations: Array<string> = [];
  const failures: Array<HttpServerError.HttpServerError> = [];
  let clock = 0;
  const routes = HttpRouter.use((router) =>
    Effect.gen(function* () {
      const echo = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          reached.push(`${request.method} ${request.url}`);
          const body = yield* request.text.pipe(
            Effect.map((text) => text.length),
            Effect.catch((error) =>
              Effect.sync(() => {
                failures.push(error);
                return error._tag;
              }),
            ),
          );
          bodies.push(body);
          return HttpServerResponse.text("ok");
        });
      // The better-auth mount's shape: the handler is given a web Request, not the Effect one.
      yield* router.add("*", "/api/auth/*", (request) =>
        Effect.gen(function* () {
          reached.push(`${request.method} ${request.url}`);
          const web = yield* boundedWebRequest(request);
          if (web === null) return HttpServerResponse.empty({ status: 413 });
          bodies.push((yield* Effect.promise(() => web.text())).length);
          return HttpServerResponse.text("ok");
        }),
      );
      // An exact parameterized route prevents the fallback satisfying normalization checks.
      yield* router.add("POST", "/api/invitations/:id/accept", (request) =>
        Effect.sync(() => {
          invitations.push(request.url);
          return HttpServerResponse.text("invitation handler");
        }),
      );
      yield* router.add("POST", "/api/sessions/stream/images", read);
      yield* router.addAll([
        HttpRouter.prefixRoute(HttpRouter.route("POST", "/read", read), "/api/mounted"),
      ]);
      yield* router.add("*", "/api/*", echo);
    }),
  );
  const budgeted = Layer.mergeAll(
    routes,
    requestBudgets(
      makeBudgets({ ...DEFAULT_BUDGET_LIMITS, ...limits }),
      trustedProxies,
      () => clock,
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    budgeted.pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return {
    reached,
    invitations,
    bodies,
    failures,
    budgeted,
    advance: (ms: number) => {
      clock += ms;
    },
    send: (path: string, init: RequestInit = {}) =>
      handler(new Request(`http://api.internal${path}`, init)),
  };
};

/**
 * The same app on a real Node HTTP server. Body limits are enforced by the Node incoming message
 * (`MaxBodySize`), which the in-process web handler does not model, so those tests go over a
 * socket like production does.
 */
const serveOverSocket = async (
  limits: Partial<BudgetLimits>,
  trustedProxies: ReadonlyArray<string> = [],
) => {
  const api = serve(limits, trustedProxies);
  const server = createServer();
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(api.budgeted, {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provide(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" }))),
  );
  await runtime.runPromise(Effect.void);
  disposers.push(() => runtime.dispose());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No HTTP address");
  return {
    ...api,
    send: (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, init),
    /**
     * A POST that declares `length` bytes and sends none of them: what the server answers before
     * reading a body it will refuse. `fetch` cannot declare a length it does not send.
     */
    declare: (path: string, length: number) =>
      new Promise<{ readonly status: number; readonly body: unknown }>((resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            path,
            method: "POST",
            headers: { "content-length": String(length) },
          },
          (incoming: IncomingMessage) => {
            const chunks: Array<Buffer> = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () => {
              resolve({
                status: incoming.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
              outgoing.destroy();
            });
          },
        );
        outgoing.on("error", reject);
        outgoing.flushHeaders();
      }),
  };
};

const expectCut = (response: Promise<Response>) =>
  expect(response).rejects.toMatchObject({ cause: { code: "UND_ERR_SOCKET" } });

/** A body that does not declare its length. */
const chunked = (body = "x".repeat(64)) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });

describe("bodies are bounded before they are decoded", () => {
  it("refuses a declared length over the limit with 413, unread", async () => {
    const api = await serveOverSocket({ bodyBytes: 16 });
    const response = await api.send("/api/projects", {
      method: "POST",
      body: "x".repeat(17),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "bodyBytes",
      limit: 16,
      retryAfterSeconds: null,
    });
    expect(api.reached).toEqual([]);
  });

  it("cuts an undeclared oversized body with the body-limit error and reads an exact-limit stream", async () => {
    const api = await serveOverSocket({ bodyBytes: 16 });
    await expectCut(
      api.send("/api/projects", {
        method: "POST",
        body: chunked(),
        // @ts-expect-error -- Node requires duplex for a streamed body; DOM RequestInit omits it.
        duplex: "half",
      }),
    );
    expect(api.reached).toEqual(["POST /api/projects"]);
    expect(api.bodies).toEqual(["HttpServerError"]);
    expect(api.failures).toMatchObject([
      {
        _tag: "HttpServerError",
        reason: {
          _tag: "RequestParseError",
          cause: new Error("maxBytes exceeded"),
        },
      },
    ]);
    const small = await api.send("/api/projects", {
      method: "POST",
      body: chunked("1234567890abcdef"),
      // @ts-expect-error -- Node requires duplex for a streamed body; DOM RequestInit omits it.
      duplex: "half",
    });
    expect(small.status).toBe(200);
    expect(await small.text()).toBe("ok");
    expect(api.bodies).toEqual(["HttpServerError", 16]);
    expect(api.failures).toHaveLength(1);
  });

  it.each([
    { route: "/api/mounted/read", budget: "bodyBytes", limit: 16 },
    {
      route: "/api/sessions/stream/images",
      budget: "uploadBodyBytes",
      limit: 32,
    },
  ])(
    "cuts streamed $route past its $budget and admits its exact byte boundary",
    async ({ route, limit }) => {
      const api = await serveOverSocket({ bodyBytes: 16, uploadBodyBytes: 32 });
      const send = (body: string) =>
        api.send(route, {
          method: "POST",
          body: chunked(body),
          // @ts-expect-error -- Node requires duplex for a streamed body; DOM RequestInit omits it.
          duplex: "half",
        });
      await expectCut(send("é".repeat(limit / 2) + "x"));
      const exact = "é".repeat(limit / 2);
      const accepted = await send(exact);
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toBe(exact);
    },
  );

  it.each([
    { kind: "plain-defect", status: 500 },
    { kind: "other-read-error", status: 400 },
    { kind: "foreign-request", status: 400 },
    { kind: "combined", status: 500 },
    { kind: "combined-interruption", status: 400 },
    { kind: "interruption", status: 503 },
  ])(
    "preserves the complete cause for $kind instead of calling it a size refusal",
    async ({ kind, status }) => {
      let original: Cause.Cause<unknown> | undefined;
      const observed: Array<Cause.Cause<unknown>> = [];
      const routes = HttpRouter.use((router) =>
        router.add("POST", "/api/probe", (request) => {
          const wrapped = new HttpServerError.HttpServerError({
            reason: new HttpServerError.RequestParseError({
              request:
                kind === "foreign-request"
                  ? HttpServerRequest.fromWeb(new Request("http://elsewhere/api/probe"))
                  : request,
              cause: new Error(
                kind === "other-read-error" ? "synthetic socket read failure" : "maxBytes exceeded",
              ),
            }),
          });
          original =
            kind === "plain-defect"
              ? Cause.die(new Error("maxBytes exceeded"))
              : kind === "interruption"
                ? Cause.interrupt()
                : kind === "combined-interruption"
                  ? Cause.combine(Cause.fail(wrapped), Cause.interrupt())
                  : kind === "combined"
                    ? Cause.combine(Cause.fail(wrapped), Cause.die(new Error("other defect")))
                    : Cause.fail(wrapped);
          return Effect.failCause(original);
        }),
      );
      const observer = HttpRouter.middleware(
        (handler) =>
          handler.pipe(
            Effect.tapCause((cause) =>
              Effect.sync(() => {
                observed.push(cause);
              }),
            ),
          ),
        { global: true },
      );
      const { handler, dispose } = HttpRouter.toWebHandler(
        Layer.mergeAll(
          routes,
          observer,
          requestBudgets(makeBudgets({ ...DEFAULT_BUDGET_LIMITS, bodyBytes: 16 }), []),
        ).pipe(Layer.provide(HttpServer.layerServices)),
        { disableLogger: true },
      );
      disposers.push(dispose);
      const response = await handler(
        new Request("http://api.internal/api/probe", { method: "POST" }),
      );
      expect(response.status).toBe(status);
      await response.text();
      expect(original).toBeDefined();
      expect(observed).toEqual([original]);
    },
  );

  it("bounds an undeclared JSON body before the real CLI authorization handler writes a request", async () => {
    const opened: Array<Parameters<DevicesRepo["Service"]["createCliAuth"]>[0]> = [];
    const network = makePublicNetwork(PublicOrigin.make("http://localhost"), []);
    const routes = HttpApiBuilder.layer(HttpApi.make("mend").add(cliAuthGroup).prefix("/api")).pipe(
      Layer.provide(DevicePairingLive),
      // DevicePairingLive also assembles protected endpoints; this unauthenticated route never
      // uses their middleware. Any unexpected protected request is refused.
      Layer.provide(Layer.succeed(AuthMiddleware, () => Effect.fail(new Unauthorized()))),
      Layer.provide(Layer.succeed(NetworkConfig, network)),
      Layer.provide(
        Layer.mock(DevicesRepo, {
          createCliAuth: (input) =>
            Effect.sync(() => {
              opened.push(input);
              return new CliAuthRequest({ ...input, createdAt: new Date() });
            }),
        }),
      ),
    );
    const server = createServer();
    const runtime = ManagedRuntime.make(
      HttpRouter.serve(
        Layer.mergeAll(
          routes,
          apiMiddleware({
            network,
            budgets: makeBudgets({ ...DEFAULT_BUDGET_LIMITS, bodyBytes: 64 }),
            trustedProxies: [],
            errorDetail: { mode: "redacted" },
          }),
        ),
        { disableLogger: true, disableListenLog: true },
      ).pipe(Layer.provide(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" }))),
    );
    disposers.push(() => runtime.dispose());
    await runtime.runPromise(Effect.void);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No HTTP address");
    const send = (body: string) =>
      fetch(`http://127.0.0.1:${address.port}/api/cli/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunked(body),
        // @ts-expect-error -- Node requires duplex for a streamed body; DOM RequestInit omits it.
        duplex: "half",
      });
    await expectCut(send(JSON.stringify({ name: "x".repeat(80) })));
    expect(opened).toEqual([]);
    const small = await send(JSON.stringify({ name: "streamed-cli", client: "cli" }));
    expect(small.status).toBe(200);
    const result = await small.json();
    expect(result).toMatchObject({
      deviceCode: expect.stringMatching(/^mdc_/),
      intervalSeconds: 2,
    });
    expect(opened).toMatchObject([{ name: "streamed-cli", client: "cli", userCode: result.code }]);
  });

  it("holds a web-Request handler (the sign-in mount) to the same limit", async () => {
    const api = await serveOverSocket({
      bodyBytes: 16,
      signInAttemptsPerMinute: 0,
    });
    await expectCut(
      api.send("/api/auth/sign-in/email", {
        method: "POST",
        body: chunked(),
        // @ts-expect-error -- `duplex` is required by Node for a streamed body and missing from the DOM type.
        duplex: "half",
      }),
    );
    expect(api.bodies).toEqual([]);
    const small = await api.send("/api/auth/sign-in/email", {
      method: "POST",
      body: "{}",
    });
    expect(small.status).toBe(200);
    expect(api.bodies).toEqual([2]);
  });

  it("holds each route to its own body budget: plain, upload, bundle", async () => {
    const api = await serveOverSocket({
      bodyBytes: 16,
      uploadBodyBytes: 64,
      bundleBytes: 128,
    });
    const body = "x".repeat(40);
    const upload = await api.send("/api/sessions/s1/images", {
      method: "POST",
      body,
    });
    expect(upload.status).toBe(200);
    const plain = await api.send("/api/sessions/s1/turns", {
      method: "POST",
      body,
    });
    expect(plain.status).toBe(413);
    const tooLarge = await api.send("/api/sessions/s1/images", {
      method: "POST",
      body: "x".repeat(65),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({
      budget: "uploadBodyBytes",
      limit: 64,
    });
    const bundle = await api.send("/api/projects/p1/handoffs", {
      method: "POST",
      body: "x".repeat(100),
    });
    expect(bundle.status).toBe(200);
    const bundleTooLarge = await api.send("/api/projects/p1/handoffs", {
      method: "POST",
      body: "x".repeat(129),
    });
    expect(bundleTooLarge.status).toBe(413);
    expect(await bundleTooLarge.json()).toMatchObject({
      budget: "bundleBytes",
      limit: 128,
    });
  });

  it("at the shipped limits, takes a 30 MiB handoff and refuses 64 MiB + 1 unread, while a file route stops at 24 MiB and a plain route at 1 MiB", async () => {
    const MiB = 1024 * 1024;
    const api = await serveOverSocket({});
    const handoff = await api.send("/api/projects/p1/handoffs", {
      method: "POST",
      body: new Uint8Array(30 * MiB),
    });
    expect(handoff.status).toBe(200);
    expect(api.bodies).toEqual([30 * MiB]);
    expect(await api.declare("/api/projects/p1/handoffs", 64 * MiB + 1)).toEqual({
      status: 413,
      body: {
        _tag: "BudgetExceeded",
        budget: "bundleBytes",
        limit: 64 * MiB,
        retryAfterSeconds: null,
        message: "budget reached · 67108864 bytes in one git bundle · nothing running was stopped",
      },
    });
    expect(await api.declare("/api/sessions/s1/images", 24 * MiB + 1)).toMatchObject({
      status: 413,
      body: { budget: "uploadBodyBytes", limit: 24 * MiB },
    });
    const image = await api.send("/api/sessions/s1/images", {
      method: "POST",
      body: new Uint8Array(24 * MiB),
    });
    expect(image.status).toBe(200);
    expect(await api.declare("/api/sessions/s1/turns", MiB + 1)).toMatchObject({
      status: 413,
      body: { budget: "bodyBytes", limit: MiB },
    });
    expect(api.reached).toEqual(["POST /api/projects/p1/handoffs", "POST /api/sessions/s1/images"]);
    expect(api.bodies).toEqual([30 * MiB, 24 * MiB]);
  });

  it("names the body routes and their budgets exactly", () => {
    expect(bodyBudgetFor("POST", "/api/skills/sync")).toBe("uploadBodyBytes");
    expect(bodyBudgetFor("POST", "/api//Skills/sync")).toBe("uploadBodyBytes");
    expect(bodyBudgetFor("POST", "/api/organization/folders/f1/files")).toBe("uploadBodyBytes");
    expect(bodyBudgetFor("POST", "/api/dotfiles/snapshot")).toBe("uploadBodyBytes");
    expect(bodyBudgetFor("PUT", "/api/projects/p1/workspace-image")).toBe("uploadBodyBytes");
    expect(bodyBudgetFor("POST", "/api/projects/p1/handoffs")).toBe("bundleBytes");
    expect(bodyBudgetFor("POST", "/api/projects/p1/Handoffs/")).toBe("bodyBytes");
    expect(bodyBudgetFor("GET", "/api/projects/p1/handoffs")).toBe("bodyBytes");
    expect(bodyBudgetFor("GET", "/api/skills/sync")).toBe("bodyBytes");
    expect(bodyBudgetFor("POST", "/api/skills/sync/extra")).toBe("bodyBytes");
    expect(bodyBudgetFor("POST", "/api/sessions/s1/images/../turns")).toBe("bodyBytes");
  });
});

describe("requests are counted per address and per credential", () => {
  it("refuses an address over its window with 429 and Retry-After, then admits it again", async () => {
    const api = serve({ addressRequestsPerMinute: 2 });
    expect((await api.send("/api/health")).status).toBe(200);
    api.advance(1_000);
    expect((await api.send("/api/health")).status).toBe(200);
    const refused = await api.send("/api/health");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("59");
    expect(await refused.json()).toMatchObject({
      budget: "addressRequestsPerMinute",
      retryAfterSeconds: 59,
    });
    expect(api.reached).toHaveLength(2);
    api.advance(59_000);
    expect((await api.send("/api/health")).status).toBe(200);
  });

  it("counts a credential by what was presented, valid or not, and never holds it", async () => {
    const api = serve({
      credentialRequestsPerMinute: 1,
      addressRequestsPerMinute: 100,
    });
    const as = (token: string) =>
      api.send("/api/projects", {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await as("mdt_a")).status).toBe(200);
    expect((await as("mdt_a")).status).toBe(429);
    expect((await as("mdt_b")).status).toBe(200);
    // No credential at all is only ever counted by address.
    expect((await api.send("/api/projects")).status).toBe(200);
    expect((await api.send("/api/projects")).status).toBe(200);
  });

  it("gives sign-in attempts a tighter window of their own", async () => {
    const api = serve({
      signInAttemptsPerMinute: 1,
      addressRequestsPerMinute: 100,
    });
    const signIn = () => api.send("/api/auth/sign-in/email", { method: "POST", body: "{}" });
    expect((await signIn()).status).toBe(200);
    const refused = await signIn();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      budget: "signInAttemptsPerMinute",
    });
    // Page loads from the same address are a different allowance.
    expect((await api.send("/api/health")).status).toBe(200);
    expect(isSignInAttempt("POST", "/api/invitations/preview")).toBe(true);
    expect(isSignInAttempt("POST", "/api/auth/reset-password")).toBe(true);
    expect(isSignInAttempt("GET", "/api/auth/sign-in/email")).toBe(false);
    expect(isSignInAttempt("POST", "/api/auth/get-session")).toBe(false);
  });

  it("counts the session cookie's value, not the header a client can pad", async () => {
    const api = serve({
      credentialRequestsPerMinute: 1,
      addressRequestsPerMinute: 100,
    });
    const withCookie = (cookie: string, authorization?: string) =>
      api.send("/api/projects", {
        headers: {
          cookie,
          ...(authorization === undefined ? {} : { authorization }),
        },
      });
    expect((await withCookie("__Secure-better-auth.session_token=abc")).status).toBe(200);
    expect((await withCookie("__Secure-better-auth.session_token=abc; pad=1")).status).toBe(429);
    // A made-up bearer beside the cookie does not start a fresh window for the cookie.
    expect((await withCookie("better-auth.session_token=abc", "Bearer junk-1")).status).toBe(429);
    expect(presentedCredentials({ cookie: "theme=dark; other=1" })).toEqual([]);
    expect(
      presentedCredentials({
        authorization: "Bearer t",
        cookie: "a=1; x.session_token=v",
      }),
    ).toEqual(["Bearer t", "v"]);
  });

  it.each([
    "/API/Invitations/abc/accept",
    "/api//invitations/abc/accept",
    "/api/%69nvitations/abc/accept",
  ])("counts %s in the recognized route's sign-in window", async (path) => {
    const api = await serveOverSocket({ signInAttemptsPerMinute: 1 });
    const accepted = await api.send(path, { method: "POST" });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("invitation handler");
    expect(api.invitations).toEqual([path]);
    expect(api.reached).toEqual([]);
    const canonical = await api.send("/api/invitations/abc/accept", {
      method: "POST",
    });
    expect(canonical.status).toBe(429);
    expect(await canonical.json()).toMatchObject({
      budget: "signInAttemptsPerMinute",
      limit: 1,
    });
    const refused = await api.send(path, { method: "POST" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({
      budget: "signInAttemptsPerMinute",
      limit: 1,
    });
    expect(api.invitations).toEqual([path]);
    api.advance(60_000);
    expect((await api.send(path, { method: "POST" })).status).toBe(200);
    expect(api.invitations).toEqual([path, path]);
  });

  it("never exempts a request because its whole chain is trusted", async () => {
    // The socket is loopback (trusted) and so is every forwarded entry: a proxy inside a trusted
    // CIDR that hides its clients. They share the socket's window; they do not escape it.
    const api = await serveOverSocket({ addressRequestsPerMinute: 2, signInAttemptsPerMinute: 1 }, [
      "10.244.0.0/16",
    ]);
    const hidden = { "x-forwarded-for": "10.244.1.7" };
    expect((await api.send("/api/health", { headers: hidden })).status).toBe(200);
    expect((await api.send("/api/health", { headers: hidden })).status).toBe(200);
    expect((await api.send("/api/health", { headers: hidden })).status).toBe(429);
    // A bare loopback socket is this machine's own and is not counted as a client...
    for (let i = 0; i < 5; i += 1) expect((await api.send("/api/health")).status).toBe(200);
    // ...except when it is proving who it is.
    const signIn = () => api.send("/api/auth/sign-in/email", { method: "POST", body: "{}" });
    expect((await signIn()).status).toBe(200);
    expect((await signIn()).status).toBe(429);
  });

  it("counts IPv6 by its /64", async () => {
    const api = await serveOverSocket({ addressRequestsPerMinute: 1 });
    const from = (address: string) =>
      api.send("/api/health", { headers: { "x-forwarded-for": address } });
    expect((await from("2001:db8:1:2::1")).status).toBe(200);
    expect((await from("2001:db8:1:2:ffff::9")).status).toBe(429);
    expect((await from("2001:db8:1:3::1")).status).toBe(200);
  });

  it("disabled address and body limits leave credential and sign-in limits enforced", async () => {
    const api = await serveOverSocket({
      addressRequestsPerMinute: 0,
      bodyBytes: 0,
      credentialRequestsPerMinute: 1,
      signInAttemptsPerMinute: 1,
    });
    const headers = { "x-forwarded-for": "203.0.113.10" };
    for (let i = 0; i < 50; i += 1)
      expect((await api.send("/api/health", { headers })).status).toBe(200);
    const large = await api.send("/api/projects", {
      method: "POST",
      headers,
      body: "x".repeat(4096),
    });
    expect(large.status).toBe(200);
    expect(api.bodies.at(-1)).toBe(4096);
    const credential = () =>
      api.send("/api/projects", {
        headers: { ...headers, authorization: "Bearer synthetic-budget-token" },
      });
    expect((await credential()).status).toBe(200);
    const refusedCredential = await credential();
    expect(refusedCredential.status).toBe(429);
    expect(await refusedCredential.json()).toMatchObject({
      budget: "credentialRequestsPerMinute",
      limit: 1,
    });
    const signIn = () => api.send("/api/auth/sign-in/email", { method: "POST", headers });
    expect((await signIn()).status).toBe(200);
    const refusedSignIn = await signIn();
    expect(refusedSignIn.status).toBe(429);
    expect(await refusedSignIn.json()).toMatchObject({
      budget: "signInAttemptsPerMinute",
      limit: 1,
    });
    expect(api.reached).toHaveLength(53);
    expect((await api.send("/api/health", { headers })).status).toBe(200);
  });
});
