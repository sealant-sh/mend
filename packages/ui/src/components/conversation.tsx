import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@mend/ui/components/ui/message-scroller";
import { cn } from "@mend/ui/lib/utils";
import * as React from "react";

/**
 * A session's conversation, in a column 704px wide. It follows the newest message as messages
 * arrive and grow, unless the person has scrolled up to read; scrolling back to the bottom (or the
 * arrow button that appears) follows again. shadcn's Message scroller does the following.
 *
 * Put each message, trace or marker in a `ConversationItem`. `footer` holds what stays under the
 * thread, such as the Prompt input or Composer card.
 *
 * `onScroll` hears the thread scroll (an app reads earlier messages as the reader nears the top),
 * and `keepPlaceOnPrepend` keeps what the reader sees still when earlier messages are added above.
 */
function Conversation({
  label,
  footer,
  onScroll,
  keepPlaceOnPrepend = false,
  children,
  className,
}: {
  /** The thread's name for screen readers, such as the session's title. */
  label?: string;
  footer?: React.ReactNode;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  keepPlaceOnPrepend?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <div data-slot="conversation" className={cn("flex size-full min-h-0 flex-col", className)}>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport
            aria-label={label}
            onScroll={onScroll}
            preserveScrollOnPrepend={keepPlaceOnPrepend}
          >
            <MessageScrollerContent className="mx-auto w-full max-w-conversation gap-5 px-4 py-6">
              {children}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
        {footer === undefined ? null : (
          <div
            data-slot="conversation-footer"
            className="mx-auto w-full max-w-conversation shrink-0 px-4 pb-4"
          >
            {footer}
          </div>
        )}
      </div>
    </MessageScrollerProvider>
  );
}

/** One entry in a Conversation. `messageId` lets the app scroll to it. */
function ConversationItem(props: React.ComponentProps<typeof MessageScrollerItem>) {
  return <MessageScrollerItem data-slot="conversation-item" {...props} />;
}

export { Conversation, ConversationItem };
