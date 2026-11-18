import { skipToken, useQuery } from "@tanstack/react-query";
import { FileDiffIcon } from "lucide-react";

import { ChangeBody } from "#/components/change/change-view";
import { sessionDetailQuery } from "#/lib/session-queries";
import { useTRPC } from "#/lib/trpc";

import type { ViewFacts, ViewPlace, WorkspaceView } from "../views.tsx";

/**
 * The Change tab's counts: lines added and removed in the workspace's change as it is now (the
 * live worktree against its base, which the event stream keeps fresh). None before the change has
 * a line, or while they are read.
 */
const useChangeFacts = (place: ViewPlace): ViewFacts => {
  const trpc = useTRPC();
  const detail = useQuery({
    ...sessionDetailQuery(trpc, place.sessionId),
    select: (read) => read.change?.id ?? null,
  });
  const changeId = detail.isPending || detail.isError ? null : detail.data;
  const stats = useQuery(
    trpc.changes.stats.queryOptions(changeId === null ? skipToken : { id: changeId }),
  );
  // While the counts are read, or if they can't be, the tab shows its name alone.
  if (stats.isPending || stats.isError) return {};
  if (stats.data.additions + stats.data.deletions === 0) return {};
  // An empty count hides, as the canvas's tab draws "+31" alone.
  return {
    ...(stats.data.additions > 0 ? { added: stats.data.additions } : {}),
    ...(stats.data.deletions > 0 ? { removed: stats.data.deletions } : {}),
  };
};

/** The Change view: this workspace's change, file by file (route PR 23). */
export const CHANGE_VIEW: WorkspaceView = {
  id: "change",
  name: "Change",
  icon: <FileDiffIcon />,
  useFacts: useChangeFacts,
  Body: ChangeBody,
};
