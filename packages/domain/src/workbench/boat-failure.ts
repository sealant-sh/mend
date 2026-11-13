import { BOAT_FAILURE_KINDS, type BoatFailureKind } from "@sealant/api-contracts";
import { Schema } from "effect";

export { BOAT_FAILURE_KINDS, type BoatFailureKind };

/**
 * Why Boat refused, or did not answer, a call Sealant made for a Boat key or a Boat workspace:
 * sealant's `BoatFailure` (sealant#634) with Mend's dates and nulls. `kind` is sealant's closed set, so
 * a sealant pin that adds a kind fails to compile wherever Mend words them. `code`, `message` and
 * `requestId` are Boat's own: they are for an operator and Boat's support, never a sentence.
 */
export const BoatFailure = Schema.Struct({
  kind: Schema.Literals(BOAT_FAILURE_KINDS),
  /** Whether the same call may succeed later as it stands. */
  retryable: Schema.Boolean,
  /** sealant's call that Boat refused (`create`, `saveSnapshot`, `verify`), when known. */
  operation: Schema.NullOr(Schema.String),
  /** The HTTP status Boat answered with; null when it did not answer. */
  status: Schema.NullOr(Schema.Number),
  /** Boat's error code (`api_key_expired`). */
  code: Schema.NullOr(Schema.String),
  /** Boat's own message, bounded, with anything shaped like a secret removed by sealant. */
  message: Schema.NullOr(Schema.String),
  /** Boat's request id (`req_…`), to give Boat's support. */
  requestId: Schema.NullOr(Schema.String),
  /** The Boat permission the call needs, for `permission-missing`. */
  permission: Schema.NullOr(Schema.String),
  /** Seconds Boat asked to wait before trying again. */
  retryAfterSeconds: Schema.NullOr(Schema.Number),
  /** When Boat said the next start is allowed. */
  retryAt: Schema.NullOr(Schema.Date),
  /** Boat's billing link (HTTPS on boat.dev only), for `billing-required`. */
  billingUrl: Schema.NullOr(Schema.String),
});
export type BoatFailure = typeof BoatFailure.Type;
