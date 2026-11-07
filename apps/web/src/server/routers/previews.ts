import { ProjectPreviewTarget } from "@mend/api-contracts";
import { ProjectId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byId = input(Schema.Struct({ id: ProjectId }));

/** Fixed project preview reads and explicit target/start actions use the authenticated API. */
export const previewsRouter = router({
  project: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.previews.project({ params: { id: i.id } })),
    ),
  start: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.previews.startProject({ params: { id: i.id } })),
    ),
  use: procedure
    .input(input(Schema.Struct({ id: ProjectId, target: ProjectPreviewTarget })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        i.target._tag === "Default"
          ? api.previews.useProject({ params: { id: i.id }, payload: i.target })
          : api.previews.useProject({ params: { id: i.id }, payload: i.target }),
      ),
    ),
});
