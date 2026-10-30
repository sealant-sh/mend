import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { SlackReports, type SlackReportTarget } from "@mend/jobs";
import { Cause, Effect, Layer, Stream } from "effect";

import { type BusSignal, EventBus } from "./events-bus.ts";

/** What a bus signal asks the Slack reporter to look at again. */
export const slackReportTargetOf = (signal: BusSignal): SlackReportTarget | null => {
  if (signal.kind === "resync") return { _tag: "Resync" };
  const { event } = signal;
  switch (event.type) {
    case "agent-conversation":
      return { _tag: "Session", id: SessionId.make(event.sessionId) };
    // A Service of any session in a worktree can serve its previews, so its moves (readiness
    // checks included) reach every thread of the worktree, not only the session's own.
    case "session":
    case "session-process":
      return { _tag: "SessionWorktree", id: SessionId.make(event.sessionId) };
    case "worktree":
    case "session-change":
      return { _tag: "Worktree", id: WorktreeId.make(event.worktreeId) };
    case "project":
      return { _tag: "Project", id: ProjectId.make(event.projectId) };
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
