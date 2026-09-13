import {
  AddProjectLink,
  AddProjectMount,
  AddProjectServiceRecipe,
  AdoptProject,
  ProjectApplyDotfilesRequest,
  ProjectAutomationRequest,
  ProjectGitAuthRequest,
  ProjectHotSessionsRequest,
  ProjectInstallCommandRequest,
  ProjectInheritUserSkillsRequest,
  ProjectReferenceSelection,
  ProjectWorkspaceImageRequest,
} from "@mend/api-contracts";
import { ProjectId, ProjectLinkId, ProjectMountId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byId = input(Schema.Struct({ id: ProjectId }));

/** Projects · references · mounts · recipes. */
export const projectsRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.projects.list())),
  detail: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.detail({ params: { id: i.id }, query: {} })),
    ),
  adopt: procedure
    .input(input(AdoptProject))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.projects.adopt({ payload }))),
  remove: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.remove({ params: { id: i.id } })),
    ),
  setAutomation: procedure
    .input(input(Schema.Struct({ id: ProjectId, choices: ProjectAutomationRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.automation({ params: { id: i.id }, payload: i.choices })),
    ),
  setWorkspaceImage: procedure
    .input(input(Schema.Struct({ id: ProjectId, request: ProjectWorkspaceImageRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.workspaceImage({ params: { id: i.id }, payload: i.request })),
    ),
  setApplyDotfiles: procedure
    .input(input(Schema.Struct({ id: ProjectId, request: ProjectApplyDotfilesRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.applyDotfiles({ params: { id: i.id }, payload: i.request })),
    ),
  setInheritUserSkills: procedure
    .input(input(Schema.Struct({ id: ProjectId, request: ProjectInheritUserSkillsRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.projects.inheritUserSkills({ params: { id: i.id }, payload: i.request }),
      ),
    ),
  setGitAuth: procedure
    .input(input(Schema.Struct({ id: ProjectId, request: ProjectGitAuthRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.gitAuth({ params: { id: i.id }, payload: i.request })),
    ),
  setHotSessions: procedure
    .input(input(Schema.Struct({ id: ProjectId, request: ProjectHotSessionsRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.hotSessions({ params: { id: i.id }, payload: i.request })),
    ),
  setInstallCommand: procedure
    .input(input(Schema.Struct({ id: ProjectId, request: ProjectInstallCommandRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.installCommand({ params: { id: i.id }, payload: i.request })),
    ),
  hotSessionsStatus: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.hotSessionsStatus({ params: { id: i.id } })),
    ),
  branches: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.branches({ params: { id: i.id } })),
    ),
  refresh: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projects.refresh({ params: { id: i.id } })),
    ),
  references: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.references.forProject({ params: { id: i.id } })),
    ),
  selectReferences: procedure
    .input(input(Schema.Struct({ id: ProjectId, selection: ProjectReferenceSelection })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.references.selectForProject({ params: { id: i.id }, payload: i.selection }),
      ),
    ),
  mounts: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectMounts.list({ params: { id: i.id } })),
    ),
  addMount: procedure
    .input(input(Schema.Struct({ id: ProjectId, mount: AddProjectMount })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectMounts.add({ params: { id: i.id }, payload: i.mount })),
    ),
  removeMount: procedure
    .input(input(Schema.Struct({ id: ProjectId, mountId: ProjectMountId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectMounts.remove({ params: { id: i.id, mountId: i.mountId } })),
    ),
  links: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectLinks.list({ params: { id: i.id } })),
    ),
  addLink: procedure
    .input(input(Schema.Struct({ id: ProjectId, link: AddProjectLink })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectLinks.add({ params: { id: i.id }, payload: i.link })),
    ),
  removeLink: procedure
    .input(input(Schema.Struct({ id: ProjectId, linkId: ProjectLinkId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectLinks.remove({ params: { id: i.id, linkId: i.linkId } })),
    ),
  recipes: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectRecipes.list({ params: { id: i.id } })),
    ),
  addRecipe: procedure
    .input(input(Schema.Struct({ id: ProjectId, recipe: AddProjectServiceRecipe })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectRecipes.add({ params: { id: i.id }, payload: i.recipe })),
    ),
  removeRecipe: procedure
    .input(input(Schema.Struct({ id: ProjectId, name: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectRecipes.remove({ params: { id: i.id, name: i.name } })),
    ),
});
