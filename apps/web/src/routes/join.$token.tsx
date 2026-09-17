import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AppShell } from "#/components/shell";
import { acceptTeamInvite } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

/**
 * The invite link's landing page. Signed-out visitors go through the login walk with this
 * path as `next` (the query's 401 does that), register if they have no account, and come
 * back here to take the seat.
 */
export const Route = createFileRoute("/join/$token")({
  ssr: false,
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      context.trpc.teams.invitePreview.queryOptions({ token: params.token }),
    );
  },
  component: JoinPage,
});

const STATE_COPY = {
  accepted: "This invite was already used.",
  revoked: "This invite was revoked by a team owner.",
  expired: "This invite has expired. Ask a team owner for a new link.",
} as const;

function JoinPage() {
  const { token } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const preview = useSuspenseQuery(trpc.teams.invitePreview.queryOptions({ token })).data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const joined = await acceptTeamInvite(token);
      await queryClient.invalidateQueries();
      await navigate({ to: "/teams/$teamId", params: { teamId: joined.team.id } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-[560px] min-w-0">
        <p className="ev-eyebrow">invitation</p>
        <h1 className="mt-2 font-display text-3xl font-medium tracking-tight text-foreground">
          {preview.teamName}
        </h1>
        <p className="mt-2 font-mono text-[11.5px] text-faint">
          as {preview.role}
          {preview.invitedBy === null ? "" : ` · invited by ${preview.invitedBy}`}
          {preview.boundEmail === null ? "" : ` · for ${preview.boundEmail}`}
        </p>

        <div className="mt-8 rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
          {preview.alreadyMember ? (
            <>
              <p className="text-sm text-foreground">You are already a member of this team.</p>
              <Link
                to="/teams"
                className="mt-4 inline-block font-sans text-sm font-medium text-info underline-offset-2 hover:underline"
              >
                Open your teams
              </Link>
            </>
          ) : preview.state !== "open" ? (
            <p className="text-sm text-foreground">{STATE_COPY[preview.state]}</p>
          ) : (
            <>
              <p className="max-w-[48ch] text-sm leading-relaxed text-muted-foreground">
                Accepting gives this account a seat in the team: you will see its projects, start
                sessions in them, and review their changes.
              </p>
              <div className="mt-5 flex items-center gap-4">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void accept()}
                  className="rounded-xl bg-primary px-4 py-2 font-sans text-sm font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
                >
                  {pending ? "Joining…" : `Join ${preview.teamName}`}
                </button>
                <Link
                  to="/"
                  className="font-sans text-xs font-medium text-muted-foreground no-underline hover:text-foreground"
                >
                  Not now
                </Link>
              </div>
            </>
          )}
          {error !== null && (
            <p role="alert" className="mt-4 font-mono text-[12.5px] text-warning">
              {error}
            </p>
          )}
        </div>
      </div>
    </AppShell>
  );
}
