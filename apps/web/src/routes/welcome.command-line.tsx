import { createFileRoute } from "@tanstack/react-router";

import { CommandLineStep } from "#/components/command-line-step";
import { accountNameOptions } from "#/lib/auth-client";
import { signedInOptions } from "#/lib/sign-in";

/**
 * `/welcome/command-line`, setup's Command line step, where creating an account or joining from
 * an invitation lands. It stays open after setup, so going back to it works.
 */
export const Route = createFileRoute("/welcome/command-line")({
  // `mend login --url` names this server by the address the browser reached it at.
  ssr: false,
  loader: async ({ context: { queryClient, trpc } }) => {
    await Promise.all([
      queryClient.ensureQueryData(signedInOptions(trpc)),
      queryClient.ensureQueryData(trpc.devices.list.queryOptions()),
      queryClient.ensureQueryData(accountNameOptions()),
    ]);
  },
  component: CommandLineStep,
});
