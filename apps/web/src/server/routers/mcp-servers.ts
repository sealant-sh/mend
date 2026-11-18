import { McpServerWrite } from "@mend/domain/workbench";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const named = Schema.Struct({ name: Schema.String });

export const mcpServersRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.mcpServers.list())),
  save: procedure
    .input(input(Schema.Struct({ name: Schema.String, server: McpServerWrite })))
    .mutation(({ ctx, input: { name, server } }) =>
      run(ctx, (api) => api.mcpServers.save({ params: { name }, payload: server })),
    ),
  remove: procedure
    .input(input(named))
    .mutation(({ ctx, input: params }) => run(ctx, (api) => api.mcpServers.remove({ params }))),
  forgetSignIn: procedure
    .input(input(named))
    .mutation(({ ctx, input: params }) =>
      run(ctx, (api) => api.mcpServers.forgetSignIn({ params })),
    ),
});
