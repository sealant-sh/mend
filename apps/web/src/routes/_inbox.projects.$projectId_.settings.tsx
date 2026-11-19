import { createFileRoute, type ErrorComponentProps, Outlet } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";

import { RouteErrorScreen } from "#/components/route-screens";
import { RemovedProjectPage } from "#/components/settings/removed-project-page";

/**
 * A project's settings (`/projects/<id>/settings/…`): the layout every project settings page sits
 * in, inside Settings' own frame (the settings sidebar replaces the app's on these addresses). It
 * reads the project once, with what this person may do to it; each page reads it from the cache.
 *
 * A project settings page is one route file, `_inbox.projects.$projectId_.settings.<slug>.tsx`,
 * with `beforeLoad: guardSettingsPage("p-<id>")` and a body built from `SettingsPage`,
 * `SettingSection` and `SettingRow` (reading the project with `useProjectSettings`), and one
 * `case` in `settingsLink()` (`components/settings/settings-links.tsx`).
 *
 * A project that can't be read because it was removed shows its General page with Restore and
 * Purge…, at whichever of its settings addresses was open.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/settings")({
  loader: async ({ context: { queryClient, trpc }, params }) => {
    // The pages name people (who added the project, who can change it) from the roster.
    void queryClient.prefetchQuery(trpc.organization.members.queryOptions());
    await queryClient.ensureQueryData(trpc.projects.detail.queryOptions({ id: params.projectId }));
  },
  errorComponent: ProjectSettingsError,
  component: Outlet,
});

const notFound = (error: unknown): boolean =>
  error instanceof TRPCClientError && error.data?.code === "NOT_FOUND";

function ProjectSettingsError(props: ErrorComponentProps) {
  const { projectId } = Route.useParams();
  return notFound(props.error) ? (
    <RemovedProjectPage projectId={projectId} reset={props.reset} />
  ) : (
    <RouteErrorScreen {...props} />
  );
}
