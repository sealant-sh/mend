import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The old app's page for a session still being made (`/starting/<draft>`). The New session
 * composer now makes the session first and opens its own page, so no draft address is handed out;
 * one kept from before goes home, where the composer is.
 */
export const Route = createFileRoute("/_inbox/starting/$draftId")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
