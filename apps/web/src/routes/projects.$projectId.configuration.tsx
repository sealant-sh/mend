import { createFileRoute, redirect } from "@tanstack/react-router";

import type { SettingsSection } from "#/components/project/settings";

/** Where each anchor of the old Configuration page lives now. */
const SECTION_OF_ANCHOR: Readonly<Record<string, SettingsSection>> = {
  environment: "workspace",
  variables: "secrets",
  secrets: "secrets",
  "cluster-bindings": "secrets",
  services: "services",
  "git-access": "git",
  landing: "landing",
  sessions: "landing",
  review: "review",
  folders: "folders",
  mounts: "folders",
};

/** The old Configuration page: its links and bookmarks land on the Settings tab that holds them. */
export const Route = createFileRoute("/projects/$projectId/configuration")({
  beforeLoad: ({ params, location }) => {
    const anchor = location.hash.replace(/^#/, "");
    if (anchor === "skills")
      throw redirect({ to: "/projects/$projectId/skills", params, replace: true });
    if (anchor === "resources")
      throw redirect({ to: "/projects/$projectId/resources", params, replace: true });
    throw redirect({
      to: "/projects/$projectId/settings/$section",
      params: { projectId: params.projectId, section: SECTION_OF_ANCHOR[anchor] ?? "general" },
      replace: true,
    });
  },
});
