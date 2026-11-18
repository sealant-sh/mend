import {
  CreateOrganizationRequest,
  InvitationAcceptRequest,
  SwitchOrganizationRequest,
} from "@mend/api-contracts";
import { OrganizationId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

export const organizationsRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.accountOrganizations.list())),
  // Whether to offer it is `organization.current`'s `canCreateOrganizations`. The caller becomes
  // its owner and this sign-in switches to it. A refused name carries `data.tag`:
  // `OrganizationNameEmpty`, `OrganizationNameNotAllowed` or `OrganizationNameTaken`.
  create: procedure
    .input(input(CreateOrganizationRequest))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.accountOrganizations.create({ payload })),
    ),
  switch: procedure
    .input(input(SwitchOrganizationRequest))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.accountOrganizations.switch({ payload })),
    ),
  leave: procedure
    .input(input(Schema.Struct({ id: OrganizationId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.accountOrganizations.leave({ params: { id: i.id } })),
    ),
  acceptInvitation: procedure
    .input(input(InvitationAcceptRequest))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.accountOrganizations.acceptInvitation({ payload })),
    ),
});
