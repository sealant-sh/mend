import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, type ErrorComponentProps, Outlet } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";

import { ProjectOrClone } from "#/components/project/project-cloning";
import { ProjectFrame } from "#/components/project/project-frame";
import { RouteErrorScreen } from "#/components/route-screens";
import { useTRPC } from "#/lib/trpc";

interface ProjectSearch {
  /** The "Set up this project" dialog is open (`?setup=1`). */
  readonly setup?: true;
}

/**
 * A project (Doop "Project · sessions" and its siblings): the frame around every tab of it, the
 * header, the tabs and the facts, with the open tab below. The tabs are child routes, so moving
 * between them swaps only the outlet; the project is read once here, and each tab reads it from
 * the cache. VS Code's "Open in Mend" opens this address.
 *
 * An address whose project doesn't exist may be a clone still running under that key: it shows
 * the clone, then moves to the project when the clone finishes.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId")({
  validateSearch: (search: Record<string, unknown>): ProjectSearch =>
    search["setup"] === true || search["setup"] === 1 || search["setup"] === "1"
      ? { setup: true }
      : {},
  loader: async ({ context: { queryClient, trpc }, params }) => {
    void queryClient.prefetchQuery(trpc.skills.forProject.queryOptions({ id: params.projectId }));
    await queryClient.ensureQueryData(trpc.projects.detail.queryOptions({ id: params.projectId }));
  },
  errorComponent: ProjectError,
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const { setup } = Route.useSearch();
  const navigate = Route.useNavigate();
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  return (
    <ProjectFrame
      detail={detail}
      setupOpen={setup === true}
      onSetupOpenChange={(open) =>
        void navigate({
          to: ".",
          search: (prev) => {
            const { setup: _open, ...rest } = prev;
            return open ? { ...rest, setup: true as const } : rest;
          },
          replace: true,
        })
      }
    >
      <Outlet />
    </ProjectFrame>
  );
}

const notFound = (error: unknown): boolean =>
  error instanceof TRPCClientError && error.data?.code === "NOT_FOUND";

function ProjectError(props: ErrorComponentProps) {
  const { projectId } = Route.useParams();
  return notFound(props.error) ? (
    <ProjectOrClone id={projectId} />
  ) : (
    <RouteErrorScreen {...props} />
  );
}
