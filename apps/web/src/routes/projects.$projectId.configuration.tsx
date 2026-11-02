import { createFileRoute, redirect } from "@tanstack/react-router";

import { anchorTarget } from "#/components/project/settings/anchors";

/** The old Configuration page: its links and bookmarks land on the tab that holds them now. */
export const Route = createFileRoute("/projects/$projectId/configuration")({
  beforeLoad: ({ params, location }) => {
    const target = anchorTarget(location.hash);
    if ("tab" in target)
      throw redirect({
        to:
          target.tab === "skills"
            ? "/projects/$projectId/skills"
            : "/projects/$projectId/resources",
        params,
        replace: true,
      });
    throw redirect({
      to: "/projects/$projectId/settings/$section",
      params: { projectId: params.projectId, section: target.section },
      replace: true,
    });
  },
});
