import { Schema } from "effect";

/** Remote bodies, query strings and credentials never enter a rendered failure. */
export class ExecutorFailure extends Schema.TaggedError<ExecutorFailure>()("ExecutorFailure", {
  kind: Schema.Literals(["refused", "unavailable", "invalid"]),
  message: Schema.String,
}) {}
