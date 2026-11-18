import { createFileRoute } from "@tanstack/react-router";

import { ResetPassword } from "#/components/reset-password";

export const Route = createFileRoute("/reset/")({
  // The reset link's secret rides the fragment, which never reaches the server.
  ssr: false,
  component: ResetPassword,
});
