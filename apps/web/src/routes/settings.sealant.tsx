import { createFileRoute } from "@tanstack/react-router";

import { SealantSettings, sealantConnectionOptions } from "#/components/settings/sealant";

export const Route = createFileRoute("/settings/sealant")({
  // Started, not awaited: the check is a live round-trip, and the tab says "checking…" meanwhile.
  loader: ({ context: { queryClient, trpc } }) => {
    void queryClient.prefetchQuery(sealantConnectionOptions(trpc));
  },
  component: SealantSettings,
});
