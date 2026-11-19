import { shortOrigin } from "#/lib/projects";
import { visiblePages } from "#/lib/settings-pages";
import { useProjectSettings } from "#/lib/use-project-settings";

import { PhoneHeader } from "../workspace/phone-header.tsx";
import { PhoneRow } from "./phone-settings.tsx";
import { SETTINGS_ICONS, settingsLink } from "./settings-links.tsx";
import { useSettingsNav } from "./settings-sidebar.tsx";

/**
 * A project's settings on a phone (Doop "Phone · Settings · Project · checkout-api"): who can see
 * the project and its repository, then one row for each of its pages. Under 1024px this is
 * `/projects/<id>/settings`; each page's Back returns here, and this page's Back to Settings.
 */
export function PhoneProjectSettings({ projectId }: { readonly projectId: string }) {
  const { detail, people } = useProjectSettings(projectId);
  const { viewer } = useSettingsNav();
  const { project } = detail;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <PhoneHeader
        title={project.name}
        sub="Project"
        back={{ link: { to: "/settings" }, label: "Settings" }}
      />
      <div className="border-b border-border px-4 py-3">
        <p className="text-muted-foreground">
          {project.visibility === "shared"
            ? `Everyone in ${people.organizationName} can see this project.`
            : project.createdByUserId === people.viewerUserId
              ? "Only you can see this project."
              : "Only the person who added it can see this project."}
        </p>
        {project.originUrl === null ? null : (
          <p className="mt-1 font-mono text-sm break-all">{shortOrigin(project.originUrl)}</p>
        )}
      </div>
      <ul aria-label={`${project.name} settings`}>
        {visiblePages("project", viewer).map((page) => (
          <PhoneRow
            key={page.id}
            link={settingsLink(page.id, project.id)}
            icon={SETTINGS_ICONS[page.id]}
          >
            {page.label}
          </PhoneRow>
        ))}
      </ul>
    </div>
  );
}
