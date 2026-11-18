import { CollapsibleTrigger } from "@mend/ui/components/ui/collapsible";
import { TraceCollapsible, TraceCollapsibleContent } from "@mend/ui/components/ui/trace";
import { cn } from "@mend/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import * as React from "react";

type TraceTone = "none" | "running" | "error" | "pending";

/** The row itself: chevron, icon, title, command and description on one 28px line. */
function TraceRowLine({
  tone,
  icon,
  title,
  code,
  description,
  expandable,
}: {
  tone: TraceTone;
  icon: React.ReactNode;
  title: React.ReactNode;
  code: string | undefined;
  description: React.ReactNode;
  expandable: boolean;
}) {
  return (
    <>
      <ChevronRightIcon
        aria-hidden="true"
        data-slot="trace-row-chevron"
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-aria-expanded/trace-row:rotate-90",
          !expandable && "invisible",
        )}
      />
      {icon === undefined ? null : (
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg:not([class*='size-'])]:size-4"
        >
          {icon}
        </span>
      )}
      <span
        data-slot="trace-row-title"
        className={cn(
          "min-w-0 shrink truncate text-foreground",
          tone === "pending" && "text-muted-foreground",
        )}
      >
        {title}
        {code === undefined || code === "" ? null : (
          <code className="ms-1.5 rounded-sm bg-muted px-1.25 py-px font-mono text-2xs">
            {code}
          </code>
        )}
      </span>
      {description === undefined ? null : (
        <span
          data-slot="trace-row-description"
          className={cn(
            "shrink-0 whitespace-nowrap text-muted-foreground tabular-nums",
            tone === "error" && "text-destructive",
          )}
        >
          {description}
        </span>
      )}
    </>
  );
}

const rowClass =
  "group/trace-row flex h-7 w-full min-w-0 items-center gap-2 rounded-sm text-left text-row outline-none";

/**
 * One thing the agent did, in a turn's trace: an icon, a one-line title, an optional command in
 * mono (`code`) and a muted description (a diffstat, a duration, a count).
 *
 * With children it is a row that opens: a chevron before it, and the nested steps or output under
 * it. `open` and `onOpenChange` control it; `defaultOpen` starts it open.
 *
 * tone: `running` keeps the title in full colour while the description says what is happening (no
 * spinner, no shimmer); `error` makes the description red; `pending` mutes the row.
 */
function TraceRow({
  tone = "none",
  icon,
  title,
  code,
  description,
  open,
  defaultOpen,
  onOpenChange,
  children,
  className,
}: {
  tone?: TraceTone;
  icon?: React.ReactNode;
  title: React.ReactNode;
  code?: string;
  description?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
  className?: string;
}) {
  const line = { tone, icon, title, code, description };

  if (children === undefined || children === null) {
    return (
      <div data-slot="trace-row" data-tone={tone} className={cn(rowClass, className)}>
        <TraceRowLine {...line} expandable={false} />
      </div>
    );
  }

  const body = (
    <>
      <CollapsibleTrigger
        className={cn(rowClass, "cursor-pointer focus-visible:ring-3 focus-visible:ring-ring/50")}
      >
        <TraceRowLine {...line} expandable />
      </CollapsibleTrigger>
      <TraceCollapsibleContent className="mt-1 mb-1 ml-1.5 pl-5">
        {children}
      </TraceCollapsibleContent>
    </>
  );
  const report = (next: boolean) => onOpenChange?.(next);
  return open === undefined ? (
    <TraceCollapsible
      data-slot="trace-row"
      data-tone={tone}
      className={className}
      defaultOpen={defaultOpen}
      onOpenChange={report}
    >
      {body}
    </TraceCollapsible>
  ) : (
    <TraceCollapsible
      data-slot="trace-row"
      data-tone={tone}
      className={className}
      open={open}
      onOpenChange={report}
    >
      {body}
    </TraceCollapsible>
  );
}

export { TraceRow, type TraceTone };
