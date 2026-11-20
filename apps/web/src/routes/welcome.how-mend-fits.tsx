import { createFileRoute } from "@tanstack/react-router";

import { HowMendFitsStep } from "#/components/how-mend-fits-step";
import { accountNameOptions } from "#/lib/auth-client";
import { screenOf } from "#/lib/how-mend-fits-screen";
import { rememberStepReached } from "#/lib/setup";
import { rememberSetupEnded } from "#/lib/setup-skips";
import { signedInOptions } from "#/lib/sign-in";

/**
 * `/welcome/how-mend-fits`, setup's last step: three screens on how Mend's parts nest, what a
 * session's page shows and what the sidebar lists (`?screen=1` to `3`). First project's Continue
 * and Skip for now open it; `/welcome` and signing in never do, so someone who finished setup
 * before this step existed isn't sent to it. Anyone may open it; it reads nothing it needs.
 * Reaching it ends setup in this browser (`rememberSetupEnded`).
 */
export const Route = createFileRoute("/welcome/how-mend-fits")({
  validateSearch: (search: Record<string, unknown>): { readonly screen?: 1 | 2 | 3 } => {
    const screen = screenOf(search["screen"]);
    return screen === 1 ? {} : { screen };
  },
  // The steps beside the sheet name this server by the address the browser reached it at, and the
  // pictures show the clone this browser started.
  ssr: false,
  loader: async ({ context: { queryClient, trpc } }) => {
    void queryClient.prefetchQuery(trpc.projects.list.queryOptions());
    void queryClient.prefetchQuery(trpc.organization.members.queryOptions());
    const [viewer] = await Promise.all([
      queryClient.ensureQueryData(signedInOptions(trpc)),
      queryClient.ensureQueryData(accountNameOptions()),
    ]);
    rememberStepReached(viewer, "nouns");
    // Every step the person owed is behind them: opening Mend no longer sends them to setup.
    rememberSetupEnded(viewer.userId);
  },
  component: HowMendFitsPage,
});

function HowMendFitsPage() {
  const { screen } = Route.useSearch();
  return <HowMendFitsStep screen={screen ?? 1} />;
}
