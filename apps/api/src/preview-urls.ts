import { PreviewsRepo } from "@mend/db";
import type { ProjectId } from "@mend/domain";
import { PreviewUrls } from "@mend/sessions";
import { Effect, Layer } from "effect";

import { PreviewSetupConfig } from "./preview-config.ts";
import { previewOriginOf } from "./preview-routing.ts";

export const PreviewUrlsLive: Layer.Layer<PreviewUrls, never, PreviewSetupConfig | PreviewsRepo> =
  Layer.effect(
    PreviewUrls,
    Effect.gen(function* () {
      const { setup } = yield* PreviewSetupConfig;
      const previews = yield* PreviewsRepo;
      return {
        of: (worktreeId, serviceName) =>
          Effect.gen(function* () {
            if (setup._tag !== "On") return null;
            const { routing } = setup;
            const views = yield* previews
              .ensureForWorktree(worktreeId)
              .pipe(Effect.orElseSucceed(() => []));
            const named = views.filter(
              ({ preview }) => preview.state === "kept" && preview.serviceName === serviceName,
            );
            const view = named.find(({ preview }) => preview.scope === "project") ?? named[0];
            if (view === undefined) return null;
            const { id, label } = view.preview;
            const tailnetPort =
              routing.mode === "tailnet-https"
                ? ((yield* previews.tailnetPorts([id])).get(id) ?? null)
                : null;
            return previewOriginOf(routing, { label, tailnetPort });
          }),
      };
    }),
  );

/** The already allocated project origin, read without reserving a port or selecting a target. */
export const fixedProjectPreviewOrigin = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const { setup } = yield* PreviewSetupConfig;
    if (setup._tag !== "On") return null;
    const previews = yield* PreviewsRepo;
    const fixed = yield* previews.projectPreview(projectId);
    if (fixed === null || fixed.preview.projectId === null) return null;
    const port =
      setup.routing.mode !== "tailnet-https"
        ? null
        : ((yield* previews.tailnetPorts([fixed.preview.id])).get(fixed.preview.id) ?? null);
    return previewOriginOf(setup.routing, { label: fixed.preview.label, tailnetPort: port });
  });
