import { PreviewsRepo } from "@mend/db";
import type { PreviewId, SessionProcessId } from "@mend/domain";
import {
  type PreviewGatewayResolution,
  PreviewStartRefusal,
  type PreviewStartRequest,
} from "@mend/domain/workbench";
import { type PreviewStartRefused, SessionEngine } from "@mend/sessions";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

export class PreviewStartFailed extends Schema.TaggedError<PreviewStartFailed>()(
  "PreviewStartFailed",
  { reason: PreviewStartRefusal },
) {}

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

/** Drops `detail`: it is for logs, never for a browser. */
export const previewStartFailure = (refused: PreviewStartRefused): PreviewStartFailed =>
  new PreviewStartFailed({ reason: refused.reason });

export const PreviewTargetsLive: Layer.Layer<PreviewTargets, never, PreviewsRepo | SessionEngine> =
  Layer.effect(
    PreviewTargets,
    Effect.gen(function* () {
      const previews = yield* PreviewsRepo;
      const engine = yield* SessionEngine;
      return {
        snapshot: (id) =>
          previews
            .gatewaySnapshot(id)
            .pipe(
              Effect.map((read) =>
                read === null || read.preview.state === "removed" ? null : read.resolution,
              ),
            ),
        snapshots: (ids) =>
          previews
            .gatewaySnapshots(ids)
            .pipe(
              Effect.map(
                (read) =>
                  new Map(
                    [...read].flatMap(([id, found]) =>
                      found.preview.state === "removed" ? [] : [[id, found.resolution] as const],
                    ),
                  ),
              ),
            ),
        ensureRunning: (request) =>
          engine.ensurePreviewRunning(request).pipe(
            Effect.tapError((refused) =>
              Effect.logWarning("preview: a request-triggered start was refused").pipe(
                Effect.annotateLogs({
                  previewId: request.previewId,
                  reason: refused.reason,
                  detail: refused.detail ?? "",
                }),
              ),
            ),
            Effect.mapError(previewStartFailure),
          ),
      };
    }),
  );
