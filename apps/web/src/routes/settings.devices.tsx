import { createFileRoute } from "@tanstack/react-router";

import { DevicesSettings, devicesOptions } from "#/components/settings/devices";

export const Route = createFileRoute("/settings/devices")({
  loader: ({ context: { queryClient, trpc } }) => queryClient.ensureQueryData(devicesOptions(trpc)),
  component: DevicesSettings,
});
