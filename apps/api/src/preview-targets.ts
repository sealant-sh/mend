import type { PreviewId, SessionProcessId } from "@mend/domain";
import {
  type PreviewGatewayResolution,
  PreviewStartRefusal,
  type PreviewStartRequest,
} from "@mend/domain/workbench";
import { type Effect, Schema } from "effect";
import * as Context from "effect/Context";

/** A request-triggered start the engine refused, or saw not answer within the deadline. */
export class PreviewStartFailed extends Schema.TaggedError<PreviewStartFailed>()(
  "PreviewStartFailed",
  { reason: PreviewStartRefusal },
) {}

/**
 * What the preview gateway reads and asks of the engine (ADR 0017, delivery 7). Step 12 replaces
 * the implementation behind it, not its consumers.
 */
export class PreviewTargets extends Context.Service<
  PreviewTargets,
  {
    /** Null when no kept preview has this id. */
    readonly snapshot: (id: PreviewId) => Effect.Effect<PreviewGatewayResolution | null>;
    /** One read for many previews; an id with no kept preview is absent from the map. */
    readonly snapshots: (
      ids: ReadonlyArray<PreviewId>,
    ) => Effect.Effect<ReadonlyMap<PreviewId, PreviewGatewayResolution>>;
    /** Returns once the attempt is seen to answer on its port, or fails, by `request.deadline`. */
    readonly ensureRunning: (
      request: PreviewStartRequest,
    ) => Effect.Effect<SessionProcessId, PreviewStartFailed>;
  }
>()("@mend/api/PreviewTargets") {}
