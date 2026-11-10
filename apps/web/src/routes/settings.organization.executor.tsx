import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/organization/executor")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/mcp-servers", hash: "executor", replace: true });
  },
});
