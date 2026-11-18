import { ServiceId, SessionProcessId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** Cross-session Services: one list, restart/stop by id, and an attempt's recorded output. */
export const servicesRouter = router({
  list: procedure
    .input(input(Schema.Struct({ all: Schema.optional(Schema.Boolean) })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.listServices({ query: { all: i.all === true ? "1" : undefined } }),
      ),
    ),
  // A Service attempt's recorded output from `from` (a sequence; "0" is the start), at most
  // `limit` chunks (the API allows 1000). The record outlives the process and its workspace.
  logs: procedure
    .input(
      input(
        Schema.Struct({
          processId: SessionProcessId,
          from: Schema.String,
          limit: Schema.optional(Schema.Int),
        }),
      ),
    )
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessions.processLogs({
          params: { id: i.processId },
          query: { from: i.from, limit: i.limit === undefined ? undefined : String(i.limit) },
        }),
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
