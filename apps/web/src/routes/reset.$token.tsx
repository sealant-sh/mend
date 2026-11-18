import { createFileRoute } from "@tanstack/react-router";

import { toFragmentForm } from "#/lib/handed-links";

/** An older `/reset/<token>` link opens the same page as `/reset#<token>`. */
export const Route = createFileRoute("/reset/$token")({
  ssr: false,
  beforeLoad: toFragmentForm("passwordReset"),
});
