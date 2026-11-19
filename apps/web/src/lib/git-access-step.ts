import type { GitAccessView } from "@mend/api-contracts";
import type { QueryClient } from "@tanstack/react-query";

import { accountNameOptions } from "./auth-client.ts";
import { gitAccessOptions } from "./git-access.ts";
import { rememberStepReached } from "./setup.ts";
import { signedInOptions } from "./sign-in.ts";
import type { TrpcClient, TrpcProxy } from "./trpc.ts";

/**
 * What both pages that show the Git access step read before it opens: `/welcome`, while the step
 * is owed, and `/welcome/git-access`, the step's own page.
 */
export const openGitAccessStep = async ({
  queryClient,
  trpc,
  trpcClient,
  access,
}: {
  readonly queryClient: QueryClient;
  readonly trpc: TrpcProxy;
  readonly trpcClient: TrpcClient;
  readonly access: GitAccessView;
}): Promise<void> => {
  // The key is what this step is about: with the Mend key chosen (or left as the default) and
  // none made yet, make it before the page opens, so the person sees what to add to GitHub.
  if (access.mode === "mend-key" && !access.key.exists) {
    const key = await trpcClient.git.initKey.mutate();
    queryClient.setQueryData(gitAccessOptions(trpc).queryKey, { ...access, key });
  }
  const [viewer] = await Promise.all([
    queryClient.ensureQueryData(signedInOptions(trpc)),
    queryClient.ensureQueryData(accountNameOptions()),
  ]);
  rememberStepReached(viewer, "git");
};
