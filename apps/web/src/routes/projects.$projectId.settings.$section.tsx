import { createFileRoute, notFound } from "@tanstack/react-router";

import { SETTINGS_TABS } from "#/components/project/project-frame";
import { ProjectSettingsSection, settingsLoader } from "#/components/project/settings";

type Section = (typeof SETTINGS_TABS)[number]["slug"];

const isSection = (value: string): value is Section =>
  SETTINGS_TABS.some((tab) => tab.slug === value);

/** One project Settings tab (screens L1 to L8), each its own URL on the inline Settings group. */
export const Route = createFileRoute("/projects/$projectId/settings/$section")({
  ssr: false,
  params: {
    parse: ({ section }) => {
      if (!isSection(section)) throw notFound();
      return { section };
    },
    stringify: ({ section }) => ({ section }),
  },
  loader: ({ context, params }) => settingsLoader(context, params.projectId, params.section),
  component: SettingsSectionPage,
});

function SettingsSectionPage() {
  const { projectId, section } = Route.useParams();
  return <ProjectSettingsSection projectId={projectId} section={section} />;
}
