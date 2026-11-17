import { createFileRoute } from "@tanstack/react-router";

import { toFragmentForm } from "#/lib/handed-links";

export const Route = createFileRoute("/reset/$token")({
  ssr: false,
  beforeLoad: toFragmentForm("passwordReset"),
});
