import { createFileRoute } from "@tanstack/react-router";

import { AccountSettings } from "#/components/settings/account";

export const Route = createFileRoute("/settings/account")({
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.platform.sealantIdentity.queryOptions()),
      queryClient.ensureQueryData(trpc.platform.agentLogins.queryOptions()),
      // A sign-in without an organization has no Boat key to show: the section is left out.
      queryClient.prefetchQuery(
        trpc.personBoatKey.status.queryOptions(undefined, { retry: false }),
      ),
    ]),
  component: AccountSettings,
});
