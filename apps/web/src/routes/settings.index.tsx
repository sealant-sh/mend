import { createFileRoute, redirect } from "@tanstack/react-router";

import { legacyAnchorRedirect } from "#/lib/settings-tabs";

/** `/settings` opens Account; an anchor from the old single page opens the tab that holds it. */
export const Route = createFileRoute("/settings/")({
  beforeLoad: ({ location }) => {
    throw redirect({ ...legacyAnchorRedirect(location.hash), replace: true });
  },
});
