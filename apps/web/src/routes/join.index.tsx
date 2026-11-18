import { createFileRoute } from "@tanstack/react-router";

import { JoinPage } from "#/components/join-page";

export const Route = createFileRoute("/join/")({
  // The invitation's token rides the fragment, which never reaches the server.
  ssr: false,
  component: JoinPage,
});
