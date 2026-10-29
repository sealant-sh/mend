import { createHmac } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { PageFrame } from "@mend/api-contracts";
import { PAGE_FRAME_TTL_MS, PageRef } from "@mend/domain/workbench";
import { PAGE_VIEW_PATH } from "@mend/network";
import {
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Redacted,
  References,
  Schema,
  Tracer,
} from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { type HarnessProject, type HarnessUser, ids } from "../../test/support/tenancy-harness.ts";
import { pageDocument } from "../page-document.ts";
import { pageViewKeyOf, pageViewTokensOf } from "../page-view-tokens.ts";
import { API_RESPONSE_HEADERS, responseHeadersFor } from "../response-headers.ts";
import { UntracedRequestsLive } from "../untraced-requests.ts";

const KEY = pageViewKeyOf("pages-test-secret");
const decodeFrame = Schema.decodeUnknownSync(PageFrame);

const headersOf = (response: Response) =>
  Object.fromEntries([...response.headers.entries()].filter(([name]) => name !== "content-length"));

/** A GET whose request target reaches the server exactly as written: no URL normalises it. */
const rawGet = (origin: string, target: string) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const { hostname, port } = new URL(origin);
      const sent = httpRequest({ host: hostname, port, path: target, method: "GET" }, (answer) => {
        let body = "";
        answer.setEncoding("utf8");
        answer.on("data", (chunk: string) => (body += chunk));
        answer.on("end", () =>
          resolve({ status: answer.statusCode ?? 0, headers: answer.headers, body }),
        );
      });
      sent.on("error", reject);
      sent.end();
    },
  );

describe("a page by URL (docs/adr/0004, Agent pages)", () => {
  let api: TenancyApi;
  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      pageViewTokens: pageViewTokensOf(KEY),
      browserHeaders: true,
      node: true,
    });
  });
  afterAll(async () => {
    await api.dispose();
  });

  const frame = async (user: HarnessUser, project: HarnessProject, appearance = "dark") =>
    api.request(user, "GET", `/api/pages/${ids(project).page}/frame?appearance=${appearance}`);

  const frameUrl = async (user: HarnessUser, project: HarnessProject, appearance = "dark") => {
    const answer = await frame(user, project, appearance);
    expect(answer.status).toBe(200);
    return decodeFrame(await answer.json());
  };

  it("frames a readable page by a URL that serves its document with exactly the sandbox headers", async () => {
    const before = Date.now();
    const framed = await frameUrl("carol", "shared-a", "light");
    expect(framed.url.startsWith(`${PAGE_VIEW_PATH}?view=`)).toBe(true);
    expect(framed.expiresAt.getTime()).toBeGreaterThanOrEqual(before + PAGE_FRAME_TTL_MS);
    expect(framed.expiresAt.getTime() - before).toBeGreaterThan(15 * 60 * 1000);

    const page = await api.request(null, "GET", framed.url);
    expect(page.status).toBe(200);
    const stored = api.world.pages.get(ids("shared-a").page);
    expect(await page.text()).toBe(pageDocument(stored?.html ?? "", "light"));
    expect(headersOf(page)).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "sandbox allow-scripts allow-forms",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    });

    const dark = await api.request(null, "GET", (await frameUrl("carol", "shared-a")).url);
    expect(await dark.text()).toBe(pageDocument(stored?.html ?? "", "dark"));
  });

  it("answers another person's frame request exactly as a page that does not exist", async () => {
    for (const [user, project] of [
      ["bob", "shared-a"],
      ["dave", "shared-a"],
      ["carol", "private-alice"],
    ] as const) {
      const refused = await frame(user, project);
      expect({ status: refused.status, body: await refused.json() }).toEqual({
        status: 404,
        body: { _tag: "NotFound", id: ids(project).page },
      });
    }
    const missing = await api.request(
      "alice",
      "GET",
      "/api/pages/page-nowhere/frame?appearance=dark",
    );
    expect({ status: missing.status, body: await missing.json() }).toEqual({
      status: 404,
      body: { _tag: "NotFound", id: "page-nowhere" },
    });
  });

  it("refuses a token that was tampered with, signed by another key, or expired", async () => {
    const framed = await frameUrl("alice", "shared-a");
    const token = new URL(framed.url, "http://api.internal").searchParams.get("view") ?? "";
    const [payload = "", signature = ""] = token.split(".");
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...claim, page: ids("shared-b").page })).toString(
      "base64url",
    );
    const grant = { pageId: ids("shared-a").page, accountId: "alice", appearance: "dark" } as const;
    const otherKey = await Effect.runPromise(
      pageViewTokensOf(pageViewKeyOf("another-secret")).issue(grant),
    );
    const expired = await Effect.runPromise(pageViewTokensOf(KEY, -1).issue(grant));
    expect(claim.version).toBe(1);
    const nextVersion = Buffer.from(JSON.stringify({ ...claim, version: 2 })).toString("base64url");
    const signedNextVersion = `${nextVersion}.${createHmac("sha256", KEY).update(nextVersion).digest("base64url")}`;
    for (const bad of [
      `${forged}.${signature}`,
      `${payload}.${signature.slice(0, -2)}AA`,
      `${payload}.`,
      payload,
      Redacted.value(otherKey.token),
      Redacted.value(expired.token),
      signedNextVersion,
    ]) {
      const refused = await api.request(
        null,
        "GET",
        `${PAGE_VIEW_PATH}?${new URLSearchParams({ view: bad })}`,
      );
      expect(refused.status).toBe(404);
      expect(await refused.text()).not.toContain("<p>");
    }
    expect((await api.request(null, "GET", framed.url)).status).toBe(200);
  });

  it("checks the account again on every load, so losing access refuses the next one", async () => {
    const framed = await frameUrl("carol", "shared-a");
    expect((await api.request(null, "GET", framed.url)).status).toBe(200);
    api.world.setVisibility("shared-a", "private");
    try {
      const refused = await api.request(null, "GET", framed.url);
      expect(refused.status).toBe(404);
      expect(headersOf(refused)["x-frame-options"]).toBeUndefined();
    } finally {
      api.world.setVisibility("shared-a", "shared");
    }
    expect((await api.request(null, "GET", framed.url)).status).toBe(200);
  });

  it("serves a page on its own path only, never on another spelling the router would match", async () => {
    const query = new URL((await frameUrl("alice", "shared-a")).url, "http://api.internal").search;
    for (const path of [
      "/api//page-view",
      "/api/Page-View",
      "/API/page-view",
      "/api/%70age-view",
    ]) {
      const refused = await api.request(null, "GET", `${path}${query}`);
      expect({ path, status: refused.status }).toEqual({ path, status: 404 });
      expect(await refused.text()).not.toContain("<p>");
    }
  });

  it("serves the page on its exact path as sent, and on no target a URL resolves to it", async () => {
    const origin = api.nodeOrigin ?? "";
    const query = new URL((await frameUrl("alice", "shared-a")).url, "http://api.internal").search;
    const served = await rawGet(origin, `${PAGE_VIEW_PATH}${query}`);
    expect(served.status).toBe(200);
    expect(served.body).toContain("<p>shared-a</p>");
    expect(served.headers["content-security-policy"]).toBe("sandbox allow-scripts allow-forms");
    for (const target of [
      `//api/page-view${query}`,
      `/api/auth/%2e%2e/page-view${query}`,
      `/api/x/%2e%2e/page-view${query}`,
      `/api/x/../page-view${query}`,
    ]) {
      const other = await rawGet(origin, target);
      expect({ target, status: other.status }).not.toEqual({ target, status: 200 });
      expect(other.body).not.toContain("<p>");
      for (const [name, value] of Object.entries(API_RESPONSE_HEADERS)) {
        expect(other.headers[name], `${target} ${name}`).toBe(value);
      }
    }
  });

  it("lists a session's pages as metadata only, to whoever may read the session", async () => {
    const listed = await api.request(
      "carol",
      "GET",
      `/api/sessions/${ids("shared-a").session}/pages`,
    );
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body).toEqual([
      {
        id: ids("shared-a").page,
        sessionId: ids("shared-a").session,
        title: "Page of shared-a",
        height: 320,
        publishedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("<p>");
    const refused = await api.request(
      "bob",
      "GET",
      `/api/sessions/${ids("shared-a").session}/pages`,
    );
    expect(refused.status).toBe(404);
  });

  it("gives the page view's headers to its exact path alone, as the client sent it", () => {
    expect(responseHeadersFor(`${PAGE_VIEW_PATH}?view=x`)).not.toBe(API_RESPONSE_HEADERS);
    expect(responseHeadersFor(`http://api.internal${PAGE_VIEW_PATH}`)).not.toBe(
      API_RESPONSE_HEADERS,
    );
    for (const target of [
      "/api/auth/%2e%2e/page-view?view=x",
      "/api/auth/../page-view?view=x",
      "//api/page-view?view=x",
      `${PAGE_VIEW_PATH}/`,
      "/api/Page-View",
    ]) {
      expect(responseHeadersFor(target), target).toBe(API_RESPONSE_HEADERS);
    }
  });

  it("leaves every other route's headers as they were, a path that only looks like it included", async () => {
    const answers = await Promise.all([
      frame("alice", "shared-a"),
      frame("bob", "shared-a"),
      api.request("alice", "GET", `/api/sessions/${ids("shared-a").session}/pages`),
      api.request(null, "GET", `${PAGE_VIEW_PATH}/extra?view=x`),
      api.request(null, "GET", "/api/page-viewer?view=x"),
      api.request("alice", "GET", "/api/health"),
    ]);
    for (const answer of answers) {
      for (const [name, value] of Object.entries(API_RESPONSE_HEADERS)) {
        expect(answer.headers.get(name), name).toBe(value);
      }
    }
  });
});

describe("the page-view token never reaches the API's log", () => {
  it("logs the route's path and never its query", async () => {
    const lines: Array<string> = [];
    const routes = HttpRouter.use((router) =>
      router.add("GET", PAGE_VIEW_PATH, () => Effect.succeed(HttpServerResponse.text("page"))),
    );
    const capture = Logger.layer([
      Logger.make(({ message, fiber }) => {
        lines.push(
          JSON.stringify({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) }),
        );
      }),
    ]);
    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.mergeAll(routes, capture).pipe(Layer.provide(HttpServer.layerServices)),
    );
    try {
      const answer = await handler(
        new Request(`http://api.internal${PAGE_VIEW_PATH}?view=secret-token-value`),
      );
      expect(answer.status).toBe(200);
    } finally {
      await dispose();
    }
    expect(lines.join("\n")).toContain(PAGE_VIEW_PATH);
    expect(lines.join("\n")).not.toContain("secret-token-value");
  });
});

describe("the page-view token never reaches a trace", () => {
  it("records no span for a page view on any spelling or a raw read, and the usual span for every other route", async () => {
    const spans: Array<{ readonly name: string; readonly attributes: Map<string, unknown> }> = [];
    class RecordedSpan extends Tracer.NativeSpan {
      readonly recorded = new Map<string, unknown>();
      override attribute(key: string, value: unknown) {
        this.recorded.set(key, value);
        super.attribute(key, value);
      }
    }
    const tracer = Tracer.make({
      span: (options) => {
        const span = new RecordedSpan(options);
        spans.push({ name: span.name, attributes: span.recorded });
        return span;
      },
    });
    const routes = HttpRouter.use((router) =>
      Effect.all([
        router.add("GET", PAGE_VIEW_PATH, () => Effect.succeed(HttpServerResponse.text("page"))),
        router.add("GET", "/api/worktrees/:id/raw", () =>
          Effect.succeed(HttpServerResponse.text("raw")),
        ),
        router.add("GET", "/api/health", () => Effect.succeed(HttpServerResponse.text("ok"))),
      ]),
    );
    const server = createServer();
    const runtime = ManagedRuntime.make(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provide(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" })),
        Layer.provide(UntracedRequestsLive),
        Layer.provide(Layer.succeed(Tracer.Tracer)(tracer)),
      ),
    );
    try {
      await runtime.runPromise(Effect.void);
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No HTTP address");
      const origin = `http://127.0.0.1:${address.port}`;
      for (const path of [
        PAGE_VIEW_PATH,
        "/api//page-view",
        "//api/page-view",
        "/API/Page-View/",
        "/api/%70age-view",
        `${PAGE_VIEW_PATH};x`,
        "/api/auth/%2e%2e/page-view",
      ]) {
        await rawGet(origin, `${path}?view=secret-token-value`);
      }
      expect((await fetch(`${origin}/api/worktrees/wt/raw?path=secret-file-name`)).status).toBe(
        200,
      );
      expect((await fetch(`${origin}/api/health?view=secret-token-value`)).status).toBe(200);
    } finally {
      await runtime.dispose();
    }
    const recorded = spans.map((span) => [span.name, Object.fromEntries(span.attributes)]);
    expect(JSON.stringify(recorded)).not.toContain("secret-token-value");
    expect(JSON.stringify(recorded)).not.toContain("secret-file-name");
    expect(recorded).toContainEqual([
      expect.any(String),
      expect.objectContaining({ "url.path": "/api/health", "url.query": "view=REDACTED" }),
    ]);
    expect(
      recorded.filter(([, attributes]) => JSON.stringify(attributes).includes(PAGE_VIEW_PATH)),
    ).toEqual([
      [
        expect.any(String),
        expect.objectContaining({
          "http.response.status_code": 404,
          "url.query": "view=REDACTED",
        }),
      ],
    ]);
  });
});

describe("the transcript route", () => {
  it("carries a page as its reference and no page call's HTML", async () => {
    const html = `<!doctype html><p>${"p99 ".repeat(1_000)}</p>`;
    const page = new PageRef({
      id: ids("shared-a").page,
      sessionId: ids("shared-a").session,
      title: "Latency",
      height: 420,
      publishedAt: new Date("2026-10-29T10:00:00.000Z"),
    });
    const api = await createTenancyApi(undefined, {
      implement: {
        engine: {
          launchUnderWay: () => false,
          transcript: () =>
            Effect.succeed({
              sourceHarness: "claude",
              events: [
                {
                  kind: "tool",
                  name: "mcp__mend__html_render",
                  args: JSON.stringify({ html, title: "Latency", height: 420 }),
                  argsFormat: "json",
                  output: JSON.stringify({ htmlRender: { attachmentId: page.id } }),
                  command: null,
                },
                { kind: "page", page },
              ],
            }),
        },
      },
    });
    try {
      const answer = await api.request(
        "alice",
        "GET",
        `/api/sessions/${ids("shared-a").session}/transcript`,
      );
      expect(answer.status).toBe(200);
      const body = await answer.text();
      expect(body).not.toContain("p99");
      expect(JSON.parse(body).events.map((event: { kind: string }) => event.kind)).toEqual([
        "tool",
        "page",
      ]);
    } finally {
      await api.dispose();
    }
  });
});
