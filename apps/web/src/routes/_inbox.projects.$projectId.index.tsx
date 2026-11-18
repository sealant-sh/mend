import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { SessionsTab } from "#/components/project/sessions-tab";
import { parseProjectSessionsSearch } from "#/lib/project-sessions";
import { useTRPC } from "#/lib/trpc";

/**
 * A project's Sessions tab, its first. Its filters live in the address, so a filtered list can be
 * linked and reloaded; the project layout has already read the project.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId/")({
  validateSearch: parseProjectSessionsSearch,
  component: ProjectSessions,
});

function ProjectSessions() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  const { setup, ...filters } = search;
  return (
    <SessionsTab
      detail={detail}
      search={filters}
      onSearch={(next) =>
        void navigate({ search: setup === true ? { ...next, setup } : next, replace: true })
      }
      onSetUp={() => void navigate({ search: { ...filters, setup: true }, replace: true })}
    />
  );
}
