import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BUDGET_LIMITS, makeBudgets, type BudgetLimits } from "./budgets.ts";
import {
  boundedWebRequest,
  isSignInAttempt,
  isUploadRoute,
  presentedCredentials,
  requestBudgets,
} from "./request-budgets.ts";

/**
 * MEND-05 (docs/adr/0004, "Budgets"): every refusal here happens before the route runs, which the
 * `reached` counter proves. A refused request reaches nothing.
 */
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

const serve = (limits: Partial<BudgetLimits>, trustedProxies: ReadonlyArray<string> = []) => {
  const reached: Array<string> = [];
  const bodies: Array<number | string> = [];
  let clock = 0;
  const routes = HttpRouter.use((router) =>
    Effect.gen(function* () {
      const echo = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          reached.push(`${request.method} ${request.url}`);
          const body = yield* request.text.pipe(
            Effect.map((text) => text.length),
            Effect.catch((error) => Effect.succeed(String(error._tag))),
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
    bodies,
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
    HttpRouter.serve(api.budgeted, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" })),
    ),
  );
  await runtime.runPromise(Effect.void);
  disposers.push(() => runtime.dispose());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No HTTP address");
  return {
    ...api,
    send: (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, init),
  };
};

/** A body that does not declare its length. */
const chunked = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(64)));
      controller.close();
    },
  });

describe("bodies are bounded before they are decoded", () => {
  it("refuses a declared length over the limit with 413, unread", async () => {
    const api = await serveOverSocket({ bodyBytes: 16 });
    const response = await api.send("/api/projects", { method: "POST", body: "x".repeat(17) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "bodyBytes",
      limit: 16,
      retryAfterSeconds: null,
    });
    expect(api.reached).toEqual([]);
  });

  it("cuts a body that does not declare its length at the same point", async () => {
    const api = await serveOverSocket({ bodyBytes: 16 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(64)));
        controller.close();
      },
    });
    await api.send("/api/projects", {
      method: "POST",
      body: stream,
      // @ts-expect-error -- `duplex` is required by Node for a streamed body and missing from the DOM type.
      duplex: "half",
    });
    // The route ran (no length to refuse on), and its read failed instead of buffering 64 bytes.
    expect(api.bodies).toHaveLength(1);
    expect(api.bodies[0]).not.toBe(64);
  });

  it("holds a web-Request handler (the sign-in mount) to the same limit", async () => {
    const api = await serveOverSocket({ bodyBytes: 16, signInAttemptsPerMinute: 0 });
    const cut = await api.send("/api/auth/sign-in/email", {
      method: "POST",
      body: chunked(),
      // @ts-expect-error -- `duplex` is required by Node for a streamed body and missing from the DOM type.
      duplex: "half",
    });
    expect(cut.status).toBe(413);
    expect(api.bodies).toEqual([]);
    const small = await api.send("/api/auth/sign-in/email", { method: "POST", body: "{}" });
    expect(small.status).toBe(200);
    expect(api.bodies).toEqual([2]);
  });

  it("gives the upload routes their own, larger limit and nothing else", async () => {
    const api = await serveOverSocket({ bodyBytes: 16, uploadBodyBytes: 64 });
    const body = "x".repeat(40);
    const upload = await api.send("/api/sessions/s1/images", { method: "POST", body });
    expect(upload.status).toBe(200);
    const plain = await api.send("/api/sessions/s1/turns", { method: "POST", body });
    expect(plain.status).toBe(413);
    const tooLarge = await api.send("/api/sessions/s1/images", {
      method: "POST",
      body: "x".repeat(65),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ budget: "uploadBodyBytes", limit: 64 });
  });

  it("names the upload routes exactly", () => {
    expect(isUploadRoute("POST", "/api/skills/sync")).toBe(true);
    expect(isUploadRoute("POST", "/api/organization/folders/f1/files")).toBe(true);
    expect(isUploadRoute("POST", "/api/dotfiles/snapshot")).toBe(true);
    expect(isUploadRoute("PUT", "/api/projects/p1/workspace-image")).toBe(true);
    expect(isUploadRoute("GET", "/api/skills/sync")).toBe(false);
    expect(isUploadRoute("POST", "/api/skills/sync/extra")).toBe(false);
    expect(isUploadRoute("POST", "/api/sessions/s1/images/../turns")).toBe(false);
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
    const api = serve({ credentialRequestsPerMinute: 1, addressRequestsPerMinute: 100 });
    const as = (token: string) =>
      api.send("/api/projects", { headers: { authorization: `Bearer ${token}` } });
    expect((await as("mdt_a")).status).toBe(200);
    expect((await as("mdt_a")).status).toBe(429);
    expect((await as("mdt_b")).status).toBe(200);
    // No credential at all is only ever counted by address.
    expect((await api.send("/api/projects")).status).toBe(200);
    expect((await api.send("/api/projects")).status).toBe(200);
  });

  it("gives sign-in attempts a tighter window of their own", async () => {
    const api = serve({ signInAttemptsPerMinute: 1, addressRequestsPerMinute: 100 });
    const signIn = () => api.send("/api/auth/sign-in/email", { method: "POST", body: "{}" });
    expect((await signIn()).status).toBe(200);
    const refused = await signIn();
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ budget: "signInAttemptsPerMinute" });
    // Page loads from the same address are a different allowance.
    expect((await api.send("/api/health")).status).toBe(200);
    expect(isSignInAttempt("POST", "/api/invitations/preview")).toBe(true);
    expect(isSignInAttempt("POST", "/api/auth/reset-password")).toBe(true);
    expect(isSignInAttempt("GET", "/api/auth/sign-in/email")).toBe(false);
    expect(isSignInAttempt("POST", "/api/auth/get-session")).toBe(false);
  });

  it("counts the session cookie's value, not the header a client can pad", async () => {
    const api = serve({ credentialRequestsPerMinute: 1, addressRequestsPerMinute: 100 });
    const withCookie = (cookie: string, authorization?: string) =>
      api.send("/api/projects", {
        headers: { cookie, ...(authorization === undefined ? {} : { authorization }) },
      });
    expect((await withCookie("__Secure-better-auth.session_token=abc")).status).toBe(200);
    expect((await withCookie("__Secure-better-auth.session_token=abc; pad=1")).status).toBe(429);
    // A made-up bearer beside the cookie does not start a fresh window for the cookie.
    expect((await withCookie("better-auth.session_token=abc", "Bearer junk-1")).status).toBe(429);
    expect(presentedCredentials({ cookie: "theme=dark; other=1" })).toEqual([]);
    expect(
      presentedCredentials({ authorization: "Bearer t", cookie: "a=1; x.session_token=v" }),
    ).toEqual(["Bearer t", "v"]);
  });

  it("matches paths the way the router does: case, doubled slashes and escapes", () => {
    expect(isSignInAttempt("POST", "/API/Invitations/abc/accept")).toBe(true);
    expect(isSignInAttempt("POST", "/api//invitations/abc/accept")).toBe(true);
    expect(isSignInAttempt("POST", "/api/%69nvitations/abc/accept")).toBe(true);
    expect(isUploadRoute("POST", "/api//Skills/sync")).toBe(true);
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

  it("turns one budget off at 0 without touching the others", async () => {
    const api = await serveOverSocket({ addressRequestsPerMinute: 0, bodyBytes: 0 });
    for (let i = 0; i < 50; i += 1) expect((await api.send("/api/health")).status).toBe(200);
    const large = await api.send("/api/projects", { method: "POST", body: "x".repeat(4096) });
    expect(large.status).toBe(200);
  });
});
