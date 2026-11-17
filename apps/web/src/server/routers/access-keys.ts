import { CreateAccessKeyRequest } from "@mend/api-contracts";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

export const accessKeysRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.accessKeys.list())),
  create: procedure
    .input(input(CreateAccessKeyRequest))
    .mutation(({ ctx, input: i }) => run(ctx, (api) => api.accessKeys.create({ payload: i }))),
  revoke: procedure
    .input(input(Schema.Struct({ id: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.accessKeys.revoke({ params: { id: i.id } })),
    ),
});
