import { run } from "../api/index.ts";
import { procedure, router } from "./trpc.ts";

/** The server-owned model catalog (docs/models-audit.md): what every picker lists. */
export const harnessesRouter = router({
  models: procedure.query(({ ctx }) => run(ctx, (api) => api.harnessModels.list())),
});
