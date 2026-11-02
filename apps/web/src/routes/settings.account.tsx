import { createFileRoute } from "@tanstack/react-router";

import { AccountSettings } from "#/components/settings/account";

export const Route = createFileRoute("/settings/account")({
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.platform.sealantIdentity.queryOptions()),
      queryClient.ensureQueryData(trpc.platform.agentLogins.queryOptions()),
    ]),
  component: AccountSettings,
});
