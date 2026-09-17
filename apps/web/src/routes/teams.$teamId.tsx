import { TeamId } from "@mend/domain";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { AppShell } from "#/components/shell";
import {
  InvitesPanel,
  MembersPanel,
  TeamHeader,
  TeamProjectsPanel,
} from "#/components/team-detail";
import { authClient } from "#/lib/auth-client";
import { useTRPC } from "#/lib/trpc";
import { useWorkbenchEvents } from "#/lib/workbench-events";

/** One team: roster, invite links (owners), and the projects scoped to it. */
export const Route = createFileRoute("/teams/$teamId")({
  ssr: false,
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      context.trpc.teams.detail.queryOptions({ id: TeamId.make(params.teamId) }),
    );
  },
  component: TeamPage,
});

function TeamPage() {
  const { teamId } = Route.useParams();
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.teams.detail.queryOptions({ id: TeamId.make(teamId) })).data;
  const session = authClient.useSession();
  const currentUserId = session.data?.user.id ?? null;
  useWorkbenchEvents();

  return (
    <AppShell>
      <div className="min-w-0">
        <Link
          to="/teams"
          className="font-mono text-[11.5px] text-faint no-underline hover:text-foreground"
        >
          ← teams
        </Link>
        <div className="mt-4">
          <TeamHeader detail={detail} currentUserId={currentUserId} />
        </div>
        <div className="mt-8 space-y-6">
          <MembersPanel detail={detail} currentUserId={currentUserId} />
          {detail.role === "owner" && <InvitesPanel detail={detail} />}
          <TeamProjectsPanel detail={detail} />
        </div>
      </div>
    </AppShell>
  );
}
