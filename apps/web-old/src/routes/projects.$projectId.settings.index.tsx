import { createFileRoute, redirect } from "@tanstack/react-router";

/** Settings opens on General. */
export const Route = createFileRoute("/projects/$projectId/settings/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/projects/$projectId/settings/$section",
      params: { projectId: params.projectId, section: "general" },
      replace: true,
    });
  },
});
