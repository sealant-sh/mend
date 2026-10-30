import { SlackReports, type SlackReportTarget } from "@mend/jobs";
import { Effect, Layer, PubSub, Queue } from "effect";
import { describe, expect, it } from "vitest";

import { type BusSignal, EventBus } from "./events-bus.ts";
import { SlackReportEventsLive } from "./slack-report-events.ts";

const event = (payload: BusSignal & { readonly kind: "event" }): BusSignal => payload;

/** Publish the bus signals in order, and read the first `count` reports the reporter was asked for. */
const requested = (signals: ReadonlyArray<BusSignal>, count: number) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<BusSignal>();
        const asked = yield* Queue.unbounded<SlackReportTarget>();
        yield* Layer.build(
          SlackReportEventsLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(EventBus, { subscribe: PubSub.subscribe(pubsub) }),
                Layer.succeed(SlackReports, {
                  request: (target) => Queue.offer(asked, target).pipe(Effect.asVoid),
                }),
              ),
            ),
          ),
        );
        for (const signal of signals) yield* PubSub.publish(pubsub, signal);
        return yield* Effect.forEach(Array.from({ length: count }), () => Queue.take(asked)).pipe(
          Effect.timeout("2 seconds"),
        );
      }),
    ),
  );

describe("the Slack reporter on the events bus", () => {
  it("asks for a report of the session each session event names, and for a resync after a gap", async () => {
    const asked = await requested(
      [
        event({
          kind: "event",
          event: { type: "session", sessionId: "s-1", projectId: "p-1" },
          payload: "{}",
        }),
        event({
          kind: "event",
          event: { type: "agent-conversation", sessionId: "s-2", projectId: "p-1" },
          payload: "{}",
        }),
        event({
          kind: "event",
          event: {
            type: "review-comment",
            commentId: "c",
            changeId: "x",
            worktreeId: "w",
            projectId: "p",
          },
          payload: "{}",
        }),
        { kind: "resync" },
      ],
      3,
    );
    expect(asked).toEqual([
      { _tag: "Session", id: "s-1" },
      { _tag: "Session", id: "s-2" },
      { _tag: "Resync" },
    ]);
  });
});
