import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { agentIsLive } from "#/lib/api";
import { conversationQuery, heldConversation } from "#/lib/conversation";
import { subscribeDrafts } from "#/lib/drafts";
import { useOpeningMessage } from "#/lib/opening-messages";
import {
  sendWaiting,
  subscribeInFlight,
  useMessageOwner,
  useOutbox,
  waitingSessions,
} from "#/lib/outbox";
import { isDraftId } from "#/lib/pending-starts";
import { composerMode, heldMessagesFate } from "#/lib/session-composer";
import { sessionDetailQuery } from "#/lib/session-queries";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

/** Hear the outboxes change, in storage or in this tab's memory alone. */
const subscribeOutboxes = (listener: () => void) => {
  const drafts = subscribeDrafts(listener);
  const memory = subscribeInFlight(listener);
  return () => {
    drafts();
    memory();
  };
};

/**
 * What a person sent while a session started goes once its agent runs and its opening turn is in
 * (`heldMessagesFate`), wherever the person is by then. Rendered once, in the frame around every
 * signed-in page: a message waits for the agent, never for its writer to stay on the session's
 * page (SLNT-1232). Each one's outcome stays on its bubble, with Try again and Edit when it didn't
 * arrive, for the session's page to show.
 */
export function HeldMessagesCourier() {
  const userId = useMessageOwner();
  const waiting = useSyncExternalStore(
    subscribeOutboxes,
    () => (userId === null ? "" : waitingSessions(userId)),
    () => "",
  );
  // A start's own address is moved onto its session once Mend has made it; nothing goes from it.
  const sessions = waiting === "" ? [] : waiting.split(" ").filter((id) => !isDraftId(id));
  return sessions.map((sessionId) => <HeldRelease key={sessionId} sessionId={sessionId} />);
}

/** One session's waiting messages: sent once its agent can take them. */
function HeldRelease({ sessionId }: { readonly sessionId: string }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  // The reads the session's page makes, kept current by the event stream for every page.
  const detail = useQuery(sessionDetailQuery(trpc, sessionId));
  const conversation = useInfiniteQuery({
    ...conversationQuery(trpc, client, sessionId),
    select: (data) => heldConversation(data.pages),
  });
  const openingHeld = useOpeningMessage(sessionId) !== null;
  const outbox = useOutbox(sessionId);
  // Until the session is read, or when it can't be, they wait: a failed read is read again.
  const fate =
    detail.isPending || detail.isError
      ? "wait"
      : heldMessagesFate({
          mode: composerMode({
            session: detail.data.session,
            currentAgent: detail.data.currentAgent,
            steer: detail.data.control.steer,
            agentLive: agentIsLive(detail.data.session, detail.data.currentAgent),
          }),
          status: detail.data.session.status,
          turns:
            conversation.isPending || conversation.isError ? undefined : conversation.data.turns,
          openingHeld,
        });
  const count = outbox.messages.filter((message) => message.state._tag === "Waiting").length;
  const release = useEffectEvent(() => {
    if (outbox.scope !== null) void sendWaiting(outbox.courier, outbox.scope);
  });
  // An effect, since the agent comes up on the server, heard as the session is read again.
  useEffect(() => {
    if (fate === "send" && count > 0) release();
  }, [fate, count]);
  return null;
}
