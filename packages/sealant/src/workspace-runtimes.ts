import type { WorkspaceRuntimesReading } from "@mend/domain";
import { Clock, Duration, Effect, Layer, Ref } from "effect";
import * as Context from "effect/Context";

import { SealantClients } from "./client.ts";
import type { SealantPlatformError } from "./errors.ts";

/**
 * What sealant says each runtime it launches supports, as Mend last read it. Every page, save and
 * launch that needs a runtime fact reads it here. Never fails: when sealant does not answer, the
 * reading is `unread` with the reason, and nothing is assumed supported.
 */
export class WorkspaceRuntimesReport extends Context.Service<
  WorkspaceRuntimesReport,
  { readonly read: () => Effect.Effect<WorkspaceRuntimesReading> }
>()("@mend/sealant/WorkspaceRuntimesReport") {}

/** An answer is kept this long: what a runtime supports changes only when sealant's install does. */
export const RUNTIMES_KEPT = Duration.minutes(1);
/** A failed read is kept this long, so a page that reads it often waits on sealant at most once. */
export const RUNTIMES_UNREAD_KEPT = Duration.seconds(15);
/** How long a read waits for sealant. */
export const RUNTIMES_READ_TIMEOUT = Duration.seconds(5);

/**
 * Why the report is unread, in words any member may read: sealant's own text can name internal hosts
 * and paths, so it goes to the log and never into the reading.
 */
const unreadReason = (cause: SealantPlatformError | TimedOut): string =>
  cause instanceof TimedOut
    ? "Sealant did not answer within 5 seconds"
    : cause.status !== null && cause.status > 0
      ? `Sealant answered HTTP ${cause.status}`
      : "Sealant could not be reached";

class TimedOut {
  readonly _tag = "TimedOut";
}

export const WorkspaceRuntimesReportLive: Layer.Layer<
  WorkspaceRuntimesReport,
  never,
  SealantClients
> = Layer.effect(
  WorkspaceRuntimesReport,
  Effect.gen(function* () {
    const clients = yield* SealantClients;
    const kept = yield* Ref.make<{
      readonly until: number;
      readonly reading: WorkspaceRuntimesReading;
    } | null>(null);
    const fetch = clients.workspaceRuntimes().pipe(
      Effect.timeoutOrElse({
        duration: RUNTIMES_READ_TIMEOUT,
        orElse: () => Effect.fail(new TimedOut()),
      }),
      Effect.flatMap((runtimes) =>
        Clock.currentTimeMillis.pipe(
          Effect.map(
            (now): WorkspaceRuntimesReading => ({
              state: "observed",
              observedAt: new Date(now),
              runtimes,
            }),
          ),
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("workspace runtimes: Sealant's report could not be read").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
          Effect.as<WorkspaceRuntimesReading>({ state: "unread", reason: unreadReason(cause) }),
        ),
      ),
    );
    const read = Effect.fn("WorkspaceRuntimesReport.read")(function* () {
      const now = yield* Clock.currentTimeMillis;
      const known = yield* Ref.get(kept);
      if (known !== null && known.until > now) return known.reading;
      const reading = yield* fetch;
      const keep = reading.state === "observed" ? RUNTIMES_KEPT : RUNTIMES_UNREAD_KEPT;
      yield* Ref.set(kept, { until: now + Duration.toMillis(keep), reading });
      return reading;
    });
    return { read };
  }),
);

/** A report that always answers `reading`: for tests, and for a Mend that runs without sealant. */
export const workspaceRuntimesReportOf = (
  reading: WorkspaceRuntimesReading,
): Layer.Layer<WorkspaceRuntimesReport> =>
  Layer.succeed(WorkspaceRuntimesReport, { read: () => Effect.succeed(reading) });
