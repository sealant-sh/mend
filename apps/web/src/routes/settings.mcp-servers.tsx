import { createFileRoute } from "@tanstack/react-router";

import { McpServersSettings, mcpServersOptions } from "#/components/settings/mcp-servers";

export const Route = createFileRoute("/settings/mcp-servers")({
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(mcpServersOptions(trpc)),
  component: McpServersSettings,
});
