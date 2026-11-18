import { createFileRoute } from "@tanstack/react-router";

import { newSessionLoader } from "#/components/new-session/loader";
import { NewSessionPage } from "#/components/new-session/new-session-page";

/**
 * Home: the New session composer on the sheet beside the sidebar. Under 1024px home is the inbox
 * (the layout draws it instead), and the composer is `/new`.
 */
export const Route = createFileRoute("/_inbox/")({
  loader: newSessionLoader,
  component: NewSessionPage,
});
