import { Schema } from "effect";

/**
 * The one timestamp codec for every domain object that crosses a boundary.
 *
 * `Schema.Date` validates a `Date` on BOTH sides (Encoded = Date instance), so
 * a client that decodes wire JSON against it always fails: the HTTP layer
 * JSON.stringifies the encoded form and dates travel as ISO strings. This
 * union makes both producers decodable — ISO strings from the JSON wire,
 * `Date` instances straight from pg rows (drizzle `mode: "date"`) — and always
 * encodes to the wire form (ISO string), because the string member comes
 * first. Invalid dates are rejected on every path.
 */
export const Timestamp = Schema.Union([Schema.DateFromString, Schema.Date]);
export type Timestamp = typeof Timestamp.Type;

/**
 * Record sequence counters are bigints for the same reason timestamps are
 * Dates: that is what the domain computes with. On the JSON wire they travel
 * as strings (JSON has no bigint), and pg rows deliver them as bigints —
 * this union decodes both and encodes to the wire form, mirroring
 * [[Timestamp]] exactly.
 */
export const SequenceNumber = Schema.Union([Schema.BigIntFromString, Schema.BigInt]);
export type SequenceNumber = typeof SequenceNumber.Type;
