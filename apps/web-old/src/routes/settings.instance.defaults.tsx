import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Instance · Defaults held only the instance's automation switches, which nothing reads any more:
 * each person's own are what count (docs/adr/0025-one-home-per-setting.md). An old link lands on
 * Instance · Environment.
 */
export const Route = createFileRoute("/settings/instance/defaults")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/instance/environment", replace: true });
  },
});
