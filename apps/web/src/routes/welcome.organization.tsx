import { createFileRoute, redirect } from "@tanstack/react-router";

import { OrganizationStep } from "#/components/organization-step";
import { accountNameOptions } from "#/lib/auth-client";
import { gitAccessChosen, namesOrganization, SETUP_PATHS } from "#/lib/setup";
import { signedInOptions } from "#/lib/sign-in";

/**
 * `/welcome/organization`, the first account's Organization step, after Agent login and before
 * First project. Only the person who names the organization (`namesOrganization`) has it; anyone
 * else goes on to First project. It comes after Git access: without it, the person goes back
 * there. It stays open after setup, so going back to it works.
 */
export const Route = createFileRoute("/welcome/organization")({
  // The steps beside the sheet name this server by the address the browser reached it at.
  ssr: false,
  loader: async ({ context: { queryClient, trpc } }) => {
    void queryClient.prefetchQuery(trpc.platform.sealantIdentity.queryOptions());
    const [viewer, access] = await Promise.all([
      queryClient.ensureQueryData(signedInOptions(trpc)),
      queryClient.ensureQueryData(trpc.git.access.queryOptions()),
      queryClient.ensureQueryData(trpc.organization.settings.queryOptions()),
      queryClient.ensureQueryData(accountNameOptions()),
    ]);
    if (!gitAccessChosen(access)) throw redirect({ href: SETUP_PATHS.gitAccess });
    if (!namesOrganization(viewer)) throw redirect({ href: SETUP_PATHS.firstProject });
  },
  component: OrganizationStep,
});
