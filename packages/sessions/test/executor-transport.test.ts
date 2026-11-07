import { createServer } from "node:http";

import { Effect, Redacted } from "effect";
import { expect, it } from "vitest";

import { ExecutorTransport, ExecutorTransportLive } from "../src/executor/transport.ts";

it("resolves held app ids in the service grant's organization without exposing credentials", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer fixture-service-grant");
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/context") response.end(JSON.stringify({ organization: "org-probe" }));
    else if (request.url === "/api/organizations/org-probe/apps/app_probe")
      response.end(
        JSON.stringify({ id: "app_probe", name: "Approval probe", slug: "approval-probe" }),
      );
    else {
      response.statusCode = 403;
      response.end(JSON.stringify({ private: "must not appear in Mend's failure" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture listener");
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* ExecutorTransport;
        const origin = `http://127.0.0.1:${address.port}`;
        const grant = {
          accessToken: Redacted.make("fixture-service-grant"),
          refreshToken: Redacted.make("unused-refresh"),
          subject: "fixture-person",
          expiresAt: Date.now() + 60000,
        };
        expect(yield* transport.service(origin, grant, "app_probe")).toMatchObject({
          name: "Approval probe",
          slug: "approval-probe",
        });
        const refused = yield* Effect.result(transport.service(origin, grant, "app_unavailable"));
        expect(refused).toMatchObject({
          _tag: "Failure",
          failure: { message: "Executor refused the request · HTTP 403 · observed" },
        });
      }).pipe(Effect.provide(ExecutorTransportLive)),
    );
    expect(requests).toEqual([
      "/api/context",
      "/api/organizations/org-probe/apps/app_probe",
      "/api/context",
      "/api/organizations/org-probe/apps/app_unavailable",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
