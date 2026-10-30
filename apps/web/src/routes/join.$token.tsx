import { createFileRoute } from "@tanstack/react-router";

import { toFragmentForm } from "#/lib/handed-links";

export const Route = createFileRoute("/join/$token")({
  ssr: false,
  beforeLoad: toFragmentForm("invitation"),
});
