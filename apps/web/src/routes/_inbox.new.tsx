import { createFileRoute } from "@tanstack/react-router";

import { newSessionLoader } from "#/components/new-session/loader";
import { NewSessionPage } from "#/components/new-session/new-session-page";

/**
 * The New session composer as its own screen, where the phone inbox's New session leads (Doop
 * "Phone · New session"). On a wide screen it is the same composer as home.
 */
export const Route = createFileRoute("/_inbox/new")({
  loader: newSessionLoader,
  component: NewSessionPage,
});
