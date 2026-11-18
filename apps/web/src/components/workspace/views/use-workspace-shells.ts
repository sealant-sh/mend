import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { inboxQuery } from "#/lib/inbox-live";
import { sessionDetailQuery } from "#/lib/session-queries";
import { harnessName } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";
import { type ShellSession, workspaceShells } from "#/lib/workspace-shells";

import type { ViewPlace } from "../views.tsx";

/**
 * The sessions of the place's workspace with their processes, and its shells. Every read is a
 * cached query the workbench events keep fresh (`event-scope.ts` re-reads a session's processes
 * when one starts or ends), so the tab, its "+" item and the view share them.
 */
export const useWorkspaceShells = (place: ViewPlace) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const inbox = useQuery({
    ...inboxQuery(trpc),
    select: (rows) => rows.filter((row) => row.session.worktreeId === place.worktreeId),
  });
  const page = useQuery(sessionDetailQuery(trpc, place.sessionId));
  const rows = inbox.isPending || inbox.isError ? [] : inbox.data;
  // The page's own session is in the workspace even before (or without) its inbox row.
  const pageSession = page.isPending || page.isError ? null : page.data.session;
  const listed: ReadonlyArray<Omit<ShellSession, "processes">> = [
    ...rows.map((row) => ({
      id: row.session.id,
      title: row.title,
      harness: row.session.harness,
      status: row.session.status,
      ownerUserId: row.session.ownerUserId,
      sharedControlEnabledAt: row.session.sharedControlEnabledAt,
      sharedControlUserIds: row.session.sharedControlUserIds,
    })),
    ...(pageSession === null || rows.some((row) => row.session.id === pageSession.id)
      ? []
      : [
          {
            id: pageSession.id,
            title: pageSession.label ?? "This session",
            harness: pageSession.harness,
            status: pageSession.status,
            ownerUserId: pageSession.ownerUserId,
            sharedControlEnabledAt: pageSession.sharedControlEnabledAt,
            sharedControlUserIds: pageSession.sharedControlUserIds,
          },
        ]),
  ];
  const processes = useQueries({
    queries: listed.map((session) => trpc.sessions.processes.queryOptions({ id: session.id })),
  });
  const sessions: ReadonlyArray<ShellSession> = listed.map((session, index) => {
    const read = processes[index];
    return {
      ...session,
      processes: read === undefined || read.isPending || read.isError ? null : read.data,
    };
  });
  const failed =
    processes.find((read) => read.isError)?.error ?? (page.isError ? page.error : null);
  return {
    sessions,
    shells: workspaceShells(sessions, harnessName),
    /** Every session's processes are read. */
    ready: !page.isPending && processes.every((read) => read.isSuccess),
    failed,
    retrying: processes.some((read) => read.isFetching),
    retry: () =>
      void queryClient.refetchQueries({
        predicate: (query) => query.state.status === "error",
      }),
  };
};
