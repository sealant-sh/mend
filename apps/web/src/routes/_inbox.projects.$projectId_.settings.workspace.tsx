import { createFileRoute } from "@tanstack/react-router";

import { ProjectWorkspacePage } from "#/components/settings/project-workspace-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → a project → Workspace: the project's own image, its dependency install and its ready
 * workspaces. The old app's `/projects/<id>/configuration#environment`, `#install-command` and
 * `#hot-sessions` land here through `lib/settings-pages.ts`.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/settings/workspace")({
  beforeLoad: guardSettingsPage("p-workspace"),
  component: WorkspaceRoute,
});

function WorkspaceRoute() {
  const { projectId } = Route.useParams();
  return <ProjectWorkspacePage projectId={projectId} />;
}
