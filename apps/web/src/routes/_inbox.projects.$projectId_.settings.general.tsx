import { createFileRoute } from "@tanstack/react-router";

import { ProjectGeneralPage } from "#/components/settings/project-general-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → a project → General: its name, repository, default branch, who can see it, the setup
 * session and removing it. `/projects/<id>/settings` opens the same page on the desk.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/settings/general")({
  beforeLoad: guardSettingsPage("p-general"),
  component: GeneralRoute,
});

function GeneralRoute() {
  const { projectId } = Route.useParams();
  return <ProjectGeneralPage projectId={projectId} />;
}
