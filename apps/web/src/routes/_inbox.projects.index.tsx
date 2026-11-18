import { createFileRoute } from "@tanstack/react-router";

import { ProjectsPage } from "#/components/projects/projects-page";
import { signedInOptions } from "#/lib/sign-in";

/**
 * Projects: the projects the person can see, adding one, and removing one. A project's own page
 * (`/projects/<id>`) is a later route.
 */
export const Route = createFileRoute("/_inbox/projects/")({
  // The list is the page; the rest (open sessions, removed projects, who added each) is read beside
  // it and drawn as it arrives.
  loader: async ({ context: { queryClient, trpc } }) => {
    void queryClient.prefetchQuery(trpc.sessions.listActive.queryOptions());
    void queryClient.prefetchQuery(trpc.projects.removed.queryOptions());
    await Promise.all([
      queryClient.ensureQueryData(trpc.projects.list.queryOptions()),
      queryClient.ensureQueryData(signedInOptions(trpc)),
    ]);
  },
  component: ProjectsPage,
});
