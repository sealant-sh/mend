import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { ProjectDetailDto } from "#/lib/api";
import { inboxRows } from "#/lib/inbox";
import { inboxQuery } from "#/lib/inbox-live";
import { type ProjectSessionRow, projectSessionRows } from "#/lib/project-sessions";
import { useTRPC } from "#/lib/trpc";
import { useMinute } from "#/lib/use-inbox";

/**
 * The project's sessions as the Sessions tab lists them, open or stopped. The tab's list and its
 * count in the project's tabs both read these, so the count is what the tab shows. The inbox read
 * names the sessions it carries and says what their agents do; without it the rows still list,
 * with the project's own words.
 */
export function useProjectSessionRows(detail: ProjectDetailDto): ReadonlyArray<ProjectSessionRow> {
  const trpc = useTRPC();
  const now = useMinute();
  const inbox = useQuery(inboxQuery(trpc));
  const inboxData = inbox.isPending || inbox.isError ? undefined : inbox.data;
  const projectId = detail.project.id;
  return useMemo(
    () =>
      projectSessionRows(
        detail,
        inboxRows({
          rows: (inboxData ?? []).filter((row) => row.session.projectId === projectId),
          marks: [],
          now,
        }),
      ),
    [detail, inboxData, projectId, now],
  );
}
