import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/organization/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/organization/members", replace: true });
  },
});
