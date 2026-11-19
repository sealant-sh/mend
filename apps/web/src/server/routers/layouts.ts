import { RenameLayoutRequest, SaveLayoutRequest } from "@mend/domain/workbench";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/**
 * The signed-in person's saved layouts of a workspace's tiles (ADR 0026, "Layouts"): listed,
 * saved under a name, renamed and removed. Refusals keep the API's tag: `SavedLayoutNameTaken`,
 * `SavedLayoutLimitReached` (409) and `SavedLayoutNotFound` (404), each with a `message` to show.
 */
export const layoutsRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.savedLayouts.list())),
  save: procedure
    .input(input(SaveLayoutRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.savedLayouts.save({ payload }))),
  rename: procedure
    .input(input(Schema.Struct({ id: Schema.String, request: RenameLayoutRequest })))
    .mutation(({ ctx, input: { id, request } }) =>
      run(ctx, (api) => api.savedLayouts.rename({ params: { id }, payload: request })),
    ),
  remove: procedure
    .input(input(Schema.Struct({ id: Schema.String })))
    .mutation(({ ctx, input: params }) => run(ctx, (api) => api.savedLayouts.remove({ params }))),
});
