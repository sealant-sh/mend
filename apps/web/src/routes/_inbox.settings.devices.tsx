import { createFileRoute } from "@tanstack/react-router";

import { DevicesPage } from "#/components/settings/devices-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → Account → Devices and access keys: pairing a phone, signed-in devices, access keys
 * and workspace SSH keys. Old `/settings/access-keys` lands here.
 */
export const Route = createFileRoute("/_inbox/settings/devices")({
  beforeLoad: guardSettingsPage("a-devices"),
  // Workspace SSH keys are read by their own section, so a platform that can't answer them leaves
  // the rest of the page standing.
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.devices.list.queryOptions()),
      queryClient.ensureQueryData(trpc.accessKeys.list.queryOptions()),
    ]),
  component: DevicesPage,
});
