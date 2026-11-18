import { createFileRoute } from "@tanstack/react-router";

import { ProjectsPage } from "#/components/projects/projects-page";
import { signedInOptions } from "#/lib/sign-in";

/**
 * Projects: the projects the person can see, adding one, and removing one. A project's own page
 * (`/projects/<id>`) is a later route.
 */
/** `?add=true` opens Add project… on arrival: search's "Add project…" links here so. */
interface ProjectsSearch {
  readonly add?: true;
}

export const Route = createFileRoute("/_inbox/projects/")({
  validateSearch: (search: Record<string, unknown>): ProjectsSearch =>
    search["add"] === true || search["add"] === "true" ? { add: true } : {},
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
