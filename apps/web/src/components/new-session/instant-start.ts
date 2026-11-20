import { toast } from "@mend/ui/components/ui/toast";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { conversationQuery } from "#/lib/conversation";
import { holdOpeningMessage } from "#/lib/opening-messages";
import { newDraftId, type RefusedStart } from "#/lib/pending-starts";
import type { ProjectStart } from "#/lib/project-starts";
import { sessionDetailQuery } from "#/lib/session-queries";
import { sessionLink } from "#/lib/session-sheet";
import { signedInOptions } from "#/lib/sign-in";
import { type InstantStart, type StartPlace, startInstantly } from "#/lib/start-session";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

/** What a start says of itself; who starts it and its id are the hook's. */
export type StartRequest = Omit<InstantStart, "draftId" | "userId" | "now">;

/** What every place a start shows in shares: the reads, the held message, the cache. */
const useStartCommon = (): Pick<StartPlace, "prefetch" | "holdOpening" | "moved"> & {
  readonly userId: string;
} => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  // The root route read who is signed in before any signed-in page renders.
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  return {
    userId: viewer.userId,
    prefetch: (sessionId) =>
      Promise.all([
        queryClient.ensureQueryData(sessionDetailQuery(trpc, sessionId)),
        queryClient.ensureInfiniteQueryData(conversationQuery(trpc, trpcClient, sessionId)),
      ]),
    holdOpening: holdOpeningMessage,
    moved: () => {
      void queryClient.invalidateQueries(trpc.sessions.pathFilter());
      void queryClient.invalidateQueries(trpc.projects.pathFilter());
    },
  };
};

/**
 * Start a session and open its page at once, at the start's own address (SLNT-1196). Once Mend has
 * made it, the address moves to the session's id in place, if the person is still there. A
 * refusal takes them back to where they started, if they are still on the start's page, and
 * `onRefused` says it there.
 */
export const usePageStart = () => {
  const common = useStartCommon();
  const navigate = useNavigate();
  const router = useRouter();
  // The session page's code is fetched while the person writes, so Start draws it at once. A
  // start's address reads nothing from the server, so this preload asks it for nothing.
  useEffect(() => {
    void router.preloadRoute(sessionLink(newDraftId("preload"))).catch(() => undefined);
  }, [router]);
  return (request: StartRequest, onRefused: (refused: RefusedStart) => void) => {
    const draftId = newDraftId(crypto.randomUUID());
    const page = sessionLink(draftId);
    const at = () => router.state.location.pathname === `/sessions/${draftId}`;
    const from = router.state.location.href;
    const place: StartPlace = {
      ...common,
      show: () => navigate(page),
      settle: (sessionId) => {
        if (at()) void navigate({ ...sessionLink(sessionId), replace: true });
      },
      refuse: (refused) => {
        if (at()) router.history.replace(from);
        onRefused(refused);
      },
    };
    void startInstantly(place, { ...request, draftId, userId: common.userId });
  };
};

/**
 * Start a session in a tab of its workspace's sheet: the tab shows the start (`show`), and becomes
 * the session's once Mend has made it and its page is read (`settle`).
 */
export const useTabStart = () => {
  const common = useStartCommon();
  return (request: StartRequest, place: Pick<StartPlace, "show" | "settle" | "refuse">) => {
    const draftId = newDraftId(crypto.randomUUID());
    void startInstantly({ ...common, ...place }, { ...request, draftId, userId: common.userId });
  };
};

/**
 * A start from a project's page or a menu (a session in a worktree, a shell, a setup session):
 * no first message, the session's page at once, and a refusal said in a toast, since the menu
 * that asked has closed.
 */
export const useProjectStart = (projectId: string) => {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions());
  // The name shows on the start's page until the session's own is read; it may be blank till then.
  const name =
    projects.isPending || projects.isError
      ? ""
      : (projects.data.find((project) => project.id === projectId)?.name ?? "");
  const pageStart = usePageStart();
  return (start: ProjectStart, failure: string) =>
    pageStart(
      { ...start, project: { id: projectId, name }, prompt: "", selection: null, failure },
      (refused) => toast.add({ description: refused.words, priority: "high" }),
    );
};
