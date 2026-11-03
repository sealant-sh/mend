import type { Query, QueryFilters, QueryKey } from "@tanstack/react-query";

import type { WorkbenchEventDto } from "./api.ts";
import type { TrpcProxy } from "./trpc.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The input a tRPC query was read with: its key is `[path, { input, type }]`. */
const inputField = (key: QueryKey, field: string): unknown => {
  const meta = key[1];
  if (!isRecord(meta) || !isRecord(meta["input"])) return undefined;
  return meta["input"][field];
};

/**
 * The queries of `family` read for one thing: those whose input's `field` is `id`. `except`
 * leaves out the ones patched in place instead of read again.
 */
export const readFor = (
  family: QueryFilters,
  field: string,
  id: string,
  except?: (query: Query) => boolean,
): QueryFilters => ({
  ...family,
  predicate: (query) => inputField(query.queryKey, field) === id && !(except?.(query) ?? false),
});

/**
 * What one workbench event marks stale (plan §9.4: payloads are pointers, clients re-read through
 * the API). Each event names a session, a worktree, a change or a project, and marks stale only
 * the reads of that thing; only those a page shows are read again. No event reads every project's
 * detail, every session's, or any list of them: the inbox's rows are patched one by one
 * (`makeInboxPatcher`), and the rail counts from them. `session-progress` marks nothing: pages
 * that show live lines take it through `onEvent`.
 *
 * `patched` names the reads an event patches in place instead (a conversation's held pages).
 */
export const invalidationsFor = (
  event: WorkbenchEventDto,
  trpc: TrpcProxy,
  patched?: (query: Query) => boolean,
): ReadonlyArray<QueryFilters> => {
  const { sessionId, projectId, worktreeId, changeId } = event;
  const session = (id: string) => [
    readFor(trpc.sessions.pathFilter(), "id", id, patched),
    readFor(trpc.screens.pathFilter(), "id", id),
  ];
  const project = (id: string) => [readFor(trpc.projects.detail.pathFilter(), "id", id)];
  const worktree = (id: string, inProject: string | undefined) => [
    readFor(trpc.worktrees.pathFilter(), "id", id),
    ...(inProject === undefined
      ? []
      : [readFor(trpc.worktrees.list.pathFilter(), "projectId", inProject)]),
  ];
  const change = (id: string) => [
    readFor(trpc.changes.pathFilter(), "id", id),
    readFor(trpc.changes.pathFilter(), "changeId", id),
    readFor(trpc.landings.forChange.pathFilter(), "id", id),
  ];
  switch (event.type) {
    case "project":
      // A setting, a recipe or a skill of one project; its name or visibility can move the list.
      return projectId === undefined
        ? []
        : [
            ...project(projectId),
            trpc.projects.list.queryFilter(),
            readFor(trpc.projects.folders.pathFilter(), "id", projectId),
            readFor(trpc.environment.pathFilter(), "projectId", projectId),
          ];
    case "session":
      // Its status, label or membership: its own reads, its project's page, and the live list
      // the composer reads for who already works in a worktree.
      return sessionId === undefined
        ? []
        : [
            ...session(sessionId),
            ...(projectId === undefined ? [] : project(projectId)),
            trpc.sessions.listActive.queryFilter(),
          ];
    case "agent-conversation":
      // A turn, an item or a request of one session: its reads, its landing decision (it rides
      // on the turn) and its screen log (the agent's looks and actions are items too).
      return sessionId === undefined
        ? []
        : [...session(sessionId), readFor(trpc.landings.forSession.pathFilter(), "id", sessionId)];
    case "session-process":
      // A process of one session started, bound a port or ended: its processes, the Services
      // list and the previews it feeds.
      return sessionId === undefined
        ? []
        : [
            trpc.sessions.processes.queryFilter({ id: sessionId }),
            trpc.services.list.pathFilter(),
            trpc.worktrees.previews.pathFilter(),
          ];
    case "worktree":
      return worktreeId === undefined
        ? []
        : [
            ...worktree(worktreeId, projectId),
            ...(projectId === undefined ? [] : project(projectId)),
          ];
    case "session-change":
    case "review-comment":
      // One change: its reads and landings, and the comment counts its worktree and project show.
      return [
        ...(changeId === undefined ? [] : change(changeId)),
        ...(sessionId === undefined
          ? []
          : [readFor(trpc.landings.forSession.pathFilter(), "id", sessionId)]),
        ...(worktreeId === undefined ? [] : worktree(worktreeId, projectId)),
        ...(projectId === undefined ? [] : project(projectId)),
      ];
    case "organization":
      // Membership, roles, invitations, folders or references: which projects a person sees can
      // move, so the project list is read again; no project's detail is.
      return [
        trpc.organization.pathFilter(),
        trpc.folders.pathFilter(),
        trpc.git.references.pathFilter(),
        trpc.projects.list.queryFilter(),
        trpc.sessions.listActive.queryFilter(),
      ];
    case "resync":
      // The server lost its event feed for a moment; anything could have changed meanwhile.
      return [{}];
    default:
      return [];
  }
};
