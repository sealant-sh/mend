import { createAuthHandler } from "@mend/auth";
import { CliAuthRequest } from "@mend/db";
import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { observedWebHandler } from "@mend/network/http-observation";
import { Effect, Layer, Logger, Tracer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/http";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../test/support/tenancy-api.ts";
import { boundedWebRequest } from "./request-budgets.ts";
import { apiObservation } from "./request-observation.ts";

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
  const { handler, dispose } = observedWebHandler(
    routes.pipe(
      // Effect records no header on a span until a filter opts in; this one opts in to every one.
      Layer.provideMerge(Layer.succeed(HttpMiddleware.TracerHeaderFilter)(() => true)),
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
    apiObservation,
  );
  const get = (path: string) => handler(new Request(`${network.appUrl}${path}`));
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    handler(
      new Request(`${network.appUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: network.appUrl, ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { logs, spans, get, post, dispose };
};

const logLines = (logs: ReadonlyArray<string>) =>
  logs.map((line): { readonly annotations: Record<string, unknown> } => JSON.parse(line));

describe("secrets in request URLs", () => {
  it("keeps a CLI sign-in's user code out of the request log and traces in every spelling the router accepts", async () => {
    const logs: string[] = [];
    const spans: Tracer.Span[] = [];
    const waiting = new CliAuthRequest({
      userCode: "CODE7SEC",
      name: "Work laptop",
      client: "cli",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const api = await createTenancyApi(
      {},
      {
        logs,
        spans,
        implement: {
          devices: {
            getCliAuth: () => Effect.succeed(waiting),
            approveCliAuth: () => Effect.succeed(waiting),
            denyCliAuth: () => Effect.succeed(waiting),
          },
        },
      },
    );
    const requests = [
      ["GET", "/api/me/cli-auth/CODE-7SEC", "/api/me/cli-auth/:code"],
      ["POST", "/api/me/cli-auth/CODE-7SEC/approve", "/api/me/cli-auth/:code/approve"],
      ["POST", "/api/me/cli-auth/CODE-7SEC/deny", "/api/me/cli-auth/:code/deny"],
      ["GET", "/API/Me/CLI-AUTH/code-7sec", "/api/me/cli-auth/:code"],
      ["GET", "//api//me/cli-auth//CODE-7SEC/", "/api/me/cli-auth/:code"],
      ["GET", "/api/me/cli-auth/CODE%2D7SEC", "/api/me/cli-auth/:code"],
      [
        "POST",
        "/api/me/cli-auth/code-7sec/approve?code=CODE-7SEC",
        "/api/me/cli-auth/:code/approve",
      ],
    ] as const;
    try {
      const answers: string[] = [];
      for (const [method, path] of requests)
        answers.push(`${method} ${(await api.request("carol", method, path)).status}`);
      expect(answers).toEqual(requests.map(([method]) => `${method} 200`));
      expect.soft(logs.filter((line) => /7sec/i.test(line))).toEqual([]);
      expect.soft(traced(spans)).not.toMatch(/7sec/i);
      expect(
        logLines(logs)
          .map(({ annotations }) => annotations)
          .filter((annotations) => annotations["http.status"] !== undefined)
          .map((annotations) => [annotations["http.method"], annotations["http.route"]]),
      ).toEqual(requests.map(([method, , route]) => [method, route]));
    } finally {
      await api.dispose();
    }
  });

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

  it("keeps the invitation token a sign-up carries in its header out of the request log and traces", async () => {
    const boundary = betterAuthBoundary();
    try {
      await boundary.post(
        "/api/auth/sign-up/email",
        { "x-mend-invitation": "invite-secret-needle" },
        { name: "Dana", email: "dana@example.com", password: "a long enough password" },
      );
      expect(traced(boundary.spans)).toContain('["http.route","/api/auth/*"]');
      expect
        .soft(boundary.logs.filter((line) => line.includes("invite-secret-needle")))
        .toEqual([]);
      expect.soft(traced(boundary.spans)).not.toContain("invite-secret-needle");
    } finally {
      await boundary.dispose();
    }
  });
});
