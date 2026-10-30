import { createFileRoute } from "@tanstack/react-router";

import { SlackLinkPage } from "#/components/slack-link-page";

export const Route = createFileRoute("/slack/link/")({
  ssr: false,
  component: SlackLinkPage,
});
