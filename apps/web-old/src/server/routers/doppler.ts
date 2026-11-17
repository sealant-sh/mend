import { ProjectId } from "@mend/domain";
import { DopplerConnectionInput, DopplerSelection } from "@mend/domain/workbench";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** The signed-in person's write-only Doppler connection and project mappings. */
export const dopplerRouter = router({
  status: procedure.query(({ ctx }) => run(ctx, (api) => api.doppler.status())),
  connect: procedure
    .input(input(DopplerConnectionInput))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.doppler.save({ payload }))),
  disconnect: procedure.mutation(({ ctx }) => run(ctx, (api) => api.doppler.disconnect())),
  projects: procedure.query(({ ctx }) => run(ctx, (api) => api.doppler.projects())),
  configs: procedure
    .input(input(Schema.Struct({ project: Schema.String })))
    .query(({ ctx, input: query }) => run(ctx, (api) => api.doppler.configs({ query }))),
  use: procedure
    .input(input(Schema.Struct({ projectId: ProjectId, ...DopplerSelection.fields })))
    .mutation(({ ctx, input: { projectId, ...payload } }) =>
      run(ctx, (api) => api.doppler.use({ params: { projectId }, payload })),
    ),
  removeMapping: procedure
    .input(input(Schema.Struct({ projectId: ProjectId })))
    .mutation(({ ctx, input: params }) => run(ctx, (api) => api.doppler.removeMapping({ params }))),
});
