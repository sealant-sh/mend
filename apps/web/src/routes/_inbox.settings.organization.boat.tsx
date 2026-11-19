import { createFileRoute } from "@tanstack/react-router";

import { BoatPage, boatKeyStatusOptions } from "#/components/settings/boat-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → the organization → Boat: the organization's Boat key. Everyone reads whether there is
 * one; owners read its details and change it.
 */
export const Route = createFileRoute("/_inbox/settings/organization/boat")({
  beforeLoad: guardSettingsPage("o-boat"),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(boatKeyStatusOptions(trpc)),
  component: BoatPage,
});
