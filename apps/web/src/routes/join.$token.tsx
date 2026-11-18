import { createFileRoute } from "@tanstack/react-router";

import { toFragmentForm } from "#/lib/handed-links";

/** An older `/join/<token>` link opens the same page as `/join#<token>`. */
export const Route = createFileRoute("/join/$token")({
  ssr: false,
  beforeLoad: toFragmentForm("invitation"),
});
