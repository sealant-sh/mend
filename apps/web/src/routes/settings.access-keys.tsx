import { createFileRoute } from "@tanstack/react-router";

import { AccessKeysSettings, accessKeysOptions } from "#/components/settings/access-keys";

export const Route = createFileRoute("/settings/access-keys")({
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(accessKeysOptions(trpc)),
  component: AccessKeysSettings,
});
