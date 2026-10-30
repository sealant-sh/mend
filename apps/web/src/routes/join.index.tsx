import { createFileRoute } from "@tanstack/react-router";

import { JoinPage } from "#/components/join-page";

export const Route = createFileRoute("/join/")({
  ssr: false,
  component: JoinPage,
});
