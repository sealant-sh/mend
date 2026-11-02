import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { SessionsTab } from "#/components/project/tabs/sessions";
import {
  filtersOfSearch,
  parseSessionSearch,
  searchOfFilters,
} from "#/components/project/tabs/sessions-filters";
import { useTRPC } from "#/lib/trpc";

/**
 * The Sessions tab (screen K1), the project's first tab. Its filters live in the URL; the project
 * layout has already read the project.
 */
export const Route = createFileRoute("/projects/$projectId/")({
  validateSearch: parseSessionSearch,
  component: ProjectSessionsPage,
});

function ProjectSessionsPage() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  return (
    <SessionsTab
      detail={detail}
      filters={filtersOfSearch(search)}
      onFiltersChange={(filters) =>
        void navigate({ search: searchOfFilters(filters), replace: true })
      }
    />
  );
}
