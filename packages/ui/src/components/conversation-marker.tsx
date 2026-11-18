import { Marker, MarkerContent } from "@mend/ui/components/ui/marker";
import { cn } from "@mend/ui/lib/utils";
import { GitCommitHorizontalIcon } from "lucide-react";
import * as React from "react";

/**
 * A line inside a conversation.
 *
 * `kind="checkpoint"` is a hairline divider naming the checkpoint (`label`) and its `sha`, with a
 * cobalt `link` (a button or anchor the app renders, such as "Review from here") that opens the
 * change from that checkpoint. Its pieces stay on one line.
 *
 * `kind="status"` is a muted line while a turn works ("Running tests…"), with no spinner or
 * shimmer. A long one wraps.
 */
function ConversationMarker({
  kind = "checkpoint",
  label,
  sha,
  link,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  kind?: "checkpoint" | "status";
  label: React.ReactNode;
  sha?: string;
  link?: React.ReactNode;
}) {
  if (kind === "status") {
    return (
      <Marker
        data-slot="conversation-marker"
        data-kind={kind}
        className={cn("min-h-7 items-start py-1 text-row text-muted-foreground", className)}
        {...props}
      >
        <MarkerContent className="flex-1 text-pretty">{label}</MarkerContent>
      </Marker>
    );
  }
  return (
    <Marker
      data-slot="conversation-marker"
      data-kind={kind}
      variant="separator"
      className={cn(
        "min-h-7 gap-2 text-meta whitespace-nowrap text-muted-foreground before:mr-0 after:ml-0",
        className,
      )}
      {...props}
    >
      <GitCommitHorizontalIcon aria-hidden="true" className="size-3.5" />
      <MarkerContent className="flex items-center gap-2">
        <span>{label}</span>
        {sha === undefined ? null : (
          <>
            <span aria-hidden="true">·</span>
            <code className="font-mono text-2xs">{sha}</code>
          </>
        )}
        {link === undefined ? null : (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-medium text-info *:[a,button]:cursor-pointer *:[a,button]:no-underline *:[a,button]:hover:underline">
              {link}
            </span>
          </>
        )}
      </MarkerContent>
    </Marker>
  );
}

export { ConversationMarker };
