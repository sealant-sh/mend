import {
  AddTeamMemberRequest,
  CreateTeamInviteRequest,
  CreateTeamRequest,
  RenameTeamRequest,
  SetTeamRoleRequest,
} from "@mend/api-contracts";
import { TeamId, TeamInviteId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byId = input(Schema.Struct({ id: TeamId }));

/** Teams, seats, and invite links (docs/adr/0002-teams-and-project-scope.md). */
export const teamsRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.teams.list())),
  detail: procedure
    .input(byId)
    .query(({ ctx, input: i }) => run(ctx, (api) => api.teams.detail({ params: { id: i.id } }))),
  create: procedure
    .input(input(CreateTeamRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.teams.create({ payload }))),
  rename: procedure
    .input(input(Schema.Struct({ id: TeamId, request: RenameTeamRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.teams.rename({ params: { id: i.id }, payload: i.request })),
    ),
  remove: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) => run(ctx, (api) => api.teams.remove({ params: { id: i.id } }))),
  addMember: procedure
    .input(input(Schema.Struct({ id: TeamId, request: AddTeamMemberRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.teams.addMember({ params: { id: i.id }, payload: i.request })),
    ),
  setRole: procedure
    .input(input(Schema.Struct({ id: TeamId, userId: Schema.String, request: SetTeamRoleRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.teams.setRole({ params: { id: i.id, userId: i.userId }, payload: i.request }),
      ),
    ),
  removeMember: procedure
    .input(input(Schema.Struct({ id: TeamId, userId: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.teams.removeMember({ params: { id: i.id, userId: i.userId } })),
    ),
  createInvite: procedure
    .input(input(Schema.Struct({ id: TeamId, request: CreateTeamInviteRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.teams.createInvite({ params: { id: i.id }, payload: i.request })),
    ),
  revokeInvite: procedure
    .input(input(Schema.Struct({ id: TeamId, inviteId: TeamInviteId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.teams.revokeInvite({ params: { id: i.id, inviteId: i.inviteId } })),
    ),
  invitePreview: procedure
    .input(input(Schema.Struct({ token: Schema.String })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.teams.invitePreview({ params: { token: i.token } })),
    ),
  acceptInvite: procedure
    .input(input(Schema.Struct({ token: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.teams.acceptInvite({ params: { token: i.token } })),
    ),
});
