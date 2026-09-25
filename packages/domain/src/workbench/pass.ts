import { Schema } from "effect";

import { ChangeId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/** Which machine pass over a change: tour composition, the record-grounded read, the suggestion pass. */
export const PassKind = Schema.Literals(["tour", "read", "suggest"]);
export type PassKind = typeof PassKind.Type;

/**
 * `queued` is written when the pass is enqueued and replaced when a worker begins it, so a pass
 * waiting behind others reads "queued", never a spinner that looks like work.
 */
export const PassStatus = Schema.Literals(["queued", "running", "completed", "failed"]);
export type PassStatus = typeof PassStatus.Type;

/**
 * The durable answer to "did Mend run over this change, and what came of
 * it". One row per (change, kind), replaced on each run. Status is a process
 * fact (queued · running · completed · failed), `findings` counts what the pass
 * drafted (null where the kind has no count — the tour), `detail` carries a
 * failure's own words. Zero findings on a completed pass is an outcome the
 * UI states out loud — silence and "nothing cleared the bar" must never
 * look the same.
 */
export class ChangePass extends Schema.Class<ChangePass>("ChangePass")({
  changeId: ChangeId,
  kind: PassKind,
  status: PassStatus,
  detail: Schema.NullOr(Schema.String),
  findings: Schema.NullOr(Schema.Int),
  /** When it began running; for a `queued` row, when it was queued. */
  startedAt: Timestamp,
  finishedAt: Schema.NullOr(Timestamp),
}) {}
