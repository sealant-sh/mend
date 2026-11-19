import { createFileRoute } from "@tanstack/react-router";

import { AuditLogPage, auditPages } from "#/components/settings/audit-log-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → the organization → Audit log: what people did in the organization, for its owners.
 * Anyone else is sent to Profile before the page reads anything (the server answers them 404).
 */
export const Route = createFileRoute("/_inbox/settings/organization/audit-log")({
  beforeLoad: guardSettingsPage("o-audit"),
  loader: ({ context: { queryClient, trpc, trpcClient } }) =>
    queryClient.ensureInfiniteQueryData(auditPages(trpc, trpcClient)),
  component: AuditLogPage,
});
