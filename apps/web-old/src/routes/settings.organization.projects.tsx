import { createFileRoute } from "@tanstack/react-router";

import { ProjectsTab } from "#/components/settings/org-projects";
import { requireOrganization } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/organization/projects")({
  beforeLoad: ({ context }) => requireOrganization(context, "owner"),
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.organization.orphanedProjects.queryOptions()),
      queryClient.ensureQueryData(trpc.organization.resourceArchives.queryOptions()),
    ]),
  component: ProjectsTab,
});
