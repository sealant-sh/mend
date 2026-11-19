import type { RemovedProject } from "@mend/domain/workbench";
import { toast } from "@mend/ui/components/ui/toast";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/use-viewer";

import { RemovedProjectRow } from "../projects/removed-projects.tsx";
import { NotFoundScreen, QueryError, QueryPending } from "../route-screens.tsx";
import { SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/**
 * A project's settings when the project can't be read: one that was removed shows its General
 * page with what is left to do (Restore, Purge…, for whoever the server allows, as Projects' own
 * Removed projects list does); any other address is not found. Restoring it opens its settings
 * again.
 */
export function RemovedProjectPage({
  projectId,
  reset,
}: {
  readonly projectId: string;
  /** Clears the route's error, so reading the project again can draw its page. */
  readonly reset: () => void;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const { organizationName } = useViewer();
  const removed = useQuery(trpc.projects.removed.queryOptions());
  const members = useQuery(trpc.organization.members.queryOptions());
  const [seen, setSeen] = useState<RemovedProject | null>(null);
  const [purged, setPurged] = useState(false);
  const listed = removed.data?.find((candidate) => candidate.id === projectId) ?? null;
  if (listed !== null && listed !== seen) setSeen(listed);
  if (removed.isPending) return <QueryPending />;
  if (removed.isError) {
    return (
      <div className="px-6 pt-9">
        <QueryError
          error={removed.error}
          retry={() => void removed.refetch()}
          retrying={removed.isFetching}
        />
      </div>
    );
  }
  // Restoring it takes it out of the removed list before its row's callback runs: the row stays
  // on screen until the page reads the project again, so the callback isn't lost with it.
  const project = purged ? null : (listed ?? seen);
  if (project === null) return <NotFoundScreen />;
  const removedBy =
    members.status === "success"
      ? (members.data.find((member) => member.userId === project.removedByUserId)?.name ?? null)
      : null;
  return (
    <SettingsPage
      page="p-general"
      project={{ id: project.id, name: project.name }}
      intro={`${project.name} was removed from ${organizationName}'s projects. Mend keeps it until someone purges it.`}
    >
      <SettingSection title="Removed project">
        <ul aria-label="Removed project" className="max-lg:px-4">
          <RemovedProjectRow
            project={project}
            organizationName={organizationName}
            removedBy={removedBy}
            onRestored={(name) => {
              toast.add({ description: `${name} is back in ${organizationName}'s projects.` });
              // Reading the project again leaves this view for its settings. The removed list no
              // longer holds it, so the error is cleared first rather than drawing not found.
              reset();
              void router.invalidate();
            }}
            onPurged={() => setPurged(true)}
          />
        </ul>
      </SettingSection>
    </SettingsPage>
  );
}
