import { Effect, Schema } from "effect";

export const DesktopPilotRequest = Schema.Struct({
  harness: Schema.Literals(["claude", "codex"]),
  mode: Schema.Literals(["actions", "code"]),
  model: Schema.String,
  goal: Schema.String,
});

/** A desktop interaction recorded by the terminal agent or a separate pilot. */
export const DesktopPilotRun = Schema.Struct({
  id: Schema.String,
  source: Schema.optionalKey(Schema.Literals(["terminal", "pilot"])),
  sessionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  harness: Schema.Literals(["claude", "codex"]),
  mode: Schema.Literals(["actions", "code"]),
  model: Schema.String,
  goal: Schema.String,
  status: Schema.Literals([
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "timed-out",
  ]),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  result: Schema.String,
  actions: Schema.Number,
});

/** Live controller state or the last captured desktop observations. */
export const DesktopState = Schema.Struct({
  live: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  active: Schema.NullOr(DesktopPilotRun),
  humanControl: Schema.Boolean,
  runs: Schema.Array(DesktopPilotRun),
  display: Schema.String,
});
