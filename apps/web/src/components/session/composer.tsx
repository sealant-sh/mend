import { openTurnOf } from "@mend/agent-conversation";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { focusRing } from "#/components/kit/button";
import { SessionMessageInput } from "#/components/session-message-input";
import { latestAgentText } from "#/lib/conversation-rows";
import { useTRPC } from "#/lib/trpc";

import { useConversation } from "./conversation";
import type { SessionFacts } from "./facts";

/**
 * The composer under the conversation (and under every other tab): it steers the running turn or
 * starts the next one, as the sender's own setting says. Where this viewer cannot send, the same
 * place says why and where to go instead.
 */
export function Composer({ facts }: { readonly facts: SessionFacts }) {
  const { session, control, viewer } = facts;
  const conversation = useConversation(session.id);
  if (facts.conversationLive && control.steer && viewer != null) {
    // "Steer" while a turn is under way: the words go into it, as the sender's setting says.
    const working =
      conversation.data !== undefined && openTurnOf(conversation.data.turns) !== undefined;
    return (
      <SessionMessageInput
        key={session.id}
        sessionId={session.id}
        attach
        submitLabel={working ? "Steer" : "Send"}
        placeholder={
          working
            ? `Message ${facts.agent}. It reads this while it works.`
            : `Message ${facts.agent}.`
        }
      />
    );
  }
  // Before its agent's process exists a session cannot say whether it runs in a terminal.
  if (control.steer && facts.detail.currentAgent === null && session.status === "starting")
    return (
      <p
        role="status"
        className="rounded-[18px] border border-dashed border-input px-[18px] py-3.5 text-[13.5px] text-muted-foreground"
      >
        {facts.agent} is starting. Write to it here once it runs.
      </p>
    );
  const words = !control.steer
    ? facts.ownerName === null
      ? "Nobody steers this session. You can read the record and review the change."
      : `Only ${facts.ownerName} steers this session. You can read the record and review the change.`
    : facts.agentLive
      ? null
      : `${facts.agent} is not running. Resume it from the header to send a message.`;
  if (facts.agentLive && control.steer && !facts.conversationLive)
    return (
      <p className="rounded-[18px] border border-dashed border-input px-[18px] py-3.5 text-[13.5px] text-muted-foreground">
        This session runs in a terminal. Type to it in the{" "}
        <Link
          to="/sessions/$sessionId/terminal"
          params={{ sessionId: session.id }}
          search={true}
          className={cn("text-info underline-offset-2 hover:underline", focusRing)}
        >
          Terminal tab
        </Link>
        .
      </p>
    );
  if (words === null || viewer === undefined) return null;
  return (
    <p className="rounded-[18px] border border-dashed border-input px-[18px] py-3.5 text-[13.5px] text-muted-foreground">
      {words}
    </p>
  );
}

/**
 * `.latest`: the agent's newest words above the composer on every tab but Conversation, with the
 * way back to the whole conversation.
 */
export function LatestMessage({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const conversation = useConversation(facts.session.id);
  const protocol = (conversation.data?.turns.length ?? 0) > 0;
  const transcript = useQuery({
    ...trpc.sessions.transcript.queryOptions({ id: facts.session.id }),
    enabled: conversation.isSuccess && !protocol && facts.session.sealantRunId !== null,
  });
  const latest = protocol
    ? (conversation.data === undefined ? null : latestAgentText(conversation.data))?.text
    : transcript.data?.events.findLast((event) => event.kind === "assistant" && event.text !== null)
        ?.text;
  if (latest === undefined || latest === null) return null;
  return (
    <div className="mb-2 flex items-baseline gap-2.5 rounded-xl bg-secondary px-3.5 py-[9px] text-[13.5px] text-ink-2">
      <b className="shrink-0 font-sans text-[13px] font-semibold text-foreground">{facts.agent}</b>
      <span className="min-w-0 flex-1 truncate">{latest.replace(/\s+/g, " ")}</span>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: facts.session.id }}
        search={true}
        className={cn("shrink-0 rounded-md text-info no-underline hover:underline", focusRing)}
      >
        Conversation
      </Link>
    </div>
  );
}
