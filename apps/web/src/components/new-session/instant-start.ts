import { toast } from "@mend/ui/components/ui/toast";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { readSessionStart } from "#/lib/api";
import { conversationQuery } from "#/lib/conversation";
import { makeCourier, sendHeld } from "#/lib/outbox";
import {
  keepRefusal,
  newDraftId,
  type PendingStart,
  type RefusedStart,
} from "#/lib/pending-starts";
import { usePhone } from "#/lib/phone";
import type { ProjectStart } from "#/lib/project-starts";
import { sessionDetailQuery } from "#/lib/session-queries";
import { sessionLink } from "#/lib/session-sheet";
import { signedInOptions } from "#/lib/sign-in";
import {
  type InstantStart,
  recoverStart,
  type StartPlace,
  startInstantly,
} from "#/lib/start-session";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

/** What a start says of itself; who starts it and its id are the hook's. */
export type StartRequest = Omit<InstantStart, "draftId" | "userId" | "now">;

/** How often, and how many times, a start's page reads its conversation for the first message. */
const OPENING_READ_MS = 250;
const OPENING_READS = 12;

/** What every place a start shows in shares: the reads, what was written, the cache. */
const useStartCommon = (): Pick<StartPlace, "prefetch" | "sendWritten" | "moved"> & {
  readonly userId: string;
} => {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  // The root route read who is signed in before any signed-in page renders.
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  return {
    userId: viewer.userId,
    prefetch: async (sessionId, opening) => {
      const conversation = conversationQuery(trpc, trpcClient, sessionId);
      await Promise.all([
        queryClient.ensureQueryData(sessionDetailQuery(trpc, sessionId)),
        queryClient.ensureInfiniteQueryData(conversation),
      ]);
      // The launch records the first message as it is admitted, a moment after the session is
      // made: until the conversation holds it, the start's page, which shows it, stays.
      if (!opening) return;
      for (let read = 0; read < OPENING_READS; read++) {
        const held = queryClient.getQueryData(conversation.queryKey);
        if (held?.pages.some((page) => page.turns.length > 0) === true) return;
        await new Promise((resolve) => setTimeout(resolve, OPENING_READ_MS));
        await queryClient.refetchQueries({ queryKey: conversation.queryKey, exact: true });
      }
    },
    sendWritten: (sessionId, written) => {
      const courier = makeCourier(queryClient, trpcClient, trpc, sessionId);
      void sendHeld(courier, { userId: viewer.userId, sessionId }, written);
    },
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

/** Starts this tab is recovering now: a page drawn twice recovers each once. */
const recovering = new Set<string>();

/**
 * Pick up a start this tab kept from before a reload (SLNT-1239), on its own page: once Mend says
 * which session it made, the address moves to that session; a start Mend refused or never got
 * goes back to the composer with the words and the reason.
 */
export const useRecoverStart = () => {
  const common = useStartCommon();
  const navigate = useNavigate();
  const router = useRouter();
  const phone = usePhone();
  return (start: PendingStart) => {
    if (recovering.has(start.draftId)) return;
    recovering.add(start.draftId);
    const at = () => router.state.location.pathname === `/sessions/${start.draftId}`;
    const place: StartPlace = {
      ...common,
      show: () => undefined,
      settle: (sessionId) => {
        if (at()) void navigate({ ...sessionLink(sessionId), replace: true });
      },
      refuse: (refused) => {
        keepRefusal(refused);
        // The composer takes the words back: `/` on a wide screen, `/new` on a phone.
        if (at()) void navigate({ to: phone ? "/new" : "/", replace: true });
      },
    };
    void recoverStart(place, start, {
      read: readSessionStart,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    }).finally(() => recovering.delete(start.draftId));
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
