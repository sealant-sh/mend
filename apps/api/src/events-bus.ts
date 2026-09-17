import { PgClient } from "@effect/sql-pg";
import { MEND_EVENTS_CHANNEL, MendEvent } from "@mend/db";
import { Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import * as Context from "effect/Context";
import type * as Scope from "effect/Scope";

/**
 * What subscribers receive: a decoded pointer event with its original payload, or `resync`
 * after the listen connection was lost and re-established, when events may have been missed.
 */
export type BusSignal =
  | { readonly kind: "event"; readonly event: MendEvent; readonly payload: string }
  | { readonly kind: "resync" };

/**
 * One application-owned fan-out of the `mend_events` NOTIFY channel. A single LISTEN per process
 * publishes into a sliding buffer; each SSE stream subscribes and only unsubscribes when it ends.
 * Streams used to call `sql.listen` themselves, and the shared connection's per-stream UNLISTEN
 * meant one closing browser silenced every other stream on the process.
 */
export class EventBus extends Context.Service<
  EventBus,
  {
    readonly subscribe: Effect.Effect<PubSub.Subscription<BusSignal>, never, Scope.Scope>;
  }
>()("@mend/api/EventBus") {}

/** A slow subscriber loses the oldest pointers, never slows the others; clients re-read anyway. */
const BUFFER = 1024;

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(MendEvent));

/** Publish every decodable payload of one stream of NOTIFY payloads; undecodable ones drop. */
export const pumpEvents = <E, R>(
  pubsub: PubSub.PubSub<BusSignal>,
  payloads: Stream.Stream<string, E, R>,
) =>
  Stream.runForEach(payloads, (payload) => {
    const decoded = decodeEvent(payload);
    return decoded._tag === "Some"
      ? PubSub.publish(pubsub, { kind: "event", event: decoded.value, payload })
      : Effect.void;
  });

export const makeEventBus = <E, R>(listen: Stream.Stream<string, E, R>) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.sliding<BusSignal>(BUFFER);
    const loop = Effect.gen(function* () {
      yield* pumpEvents(pubsub, listen).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("the events listen connection ended; reconnecting").pipe(
            Effect.annotateLogs({ cause: String(cause) }),
          ),
        ),
      );
      // Whatever was notified while not listening is gone: tell subscribers to re-read.
      yield* PubSub.publish(pubsub, { kind: "resync" });
    }).pipe(Effect.repeat(Schedule.spaced("1 second")));
    yield* Effect.forkScoped(loop);
    return { subscribe: PubSub.subscribe(pubsub) };
  });

export const EventBusLive: Layer.Layer<EventBus, never, PgClient.PgClient> = Layer.effect(
  EventBus,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* makeEventBus(sql.listen(MEND_EVENTS_CHANNEL));
  }),
);
