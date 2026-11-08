import type { TimelineEntry } from "@sealant/sdk";
import { Effect, Option, Schema } from "effect";

import { InferenceToolError } from "./provider.ts";
import { RecordingEvent } from "./tools.ts";

const decodeEvent = Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(RecordingEvent.fields)));
const parseDate = Schema.decodeUnknownOption(Schema.DateFromString);

/** Translate the public SDK's timeline clock and decode external entries without throwing. */
export const parseRecordingEvent = (
  entry: TimelineEntry,
): Effect.Effect<RecordingEvent, InferenceToolError> => {
  // Core's timeline occurredAt is a decimal-string monotonic timestamp, not epoch time.
  // Preserve older wall-clock strings, but never let Date.parse turn a short counter into a year.
  const monotonic = typeof entry.occurredAt === "string" && /^\d+$/.test(entry.occurredAt);
  return decodeEvent({
    sequence: entry.sequence,
    kind: entry.kind,
    occurredAt: monotonic ? null : Option.getOrNull(parseDate(entry.occurredAt)),
    ...(monotonic ? { monotonicTimestamp: entry.occurredAt } : {}),
    summary: entry.summary,
    provenance: "observed",
    data: entry.data,
  }).pipe(
    Effect.map((decoded) => new RecordingEvent(decoded)),
    Effect.mapError(
      () =>
        new InferenceToolError({
          tool: "read_recording",
          message: "the record contains an invalid timeline entry",
        }),
    ),
  );
};
