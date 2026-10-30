import { createAuthHandler } from "@mend/auth";
import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { Effect, Layer, Logger, Tracer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { describe, expect, it } from "vitest";

import { boundedWebRequest } from "./request-budgets.ts";
import { unloggedRequests } from "./unlogged-requests.ts";
import { UntracedRequestsLive } from "./untraced-requests.ts";

const network = makePublicNetwork(PublicOrigin.make("http://localhost:3105"), []);

const traced = (spans: ReadonlyArray<Tracer.Span>) =>
  JSON.stringify(spans.map((span) => [span.name, [...span.attributes]]));

const betterAuthBoundary = () => {
  const logs: string[] = [];
  const spans: Tracer.Span[] = [];
  const auth = createAuthHandler({
    network,
    secret: "url-secrets-test-secret-with-thirty-two-bytes",
  });
  const routes = HttpRouter.use((router) =>
    router.add("*", "/api/auth/*", (request) =>
      Effect.gen(function* () {
        const webRequest = yield* boundedWebRequest(request);
        if (webRequest === null) return HttpServerResponse.empty({ status: 413 });
        return HttpServerResponse.fromWeb(yield* Effect.promise(() => auth(webRequest)));
      }),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(routes, unloggedRequests).pipe(
      Layer.provideMerge(UntracedRequestsLive),
      Layer.provideMerge(
        Layer.succeed(
          Tracer.Tracer,
          Tracer.make({
            span(options) {
              const span = Tracer.nativeTracer.span(options);
              spans.push(span);
              return span;
            },
          }),
        ),
      ),
      Layer.provideMerge(
        Logger.layer([Logger.make((entry) => logs.push(String(Logger.formatJson.log(entry))))]),
      ),
    ),
  );
  const get = (path: string) => handler(new Request(`${network.appUrl}${path}`));
  return { logs, spans, get, dispose };
};

describe("secrets in request URLs", () => {
  it("refuses a password reset token in Better Auth's link path, and keeps it out of the request log and traces", async () => {
    const boundary = betterAuthBoundary();
    try {
      const reset = await boundary.get(
        "/api/auth/reset-password/reset-secret-needle?callbackURL=%2Freset",
      );
      expect(reset.status).toBe(404);
      expect(reset.headers.get("location")).toBeNull();
      expect.soft(boundary.logs.filter((line) => line.includes("reset-secret-needle"))).toEqual([]);
      expect.soft(traced(boundary.spans)).not.toContain("reset-secret-needle");
    } finally {
      await boundary.dispose();
    }
  });

  it("keeps Better Auth's query tokens and codes out of the request log and traces", async () => {
    const boundary = betterAuthBoundary();
    try {
      const answers: number[] = [];
      for (const path of [
        "/api/auth/verify-email?token=verify-secret-needle&callbackURL=%2F",
        "/api/auth/delete-user/callback?token=delete-secret-needle&callbackURL=%2F",
        "/api/auth/callback/github?code=oauth-secret-needle",
      ]) {
        answers.push((await boundary.get(path)).status);
      }
      expect(answers).toHaveLength(3);
      expect(boundary.logs.filter((line) => line.includes("Sent HTTP response"))).toHaveLength(3);
      expect.soft(boundary.logs.filter((line) => line.includes("secret-needle"))).toEqual([]);
      expect.soft(traced(boundary.spans)).not.toContain("secret-needle");
    } finally {
      await boundary.dispose();
    }
  });
});
