import { createFileRoute } from "@tanstack/react-router";

import { OrganizationProjectsPage } from "#/components/settings/organization-projects-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → the organization → Projects: projects whose creator left, and the volumes kept from
 * removed projects, for the organization's owners. Anyone else is sent to Profile before the page
 * reads anything (the server answers them 404).
 */
export const Route = createFileRoute("/_inbox/settings/organization/projects")({
  beforeLoad: guardSettingsPage("o-projects"),
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.organization.orphanedProjects.queryOptions()),
      queryClient.ensureQueryData(trpc.organization.resourceArchives.queryOptions()),
    ]),
  component: OrganizationProjectsPage,
});
