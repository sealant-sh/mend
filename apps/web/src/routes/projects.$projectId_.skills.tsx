import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId_/skills")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/projects/$projectId/configuration",
      params: { projectId: params.projectId },
      hash: "skills",
    });
  },
});
