import { createFileRoute } from "@tanstack/react-router";

import { PhoneProjectSettings } from "#/components/settings/phone-project-settings";
import { ProjectGeneralPage } from "#/components/settings/project-general-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * `/projects/<id>/settings`: on the desk it opens the project's General page; under 1024px it is
 * the list of the project's pages, where each page's Back returns. The project's "…", the phone
 * Settings tab and older links open this address.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/settings/")({
  beforeLoad: guardSettingsPage("p-general"),
  component: ProjectSettingsHome,
});

function ProjectSettingsHome() {
  const { projectId } = Route.useParams();
  return (
    <>
      <div className="contents lg:hidden">
        <PhoneProjectSettings projectId={projectId} />
      </div>
      <div className="contents max-lg:hidden">
        <ProjectGeneralPage projectId={projectId} />
      </div>
    </>
  );
}
