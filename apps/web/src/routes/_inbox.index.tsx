import { createFileRoute, redirect } from "@tanstack/react-router";

import { newSessionLoader } from "#/components/new-session/loader";
import { NewSessionPage } from "#/components/new-session/new-session-page";
import { ENTRY_PATHS, readHomeEntry } from "#/lib/setup";

/**
 * Home: the New session composer on the sheet beside the sidebar. Under 1024px home is the inbox
 * (the layout draws it instead), and the composer is `/new`.
 *
 * Someone who hasn't finished setup and opens Mend here goes to their next step, as signing in
 * would send them (`homeEntry`), so closing the tab partway through setup loses nothing. For
 * anyone past setup the check reads only what the inbox and the composer already hold.
 */
export const Route = createFileRoute("/_inbox/")({
  loader: async (match) => {
    // The composer's reads start beside the check, so a person past setup waits for nothing more.
    const composer = newSessionLoader(match);
    const entry = await readHomeEntry(match.context);
    if (entry !== "home") {
      // Leaving: whatever the composer's reads do no longer matters.
      void composer.catch(() => undefined);
      throw redirect({ href: ENTRY_PATHS[entry] });
    }
    await composer;
  },
  component: NewSessionPage,
});
