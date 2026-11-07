import { createFileRoute } from "@tanstack/react-router";

import { StartingSession } from "#/components/session/starting-session";

export const Route = createFileRoute("/_inbox/starting/$draftId")({
  ssr: false,
  component: StartingPage,
});

function StartingPage() {
  return <StartingSession draftId={Route.useParams().draftId} />;
}
