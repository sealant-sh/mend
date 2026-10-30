import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { SlackReports, type SlackReportTarget } from "@mend/jobs";
import { Cause, Effect, Layer, Stream } from "effect";

import { type BusSignal, EventBus } from "./events-bus.ts";
import { type PreviewSetup, PreviewSetupConfig } from "./preview-config.ts";

/**
 * What a bus signal asks the Slack reporter to look at again. With the preview gateway on, a
 * Service of any session in a worktree can serve its previews, so a session's moves (readiness
 * checks included) reach every thread of its worktree, and a preparation's (`worktree`) does too.
 * With it off no thread shows a preview, and a session's moves reach its own thread only.
 */
export const slackReportTargetOf = (
  signal: BusSignal,
  previews: PreviewSetup["_tag"],
): SlackReportTarget | null => {
  if (signal.kind === "resync") return { _tag: "Resync" };
  const { event } = signal;
  switch (event.type) {
    case "agent-conversation":
      return { _tag: "Session", id: SessionId.make(event.sessionId) };
    case "session":
    case "session-process":
    case "session-change":
      return previews === "On"
        ? { _tag: "SessionWorktree", id: SessionId.make(event.sessionId) }
        : { _tag: "Session", id: SessionId.make(event.sessionId) };
    case "worktree":
      return previews === "On" ? { _tag: "Worktree", id: WorktreeId.make(event.worktreeId) } : null;
    case "project":
      return { _tag: "Project", id: ProjectId.make(event.projectId) };
    default:
      return null;
  }
};

/** A reconnect's `resync` makes the reporter look at every active session again. */
export const SlackReportEventsLive: Layer.Layer<
  never,
  never,
  EventBus | SlackReports | PreviewSetupConfig
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const reports = yield* SlackReports;
    const { setup } = yield* PreviewSetupConfig;
    const subscription = yield* (yield* EventBus).subscribe;
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((signal) => {
        const target = slackReportTargetOf(signal, setup._tag);
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
