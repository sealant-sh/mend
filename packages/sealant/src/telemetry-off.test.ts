import { createServer, type IncomingHttpHeaders } from "node:http";

import { telemetryLayer } from "@mend/telemetry";
import { Sealant } from "@sealant/sdk";
import {
  listWorkspacesOp,
  resolveInternalConfig,
  sealantApiClientLayer,
} from "@sealant/sdk/effect";
import { ConfigProvider, Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

const TRACE_HEADERS = ["traceparent", "tracestate", "baggage", "b3", "sentry-trace"];

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A sealant that keeps each request's headers; what it answers does not matter here. */
const serve = async () => {
  const seen: Array<IncomingHttpHeaders> = [];
  const server = createServer((request, response) => {
    seen.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [], nextCursor: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
};

/** Telemetry as a Mend server with no `SENTRY_DSN` has it (SLNT-1404). */
const withoutDsn = telemetryLayer({ name: "mend-test" }).pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
);

describe("a Mend server with telemetry off", () => {
  it("sends sealant no trace header, through the SDK's Effect core or its facade", async () => {
    const sealant = await serve();
    const facade = new Sealant({ baseUrl: sealant.baseUrl });
    closers.push(() => facade.close());
    await Effect.runPromise(
      Effect.gen(function* () {
        // Only the headers are read: neither call needs to succeed.
        yield* Effect.exit(listWorkspacesOp({ ownerUserId: "user-1" }));
        yield* Effect.exit(Effect.tryPromise(() => facade.workspaces.list()));
      }).pipe(
        Effect.withSpan("mend.test.request"),
        Effect.provide(sealantApiClientLayer(resolveInternalConfig({ baseUrl: sealant.baseUrl }))),
        Effect.provide(withoutDsn),
      ),
    );
    expect(sealant.seen.length).toBeGreaterThanOrEqual(2);
    for (const headers of sealant.seen)
      expect(TRACE_HEADERS.filter((name) => headers[name] !== undefined)).toEqual([]);
  });
});
