import { DotfilesRepositoryRequest, DotfilesSnapshotRequest } from "@mend/api-contracts";
import { MendSettings, WorkspaceImage } from "@mend/domain";
import { SecretFileUpload } from "@mend/domain/workbench";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** Settings · workspace environment · dotfiles · the account's secret files. */
export const settingsRouter = router({
  secretFiles: procedure.query(({ ctx }) => run(ctx, (api) => api.secretFiles.list())),
  putSecretFile: procedure
    .input(input(SecretFileUpload))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.secretFiles.save({ payload }))),
  deleteSecretFile: procedure
    .input(input(Schema.Struct({ path: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.secretFiles.remove({ query: { path: i.path } })),
    ),
  get: procedure.query(({ ctx }) => run(ctx, (api) => api.settings.get())),
  put: procedure
    .input(input(MendSettings))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.settings.set({ payload }))),
  saveWorkspaceEnvironment: procedure
    .input(input(WorkspaceImage))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) =>
        // The image is a union; the client's payload overloads want one member.
        payload.mode === "custom"
          ? api.settings.setWorkspaceEnvironment({ payload })
          : api.settings.setWorkspaceEnvironment({ payload }),
      ),
    ),
  environmentSuggestions: procedure.query(({ ctx }) =>
    run(ctx, (api) => api.settings.scanHostEnvironment()),
  ),
  dotfiles: procedure.query(({ ctx }) => run(ctx, (api) => api.dotfiles.get())),
  putDotfilesRepository: procedure
    .input(input(DotfilesRepositoryRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.dotfiles.repository({ payload }))),
  postDotfilesSnapshot: procedure
    .input(input(DotfilesSnapshotRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.dotfiles.snapshot({ payload }))),
  deleteDotfilesSnapshot: procedure.mutation(({ ctx }) =>
    run(ctx, (api) => api.dotfiles.clearSnapshot()),
  ),
});
