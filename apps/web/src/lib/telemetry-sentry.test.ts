// @vitest-environment jsdom
import {
  addBreadcrumb,
  captureException,
  close,
  createTransport,
  flush,
  getClient,
  init,
  spanToJSON,
  startInactiveSpan,
  startSpan,
  withActiveSpan,
} from "@sentry/browser";
import { TRPCClientError } from "@trpc/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  aside,
  backgroundRead,
  currentAction,
  firstVisibleOutput,
  procedureSpanName,
  reportCaught,
  routeTemplate,
  sentryOptions,
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

/** A span as the client sent it (a v2 streamed span). */
interface SentSpan {
  readonly name: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id?: string;
  readonly start_timestamp: number;
  readonly end_timestamp: number;
  readonly status: string;
  readonly attributes: Readonly<Record<string, { readonly value: unknown } | undefined>>;
  readonly links?: ReadonlyArray<{ readonly trace_id: string; readonly span_id: string }>;
}

const isSentSpan = (item: unknown): item is SentSpan =>
  typeof item === "object" && item !== null && "span_id" in item && "trace_id" in item;

/**
 * A request read to its end, as tRPC reads it, and its span ended: the SDK ends a request's span
 * once it has read a copy of the answer's body, after the page has its answer.
 */
const answered = async (url: string, request: RequestInit): Promise<void> => {
  const ended = new Promise<void>((resolve) => {
    const stop = getClient()?.on("spanEnd", (span) => {
      const { attributes } = spanToJSON(span);
      if (attributes?.["sentry.op"] !== "http.client") return;
      if (attributes["url.path"] !== url.split("?")[0]) return;
      stop?.();
      resolve();
    });
  });
  await (await fetch(url, request)).text();
  await ended;
};

/** Every span the client has sent so far. */
const sentSpans = (): ReadonlyArray<SentSpan> =>
  sent
    .flatMap((body) => body.split("\n"))
    .flatMap((line) => {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" &&
        parsed !== null &&
        "items" in parsed &&
        Array.isArray(parsed.items)
        ? parsed.items.filter(isSentSpan)
        : [];
    });

const attribute = (span: SentSpan | undefined, key: string): unknown =>
  span?.attributes[key]?.value;

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
    // A click on a control whose label is a session's name, and a batch whose input is a prompt.
    startInactiveSpan({
      name: `button[aria-label="${CANARY}"]`,
      op: "ui.interaction.click",
      attributes: {
        "ui.component_name": "SessionRow",
        // Sentry writes a label's value as it is: one holding ` > ` must not split into names.
        "browser.web_vital.inp.target": `SessionRow > button.flex[aria-label="Stop auth > ${CANARY} now"]`,
      },
    }).end();
    await answered(`/trpc/sessions.sendMessage?batch=1&input=${CANARY}`, { method: "POST" });
    reportCaught(new Error(`clone failed: token=${CANARY} (Authorization: Bearer ${CANARY})`));
    await flush(2_000);

    const everything = sent.join("\n");
    // It did send: the error, its route and the span all arrived.
    expect(everything).toContain("clone failed");
    expect(everything).toContain("/sessions/s1");
    expect(everything).toContain("GET /api/resources/r1");
    expect(everything).toContain("click in SessionRow");
    expect(everything).toContain("trpc sessions.send_message");
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
    expect(batch?.name).toBe("POST /trpc/:procedures");
    expect(batch?.attributes).toMatchObject({
      "sentry.description": "POST /trpc/:procedures",
      "url.template": "/trpc/:procedures",
      "mend.trpc.procedures": "sessions.detail,sessions.pages,sessions.items",
      "mend.trpc.batch_size": 3,
    });
    // One call alone reads the same: the name never says what or how many a request carries.
    expect(request("POST", "http://localhost:45877/trpc/sessions.launch")?.name).toBe(
      "POST /trpc/:procedures",
    );
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

  it("tells a read the page repeats on a timer from the rest", () => {
    expect(backgroundRead("http://localhost:3105/trpc/executor.calls?batch=1")).toBe(true);
    expect(backgroundRead("http://localhost:3105/trpc/executor.calls,sessions.detail")).toBe(false);
    expect(backgroundRead("/api/health")).toBe(false);
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

describe("each trace covers one thing the page did", () => {
  it("gives a tRPC request one child span per procedure, named for it", async () => {
    sent.length = 0;
    await answered("/trpc/sessions.inboxRow,changes.stats?batch=1&input=%7B%7D", {
      method: "POST",
    });
    await flush(2_000);
    const spans = sentSpans();
    const request = spans.find(
      (span) => attribute(span, "mend.trpc.procedures") === "sessions.inboxRow,changes.stats",
    );
    expect(request?.name).toBe("POST /trpc/:procedures");
    // The trace's root name, as every span of it repeats it, is the request's route too.
    expect(attribute(request, "sentry.segment.name")).toBe("POST /trpc/:procedures");
    const procedures = spans.filter((span) => span.parent_span_id === request?.span_id);
    expect(procedures.map((span) => span.name).toSorted()).toEqual([
      "trpc changes.stats",
      "trpc sessions.inbox_row",
    ]);
    for (const procedure of procedures) {
      expect(attribute(procedure, "sentry.op")).toBe("rpc.client");
      expect(attribute(procedure, "rpc.system")).toBe("trpc");
      expect(procedure.end_timestamp).toBe(request?.end_timestamp);
    }
    expect(attribute(procedures[0], "rpc.method")).toMatch(/^(sessions\.inboxRow|changes\.stats)$/);
  });

  it("starts a trace of its own for each request no span holds", async () => {
    requests.length = 0;
    await fetch("/trpc/sessions.inbox", { method: "POST" });
    await fetch("/trpc/sessions.inbox", { method: "POST" });
    const [first, second] = requests.map((each) => each.headers.get("traceparent")?.split("-")[1]);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });

  it("keeps a background read out of the span that is running", async () => {
    requests.length = 0;
    let running = "none";
    await startSpan({ name: "/sessions/$sessionId", op: "navigation" }, async (span) => {
      running = span.spanContext().traceId;
      await aside("/trpc/executor.calls?batch=1", () =>
        fetch("/trpc/executor.calls?batch=1", { method: "POST" }),
      );
      await aside("/trpc/sessions.detail?batch=1", () =>
        fetch("/trpc/sessions.detail?batch=1", { method: "POST" }),
      );
    });
    const [poll, read] = requests.map((each) => each.headers.get("traceparent")?.split("-")[1]);
    expect(poll).not.toBe(running);
    expect(read).toBe(running);
  });

  it("starts a span whose parent already ended in a trace of its own, linked to the parent", async () => {
    sent.length = 0;
    const page = startInactiveSpan({ name: "/sessions/$sessionId", op: "pageload" });
    page.end();
    // A web vital reported when the page is left, at the moment it measured.
    startInactiveSpan({
      name: "Click",
      op: "ui.interaction.click",
      parentSpan: page,
      attributes: { "ui.component_name": "SessionRow" },
    }).end();
    await flush(2_000);
    const click = sentSpans().find((span) => span.name === "SessionRow");
    expect(click?.trace_id).not.toBe(page.spanContext().traceId);
    expect(click?.parent_span_id).toBeUndefined();
    expect(click?.links?.[0]?.span_id).toBe(page.spanContext().spanId);
    expect(click?.links?.[0]?.trace_id).toBe(page.spanContext().traceId);
  });

  it("names a click, a layout shift and a paint for the component it happened in", () => {
    const { beforeSendSpan } = sentryOptions({
      dsn: "https://6f570eb21e7adee8a5de60116db1b2a7@sentry.example/4",
      environment: "test",
      release: null,
      tracesSampleRate: 1,
    });
    const vital = (op: string, name: string, attributes: Record<string, string>) =>
      beforeSendSpan?.({
        trace_id: "0af7651916cd43dd8448eb211c80319c",
        span_id: "b7ad6b7169203333",
        name,
        start_timestamp: 1,
        end_timestamp: 2,
        status: "ok",
        is_segment: false,
        attributes: { "sentry.op": op, ...attributes },
      });
    const click = vital("ui.interaction.click", "SessionRow", {
      "ui.component_name": "SessionRow",
      "browser.web_vital.inp.target":
        'SessionRow > div.flex.gap-2 > button.group/button.inline-flex[aria-label="Stop Fix the login bug"]',
    });
    expect(click?.name).toBe("SessionRow");
    expect(click?.attributes["sentry.description"]).toBe("click in SessionRow");
    // The element's selector carries classes and labels: none of it leaves.
    expect(click?.attributes).not.toHaveProperty("browser.web_vital.inp.target");
    const bare = vital("ui.interaction.click", "body > div#root.flex > button.inline-flex", {
      "browser.web_vital.inp.target": "body > div#root.flex > button.inline-flex",
    });
    expect(bare?.name).toBe("Click");
    expect(bare?.attributes["sentry.description"]).toBe("click");
    // The page it happened on, when the SDK names it: the route's template.
    const onPage = vital("ui.interaction.click", "Click", {
      "sentry.transaction": "/sessions/$sessionId",
    });
    expect(onPage?.attributes["sentry.description"]).toBe("click on /sessions/$sessionId");
    const stillOnPage = vital("ui.webvital.cls", "Layout shift", {
      "sentry.transaction": "/login",
    });
    expect(stillOnPage?.attributes["sentry.description"]).toBe("no layout shift on /login");
    const press = vital("ui.interaction.press", "Key press", {});
    expect(press?.attributes["sentry.description"]).toBe("key press");
    // A page whose layout never moved still reports its CLS, with no element to name.
    const still = vital("ui.webvital.cls", "Layout shift", {});
    expect(still?.attributes["sentry.description"]).toBe("no layout shift");
    const shifted = vital("ui.webvital.cls", "InboxGroups", {
      "ui.component_name": "InboxGroups",
      "browser.web_vital.cls.source.1": "InboxGroups > div.flex.flex-col.gap-0.5.border-t",
    });
    expect(shifted?.attributes["sentry.description"]).toBe("layout shift in InboxGroups");
    expect(shifted?.attributes).not.toHaveProperty("browser.web_vital.cls.source.1");
    const moved = vital("ui.webvital.cls", "Layout shift", {
      "browser.web_vital.cls.source.1": "div.flex",
    });
    expect(moved?.attributes["sentry.description"]).toBe("layout shift");
  });

  it("names a procedure's span by router and procedure in snake case", () => {
    expect(procedureSpanName("sessions.inboxRow")).toBe("trpc sessions.inbox_row");
    expect(procedureSpanName("platform.machine")).toBe("trpc platform.machine");
    expect(procedureSpanName("settings.agentLogins.listAll")).toBe(
      "trpc settings.agent_logins.list_all",
    );
  });

  it("names a page by URL template: a splat as `*`, an index without its slash", () => {
    expect(routeTemplate("/$")).toBe("/*");
    expect(routeTemplate("/settings/$")).toBe("/settings/*");
    expect(routeTemplate("/projects/$projectId/settings/$")).toBe(
      "/projects/$projectId/settings/*",
    );
    expect(routeTemplate("/projects/")).toBe("/projects");
    expect(routeTemplate("/sessions/$sessionId/$view")).toBe("/sessions/$sessionId/$view");
    expect(routeTemplate("/")).toBe("/");
  });
});
