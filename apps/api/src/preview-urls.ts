import { PreviewsRepo } from "@mend/db";
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
            const view = views.find(
              ({ preview }) => preview.state === "kept" && preview.serviceName === serviceName,
            );
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
