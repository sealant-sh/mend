import { createFileRoute, redirect } from "@tanstack/react-router";

import { legacyAnchorTarget } from "#/lib/settings-tabs";

/** `/settings` opens Account; an anchor from the old single page opens the tab that holds it. */
export const Route = createFileRoute("/settings/")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: legacyAnchorTarget(location.hash), replace: true });
  },
});
