import { SessionId } from "@mend/domain";
import { SlackReports, type SlackReportTarget } from "@mend/jobs";
import { Cause, Effect, Layer, Stream } from "effect";

import { type BusSignal, EventBus } from "./events-bus.ts";

/** What a bus signal asks the Slack reporter to look at again. */
export const slackReportTargetOf = (signal: BusSignal): SlackReportTarget | null => {
  if (signal.kind === "resync") return { _tag: "Resync" };
  const { event } = signal;
  switch (event.type) {
    case "session":
    case "session-process":
    case "agent-conversation":
    case "session-change":
      return { _tag: "Session", id: SessionId.make(event.sessionId) };
    default:
      return null;
  }
};

/** A reconnect's `resync` makes the reporter look at every active session again. */
export const SlackReportEventsLive: Layer.Layer<never, never, EventBus | SlackReports> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const reports = yield* SlackReports;
      const subscription = yield* (yield* EventBus).subscribe;
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.runForEach((signal) => {
          const target = slackReportTargetOf(signal);
          return target === null ? Effect.void : reports.request(target);
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("slack reporter: events subscription ended").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );
