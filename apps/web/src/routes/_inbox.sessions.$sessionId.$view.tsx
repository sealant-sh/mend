import { createFileRoute, notFound } from "@tanstack/react-router";

import { workspaceView } from "#/components/workspace/views";

/**
 * A view's own address, `/sessions/<id>/<view>` (`/sessions/<id>/terminal`): the session's sheet,
 * as its parent route draws it, with that view's tab showing and focused, added beside the active
 * session tab when it isn't open. One route serves every view in `WORKSPACE_VIEWS`, so a view
 * gets its address with its entry; any other name is not found. The parent stays mounted when
 * the address moves between the session and its views, so no tab's body starts again.
 */
export const Route = createFileRoute("/_inbox/sessions/$sessionId/$view")({
  beforeLoad: ({ params }) => {
    if (workspaceView(params.view) === undefined) throw notFound();
  },
});
