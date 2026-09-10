import { Button } from "@mend/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { GitAccessPanel } from "#/components/git-access-panel";
import { SetupFrame } from "#/components/setup-frame";
import { setGitAccess } from "#/lib/api";
import { safeNextPath } from "#/lib/onboarding";
import { useTRPC } from "#/lib/trpc";

export const Route = createFileRoute("/welcome")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { readonly next?: string } => {
    const next = safeNextPath(search["next"]);
    return next === "/" ? {} : { next };
  },
  // The key is the point of the page. When the account's choice is (or defaults
  // to) the Mend key and none exists yet, create it before first paint, so the
  // visitor sees what to add on the git host — not a button asking permission.
  loader: async ({ context: { queryClient, trpc } }) => {
    const access = await queryClient.ensureQueryData(trpc.git.access.queryOptions());
    if (access.mode === "mend-key" && !access.key.exists) {
      await setGitAccess("mend-key");
      await queryClient.invalidateQueries(trpc.git.pathFilter());
    }
  },
  component: WelcomePage,
});

/**
 * Step two of first contact: how this account reaches its repositories. The
 * same panel Settings keeps, framed once as a question; the answer is saved
 * as it is chosen, so leaving early loses nothing.
 */
function WelcomePage() {
  const navigate = useNavigate();
  const next = Route.useSearch().next ?? "/";
  const trpc = useTRPC();
  const access = useSuspenseQuery(trpc.git.access.queryOptions()).data;

  const observed =
    access.mode === "mend-key"
      ? access.key.exists
        ? "key created · add it to your git account"
        : "no key yet"
      : access.bridge.connected
        ? `signer connected · ${access.bridge.clientName ?? "unknown machine"}`
        : "no signer yet · connects while a mend command runs";

  return (
    <SetupFrame step={2} width="wide">
      <h1 className="font-display text-lg font-semibold tracking-[-0.01em]">Git access</h1>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-muted-foreground">
        How Mend reaches your repositories: with a key of yours held on this server, or through the
        ssh-agent on your machine. New projects adopt with the answer; a project&apos;s setup page
        can override it, and{" "}
        <Link
          to="/settings"
          hash="git-access"
          className="text-ink-2 underline decoration-rule underline-offset-2 hover:text-ink"
        >
          Settings
        </Link>{" "}
        keeps it.
      </p>
      <div className="mt-6">
        <GitAccessPanel compact />
      </div>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-[var(--sw-faint-rule)] pt-5">
        <p className="min-w-0 font-mono text-[12px] text-faint">{observed}</p>
        <Button
          type="button"
          size="lg"
          onClick={() => {
            if (next === "/") void navigate({ to: "/" });
            else window.location.assign(next);
          }}
        >
          Continue to Mend
        </Button>
      </div>
    </SetupFrame>
  );
}
