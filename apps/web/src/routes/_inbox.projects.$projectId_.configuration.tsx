import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { PendingScreen } from "#/components/route-screens";
import { oldProjectAnchorPath } from "#/lib/settings-pages";

/**
 * The old app's project Configuration page (`/projects/<id>/configuration#<section>`): each of its
 * sections opens the page that holds that setting now, and no section opens General. The fragment
 * never reaches the server, so the browser reads it once the page is up.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/configuration")({
  component: OldConfiguration,
});

function OldConfiguration() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ href: oldProjectAnchorPath(projectId, window.location.hash), replace: true });
  }, [navigate, projectId]);
  return <PendingScreen />;
}
