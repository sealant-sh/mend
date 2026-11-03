import { createFileRoute } from "@tanstack/react-router";

import { auditPages, AuditLogTab } from "#/components/settings/org-audit-log";
import { requireOrganization } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/organization/audit-log")({
  beforeLoad: ({ context }) => requireOrganization(context, "owner"),
  loader: ({ context: { queryClient, trpc, trpcClient } }) =>
    queryClient.ensureInfiniteQueryData(auditPages(trpc, trpcClient)),
  component: AuditLogTab,
});
