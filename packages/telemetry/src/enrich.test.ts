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
      name: "mend.db.transaction",
      "sentry.op": "db.sql.transaction",
      "sentry.description": "database transaction",
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

  it("names a server span no route matched for its path, templated, and drops the path", () => {
    const span = read(
      enrichSpan(
        spanOf("GET", 2, {
          "http.request.method": "GET",
          "http.route": "unrouted",
          "url.path": "/api/me/cli-auth/57TX-M9HG",
        }),
      ),
    );
    expect(span).toMatchObject({
      name: "GET /api/me/cli-auth/:code",
      "sentry.description": "GET /api/me/cli-auth/:code",
      "http.route": "/api/me/cli-auth/:code",
    });
    expect(span).not.toHaveProperty("url.path");
    expect(
      read(
        enrichSpan(spanOf("POST", 2, { "http.request.method": "POST", "http.route": "unrouted" })),
      ).name,
    ).toBe("POST /*");
  });

  it("names a client call to Mend's API for the route it matches", () => {
    const named = (path: string) =>
      read(
        enrichSpan(
          spanOf("GET", 3, {
            "http.request.method": "GET",
            "url.full": `http://127.0.0.1:3100${path}`,
          }),
        ),
      ).name;
    expect(named("/api/me/cli-auth/VWMC-T7PJ")).toBe("GET /api/me/cli-auth/:code");
    expect(named("/api/me/cli-auth/ABCD-EFGH/approve")).toBe("GET /api/me/cli-auth/:code/approve");
    expect(
      named("/api/projects/0b6d2c1e-6a43-4a35-8f55-5f2a4f1d9c2e/resources/postgres/start"),
    ).toBe("GET /api/projects/:id/resources/:name/start");
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
    ["/api/me/cli-auth/ABCD-EFGH", "/api/me/cli-auth/:secret"],
    ["/join/Zq8mJx2vNc4tPr6s", "/join/:secret"],
    ["/v1/projects/p/resources/vdb3jti/start", "/v1/projects/p/resources/:resourceId/start"],
    ["/v2/hosts/10.0.0.4/health", "/v2/hosts/:hostId/health"],
  ])("templates %s", (path, template) => {
    expect(templatePath(path)).toBe(template);
  });
});

describe("any other span", () => {
  it.each([
    [
      "SessionEngine.installDependenciesIfNeeded",
      "mend.workspace.install_dependencies",
      "mend.workspace",
      "install workspace dependencies",
    ],
    [
      "ProjectAccess.sessionAs",
      "mend.access.authorize_session",
      "mend.access",
      "authorize session",
    ],
    [
      "ProjectAccess.sessionView",
      "mend.access.authorize_session_view",
      "mend.access",
      "authorize session view",
    ],
    ["Auth.getSession", "mend.auth.authenticate_request", "mend.auth", "authenticate request"],
    [
      "SessionEngine.changingBoatKey.drain",
      "mend.workspace.drain_boat_standbys",
      "mend.workspace",
      "drain standbys for key change",
    ],
    [
      "observeLandings",
      "mend.landing.observe_state",
      "mend.landing",
      "observe change landing state",
    ],
    [
      "ProtocolHost.sendMessage",
      "mend.turn.send_message",
      "mend.turn",
      "send conversation message",
    ],
  ])(
    "names %s as %s, filed under %s, reads %s, and keeps its own name",
    (name, renamed, op, description) => {
      expect(read(enrichSpan(spanOf(name, 1, {})))).toMatchObject({
        name: renamed,
        "sentry.op": op,
        "sentry.description": description,
        "code.function.name": name,
      });
    },
  );

  it.each([
    ["mend.session.launch", "mend.session", "launch session"],
    ["mend.session.start", "mend.session", "create and launch session"],
    ["mend.turn.dispatch", "mend.turn", "dispatch turn"],
    ["mend.turn.complete", "mend.turn", "complete turn"],
    ["sealant.sdk.sessions.get_session_output", "mend.sealant", "get session output"],
  ])("keeps %s, filed under %s, reading %s", (name, op, description) => {
    expect(read(enrichSpan(spanOf(name, 1, {})))).toMatchObject({
      name,
      "sentry.op": op,
      "sentry.description": description,
    });
  });

  it("names a span the catalog does not hold for its service and method", () => {
    expect(read(enrichSpan(spanOf("WidgetRepo.listOpen", 1, {})))).toMatchObject({
      name: "mend.widget.list_open",
      "sentry.op": "mend.widget",
      "sentry.description": "list open",
      "code.function.name": "WidgetRepo.listOpen",
    });
  });

  it("never describes a span with the operation it is filed under", () => {
    const names = [
      "SessionSteering.session",
      "SessionEngine.launchInternal",
      "ProjectAccess.sessionAs",
      "mend.session.session",
      "Migrator up",
      "ensureCaptureCache",
      "mend.web.message.send",
    ];
    for (const name of names) {
      const span = read(enrichSpan(spanOf(name, 1, {})));
      expect(span["sentry.description"]).not.toBe("");
      expect(span["sentry.description"]).not.toMatch(/^(?:mend|sealant)\./);
      expect(span["sentry.description"]?.startsWith(`${span["sentry.op"]}.`)).toBe(false);
    }
  });

  it("describes a procedure of the web tier by its method", () => {
    const span = enrichSpan(
      spanOf("mend.web.sessions.sendMessage", 2, {
        "rpc.system": "trpc",
        "rpc.method": "sessions.sendMessage",
      }),
    );
    expect(read(span)).toMatchObject({
      name: "mend.web.sessions.send_message",
      "sentry.op": "rpc.server",
      "sentry.description": "sessions.sendMessage",
    });
  });

  it("files a job by its queue, as it is published and as it is processed", () => {
    const attributes = {
      "messaging.system": "pg-boss",
      "messaging.destination.name": "session-start",
    };
    expect(read(enrichSpan(spanOf("JobRunner.enqueue", 4, attributes)))).toMatchObject({
      name: "mend.job.enqueue",
      "sentry.op": "queue.publish",
      "sentry.description": "session-start",
    });
    expect(read(enrichSpan(spanOf("mend.job.process", 5, attributes)))).toMatchObject({
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

/** The spans `effect` hands the OTLP transport, through the telemetry layer a process runs. */
const exported = async (effect: Effect.Effect<void>): Promise<ReadonlyArray<Span>> => {
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
    effect.pipe(
      Effect.provide(
        enabledTelemetryLayer(
          settings,
          { name: "mend-test" },
          { otlp: Layer.succeed(HttpClient.HttpClient, client) },
        ),
      ),
      Effect.scoped,
    ),
  );
  return bodies
    .filter((body) => body.includes("resourceSpans"))
    .flatMap((body) => JSON.parse(body).resourceSpans[0].scopeSpans[0].spans);
};

/** A database query, as Effect's SQL client spans one. */
const sqlQuery = (name: string) =>
  Effect.withSpan(Effect.void, name, {
    kind: "client",
    attributes: { "db.system.name": "postgresql", "db.query.text": "select 1" },
  });

describe("the spans that reach Sentry", () => {
  it("hang a wrapper library span's child off the span above it", async () => {
    const spans = await exported(
      Effect.withSpan(Effect.void, "mend.test.query").pipe(
        Effect.withSpan("drizzle.operation"),
        Effect.withSpan("mend.test.insert"),
      ),
    );
    const names = spans.map((span) => span.name);
    expect(names).not.toContain("drizzle.operation");
    const insert = spans.find((span) => span.name === "mend.test.insert");
    const query = spans.find((span) => span.name === "mend.test.query");
    expect(query?.parentSpanId).toBe(insert?.spanId);
  });

  it("leave out a query that ran under no span, and keep one that did", async () => {
    const spans = await exported(
      Effect.andThen(
        sqlQuery("orphan"),
        sqlQuery("child").pipe(Effect.withSpan("mend.test.parent")),
      ),
    );
    expect(
      spans.filter((span) => span.parentSpanId === undefined).map((span) => span.name),
    ).toEqual(["mend.test.parent"]);
    expect(spans).toHaveLength(2);
  });

  it("fold the sealant SDK's span into the Mend call that made it, with its IDs", async () => {
    const spans = await exported(
      Effect.withSpan(Effect.void, "GET", { kind: "client" }).pipe(
        Effect.withSpan("sealant.sdk.workspaces.get_workspace", {
          kind: "client",
          // What sealant's SDK (0.40.0-next.951) says of its own span: the call keeps its own.
          attributes: {
            "sealant.workspace_id": "ws_1",
            "sentry.op": "sealant.sdk",
            "sentry.description": "get workspace",
            "code.function.name": "sealant.sdk.workspaces.get_workspace",
          },
        }),
        Effect.withSpan("SealantClient.getWorkspace"),
      ),
    );
    expect(spans.map((span) => span.name)).not.toContain("sealant.sdk.workspaces.get_workspace");
    const call = spans.find((span) => span.name === "mend.sealant.read_workspace");
    const request = spans.find((span) => span.name === "GET");
    expect(request?.parentSpanId).toBe(call?.spanId);
    expect(call?.attributes).toContainEqual({
      key: "sealant.workspace_id",
      value: { stringValue: "ws_1" },
    });
    const value = (key: string) =>
      call?.attributes.find((attribute) => attribute.key === key)?.value;
    expect(value("sentry.op")).toEqual({ stringValue: "mend.sealant" });
    expect(value("sentry.description")).toEqual({ stringValue: "read sealant workspace" });
    expect(value("code.function.name")).toEqual({ stringValue: "SealantClient.getWorkspace" });
  });
});
