import { createFileRoute } from "@tanstack/react-router";

import { AgentLoginsPage } from "#/components/settings/agent-logins-page";
import { gitAccessOptions } from "#/lib/git-access";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → Account → Agent logins and Git: the person's agent logins, GitHub's login for gh,
 * the Git author, the Mend key and the Git access mode. Old `/settings/git-access` lands here.
 */
export const Route = createFileRoute("/_inbox/settings/agent-logins")({
  beforeLoad: guardSettingsPage("a-logins"),
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.platform.sealantIdentity.queryOptions()),
      queryClient.ensureQueryData(trpc.platform.agentLogins.queryOptions()),
      queryClient.ensureQueryData(trpc.git.author.queryOptions()),
      queryClient.ensureQueryData(gitAccessOptions(trpc)),
    ]),
  component: AgentLoginsPage,
});
