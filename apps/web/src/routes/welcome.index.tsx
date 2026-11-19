import { createFileRoute, redirect } from "@tanstack/react-router";

import { GitAccessStep } from "#/components/git-access-step";
import { openGitAccessStep } from "#/lib/git-access-step";
import { ENTRY_PATHS, readSetup, welcomeEntry } from "#/lib/setup";

/**
 * `/welcome`, the way into setup and its Git access step while that step is owed. A person who
 * has finished setup goes on to `/`, and one whose next step is Organization or First project goes
 * there (`welcomeEntry`). Going back to Git access from a later step opens its own page,
 * `/welcome/git-access`, which sends nobody on.
 */
export const Route = createFileRoute("/welcome/")({
  // Reading Git access can make the Mend key, which belongs to the browser's visit, not a render.
  ssr: false,
  loader: async ({ context: { queryClient, trpc, trpcClient } }) => {
    const observed = await readSetup({ queryClient, trpc });
    const entry = await welcomeEntry(observed);
    if (entry !== "git-access") throw redirect({ href: ENTRY_PATHS[entry] });
    await openGitAccessStep({ queryClient, trpc, trpcClient, access: observed.access });
  },
  component: GitAccessStep,
});
