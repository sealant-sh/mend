import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BUDGET_LIMITS, makeBudgets, type BudgetLimits } from "./budgets.ts";
import { apiMiddleware } from "./http-middleware.ts";
import { API_RESPONSE_HEADERS } from "./response-headers.ts";

/**
 * The order of the API's global middleware, held to what a client observes (docs/adr/0004;
 * MEND-05, MEND-11). Built from `apiMiddleware`, the same layer the server installs, so a
 * reordering there fails here.
 */
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

const ORIGIN = "https://mend.example";
const STORE_PATH = "/var/lib/mend/store/prj_9f2/repo.git";

const serve = (limits: Partial<BudgetLimits> = {}) => {
  const routes = HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.add("*", "/api/ok", () => Effect.succeed(HttpServerResponse.text("ok")));
      yield* router.add("GET", "/api/defect", () =>
        Effect.die(new Error(`EACCES: permission denied, open '${STORE_PATH}/config'`)),
      );
      yield* router.add("GET", "/api/undeclared", () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ stack: `Error\n    at ${STORE_PATH}` }, { status: 500 }),
        ),
      );
    }),
  );
  const app = Layer.mergeAll(
    routes,
    apiMiddleware({
      network: makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)(ORIGIN), []),
      budgets: makeBudgets({ ...DEFAULT_BUDGET_LIMITS, ...limits }),
      trustedProxies: [],
      errorDetail: { mode: "redacted" },
      now: () => 0,
    }),
  ).pipe(Layer.provide(HttpServer.layerServices));
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  disposers.push(dispose);
  return (path: string, init: RequestInit = {}) =>
    handler(new Request(`http://api.internal${path}`, init));
};

const expectApiHeaders = (response: Response) => {
  for (const [name, value] of Object.entries(API_RESPONSE_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
};

describe("the API's global middleware, in the order it promises", () => {
  it("sets the API headers on every answer, whoever produced it", async () => {
    const send = serve({ addressRequestsPerMinute: 5, bodyBytes: 8 });
    const ok = await send("/api/ok");
    expect(ok.status).toBe(200);
    expectApiHeaders(ok);

    // The error boundary's own answers.
    const defect = await send("/api/defect");
    expect(defect.status).toBe(500);
    expectApiHeaders(defect);
    const undeclared = await send("/api/undeclared");
    expect(undeclared.status).toBe(500);
    expectApiHeaders(undeclared);

    // A route that does not exist: answered by the server, outside every other middleware.
    const missing = await send("/api/nowhere");
    expect(missing.status).toBe(404);
    expectApiHeaders(missing);

    // The origin policy's refusal.
    const foreign = await send("/api/ok", {
      method: "POST",
      headers: { origin: "https://elsewhere.example" },
    });
    expect(foreign.status).toBe(403);
    expectApiHeaders(foreign);

    // The budgets' refusals: a body over its limit, then the address window (the sixth counted request).
    const large = await send("/api/ok", {
      method: "POST",
      body: "x".repeat(64),
      // The in-process handler declares no length of its own; a real client's request does.
      headers: { "content-length": "64" },
    });
    expect(large.status).toBe(413);
    expectApiHeaders(large);
    const over = await send("/api/ok");
    expect(over.status).toBe(429);
    expectApiHeaders(over);
  });

  it("answers a defect with no detail, and keeps CORS on the rewritten answer", async () => {
    const send = serve();
    const defect = await send("/api/defect", { headers: { origin: ORIGIN } });
    expect(defect.status).toBe(500);
    const body = await defect.text();
    expect(body).not.toContain(STORE_PATH);
    expect(body).toContain("InternalError");
    expect(defect.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const undeclared = await send("/api/undeclared", { headers: { origin: ORIGIN } });
    expect(await undeclared.text()).not.toContain(STORE_PATH);
    expect(undeclared.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});
