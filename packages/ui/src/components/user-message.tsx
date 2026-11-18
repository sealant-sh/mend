import { Bubble, BubbleContent } from "@mend/ui/components/ui/bubble";
import { Message, MessageContent, MessageFooter } from "@mend/ui/components/ui/message";
import { cn } from "@mend/ui/lib/utils";
import * as React from "react";

/**
 * What the person sent the agent: a grey bubble on the right of the thread, with a muted byline
 * under it ("Ada Lovelace · 13 Nov, 10:42"). Files they attached go in `attachments`, above the
 * bubble. No avatar and no card. `size="touch"` is the phone size: a 320px bubble at 14px.
 */
function UserMessage({
  size = "default",
  byline,
  attachments,
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "touch";
  byline?: React.ReactNode;
  attachments?: React.ReactNode;
}) {
  return (
    <Message
      data-slot="user-message"
      data-size={size}
      align="end"
      className={cn("group/user-message", className)}
      {...props}
    >
      <MessageContent className="items-end gap-1.5 group-data-[size=touch]/user-message:gap-1">
        {attachments === undefined ? null : (
          <div data-slot="user-message-attachments" className="flex flex-wrap justify-end gap-2">
            {attachments}
          </div>
        )}
        <Bubble
          variant="muted"
          align="end"
          className="max-w-135 group-data-[size=touch]/user-message:max-w-80"
        >
          <BubbleContent className="rounded-xl px-3.5 py-2.5 text-prose leading-normal text-pretty group-data-[size=touch]/user-message:px-3 group-data-[size=touch]/user-message:py-2.25 group-data-[size=touch]/user-message:text-sm">
            {children}
          </BubbleContent>
        </Bubble>
        {byline === undefined ? null : (
          <MessageFooter className="px-0 text-meta font-normal group-data-[size=touch]/user-message:text-2xs">
            {byline}
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

export { UserMessage };
