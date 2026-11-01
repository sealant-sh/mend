import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { startSetupSession, type Harness } from "#/lib/session-launch";
import { useTRPC } from "#/lib/trpc";

/** Explicit consent, shared by adoption and the project's later setup action. */
export function SetupSessionPanel({
  projectId,
  onClose,
}: {
  readonly projectId: string;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const identity = useQuery(trpc.platform.sealantIdentity.queryOptions());
  const agents = (["claude", "codex"] satisfies Harness[]).filter((agent) =>
    identity.data?.accounts.some(
      (account) => account.provider === agent && account.status === "active",
    ),
  );
  const [chosen, setChosen] = useState<Harness | null>(null);
  const agent = agents.find((candidate) => candidate === chosen) ?? agents[0];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (agent === undefined || pending) return;
    setPending(true);
    setError(null);
    try {
      await startSetupSession(navigate, { queryClient, trpc }, projectId, agent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="rounded-2xl bg-card p-5 shadow-sm" aria-label="Set up this project">
      <h2 className="text-sm font-medium">Set up this project</h2>
      <p className="mt-2 max-w-[64ch] text-sm leading-relaxed text-muted-foreground">
        A setup session studies the repository and proposes .mend/ files for you to review. It uses
        your own agent login. Writing these files starts no commands, Services or resources.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="text-xs text-label">Agent</span>
        {agents.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={candidate === agent}
            disabled={pending}
            onClick={() => setChosen(candidate)}
            className={`rounded-lg border px-3 py-2 text-xs ${candidate === agent ? "border-primary bg-wash" : "border-border"}`}
          >
            {candidate}
          </button>
        ))}
        <button
          type="button"
          disabled={agent === undefined || pending}
          onClick={() => void start()}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-cobalt disabled:opacity-50"
        >
          {pending ? "Starting…" : "Set up this project"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onClose}
          className="rounded-xl px-3 py-2 text-sm text-muted-foreground"
        >
          Not now
        </button>
      </div>
      {identity.isPending ? (
        <p className="mt-3 text-xs text-muted-foreground">Reading connected agents…</p>
      ) : null}
      {identity.isError ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          Could not read connected agents. {identity.error.message}
        </p>
      ) : null}
      {!identity.isPending && !identity.isError && agents.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Connect Claude or Codex in{" "}
          <Link to="/settings" hash="accounts">
            Settings → Accounts
          </Link>{" "}
          to start a setup session.
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
