import { createFileRoute } from "@tanstack/react-router";

import { toFragmentForm } from "#/lib/handed-links";

export const Route = createFileRoute("/slack/link/$code")({
  ssr: false,
  beforeLoad: toFragmentForm("slackLink"),
});
