import { createFileRoute } from "@tanstack/react-router";

import { GitAccessStep } from "#/components/git-access-step";
import { gitAccessOptions } from "#/lib/git-access";
import { openGitAccessStep } from "#/lib/git-access-step";

/**
 * `/welcome/git-access`, the Git access step's own page: Command line's Continue, the steps beside
 * the sheet and the phone's back arrow open it. It shows the step with what the person chose,
 * however far they got, so they can change it and continue to Agent login again.
 */
export const Route = createFileRoute("/welcome/git-access")({
  // Reading Git access can make the Mend key, which belongs to the browser's visit, not a render.
  ssr: false,
  loader: async ({ context: { queryClient, trpc, trpcClient } }) => {
    const access = await queryClient.fetchQuery(gitAccessOptions(trpc));
    await openGitAccessStep({ queryClient, trpc, trpcClient, access });
  },
  component: GitAccessStep,
});
