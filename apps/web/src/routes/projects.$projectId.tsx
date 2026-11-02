import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";

import { Button } from "#/components/kit/button";
import { Page, PageHeader } from "#/components/kit/page";
import { ProjectFrame } from "#/components/project/project-frame";
import { projectResourcesOptions } from "#/components/project/tabs/resources";
import { AppShell } from "#/components/shell";
import { useVisibleDetail } from "#/lib/project-settings";
import { useTRPC } from "#/lib/trpc";

/**
 * The project layout: the header and tab line around every project tab and settings section.
 * The tabs are child routes, so moving between them swaps only the <Outlet>: the project detail is
 * read once here and every tab reads it from the cache instead of fetching it again. The counts on
 * the tab line start loading beside it, so the line never waits on them.
 */
export const Route = createFileRoute("/projects/$projectId")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    const projectId = params.projectId;
    void queryClient.prefetchQuery(projectResourcesOptions(trpc, projectId, null));
    void queryClient.prefetchQuery(trpc.skills.forProject.queryOptions({ id: projectId }));
    await queryClient.ensureQueryData(trpc.projects.detail.queryOptions({ id: projectId }));
  },
  errorComponent: ProjectError,
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const detail = useVisibleDetail(
    useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data,
  );

  return (
    <AppShell layout="bare" projectId={projectId}>
      <ProjectFrame detail={detail}>
        <Outlet />
      </ProjectFrame>
    </AppShell>
  );
}

function ProjectError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <AppShell layout="bare">
      <Page>
        <PageHeader eyebrow="project" title="This project did not load" />
        <p role="alert" className="font-mono text-[12.5px] text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <Button className="mt-4" onClick={() => void router.invalidate()}>
          Try again
        </Button>
      </Page>
    </AppShell>
  );
}
