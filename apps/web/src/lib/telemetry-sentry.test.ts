// @vitest-environment jsdom
import {
  addBreadcrumb,
  captureException,
  close,
  createTransport,
  flush,
  init,
  startInactiveSpan,
  startSpan,
  withActiveSpan,
} from "@sentry/browser";
import { TRPCClientError } from "@trpc/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  currentAction,
  firstVisibleOutput,
  reportCaught,
  sentryOptions,
  spansRequest,
  traceAction,
} from "./telemetry-sentry.ts";
import type { TraceRef } from "./telemetry.ts";

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

/** The page's requests, as they would leave: Sentry wraps this `fetch` when it starts. */
const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
globalThis.fetch = async (input, request) => {
  requests.push({
    url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    headers: new Headers(request?.headers),
  });
  return new Response("[]", { status: 200 });
};

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

describe("an action and what follows it", () => {
  it("carries its trace on a call made after an await only through `within`", async () => {
    requests.length = 0;
    let ref: TraceRef | null = null;
    await traceAction("mend.web.message.send", { "mend.session_id": "s1" }, async (action) => {
      ref = action.ref;
      // The outbox sends in turn: the request leaves after an await.
      await Promise.resolve();
      await action.within(() => fetch("/trpc/sessions.sendMessage", { method: "POST" }));
      await fetch("/trpc/sessions.inbox", { method: "POST" });
    });
    const traceId = (ref as TraceRef | null)?.traceId ?? "no trace";
    const [within, outside] = requests;
    expect(within?.headers.get("traceparent")).toMatch(
      new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`),
    );
    expect(outside?.headers.get("traceparent") ?? "").not.toContain(traceId);
  });

  it("names the action a call is made in even when its step starts a navigation's span", async () => {
    let seen: string | null = "none";
    let ref: TraceRef | null = null;
    await traceAction("mend.web.session.start", {}, async (action) => {
      ref = action.ref;
      // A start shows its page first: the router's navigation span becomes the page's active one.
      const navigation = startInactiveSpan({ name: "/sessions/$sessionId", op: "navigation" });
      withActiveSpan(navigation, () => {
        seen = currentAction();
      });
      navigation.end();
    });
    expect(seen).toBe((ref as TraceRef | null)?.spanId);
  });

  it("names a request for its procedures or its route, never its origin, port or IDs", () => {
    const { beforeSendSpan } = sentryOptions({
      dsn: "https://6f570eb21e7adee8a5de60116db1b2a7@sentry.example/4",
      environment: "test",
      release: null,
      tracesSampleRate: 1,
    });
    // As the SDK hands them over: named for the address the page fetched.
    const request = (method: string, url: string) =>
      beforeSendSpan?.({
        trace_id: "0af7651916cd43dd8448eb211c80319c",
        span_id: "b7ad6b7169203331",
        name: `${method} ${url}`,
        start_timestamp: 1,
        end_timestamp: 2,
        status: "ok",
        is_segment: false,
        attributes: {
          "sentry.op": { value: "http.client", type: "string" },
          "http.request.method": { value: method, type: "string" },
          "url.full": { value: url, type: "string" },
        },
      });
    const batch = request(
      "POST",
      "http://localhost:45877/trpc/sessions.detail,sessions.pages,sessions.items?batch=1&input=%7B%7D",
    );
    expect(batch?.name).toBe("POST /trpc/sessions.detail +2");
    expect(batch?.attributes).toMatchObject({
      "sentry.description": "POST /trpc/sessions.detail +2",
      "mend.trpc.procedures": "sessions.detail,sessions.pages,sessions.items",
    });
    const send = request(
      "POST",
      "http://localhost:45877/api/sessions/852bcfd6-bcde-45d8-970e-17161c13515c/messages",
    );
    expect(send?.name).toBe("POST /api/sessions/:sessionId/messages");
    expect(send?.attributes["sentry.description"]).toBe("POST /api/sessions/:sessionId/messages");
    expect(JSON.stringify([batch?.name, send?.name])).not.toContain("45877");
    const timing = beforeSendSpan?.({
      trace_id: "0af7651916cd43dd8448eb211c80319c",
      span_id: "b7ad6b7169203332",
      name: "Request",
      start_timestamp: 1,
      end_timestamp: 2,
      status: "ok",
      is_segment: false,
      attributes: {
        "sentry.op": { value: "browser.request", type: "string" },
        "url.full": {
          value: "http://localhost:45877/sessions/852bcfd6-bcde-45d8-970e-17161c13515c",
          type: "string",
        },
      },
    });
    expect(timing?.name).toBe("Request");
    expect(timing?.attributes["sentry.description"]).toBe("/sessions/:sessionId");
  });

  it("makes no span for a read the page repeats on a timer", () => {
    expect(spansRequest("http://localhost:3105/trpc/executor.calls?batch=1")).toBe(false);
    expect(spansRequest("http://localhost:3105/trpc/executor.calls,sessions.detail")).toBe(true);
    expect(spansRequest("/api/health")).toBe(true);
  });

  it("measures a turn's first visible output as its own span, with the turn's id and a link to its send", async () => {
    sent.length = 0;
    const ref = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" };
    firstVisibleOutput("turn-1", { sessionId: "s1", since: Date.now() - 250, from: "send", ref });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await flush(2_000);
    const span = sent
      .flatMap((body) => body.split("\n"))
      .flatMap((line) => {
        const parsed: unknown = JSON.parse(line);
        return typeof parsed === "object" &&
          parsed !== null &&
          "items" in parsed &&
          Array.isArray(parsed.items)
          ? parsed.items
          : [];
      })
      .find((item) => item.name === "mend.web.turn.first_visible_output");
    expect(span?.attributes["mend.turn_id"]?.value).toBe("turn-1");
    expect(span?.trace_id).not.toBe(ref.traceId);
    expect(span?.links?.[0]?.trace_id).toBe(ref.traceId);
    expect(span?.end_timestamp - span?.start_timestamp).toBeGreaterThanOrEqual(0.25);
  });
});
