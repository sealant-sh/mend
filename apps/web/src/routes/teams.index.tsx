import { teamNameIssue } from "@mend/domain/workbench";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AppShell } from "#/components/shell";
import { createTeam } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";
import { useWorkbenchEvents } from "#/lib/workbench-events";

/** The teams the signed-in account belongs to, and the one place a team is created. */
export const Route = createFileRoute("/teams/")({
  ssr: false,
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(context.trpc.teams.list.queryOptions());
  },
  component: TeamsPage,
});

function TeamsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const teams = useSuspenseQuery(trpc.teams.list.queryOptions()).data;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useWorkbenchEvents();

  const submit = async () => {
    const issue = teamNameIssue(name);
    if (issue !== null) {
      setError(issue);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const created = await createTeam(name.trim());
      await queryClient.invalidateQueries(trpc.teams.pathFilter());
      setName("");
      setCreating(false);
      await navigate({ to: "/teams/$teamId", params: { teamId: created.team.id } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <AppShell>
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <p className="ev-eyebrow">people</p>
            <h1 className="mt-2 font-display text-3xl font-medium tracking-tight text-foreground">
              Teams
            </h1>
            <p className="mt-2 max-w-[60ch] text-sm text-muted-foreground">
              A team is a group of accounts on this Mend. A project scoped to a team is visible to
              its members and nobody else; your personal projects stay yours.
            </p>
            {teams.length > 0 && (
              <p className="mt-2 font-mono text-[11.5px] text-faint">
                {teams.length} team{teams.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-expanded={creating}
            aria-controls="create-team"
            onClick={() => setCreating((open) => !open)}
            className="mt-1 shrink-0 rounded-xl border border-border bg-card px-3.5 py-2 font-sans text-[13px] font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5"
          >
            {creating ? "Close" : "New team"}
          </button>
        </div>

        <div id="create-team" className="mt-6" hidden={!creating}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="rounded-2xl bg-card p-5 shadow-sm"
          >
            <p className="text-xs font-medium text-label">New team</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                aria-label="Team name"
                placeholder="name"
                className="w-full min-w-0 flex-1 basis-64 rounded-lg border border-input bg-background px-3 py-2 font-sans text-sm text-foreground placeholder:text-faint"
              />
              <button
                type="submit"
                disabled={pending || name.trim() === ""}
                className="rounded-xl bg-primary px-4 py-2 font-sans text-sm font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-opacity disabled:opacity-50"
              >
                {pending ? "Creating…" : "Create"}
              </button>
            </div>
            {error !== null && (
              <p
                role="alert"
                className="mt-3 border-l-2 border-[var(--sw-red)] pl-2 font-mono text-xs text-danger"
              >
                {error}
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              You become its first owner. Owners add members and invite links; members work in its
              projects.
            </p>
          </form>
        </div>

        {teams.length === 0 ? (
          <p className="mt-8 text-sm text-muted-foreground">
            You are not in a team yet. Create one, or ask a team owner for an invite link.
          </p>
        ) : (
          <div className="mt-8 overflow-hidden rounded-2xl border border-rule bg-card shadow-xs">
            <div className="hidden items-center gap-4 border-b border-rule px-4 py-2 md:flex">
              <span className="ev-eyebrow min-w-0 flex-1">team</span>
              <span className="ev-eyebrow w-[92px] shrink-0">your seat</span>
              <span className="ev-eyebrow w-[92px] shrink-0">members</span>
              <span className="ev-eyebrow w-[92px] shrink-0">projects</span>
            </div>
            {teams.map((entry, index) => (
              <Link
                key={entry.team.id}
                to="/teams/$teamId"
                params={{ teamId: entry.team.id }}
                className={`flex items-center gap-4 px-4 py-2.5 no-underline transition-colors outline-offset-[-2px] hover:bg-secondary ${
                  index === 0 ? "" : "border-t border-rule-faint"
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-medium text-foreground">
                  {entry.team.name}
                </span>
                <span className="w-[92px] shrink-0 font-mono text-[11.5px] text-ink-2">
                  {entry.role}
                </span>
                <span className="w-[92px] shrink-0 font-mono text-[11.5px] text-faint">
                  {entry.memberCount}
                </span>
                <span className="w-[92px] shrink-0 font-mono text-[11.5px] text-faint">
                  {entry.projectCount}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
