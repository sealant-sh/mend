import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { checksFact, observedChecks } from "#/lib/checks";
import { conversationQuery, heldConversation } from "#/lib/conversation";
import { sessionDetailQuery } from "#/lib/session-queries";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { previewFact } from "#/lib/workspace-services";
import { runningShellsFact, shellAccess } from "#/lib/workspace-shells";

import type { ViewFacts, ViewPlace } from "./views.tsx";
import { useShownService, useWorkspaceServices } from "./views/use-workspace-services.ts";
import { useWorkspaceShells } from "./views/use-workspace-shells.ts";

/*
 * What each view's tab and "+" item say after its name. A tab shows before its view's body is
 * loaded, so these hooks live here, apart from the bodies (`views/*-view.tsx`), which load when
 * their tab first shows.
 */

/**
 * The Change tab's counts: lines added and removed in the workspace's change as it is now (the
 * live worktree against its base, which the event stream keeps fresh). None before the change has
 * a line, or while they are read.
 */
export const useChangeFacts = (place: ViewPlace): ViewFacts => {
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

/**
 * The session's conversation as far as it is read, the same cached read its conversation tile
 * makes, so the Checks tab costs no request of its own.
 */
export const useHeldConversation = (sessionId: string) => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  return useInfiniteQuery({
    ...conversationQuery(trpc, client, sessionId),
    select: (data) => heldConversation(data.pages),
  });
};

/** The Checks tab's and its "+" item's fact: "2 passed", "1 failed". Nothing while it is read. */
export const useChecksFacts = (place: ViewPlace): ViewFacts => {
  const conversation = useHeldConversation(place.sessionId);
  if (conversation.isPending || conversation.isError) return {};
  const fact = checksFact(observedChecks(conversation.data.items));
  return fact === undefined ? {} : { fact };
};

/** The Preview tab's and its "+" item's fact: the port of the Service it shows, while it runs. */
export const usePreviewFacts = (place: ViewPlace): ViewFacts => {
  const { services } = useWorkspaceServices(place);
  const fact = previewFact(useShownService(place, services));
  return fact === undefined ? {} : { fact };
};

/**
 * The Terminal tab's and its "+" item's fact: how many shells run ("1 shell") of those the person
 * may see. Nothing until who is looking is known.
 */
export const useTerminalFacts = (place: ViewPlace): ViewFacts => {
  const trpc = useTRPC();
  const viewer = useQuery(signedInOptions(trpc));
  const { sessions, shells } = useWorkspaceShells(place);
  if (viewer.isPending || viewer.isError) return {};
  const access = shellAccess(sessions, place.sessionId, viewer.data.userId);
  const fact = runningShellsFact(shells.filter((shell) => access.watches(shell.sessionId)));
  return fact === undefined ? {} : { fact };
};

/** Who holds a screen's input has no event of its own, so a screen that runs is read often. */
const SCREEN_READ_MS = 3_000;

/** The workspace's screen as Mend reads it: its tab's fact and its body read the same query. */
export const useScreenRead = (sessionId: string) => {
  const trpc = useTRPC();
  return useQuery(
    trpc.screens.read.queryOptions(
      { id: sessionId },
      {
        retry: false,
        // Only a screen that runs (or starts) changes hands; an ended one waits for the session
        // events that say it woke.
        refetchInterval: (query) => {
          const read = query.state.data;
          return read?._tag === "Screen" &&
            (read.life._tag === "Live" || read.life._tag === "Starting")
            ? SCREEN_READ_MS
            : false;
        },
      },
    ),
  );
};

/** The Screen tab's and its "+" item's fact: "live" while the workspace's screen runs. */
export const useScreenFacts = (place: ViewPlace): ViewFacts => {
  const read = useScreenRead(place.sessionId);
  if (read.isPending || read.isError) return {};
  return read.data._tag === "Screen" && read.data.life._tag === "Live" ? { fact: "live" } : {};
};

/** Record and Details say nothing after their names. */
export const useNoFacts = (_place: ViewPlace): ViewFacts => ({});
