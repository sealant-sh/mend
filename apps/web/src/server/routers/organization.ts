import {
  CreateInvitationRequest,
  InvitationPreviewRequest,
  MemberRoleRequest,
} from "@mend/api-contracts";
import { InvitationId, ProjectId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** The signed-in account's organization (docs/adr/0003-organizations-and-tenancy.md). */
export const organizationRouter = router({
  current: procedure.query(({ ctx }) => run(ctx, (api) => api.organization.current())),
  members: procedure.query(({ ctx }) => run(ctx, (api) => api.organization.members())),
  invitations: procedure.query(({ ctx }) => run(ctx, (api) => api.organization.invitations())),
  createInvitation: procedure
    .input(input(CreateInvitationRequest))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.organization.createInvitation({ payload })),
    ),
  revokeInvitation: procedure
    .input(input(Schema.Struct({ id: InvitationId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.organization.revokeInvitation({ params: { id: i.id } })),
    ),
  setMemberRole: procedure
    .input(input(Schema.Struct({ userId: Schema.String, role: MemberRoleRequest.fields.role })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.organization.setMemberRole({ params: { userId: i.userId }, payload: { role: i.role } }),
      ),
    ),
  removeMember: procedure
    .input(input(Schema.Struct({ userId: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.organization.removeMember({ params: { userId: i.userId } })),
    ),
  orphanedProjects: procedure.query(({ ctx }) =>
    run(ctx, (api) => api.organization.orphanedProjects()),
  ),
  takeOverProject: procedure
    .input(input(Schema.Struct({ id: ProjectId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.organization.takeOverProject({ params: { id: i.id } })),
    ),
  audit: procedure
    .input(input(Schema.Struct({ before: Schema.optional(Schema.String) })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.organization.audit({
          query: i.before === undefined ? {} : { before: i.before },
        }),
      ),
    ),
  // Read before the visitor has an account: the join page.
  invitationPreview: procedure
    .input(input(InvitationPreviewRequest))
    .query(({ ctx, input: payload }) => run(ctx, (api) => api.invitations.preview({ payload }))),
});
