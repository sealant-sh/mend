import { Schema } from "effect";

import { InferenceCallId } from "./ids.ts";
import { Timestamp } from "./timestamp.ts";

/**
 * Interface-side inference deliberately has no product noun — Mend uses
 * inference. Contexts name where it runs; each context is given only the tools
 * it needs, never the full set by default.
 */
export const InferenceContext = Schema.Literals([
  "brief-compilation",
  "run-summary",
  "failure-comment",
  "comment-routing",
  "run-audit-qa",
  // "Mend reads the change" (plan §7.3) — the workbench machine review pass.
  "change-reading",
  // The composed review tour — same reading, guided-walkthrough output.
  "change-tour",
  // The suggestion pass — same reading, concrete replacement proposals.
  "change-suggesting",
  // The session auto-namer — a label from the session's first prompt.
  "session-naming",
  // Slack (docs/adr/0006-slack.md): which project a thread is about, when nothing names one.
  "slack-project",
  // Landing (docs/adr/0007-landing.md): whether a turn's request asked for a change or a question.
  "request-intent",
]);
export type InferenceContext = typeof InferenceContext.Type;

/** The closed first-party tool set from PRODUCT.md. Enforced by omission. */
export const InferenceToolName = Schema.Literals([
  "read_recording",
  "read_issue",
  "read_change",
  "read_brief",
  "post_issue_comment",
  "reply_on_brief",
  "start_run",
  "publish_brief",
  // change-reading: one draft review comment per call, evidence enforced.
  "draft_finding",
  // change-suggesting: one draft suggestion per call, precision enforced.
  "draft_suggestion",
  // The harness process's actual output — where TUI-session work is visible
  // (the timeline stores PTY payloads content-addressed, not readable).
  "read_terminal",
]);
export type InferenceToolName = typeof InferenceToolName.Type;

/** One audited tool call or model exchange — the interface-inference audit trail. */
export class InferenceCall extends Schema.Class<InferenceCall>("InferenceCall")({
  id: InferenceCallId,
  context: InferenceContext,
  /** Null for the model exchange itself; set for each tool call inside the loop. */
  tool: Schema.NullOr(InferenceToolName),
  input: Schema.Unknown,
  output: Schema.Unknown,
  occurredAt: Timestamp,
}) {}
