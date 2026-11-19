import { createFileRoute } from "@tanstack/react-router";

import { McpServersPage } from "#/components/settings/mcp-servers-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/** Settings → Account → MCP servers: the person's own servers, and their Executor services. */
export const Route = createFileRoute("/_inbox/settings/mcp-servers")({
  beforeLoad: guardSettingsPage("a-mcp"),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.mcpServers.list.queryOptions()),
  component: McpServersPage,
});
