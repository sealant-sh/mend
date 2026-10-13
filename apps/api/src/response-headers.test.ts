import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { apiResponseHeaders } from "./response-headers.ts";

describe("the API's own response headers", () => {
  it("are on every answer, an error included", async () => {
    const routes = HttpRouter.use((router) =>
      Effect.gen(function* () {
        yield* router.add("GET", "/api/ok", () => Effect.succeed(HttpServerResponse.text("ok")));
        yield* router.add("GET", "/api/refused", () =>
          Effect.succeed(HttpServerResponse.empty({ status: 403 })),
        );
      }),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.mergeAll(routes, apiResponseHeaders).pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );
    try {
      for (const path of ["/api/ok", "/api/refused"]) {
        const response = await handler(new Request(`http://api.internal${path}`));
        // ADR 0004 promises these policies independently of the production header map.
        for (const [name, value] of Object.entries({
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        })) {
          expect(response.headers.get(name)).toBe(value);
        }
      }
    } finally {
      await dispose();
    }
  });
});
