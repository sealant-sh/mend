// @vitest-environment jsdom
import {
  addBreadcrumb,
  captureException,
  close,
  createTransport,
  flush,
  init,
  startSpan,
} from "@sentry/browser";
import { TRPCClientError } from "@trpc/client";
import { afterAll, describe, expect, it } from "vitest";

import { reportCaught, sentryOptions } from "./telemetry-sentry.ts";

/** A secret of a shape Mend mints and providers mint: it must never reach Sentry. */
const CANARY = "ghp_canary0secret0value0planted0here";

/** Everything the client would send, as the bytes it hands its transport. */
const sent: Array<string> = [];
const decoder = new TextDecoder();
const recording = (
  options: Parameters<typeof createTransport>[0],
): ReturnType<typeof createTransport> =>
  createTransport(options, async (request) => {
    sent.push(typeof request.body === "string" ? request.body : decoder.decode(request.body));
    return { statusCode: 200 };
  });

init(
  sentryOptions(
    {
      dsn: "https://6f570eb21e7adee8a5de60116db1b2a7@sentry.example/4",
      environment: "test",
      release: "mend-web@0.0.0-test",
      tracesSampleRate: 1,
    },
    { transport: recording },
  ),
);

afterAll(() => close());

describe("the browser's Sentry client", () => {
  it("sends an error and a trace with no secret in either (CONTRACT.md, Privacy)", async () => {
    // The page's own address, a call's address and the error's words each carry the canary.
    window.history.replaceState(null, "", `/sessions/s1?code=${CANARY}#token=${CANARY}`);
    addBreadcrumb({
      category: "fetch",
      type: "http",
      data: { method: "GET", url: `/api/resources/r1?ticket=${CANARY}`, status_code: 200 },
    });
    startSpan(
      {
        name: `GET /api/resources/r1?ticket=${CANARY}`,
        attributes: {
          "url.full": `https://mend.example/api/resources/r1?ticket=${CANARY}`,
          "http.query": `ticket=${CANARY}`,
        },
      },
      () => undefined,
    );
    reportCaught(new Error(`clone failed: token=${CANARY} (Authorization: Bearer ${CANARY})`));
    await flush(2_000);

    const everything = sent.join("\n");
    // It did send: the error, its route and the span all arrived.
    expect(everything).toContain("clone failed");
    expect(everything).toContain("/sessions/s1");
    expect(everything).toContain("GET /api/resources/r1");
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain("canary0secret");
  });

  it("leaves to the server the failures it answered, reported there with their cause", async () => {
    sent.length = 0;
    const refused = TRPCClientError.from({
      error: {
        message: "Session not found",
        code: -32004,
        data: { code: "NOT_FOUND", httpStatus: 404 },
      },
    });
    reportCaught(refused);
    captureException(refused);
    reportCaught(new Error("a render that broke"));
    await flush(2_000);
    const everything = sent.join("\n");
    expect(everything).toContain("a render that broke");
    expect(everything).not.toContain("Session not found");
  });
});
