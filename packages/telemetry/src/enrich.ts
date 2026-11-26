import type { OtlpResource, OtlpSerialization, OtlpTracer } from "effect/observability";

import { summarizeSql } from "./sql-summary.ts";
import { pathOf, templatePath } from "./url-template.ts";

/**
 * How Mend's spans read in Sentry (SLNT-1375). Sentry files an OTLP span under the operation in
 * its `sentry.op` attribute, else one it infers from a handful of OTel attributes
 * (`http.request.method`, `db.system.name`, `messaging.system`, `rpc.service`), else `default`;
 * and shows the description in `sentry.description`, else one it builds from those attributes,
 * else nothing. Effect's own spans (`Effect.fn`, `withSpan`) carry none of that, so this gives each
 * span the operation, the description and the name a person scanning a trace wants:
 *
 * - an HTTP server span: `GET /api/sessions/:id`, from its route template;
 * - an HTTP client span: `GET /v1/sessions/:sessionId/output`, the path with its IDs templated
 *   out, never the host, a port or the query;
 * - a database span: `select .. from agent_sessions where agent_sessions.id = $1 limit $2`, with
 *   its system, operation and table;
 * - a queue span: the queue's name, as `queue.publish` or `queue.process`;
 * - a procedure of the web tier: `rpc.server — sessions.sendMessage`, its tRPC path;
 * - anything else: a name of `<product>.<area>.<operation>` (an `Effect.fn("SessionEngine.start")`
 *   becomes `mend.session.start`, and keeps its own name in `code.function.name`), filed under
 *   `<product>.<area>` and described in plain words that never repeat it: Sentry shows
 *   `mend.session — launch session`, not `mend.session — mend.session.launch` (`PHRASES`).
 *
 * It runs on the spans as Effect made them, before `scrub.ts` scrubs everything it wrote.
 */

type KeyValue = OtlpResource.KeyValue;
type Span = OtlpTracer.TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number];

/** OTLP's span kinds, as Effect's exporter numbers them. */
const KIND = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const;

/**
 * The words Sentry's default scrubber (Relay's `@password:filter`) looks for in an attribute it
 * scrubs, `db.query.text` among them, replacing the whole value with `[Filtered]` when one
 * appears: so a query that names a column such as `author` or `git_auth_kind` loses its text.
 * `sentry.description` is not one it scrubs, so the description keeps the query; the attribute is
 * left out instead of arriving blank.
 */
const SENTRY_FILTERED =
  /password|secret|passwd|api[-_]key|apikey|auth|credentials|mysql_pwd|privatekey|private[-_]key|token\S*[:=]/i;

const stringOf = (attributes: ReadonlyArray<KeyValue>, key: string): string | undefined => {
  for (const attribute of attributes) {
    if (attribute.key === key) {
      const value = attribute.value;
      if (typeof value.stringValue === "string") return value.stringValue;
      if (value.intValue !== undefined) return String(value.intValue);
      return undefined;
    }
  }
  return undefined;
};

const has = (attributes: ReadonlyArray<KeyValue>, key: string): boolean =>
  attributes.some((attribute) => attribute.key === key);

/** `attributes` with each of `set` in place of any attribute of the same key. */
const withAttributes = (
  attributes: ReadonlyArray<KeyValue>,
  set: Readonly<Record<string, string | undefined>>,
  drop: ReadonlyArray<string> = [],
): Array<KeyValue> => {
  const written = Object.entries(set).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const replaced = new Set([...written.map(([key]) => key), ...drop]);
  return [
    ...attributes.filter((attribute) => !replaced.has(attribute.key)),
    ...written.map(([key, value]) => ({ key, value: { stringValue: value } })),
  ];
};

// --- Names ----------------------------------------------------------------------------------

/**
 * The area each of Mend's services works in, for the services whose names do not say it: the
 * second word of `mend.<area>.<operation>`. A service not listed takes the area its name starts
 * with (`AREA_BY_PREFIX`), and otherwise its own name.
 */
const AREA_BY_SERVICE: Readonly<Record<string, string>> = {
  Auth: "auth",
  MendKeys: "auth",
  DevicesRepo: "auth",
  ProjectAccess: "access",
  SourcePolicy: "access",
  AccessPoliciesRepo: "access",
  SealantIdentityStore: "sealant",
  PersonLayoutPlatform: "sealant",
  WorkspaceRuntimesReport: "sealant",
  ExecutorSockets: "executor",
  HarnessLayoutSteps: "session",
  ProtocolHost: "session",
  ProtocolIdleStop: "session",
  TerminalIdleStop: "session",
  QueuedSessions: "session",
  RunStarter: "session",
  ReviewPrep: "session",
  CaptureRetention: "session",
  CaptureSeals: "session",
  AgentBridge: "session",
  CodexAdapter: "session",
  Removal: "session",
  AdoptionSkills: "session",
  JobRunner: "job",
  Dispatcher: "job",
  SshKeyRevoker: "job",
  Store: "store",
  BlobStore: "store",
  GitOpsRunner: "store",
  GitRemote: "store",
  DotfilesStore: "store",
  ProjectCreation: "project",
  ProjectOperations: "project",
  Resources: "resource",
  ResourceRuntime: "resource",
  ResourceStatusReads: "resource",
  ResourceTableReads: "resource",
  PreviewPreparation: "preview",
  Landing: "landing",
  AutomaticLanding: "landing",
  InferenceProvider: "inference",
  SecretCipher: "crypto",
  UserEvents: "user",
  Migrator: "db",
  PgDrizzle: "db",
  MendClient: "gateway",
};

const AREA_BY_PREFIX: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Sealant/, "sealant"],
  [/^(?:Session|Harness|Turn)/, "session"],
  [/^Slack/, "slack"],
  [/^(?:Project|Worktree)/, "project"],
  [/^(?:Capture|Checkpoint)/, "session"],
  [/^Inference/, "inference"],
  [/^Mcp/, "mcp"],
];

const snake = (word: string): string =>
  word
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9.]+/g, "_")
    .toLowerCase();

const areaOf = (service: string): string =>
  AREA_BY_SERVICE[service] ??
  AREA_BY_PREFIX.find(([pattern]) => pattern.test(service))?.[1] ??
  snake(service.replace(/(?:Repo|Store|Service|Live)$/, ""));

/** `Service.method`, the way `Effect.fn` spans are named; `SessionEngine.changingBoatKey.drain`. */
const SERVICE_METHOD = /^([A-Z][A-Za-z0-9]*)[. ]([A-Za-z][\w./]*)$/;
/** Already `<product>.<area>.<operation>`, lower-case words. */
const DOTTED = /^[a-z][a-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
/** A bare function's name: `ensureCaptureCache`. */
const FUNCTION = /^[a-z][A-Za-z0-9]*$/;

/**
 * Spans named for a different area than their service's: a protocol host's turns are a turn's
 * steps (`mend.turn — send turn input`), not the session's.
 */
const RENAMED: Readonly<Record<string, string>> = {
  "ProtocolHost.sendMessage": "mend.turn.input",
  "ProtocolHost.submitTurn": "mend.turn.submit",
  "ProtocolHost.interruptTurn": "mend.turn.interrupt",
  "ProtocolHost.respondRequest": "mend.turn.respond",
  "ProtocolHost.steerTurn": "mend.turn.steer",
  "ProtocolHost.sendSteer": "mend.turn.steer",
  "ProtocolHost.deliverSteer": "mend.turn.deliver_steer",
};

interface Named {
  readonly name: string;
  readonly op: string;
  readonly codeName?: string | undefined;
}

/** The operation a `<product>.<area>.<operation>` name files under. */
const opOfDotted = (name: string): string => {
  if (name.startsWith("sealant.sdk.")) return "mend.sealant";
  if (name.startsWith("mend.web.")) return "mend.web";
  const [product, area] = name.split(".");
  return area === undefined ? (product ?? name) : `${product}.${area}`;
};

const nameOf = (name: string): Named => {
  const renamed = RENAMED[name];
  if (renamed !== undefined) return { name: renamed, op: opOfDotted(renamed), codeName: name };
  if (DOTTED.test(name)) return { name, op: opOfDotted(name) };
  if (name.startsWith("Migrator "))
    return { name: "mend.db.migrate", op: "db.migrate", codeName: name };
  const serviceMethod = SERVICE_METHOD.exec(name);
  if (serviceMethod !== null) {
    const [, service = "", method = ""] = serviceMethod;
    const area = areaOf(service);
    const operation = method
      .split(/[./]/)
      .filter((part) => part !== "")
      .map(snake)
      .join(".");
    return { name: `mend.${area}.${operation}`, op: `mend.${area}`, codeName: name };
  }
  if (FUNCTION.test(name)) return { name: `mend.${snake(name)}`, op: "function", codeName: name };
  return { name, op: "function" };
};

// --- Phrases --------------------------------------------------------------------------------

/**
 * What a person reads for the spans a trace is made of, by name: Sentry shows `<op> — <this>`, so
 * none repeats its operation. A name not listed reads as its own words (`phraseOf`).
 */
const PHRASES: Readonly<Record<string, string>> = {
  // Who is asking, and may they
  "mend.auth.get_session": "authenticate request",
  "mend.auth.access_key_session": "authenticate access key",
  "mend.access.session_as": "authorize session",
  "mend.access.session_as_member": "authorize session",
  "mend.access.session_view": "authorize session",
  "mend.access.project_as": "authorize project",
  "mend.access.manage_project": "authorize project management",
  "mend.access.worktree": "authorize worktree",
  "mend.access.change": "authorize change",
  "mend.access.require_owner": "authorize owner",
  "mend.access.require_operator": "authorize operator",
  "mend.access.visible_projects_of": "list visible projects",
  // A session's life
  "mend.session.start": "start session",
  "mend.session.create_as": "create session",
  "mend.session.create_in_worktree_as": "create session",
  "mend.session.launch": "launch session",
  "mend.session.provision": "create worktree",
  "mend.session.create_worktree_in": "create worktree",
  "mend.session.provision_workspace": "provision workspace",
  "mend.session.prepare_executor": "prepare workspace",
  "mend.session.supervise": "supervise session",
  "mend.session.run_drain": "wind down session",
  "mend.session.end_agent_process": "end agent process",
  "mend.session.terminate_workspace": "terminate workspace",
  "mend.session.stop": "stop session",
  "mend.session.stop_session": "stop session and workspace",
  "mend.session.resume": "resume sessions",
  "mend.session.resume_session": "resume session",
  "mend.session.reconcile_session": "reconcile session",
  "mend.session.classify_unclassified_sessions": "classify restart transcripts",
  "mend.session.switch_mode": "switch mode",
  "mend.session.launch_follow_up": "launch follow-up",
  // What a session keeps
  "mend.session.take_checkpoint": "save checkpoint",
  "mend.session.checkpoint_now": "save checkpoint",
  "mend.session.landing_checkpoint": "save landing checkpoint",
  "mend.session.take_worktree_snapshot": "snapshot worktree",
  "mend.session.observe_capture_flush": "flush capture",
  "mend.session.flush_captures": "flush captures",
  // A turn
  "mend.turn.dispatch": "dispatch turn",
  "mend.turn.input": "send turn input",
  "mend.turn.submit": "submit turn",
  "mend.turn.run": "run turn",
  "mend.turn.first_output": "first agent output",
  "mend.turn.complete": "complete turn",
  "mend.turn.interrupt": "interrupt turn",
  "mend.turn.respond": "answer agent request",
  "mend.turn.steer": "steer turn",
  // Calls to sealant
  "mend.sealant.create_workspace": "create workspace",
  "mend.sealant.find_workspace_by_key": "find workspace",
  "mend.sealant.get_workspace": "read workspace",
  "mend.sealant.expire_workspace": "set workspace expiry",
  "mend.sealant.stop_workspace": "stop workspace",
  "mend.sealant.open_session": "open session",
  "mend.sealant.get_session": "read session",
  "mend.sealant.session_output": "read session output",
  "mend.sealant.get_run": "read run",
  "mend.sealant.wait_run": "wait for run",
  "mend.sealant.run_changes": "read run changes",
  "mend.sealant.record_commands": "read command record",
  "mend.sealant.record_scrollback": "read scrollback",
  "mend.sealant.capture_status": "read capture status",
  "mend.sealant.open_forward": "open port forward",
  "mend.sealant.connection_check": "check connection",
  "mend.sealant.connect": "connect account",
  "mend.sealant.inspect_image": "inspect image",
  // Background work and jobs
  "mend.job.work": "listen for jobs",
  "mend.job.process": "process job",
  "mend.db.migrate": "migrate database",
};

/** `snake_case.words` as words: `deliver_skills_to_workspace` reads `deliver skills to workspace`. */
const words = (name: string): string => name.replace(/[._]+/g, " ").trim();

/**
 * The words for `name` filed under `op`: its phrase, else the name less the operation it repeats
 * (`mend.session.deliver_skills_to_workspace` under `mend.session` reads `deliver skills to
 * workspace`), less the SDK's `sealant.sdk.<group>.`, or less `mend.` for a bare function.
 */
const phraseOf = (name: string, op: string): string => {
  const phrase = PHRASES[name];
  if (phrase !== undefined) return phrase;
  const rest = name.startsWith(`${op}.`)
    ? name.slice(op.length + 1)
    : name.startsWith("sealant.sdk.")
      ? name.split(".").slice(3).join(".")
      : name.replace(/^(?:mend|sealant)\./, "");
  return words(rest) || words(name);
};

// --- Spans ----------------------------------------------------------------------------------

interface Enriched {
  readonly name: string;
  readonly set: Readonly<Record<string, string | undefined>>;
  readonly drop?: ReadonlyArray<string>;
}

const httpServer = (span: Span, method: string): Enriched => {
  const route = stringOf(span.attributes, "http.route") ?? "unrouted";
  const description = `${method} ${route}`;
  return {
    name: description,
    set: { "sentry.op": "http.server", "sentry.description": description },
  };
};

const httpClient = (span: Span, method: string): Enriched => {
  const path =
    pathOf(stringOf(span.attributes, "url.full")) ?? stringOf(span.attributes, "url.path");
  const template = path === undefined ? undefined : templatePath(path);
  const description = template === undefined ? method : `${method} ${template}`;
  return {
    name: description,
    set: {
      "sentry.op": "http.client",
      "sentry.description": description,
      "url.template": template,
    },
  };
};

/** Mend's databases are all SQL (Postgres, through Effect's SQL client). */
const database = (span: Span): Enriched => {
  if (span.name === "sql.transaction")
    return {
      name: "transaction",
      set: { "sentry.op": "db.sql.transaction", "sentry.description": "transaction" },
    };
  const query = stringOf(span.attributes, "db.query.text");
  if (query === undefined)
    return { name: span.name, set: { "sentry.op": "db", "sentry.description": span.name } };
  const { operation, collection, summary, text } = summarizeSql(query);
  const filtered = SENTRY_FILTERED.test(text);
  return {
    name: summary,
    set: {
      "sentry.op": "db.sql.query",
      "sentry.description": text,
      "db.query.summary": summary,
      "db.operation.name": operation,
      "db.collection.name": collection,
      "db.query.text": filtered ? undefined : text,
    },
    drop: filtered ? ["db.query.text"] : [],
  };
};

const messaging = (span: Span): Enriched => {
  const queue = stringOf(span.attributes, "messaging.destination.name");
  const named = nameOf(span.name);
  const op =
    span.kind === KIND.producer
      ? "queue.publish"
      : span.kind === KIND.consumer
        ? "queue.process"
        : named.op;
  return {
    name: named.name,
    set: { "sentry.op": op, "sentry.description": queue ?? phraseOf(named.name, named.op) },
  };
};

/** A procedure by its method, `sessions.sendMessage`, not the span's `mend.web.` name. */
const rpc = (span: Span): Enriched => {
  const named = nameOf(span.name);
  const op =
    span.kind === KIND.server ? "rpc.server" : span.kind === KIND.client ? "rpc.client" : named.op;
  return {
    name: named.name,
    set: {
      "sentry.op": op,
      "sentry.description":
        stringOf(span.attributes, "rpc.method") ?? phraseOf(named.name, named.op),
      "code.function.name": named.codeName,
    },
  };
};

const internal = (span: Span): Enriched => {
  const named = nameOf(span.name);
  return {
    name: named.name,
    set: {
      "sentry.op": named.op,
      "sentry.description": phraseOf(named.name, named.op),
      "code.function.name": named.codeName,
    },
  };
};

const enrichmentOf = (span: Span): Enriched => {
  const method = stringOf(span.attributes, "http.request.method");
  if (method !== undefined && span.kind === KIND.server) return httpServer(span, method);
  if (method !== undefined) return httpClient(span, method);
  if (has(span.attributes, "db.system.name")) return database(span);
  if (has(span.attributes, "messaging.system")) return messaging(span);
  if (has(span.attributes, "rpc.system") || has(span.attributes, "rpc.system.name"))
    return rpc(span);
  return internal(span);
};

/** `span` with the operation, description and name Sentry shows; one it already has is kept. */
export const enrichSpan = (span: Span): Span => {
  const enriched = enrichmentOf(span);
  const set = has(span.attributes, "sentry.op")
    ? { ...enriched.set, "sentry.op": undefined }
    : enriched.set;
  return {
    ...span,
    name: enriched.name,
    attributes: withAttributes(span.attributes, set, enriched.drop),
  };
};

/**
 * A query no span ran under: work outside any request, job or background pass. Alone it says
 * nothing about why it ran, and each one would be a root trace of its own in Sentry.
 */
const isOrphanQuery = (span: Span): boolean =>
  (span.parentSpanId === undefined || span.parentSpanId === "") &&
  has(span.attributes, "db.system.name");

export const enrichTraces = (data: OtlpTracer.TraceData): OtlpTracer.TraceData => ({
  resourceSpans: data.resourceSpans.map((resource) => ({
    ...resource,
    scopeSpans: resource.scopeSpans.map((scope) => ({
      ...scope,
      spans: scope.spans.filter((span) => !isOrphanQuery(span)).map(enrichSpan),
    })),
  })),
});

/** `inner`, handed traces with the operation, description and name each span reads by. */
export const enrichingSerialization = (
  inner: OtlpSerialization.OtlpSerialization["Service"],
): OtlpSerialization.OtlpSerialization["Service"] => ({
  ...inner,
  traces: (data) => inner.traces(enrichTraces(data)),
});
