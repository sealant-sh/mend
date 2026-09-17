import { PgClient } from "@effect/sql-pg";
import { MEND_EVENTS_CHANNEL, MendEvent } from "@mend/db";
import { Effect, Layer, PubSub, Ref, Schedule, Schema, Stream } from "effect";
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
    /** True from the moment the connection is lost until a payload arrives again. */
    const down = yield* Ref.make(false);
    const attempt = Effect.gen(function* () {
      yield* pumpEvents(
        pubsub,
        Stream.tap(listen, () => Ref.set(down, false)),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("the events listen connection ended; reconnecting").pipe(
            Effect.annotateLogs({ cause: String(cause) }),
          ),
        ),
      );
      // Whatever was notified while not listening is gone: tell subscribers to re-read, once per
      // outage, so a database that stays down does not make every client refetch every second.
      if (!(yield* Ref.getAndSet(down, true))) {
        yield* PubSub.publish(pubsub, { kind: "resync" });
      }
    });
    const reconnect = Schedule.exponential("1 second").pipe(
      Schedule.either(Schedule.spaced("30 seconds")),
    );
    yield* Effect.forkScoped(Effect.repeat(attempt, reconnect));
    return { subscribe: PubSub.subscribe(pubsub) };
  });

export const EventBusLive: Layer.Layer<EventBus, never, PgClient.PgClient> = Layer.effect(
  EventBus,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* makeEventBus(sql.listen(MEND_EVENTS_CHANNEL));
  }),
);
