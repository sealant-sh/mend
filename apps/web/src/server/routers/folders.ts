import { CreateFolderRequest, FolderUploadFile, FolderUploadRequest } from "@mend/api-contracts";
import { FolderId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** Organization folders (docs/adr/0003): owners change them, members read them. */
export const foldersRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.folders.list())),
  create: procedure
    .input(input(CreateFolderRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.folders.create({ payload }))),
  remove: procedure
    .input(input(Schema.Struct({ id: FolderId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.folders.remove({ params: { id: i.id } })),
    ),
  files: procedure
    .input(input(Schema.Struct({ id: FolderId })))
    .query(({ ctx, input: i }) => run(ctx, (api) => api.folders.files({ params: { id: i.id } }))),
  upload: procedure
    .input(
      input(
        Schema.Struct({
          id: FolderId,
          files: Schema.Array(FolderUploadFile),
          merge: Schema.Boolean,
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.folders.upload({
          params: { id: i.id },
          payload: new FolderUploadRequest({ files: i.files, merge: i.merge }),
        }),
      ),
    ),
  deleteFile: procedure
    .input(input(Schema.Struct({ id: FolderId, path: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.folders.deleteFile({ params: { id: i.id }, query: { path: i.path } })),
    ),
});
