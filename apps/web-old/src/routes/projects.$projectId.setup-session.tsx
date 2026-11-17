import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { SetupSessionPanel } from "#/components/setup-session-panel";

export const Route = createFileRoute("/projects/$projectId/setup-session")({
  ssr: false,
  component: SetupSessionPage,
});

function SetupSessionPage() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate();
  return (
    <div className="mt-6">
      <SetupSessionPanel
        projectId={projectId}
        onClose={() => void navigate({ to: "/projects/$projectId", params: { projectId } })}
      />
    </div>
  );
}
