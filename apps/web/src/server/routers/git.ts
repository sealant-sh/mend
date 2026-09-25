import { AddReference, SetGitAccessRequest, SetGitAuthorRequest } from "@mend/api-contracts";
import { ReferenceId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** References (global) · git keys · bridge · the account's git author. */
export const gitRouter = router({
  references: procedure.query(({ ctx }) => run(ctx, (api) => api.references.list())),
  addReference: procedure
    .input(input(AddReference))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.references.add({ payload }))),
  removeReference: procedure
    .input(input(Schema.Struct({ id: ReferenceId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.references.remove({ params: { id: i.id } })),
    ),
  refreshReference: procedure
    .input(input(Schema.Struct({ id: ReferenceId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.references.refresh({ params: { id: i.id } })),
    ),
  key: procedure.query(({ ctx }) => run(ctx, (api) => api.gitKeys.show())),
  initKey: procedure.mutation(({ ctx }) => run(ctx, (api) => api.gitKeys.init())),
  bridgeStatus: procedure.query(({ ctx }) => run(ctx, (api) => api.gitKeys.bridgeStatus())),
  access: procedure.query(({ ctx }) => run(ctx, (api) => api.gitKeys.access())),
  setAccess: procedure
    .input(input(SetGitAccessRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.gitKeys.setAccess({ payload }))),
  author: procedure.query(({ ctx }) => run(ctx, (api) => api.gitKeys.author())),
  setAuthor: procedure
    .input(input(SetGitAuthorRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.gitKeys.setAuthor({ payload }))),
  clearAuthor: procedure.mutation(({ ctx }) => run(ctx, (api) => api.gitKeys.clearAuthor())),
});
