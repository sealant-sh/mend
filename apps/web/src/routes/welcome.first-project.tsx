import { createFileRoute, redirect } from "@tanstack/react-router";

import { FirstProjectStep } from "#/components/first-project-step";
import { accountNameOptions } from "#/lib/auth-client";
import { ENTRY_PATHS, firstProjectEntry, readSetup, rememberStepReached } from "#/lib/setup";
import { signedInOptions } from "#/lib/sign-in";

/**
 * `/welcome/first-project`, setup's First project step. It comes after Git access; the agent login
 * before it may have been skipped. Someone who can already see a project goes on to How Mend fits
 * together, the step after it (`firstProjectEntry`).
 */
export const Route = createFileRoute("/welcome/first-project")({
  // The clone this browser started is kept in its storage, which the server can't read.
  ssr: false,
  loader: async ({ context: { queryClient, trpc } }) => {
    void queryClient.prefetchQuery(trpc.platform.sealantIdentity.queryOptions());
    void queryClient.prefetchQuery(trpc.organization.members.queryOptions());
    const [observed, viewer] = await Promise.all([
      readSetup({ queryClient, trpc }),
      queryClient.ensureQueryData(signedInOptions(trpc)),
      queryClient.ensureQueryData(accountNameOptions()),
    ]);
    const entry = firstProjectEntry(observed);
    if (entry !== "first-project") throw redirect({ href: ENTRY_PATHS[entry] });
    rememberStepReached(viewer, "project");
  },
  component: FirstProjectStep,
});
