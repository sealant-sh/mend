import { createFileRoute } from "@tanstack/react-router";

import { SettingsLayout } from "#/components/settings/settings-layout";
import { signedInOptions } from "#/lib/viewer";

export const Route = createFileRoute("/settings")({
  ssr: false,
  // Who is looking decides which groups the tab line shows; each tab's own loader runs beside
  // this one, not after it.
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.prefetchQuery(signedInOptions(trpc)),
  component: SettingsLayout,
});
