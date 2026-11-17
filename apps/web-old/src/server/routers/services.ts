import { ServiceId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** Cross-session Services: one list, restart/stop by id. */
export const servicesRouter = router({
  list: procedure
    .input(input(Schema.Struct({ all: Schema.optional(Schema.Boolean) })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.listServices({ query: { all: i.all === true ? "1" : undefined } }),
      ),
    ),
  restart: procedure
    .input(input(Schema.Struct({ id: ServiceId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.restartService({ params: { id: i.id } })),
    ),
  stop: procedure
    .input(input(Schema.Struct({ id: ServiceId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessions.stopService({ params: { id: i.id } })),
    ),
});
