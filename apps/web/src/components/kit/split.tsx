import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

/**
 * Two panes and the `.rsz` divider between them. Drag the handle, or focus it with Tab and use
 * the arrow keys (Home and End jump to the limits); the separator role and its value come from
 * react-resizable-panels. The sizes are percentages, and `storageKey` keeps the layout per
 * browser.
 *
 * ```tsx
 * <SplitView storageKey="session-split" label="Resize the conversation"
 *   start={<Conversation />} end={<WorkPanel />} defaultStart={38} minStart={28} minEnd={30} />
 * ```
 */
export function SplitView({
  storageKey,
  label,
  start,
  end,
  defaultStart = 50,
  minStart = 20,
  minEnd = 20,
  endSize,
  className,
}: {
  readonly storageKey: string;
  readonly label: string;
  readonly start: ReactNode;
  readonly end: ReactNode;
  readonly defaultStart?: number;
  readonly minStart?: number;
  readonly minEnd?: number;
  /**
   * A fixed-width end pane, such as a side panel: its first width and its limits in CSS units
   * ("212px"). The percentages above then size only the start pane's floor.
   */
  readonly endSize?: { readonly initial: string; readonly min: string; readonly max: string };
  readonly className?: string;
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `mend-split-${storageKey}`,
    panelIds: ["start", "end"],
  });
  return (
    <Group
      orientation="horizontal"
      {...(defaultLayout !== undefined
        ? { defaultLayout }
        : endSize === undefined
          ? { defaultLayout: { start: defaultStart, end: 100 - defaultStart } }
          : {})}
      onLayoutChanged={onLayoutChanged}
      className={cn("flex min-h-0 min-w-0 flex-1", className)}
    >
      <Panel id="start" minSize={`${minStart}%`} className="flex min-w-0 flex-col">
        {start}
      </Panel>
      <SplitDivider label={label} />
      <Panel
        id="end"
        {...(endSize === undefined
          ? { minSize: `${minEnd}%` }
          : { defaultSize: endSize.initial, minSize: endSize.min, maxSize: endSize.max })}
        className="flex min-w-0 flex-col"
      >
        {end}
      </Panel>
    </Group>
  );
}

/** The divider alone, for a `Group` laid out by hand. */
export function SplitDivider({ label }: { readonly label: string }) {
  return (
    <Separator
      aria-label={label}
      title="Drag to resize"
      className="group/rsz relative z-[3] -mx-1.5 flex w-[11px] shrink-0 cursor-col-resize items-center justify-center outline-none before:absolute before:inset-y-0 before:left-[5px] before:w-px before:bg-rule data-[separator=active]:before:bg-primary data-[separator=focus]:before:bg-primary data-[separator=hover]:before:bg-primary"
    >
      <i className="h-10 w-1 rounded-[3px] bg-rule shadow-[0_0_0_2px_var(--sw-bg)] group-data-[separator=active]/rsz:bg-primary group-data-[separator=focus]/rsz:bg-primary group-data-[separator=hover]/rsz:bg-primary" />
    </Separator>
  );
}
