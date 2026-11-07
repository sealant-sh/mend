import { Bubble, BubbleContent } from "@mend/ui/components/ui/bubble";
import { Message, MessageContent, MessageHeader } from "@mend/ui/components/ui/message";
import { cn } from "@mend/ui/lib/utils";

import { Button } from "#/components/kit/button";
import type { OutboxMessage } from "#/lib/outbox";

/** What a bubble of the person's own says of a message still in their outbox. */
const outboxNote = (
  message: OutboxMessage,
): { readonly words: string; readonly className: string } | null => {
  switch (message.state._tag) {
    case "Sending":
      // A stopped session takes the words once Mend has resumed it.
      return {
        words: message.resuming === true ? "resuming…" : "sending",
        className: "text-faint",
      };
    case "Sent":
      return null;
    case "Unconfirmed":
      return { words: "delivery not confirmed", className: "text-warning" };
    case "NotSent":
      return { words: "not sent", className: "text-danger" };
  }
};

/**
 * A message the person (or someone sharing control) sent: the right-hand `.msg-you` bubble. One
 * of their own still in their outbox says how far it got; one that did not arrive says why, under
 * the bubble, with Retry and Edit. The composer's footer announces the outcome, on every tab.
 */
export function YouMessage({
  text,
  from,
  note,
  narrow,
  outbox = null,
  onRetry,
  onEdit,
}: {
  readonly text: string;
  readonly from: string | null;
  readonly note: string | null;
  readonly narrow: boolean;
  readonly outbox?: OutboxMessage | null;
  readonly onRetry?: (message: OutboxMessage) => void;
  readonly onEdit?: (message: OutboxMessage) => void;
}) {
  const pending = outbox === null ? null : outboxNote(outbox);
  const stuck =
    outbox !== null && (outbox.state._tag === "NotSent" || outbox.state._tag === "Unconfirmed")
      ? outbox
      : null;
  return (
    <Message align="end">
      <MessageContent>
        {from === null && note === null && pending === null ? null : (
          <MessageHeader className="justify-end gap-2 px-1 font-mono text-[11px] text-faint">
            {from === null ? null : (
              <span className="font-sans font-semibold text-ink-2">{from}</span>
            )}
            {pending === null ? note : <span className={pending.className}>{pending.words}</span>}
          </MessageHeader>
        )}
        <Bubble variant="secondary" align="end" className={narrow ? "max-w-[92%]" : "max-w-[78%]"}>
          <BubbleContent
            className={cn(
              "rounded-[18px_18px_6px_18px] px-4 py-3 text-[14.5px] leading-[1.55] whitespace-pre-wrap text-foreground",
              stuck !== null && "border border-dashed border-input bg-transparent",
            )}
          >
            {text}
          </BubbleContent>
        </Bubble>
        {stuck === null ? null : (
          <div className="flex flex-wrap items-center justify-end gap-1.5 px-1">
            {stuck.state._tag === "NotSent" ? (
              <p className="min-w-0 flex-1 text-right font-mono text-[11.5px] text-danger">
                {stuck.state.words}
              </p>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => onRetry?.(stuck)}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onEdit?.(stuck)}>
              Edit
            </Button>
          </div>
        )}
      </MessageContent>
    </Message>
  );
}
