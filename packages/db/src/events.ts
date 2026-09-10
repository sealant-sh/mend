import type { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";

/**
 * One NOTIFY channel carries every domain change; the SSE endpoint and the
 * dispatcher wake on it instead of tight-polling. Payloads are small pointers
 * ("something about this issue/run changed") — clients re-read state through
 * the API, they never trust the payload as data.
 */
export const MEND_EVENTS_CHANNEL = "mend_events";

export const MendEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["issue"]),
    issueId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["run"]),
    runId: Schema.String,
    issueId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["run-progress"]),
    runId: Schema.String,
    issueId: Schema.String,
    sequence: Schema.String,
    line: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["brief"]),
    changeId: Schema.String,
    issueId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["brief-comment"]),
    briefId: Schema.String,
    issueId: Schema.String,
  }),
  // ── Workbench events (plan §9.4) — same pointer discipline as above. ──
  Schema.Struct({
    type: Schema.Literals(["project"]),
    projectId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["session"]),
    sessionId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["session-progress"]),
    sessionId: Schema.String,
    projectId: Schema.String,
    sequence: Schema.String,
    line: Schema.String,
  }),
  Schema.Struct({
    // A workspace process changed: created, status flip, port bound, ended.
    type: Schema.Literals(["session-process"]),
    sessionId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    // A protocol turn, item, or request changed; clients re-read by cursor.
    type: Schema.Literals(["agent-conversation"]),
    sessionId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    // The container changed: created, renamed, removed, session membership moved.
    type: Schema.Literals(["worktree"]),
    worktreeId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["session-change"]),
    changeId: Schema.String,
    worktreeId: Schema.String,
    /** The contributing session (the change's mirror); kept while clients migrate. */
    sessionId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["review-comment"]),
    commentId: Schema.String,
    changeId: Schema.String,
    worktreeId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    // One account's own facts changed — connected accounts, paired devices and CLI
    // sign-ins, the git access choice or key. The first-run checklist and Settings
    // re-read the facet; nothing project-scoped moves.
    type: Schema.Literals(["user"]),
    userId: Schema.String,
    facet: Schema.Literals(["accounts", "devices", "git-access"]),
  }),
]);
export type MendEvent = typeof MendEvent.Type;

const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(MendEvent));

export const notifyEvent = (sql: PgClient.PgClient, event: MendEvent) =>
  Effect.gen(function* () {
    const payload = yield* encodeEvent(event).pipe(Effect.orDie);
    yield* sql.notify(MEND_EVENTS_CHANNEL, payload).pipe(Effect.orDie);
  });
