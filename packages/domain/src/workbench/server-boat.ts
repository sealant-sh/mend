import { Effect, Schema } from "effect";

import { BoatKeyReport, BoatUnreachable } from "./boat-key.ts";

/**
 * What a server that offers Boat sessions observed about Boat, for its operator (SLNT-799): the
 * public addresses Boat VMs dial, the server's own Boat key as Sealant last checked it, and whether
 * Sealant lists Boat as a runtime it can launch. Each fact says when it was observed, or why it
 * was not. `mend server status`, `mend doctor` and the instance page read it through
 * `server-boat-words.ts`, so they say the same thing.
 */

/** Which of the two public addresses: session traffic, or the blob store that keeps saved work. */
export const BoatAddressPurpose = Schema.Literals(["sessions", "saved-work"]);
export type BoatAddressPurpose = typeof BoatAddressPurpose.Type;

/**
 * One public address as the server last asked it. Any HTTP answer means the forwarding reaches
 * something; `detail` is why there was none. Asked from the server, not from Boat's network.
 */
export const BoatAddress = Schema.Struct({
  purpose: BoatAddressPurpose,
  url: Schema.String,
  answer: Schema.Union([
    Schema.Struct({ answered: Schema.Literal(true), status: Schema.Int }),
    Schema.Struct({ answered: Schema.Literal(false), detail: Schema.String }),
  ]),
  observedAt: Schema.Date,
});
export type BoatAddress = typeof BoatAddress.Type;

/**
 * The server's own Boat key: `none` when it has none (organizations connect their own), `held`
 * with Sealant's last report (null until Sealant checks it, which it does when the server starts
 * and once a day), or `unread` when Sealant did not answer.
 */
export const ServerBoatKey = Schema.Union([
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({
    state: Schema.Literal("held"),
    report: Schema.NullOr(BoatKeyReport),
    /** What the key made in Boat that sealant cannot reach in any wallet it can bill. */
    unreachable: Schema.NullOr(BoatUnreachable).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null)),
    ),
  }),
  Schema.Struct({ state: Schema.Literal("unread"), reason: Schema.String }),
]);
export type ServerBoatKey = typeof ServerBoatKey.Type;

/**
 * Whether Sealant lists Boat as a runtime it launches, which it does only once a worker has
 * reported that it can launch Boat VMs and some Boat key can pay for them. `resourceGateway` is
 * whether that worker runs the resource gateway Boat sessions reach `@db` through.
 */
export const BoatLaunch = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("listed"),
    observedAt: Schema.Date,
    resourceGateway: Schema.Boolean,
  }),
  Schema.Struct({ state: Schema.Literal("not-listed"), observedAt: Schema.Date }),
  Schema.Struct({ state: Schema.Literal("unread"), reason: Schema.String }),
]);
export type BoatLaunch = typeof BoatLaunch.Type;

export const ServerBoatFacts = Schema.Struct({
  /** The addresses the server declares, each as last asked; empty when it declares none. */
  addresses: Schema.Array(BoatAddress),
  serverKey: ServerBoatKey,
  /**
   * How many Boat keys Sealant stores for organizations and people, null when unread. Only the
   * count: an operator does not read an organization's key.
   */
  storedKeys: Schema.NullOr(Schema.Int),
  launch: BoatLaunch,
});
export type ServerBoatFacts = typeof ServerBoatFacts.Type;
