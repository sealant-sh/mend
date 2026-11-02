import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/instance/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/instance/environment", replace: true });
  },
});
