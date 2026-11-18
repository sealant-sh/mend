import { createFileRoute, redirect } from "@tanstack/react-router";

import { AgentLoginStep } from "#/components/agent-login-step";
import { accountNameOptions } from "#/lib/auth-client";
import { gitAccessChosen, SETUP_PATHS } from "#/lib/setup";

/**
 * `/welcome/agent-login`, setup's Agent login step. It comes after Git access: someone who opens
 * it without Git access in place goes back to that step first.
 */
export const Route = createFileRoute("/welcome/agent-login")({
  // The commands name this server by the address the browser reached it at.
  ssr: false,
  loader: async ({ context: { queryClient, trpc } }) => {
    const [access] = await Promise.all([
      queryClient.ensureQueryData(trpc.git.access.queryOptions()),
      queryClient.ensureQueryData(trpc.platform.sealantIdentity.queryOptions()),
      queryClient.ensureQueryData(accountNameOptions()),
    ]);
    if (!gitAccessChosen(access)) throw redirect({ href: SETUP_PATHS.gitAccess });
  },
  component: AgentLoginStep,
});
