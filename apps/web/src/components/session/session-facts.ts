import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

import { agentIsLive } from "#/lib/api";
import { inboxQuery } from "#/lib/inbox-live";
import { sessionDetailQuery } from "#/lib/session-queries";
import { harnessName } from "#/lib/session-view";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

/**
 * What every part of the session's sheet reads about it: the detail the route loaded, the row the
 * inbox already holds (its title and worktree name, so the header and the tab paint at once), the
 * project's name, who is looking, and the names of the organization's members. Each is a cached
 * read, so any part may call this.
 */
export const useSessionFacts = (sessionId: string) => {
  const trpc = useTRPC();
  const detail = useSuspenseQuery(sessionDetailQuery(trpc, sessionId)).data;
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const { session, currentAgent } = detail;
  const row = useQuery({
    ...inboxQuery(trpc),
    select: (rows) => rows.find((each) => each.session.id === sessionId) ?? null,
  });
  const listed = row.isPending || row.isError ? null : row.data;
  const project = useQuery(
    trpc.projects.list.queryOptions(undefined, {
      select: (projects) => projects.find((each) => each.id === session.projectId)?.name ?? null,
    }),
  );
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { retry: false }));
  // Until the roster answers, or if it can't, a byline goes without a name rather than guessing.
  const names =
    members.isPending || members.isError
      ? new Map<string, string>()
      : new Map(members.data.map((member) => [member.userId, member.name]));
  // The worktree's directory, until the inbox row names it: its last part is the worktree's name.
  const directoryName = session.worktree.split("/").findLast((part) => part !== "") ?? "";
  return {
    detail,
    session,
    viewerId: viewer.userId,
    title: listed?.title ?? session.label ?? directoryName,
    worktreeName: listed?.worktreeName ?? directoryName,
    projectName: project.isPending || project.isError ? "" : (project.data ?? ""),
    agent: harnessName(session.harness),
    /** The agent runs now (a shell keeping the workspace up doesn't count). */
    agentLive: agentIsLive(session, currentAgent),
    nameOf: (userId: string): string | null => names.get(userId) ?? null,
  };
};

export type SessionFacts = ReturnType<typeof useSessionFacts>;
