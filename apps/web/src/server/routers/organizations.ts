import { InvitationAcceptRequest, SwitchOrganizationRequest } from "@mend/api-contracts";
import { OrganizationId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/**
 * The signed-in account's organizations (docs/adr/0003, "Organization switching"): which ones it
 * belongs to, which one this sign-in acts in, switching, leaving one, and joining one more.
 */
export const organizationsRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.accountOrganizations.list())),
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
