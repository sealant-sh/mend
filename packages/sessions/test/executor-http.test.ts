import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { requestExecutor } from "../src/executor/http.ts";
import { ExecutorTransport, ExecutorTransportLive } from "../src/executor/transport.ts";

const serve = async (handle: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No TCP listener");
  return {
    endpoint: { host: "127.0.0.1", port: address.port },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("Executor private routing", () => {
  it("resolves approval labels through the organization's private endpoint", async () => {
    const paths: string[] = [];
    const server = await serve((request, response) => {
      expect(request.headers.host).toBe("executor.localhost:4400");
      expect(request.headers.authorization).toBe("Bearer fixture-service");
      paths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/api/context"
            ? { organization: "fixture-org" }
            : { name: "Approval probe", slug: "approval-probe" },
        ),
      );
    });
    try {
      expect(
        await Effect.runPromise(
          Effect.flatMap(ExecutorTransport, (transport) =>
            transport.service(
              { origin: "http://executor.localhost:4400", endpoint: server.endpoint },
              {
                subject: "fixture-person",
                accessToken: Redacted.make("fixture-service"),
                refreshToken: Redacted.make("unused"),
                expiresAt: Date.now() + 60000,
              },
              "app_probe",
            ),
          ).pipe(Effect.provide(ExecutorTransportLive)),
        ),
      ).toMatchObject({ name: "Approval probe", slug: "approval-probe" });
      expect(paths).toEqual(["/api/context", "/api/organizations/fixture-org/apps/app_probe"]);
    } finally {
      await server.close();
    }
  });

  it("keeps the logical authority while selecting each organization's own endpoint", async () => {
    const first = await serve((request, response) => {
      expect(request.headers.host).toBe("executor.localhost:4400");
      expect(request.headers["sec-fetch-mode"]).toBeUndefined();
      response.setHeader("Set-Cookie", ["first=one; Path=/", "second=two; Path=/"]);
      response.end("first organization");
    });
    const second = await serve((_request, response) => response.end("second organization"));
    try {
      const origin = "http://executor.localhost:4400";
      const [a, b] = await Promise.all([
        Effect.runPromise(requestExecutor({ origin, endpoint: first.endpoint }, "/health")),
        Effect.runPromise(requestExecutor({ origin, endpoint: second.endpoint }, "/health")),
      ]);
      expect(await a.text()).toBe("first organization");
      expect(await b.text()).toBe("second organization");
      expect(a.headers.getSetCookie()).toEqual(["first=one; Path=/", "second=two; Path=/"]);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("does not follow redirects or send a request for another authority", async () => {
    let requests = 0;
    const server = await serve((_request, response) => {
      requests++;
      response.writeHead(302, { Location: "https://elsewhere.invalid/" });
      response.end();
    });
    try {
      const target = { origin: "http://executor.localhost:4400", endpoint: server.endpoint };
      const reply = await Effect.runPromise(
        requestExecutor(target, "/authorize", { headers: { Authorization: "Bearer fixture" } }),
      );
      expect(reply.status).toBe(302);
      const refused = await Effect.runPromise(
        Effect.result(requestExecutor(target, "https://elsewhere.invalid/")),
      );
      expect(refused._tag).toBe("Failure");
      expect(requests).toBe(1);
    } finally {
      await server.close();
    }
  });
});
