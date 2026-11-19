import { createFileRoute } from "@tanstack/react-router";

import { toFragmentForm } from "#/lib/handed-links";

/** An older `/slack/link/<code>` link opens the same page as `/slack/link#<code>`. */
export const Route = createFileRoute("/slack/link/$code")({
  ssr: false,
  beforeLoad: toFragmentForm("slackLink"),
});
