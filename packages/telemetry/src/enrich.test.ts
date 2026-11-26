import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { OtlpTracer } from "effect/observability";
import { describe, expect, it } from "vitest";

import { enrichSpan } from "./enrich.ts";
import { enabledTelemetryLayer } from "./layer.ts";
import { telemetrySettings } from "./settings.ts";
import { summarizeSql } from "./sql-summary.ts";
import { templatePath } from "./url-template.ts";

type Span = OtlpTracer.TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number];

const spanOf = (
  name: string,
  kind: number,
  attributes: Readonly<Record<string, string>>,
): Span => ({
  traceId: "0".repeat(31) + "1",
  spanId: "0".repeat(15) + "1",
  parentSpanId: undefined,
  name,
  kind,
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  attributes: Object.entries(attributes).map(([key, value]) => ({
    key,
    value: { stringValue: value },
  })),
  droppedAttributesCount: 0,
  events: [],
  droppedEventsCount: 0,
  status: { code: 1 },
  links: [],
  droppedLinksCount: 0,
});

const read = (span: Span): Readonly<Record<string, string | undefined>> => ({
  name: span.name,
  ...Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue])),
});

describe("a database span", () => {
  it("reads as the query with its lists folded, its system, operation and table", () => {
    const span = enrichSpan(
      spanOf("postgres", 3, {
        "db.system.name": "postgresql",
        "db.query.text": `select "id", "project_id", "harness", "model" from "agent_sessions" where "agent_sessions"."id" = $1 limit $2`,
      }),
    );
    expect(read(span)).toMatchObject({
      name: "SELECT agent_sessions",
      "sentry.op": "db.sql.query",
      "sentry.description": "select .. from agent_sessions where agent_sessions.id = $1 limit $2",
      "db.query.text": "select .. from agent_sessions where agent_sessions.id = $1 limit $2",
      "db.query.summary": "SELECT agent_sessions",
      "db.operation.name": "SELECT",
      "db.collection.name": "agent_sessions",
      "db.system.name": "postgresql",
    });
  });

  it("keeps its description when the query names a word Sentry's scrubber blanks", () => {
    // `user_git_author` holds "auth": Sentry would store this query's text as `[Filtered]`.
    const span = enrichSpan(
      spanOf("postgres", 3, {
        "db.system.name": "postgresql",
        "db.query.text": `select "name", "email" from "user_git_author" where "user_git_author"."user_id" = $1`,
      }),
    );
    expect(read(span)).toMatchObject({
      "sentry.description": "select .. from user_git_author where user_git_author.user_id = $1",
      "db.collection.name": "user_git_author",
    });
    expect(read(span)).not.toHaveProperty("db.query.text");
  });

  it.each([
    [
      `update "session_runs" set "last_seen_sequence" = $1, "updated_at" = $2 where "session_runs"."sealant_run_id" = $3`,
      "UPDATE session_runs",
      "update session_runs set .. where session_runs.sealant_run_id = $3",
    ],
    [
      `insert into "executor_calls" ("id", "tool") values ($1, $2), ($3, $4) on conflict ("id") do update set "tool" = excluded."tool", "id" = excluded."id" returning "id", "tool"`,
      "INSERT executor_calls",
      "insert into executor_calls (..) values (..) on conflict (id) do update set .. returning ..",
    ],
    [
      `delete from "session_inbox_marks" where "session_inbox_marks"."session_id" in ($1, $2, $3)`,
      "DELETE session_inbox_marks",
      "delete from session_inbox_marks where session_inbox_marks.session_id in (..)",
    ],
    [
      "\n  SELECT worktree_id, epoch::int AS epoch,\n         (expires_at > now()) AS live\n    FROM capture_leases WHERE worktree_id = $1",
      "SELECT capture_leases",
      "SELECT .. FROM capture_leases WHERE worktree_id = $1",
    ],
    [
      `with latest as (select "session_id", max("seq") as "seq" from "agent_items" group by "session_id") select "s"."id" from "agent_sessions" "s" join latest on latest.session_id = s.id`,
      "SELECT agent_sessions",
      "with latest as (select session_id, max(seq) as seq from agent_items group by session_id) select s.id from agent_sessions s join latest on latest.session_id = s.id",
    ],
    ["SELECT pg_notify($1, $2)", "SELECT pg_notify", "SELECT pg_notify($1, $2)"],
  ])("folds %s", (query, summary, text) => {
    expect(summarizeSql(query)).toMatchObject({ summary, text });
  });

  it("files a transaction as one", () => {
    const span = enrichSpan(spanOf("sql.transaction", 1, { "db.system.name": "postgresql" }));
    expect(read(span)).toMatchObject({
      name: "transaction",
      "sentry.op": "db.sql.transaction",
      "sentry.description": "transaction",
    });
  });
});

describe("an HTTP span", () => {
  it("names a server span for its route", () => {
    const span = enrichSpan(
      spanOf("GET", 2, { "http.request.method": "GET", "http.route": "/api/processes/:id/logs" }),
    );
    expect(read(span)).toMatchObject({
      name: "GET /api/processes/:id/logs",
      "sentry.op": "http.server",
      "sentry.description": "GET /api/processes/:id/logs",
    });
  });

  it("names a client span for its path with the IDs templated out, never its host or query", () => {
    const span = enrichSpan(
      spanOf("GET", 3, {
        "http.request.method": "GET",
        "url.full": "http://127.0.0.1:4000/v1/sessions/sess_dce91a8f2b3c4d5e/output?after=12",
      }),
    );
    expect(read(span)).toMatchObject({
      name: "GET /v1/sessions/:sessionId/output",
      "sentry.op": "http.client",
      "sentry.description": "GET /v1/sessions/:sessionId/output",
      "url.template": "/v1/sessions/:sessionId/output",
    });
  });

  it.each([
    [
      "/api/sessions/852bcfd6-bcde-45d8-970e-17161c13515c/messages",
      "/api/sessions/:sessionId/messages",
    ],
    [
      "/v1/workspaces/ws_01J9ZABCDEF/processes/42/logs",
      "/v1/workspaces/:workspaceId/processes/:processId/logs",
    ],
    ["/v1/harness-layouts/hl_9f8e7d6c5b4a/boxes", "/v1/harness-layouts/:harnessLayoutId/boxes"],
    ["/repos/o/r/commits/0123456789abcdef0123", "/repos/o/r/commits/:commitId"],
    ["/api/health", "/api/health"],
    ["/api/settings/git_access", "/api/settings/git_access"],
  ])("templates %s", (path, template) => {
    expect(templatePath(path)).toBe(template);
  });
});

describe("any other span", () => {
  it.each([
    ["SealantClients.forPrincipal", "mend.sealant.for_principal", "mend.sealant"],
    ["ProjectAccess.sessionAs", "mend.access.session_as", "mend.access"],
    ["SessionEngine.changingBoatKey.drain", "mend.session.changing_boat_key.drain", "mend.session"],
    ["BlobStore.listMultipart", "mend.store.list_multipart", "mend.store"],
    ["SlackReporter.look", "mend.slack.look", "mend.slack"],
  ])("names %s as %s, filed under %s, and keeps its own name", (name, renamed, op) => {
    expect(read(enrichSpan(spanOf(name, 1, {})))).toMatchObject({
      name: renamed,
      "sentry.op": op,
      "sentry.description": renamed,
      "code.function.name": name,
    });
  });

  it.each([
    ["mend.session.start", "mend.session"],
    ["mend.turn.dispatch", "mend.turn"],
    ["sealant.sdk.sessions.get_session_output", "mend.sealant"],
  ])("keeps %s, filed under %s", (name, op) => {
    expect(read(enrichSpan(spanOf(name, 1, {})))).toMatchObject({
      name,
      "sentry.op": op,
      "sentry.description": name,
    });
  });

  it("files a procedure of the web tier as a call it serves", () => {
    const span = enrichSpan(
      spanOf("mend.web.sessions.detail", 2, {
        "rpc.system": "trpc",
        "rpc.method": "sessions.detail",
      }),
    );
    expect(read(span)).toMatchObject({
      name: "mend.web.sessions.detail",
      "sentry.op": "rpc.server",
      "sentry.description": "mend.web.sessions.detail",
    });
  });

  it("files a job by its queue", () => {
    const span = enrichSpan(
      spanOf("mend.job.process", 5, {
        "messaging.system": "pg-boss",
        "messaging.destination.name": "session-start",
      }),
    );
    expect(read(span)).toMatchObject({
      name: "mend.job.process",
      "sentry.op": "queue.process",
      "sentry.description": "session-start",
    });
  });

  it("keeps an operation the span already names", () => {
    const span = enrichSpan(spanOf("mend.web.message.send", 1, { "sentry.op": "mend.action" }));
    expect(read(span)["sentry.op"]).toBe("mend.action");
  });
});

describe("the spans that reach Sentry", () => {
  it("hang a wrapper library span's child off the span above it", async () => {
    const settings = telemetrySettings({
      SENTRY_DSN: "https://0123456789abcdef0123456789abcdef@sentry.example.test/3",
    });
    if (settings === null) throw new Error("expected settings");
    const bodies: Array<string> = [];
    const client = HttpClient.make((request) => {
      if (request.body._tag === "Uint8Array")
        bodies.push(new TextDecoder().decode(request.body.body));
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
    });
    await Effect.runPromise(
      Effect.withSpan(Effect.void, "mend.test.query")
        .pipe(Effect.withSpan("drizzle.operation"), Effect.withSpan("mend.test.insert"))
        .pipe(
          Effect.provide(
            enabledTelemetryLayer(
              settings,
              { name: "mend-test" },
              {
                otlp: Layer.succeed(HttpClient.HttpClient, client),
              },
            ),
          ),
          Effect.scoped,
        ),
    );
    const spans: ReadonlyArray<Span> = bodies
      .filter((body) => body.includes("resourceSpans"))
      .flatMap((body) => JSON.parse(body).resourceSpans[0].scopeSpans[0].spans);
    const names = spans.map((span) => span.name);
    expect(names).not.toContain("drizzle.operation");
    const insert = spans.find((span) => span.name === "mend.test.insert");
    const query = spans.find((span) => span.name === "mend.test.query");
    expect(query?.parentSpanId).toBe(insert?.spanId);
  });
});
