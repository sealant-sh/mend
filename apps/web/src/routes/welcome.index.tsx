import { createFileRoute, redirect } from "@tanstack/react-router";

import { GitAccessStep } from "#/components/git-access-step";
import { accountNameOptions } from "#/lib/auth-client";
import { gitAccessOptions } from "#/lib/git-access";
import { ENTRY_PATHS, readSetup, welcomeEntry } from "#/lib/setup";

/**
 * `/welcome`, the way into setup and its Git access step. Creating the first account and joining
 * from an invitation land here; a person who has finished setup goes on to `/`, and one whose next
 * step is First project goes there (`welcomeEntry`).
 */
export const Route = createFileRoute("/welcome/")({
  // Reading Git access can make the Mend key, which belongs to the browser's visit, not a render.
  ssr: false,
  loader: async ({ context: { queryClient, trpc, trpcClient } }) => {
    const observed = await readSetup({ queryClient, trpc });
    const { access } = observed;
    const entry = await welcomeEntry(observed);
    if (entry !== "git-access") throw redirect({ href: ENTRY_PATHS[entry] });
    // The key is what this step is about: with the Mend key chosen (or left as the default) and
    // none made yet, make it before the page opens, so the person sees what to add to GitHub.
    if (access.mode === "mend-key" && !access.key.exists) {
      const key = await trpcClient.git.initKey.mutate();
      queryClient.setQueryData(gitAccessOptions(trpc).queryKey, { ...access, key });
    }
    await queryClient.ensureQueryData(accountNameOptions());
  },
  component: GitAccessStep,
});
