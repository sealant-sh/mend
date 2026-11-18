import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The old setup session page. "Set up this project" is now a dialog on the project's page, so its
 * address opens the project with the dialog open.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId/setup-session")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/projects/$projectId",
      params,
      search: { setup: true },
      replace: true,
    });
  },
});
