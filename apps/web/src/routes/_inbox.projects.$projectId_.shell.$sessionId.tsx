import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The old app's page for a shell session (`/projects/<id>/shell/<sessionId>`): a shell is now the
 * Terminal view of its session's sheet, so the address goes there.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/shell/$sessionId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/sessions/$sessionId/$view",
      params: { sessionId: params.sessionId, view: "terminal" },
      replace: true,
    });
  },
});
