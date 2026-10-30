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

const of = (payload: Extract<BusSignal, { readonly kind: "event" }>["event"]) =>
  event({ kind: "event", event: payload, payload: "{}" });

describe("the Slack reporter on the events bus", () => {
  it("asks for a report of every thread a change reaches, and for a resync after a gap", async () => {
    const asked = await requested(
      [
        of({ type: "agent-conversation", sessionId: "s-2", projectId: "p-1" }),
        // A Service in a sibling session serves the worktree's previews: its worktree is reached.
        of({ type: "session-process", sessionId: "s-service", projectId: "p-1" }),
        of({ type: "session", sessionId: "s-1", projectId: "p-1" }),
        of({ type: "worktree", worktreeId: "wt-1", projectId: "p-1" }),
        of({
          type: "session-change",
          changeId: "c-1",
          worktreeId: "wt-1",
          sessionId: "s-1",
          projectId: "p-1",
        }),
        of({ type: "project", projectId: "p-1" }),
        of({
          type: "review-comment",
          commentId: "c",
          changeId: "x",
          worktreeId: "w",
          projectId: "p",
        }),
        { kind: "resync" },
      ],
      7,
    );
    expect(asked).toEqual([
      { _tag: "Session", id: "s-2" },
      { _tag: "SessionWorktree", id: "s-service" },
      { _tag: "SessionWorktree", id: "s-1" },
      { _tag: "Worktree", id: "wt-1" },
      { _tag: "Worktree", id: "wt-1" },
      { _tag: "Project", id: "p-1" },
      { _tag: "Resync" },
    ]);
  });
});
