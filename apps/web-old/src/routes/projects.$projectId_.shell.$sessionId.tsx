import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  redirect,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";

import { Button } from "#/components/kit/button";
import { Page, PageHeader } from "#/components/kit/page";
import { ShellPage } from "#/components/project/tabs/shell-page";
import { AppShell } from "#/components/shell";
import { useTRPC } from "#/lib/trpc";

/**
 * A shell in a worktree's workspace (screen K10). The session and its project are read together;
 * a session that is not a shell has its own page, so its id goes there instead.
 */
export const Route = createFileRoute("/projects/$projectId_/shell/$sessionId")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    const [detail] = await Promise.all([
      queryClient.ensureQueryData(trpc.sessions.detail.queryOptions({ id: params.sessionId })),
      queryClient.ensureQueryData(trpc.projects.detail.queryOptions({ id: params.projectId })),
    ]);
    if (detail.session.harness !== "shell")
      throw redirect({
        to: "/sessions/$sessionId",
        params: { sessionId: params.sessionId },
        replace: true,
      });
  },
  errorComponent: ShellError,
  component: ShellRoute,
});

function ShellRoute() {
  const { projectId, sessionId } = Route.useParams();
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.sessions.detail.queryOptions({ id: sessionId })).data;
  const project = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  return (
    <AppShell layout="bare" projectId={projectId}>
      <ShellPage detail={detail} project={project} />
    </AppShell>
  );
}

function ShellError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <AppShell layout="bare">
      <Page>
        <PageHeader title="This shell did not load" />
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
