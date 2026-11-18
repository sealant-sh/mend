import { createFileRoute } from "@tanstack/react-router";

import { NotFoundScreen } from "#/components/route-screens";

/**
 * Any signed-in path no route owns yet, home among them until the composer's route: the
 * not-found screen on the frame's sheet, beside the inbox.
 */
export const Route = createFileRoute("/_inbox/$")({
  component: NotFoundScreen,
});
