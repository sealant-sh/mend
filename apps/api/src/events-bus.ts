import { PgClient } from "@effect/sql-pg";
import { MendEvent, openEvents } from "@mend/db";
import { Effect, Layer, PubSub, Ref, Schedule, Schema, Stream } from "effect";
import * as Context from "effect/Context";
import type * as Scope from "effect/Scope";

/**
 * What subscribers receive: a decoded pointer event with its original payload, or `resync` when
 * events may have been missed: once when the listen connection is lost, and once when it listens
 * again.
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

type BusEvent = Extract<BusSignal, { readonly kind: "event" }>;

/**
 * The payloads a subscription to the bus hears, for a worker written against a stream of NOTIFY
 * payloads: it shares the process's one LISTEN instead of pinning a pool connection of its own.
 */
export const busPayloads = (subscription: PubSub.Subscription<BusSignal>) =>
  Stream.fromSubscription(subscription).pipe(
    Stream.filter((signal): signal is BusEvent => signal.kind === "event"),
    Stream.map((signal) => signal.payload),
  );

/**
 * `open` LISTENs, succeeding once the LISTEN is confirmed, with the payloads from then on. Whatever
 * is notified while not listening is gone, so subscribers hear `resync` twice per outage: when the
 * connection is lost, and once it listens again, so a change made in between is read too. A
 * database that stays down adds nothing: no subscriber refetches on every failed attempt.
 */
export const makeEventBus = <E, R>(
  open: Effect.Effect<Stream.Stream<string, E>, E, R | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.sliding<BusSignal>(BUFFER);
    const down = yield* Ref.make(false);
    const attempt = Effect.scoped(
      Effect.gen(function* () {
        const payloads = yield* open;
        if (yield* Ref.getAndSet(down, false)) {
          yield* PubSub.publish(pubsub, { kind: "resync" });
        }
        yield* pumpEvents(pubsub, payloads);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("the events listen connection ended; reconnecting").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
      Effect.andThen(
        Effect.gen(function* () {
          if (!(yield* Ref.getAndSet(down, true))) {
            yield* PubSub.publish(pubsub, { kind: "resync" });
          }
        }),
      ),
    );
    const reconnect = Schedule.min([
      Schedule.exponential("1 second"),
      Schedule.spaced("30 seconds"),
    ]);
    yield* Effect.forkScoped(Effect.repeat(attempt, reconnect));
    return { subscribe: PubSub.subscribe(pubsub) };
  });

export const EventBusLive: Layer.Layer<EventBus, never, PgClient.PgClient> = Layer.effect(
  EventBus,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* makeEventBus(openEvents(sql));
  }),
);
