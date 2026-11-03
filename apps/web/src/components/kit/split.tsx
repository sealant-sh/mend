import { cn } from "@mend/ui/lib/utils";
import { useLayoutEffect, type ReactNode } from "react";
import { Group, Panel, Separator, useGroupRef, type Layout } from "react-resizable-panels";

const storageKeyOf = (key: string) => `mend-split-${key}`;

/** Tailwind's `md`, below which a `startOnlyWhenNarrow` split shows its start pane alone. */
const NARROW = "(width < 48rem)";

/**
 * A saved layout, or null when there is none or it cannot be trusted: not JSON, not the two panes
 * as numbers, below a pane's minimum, or not adding up to the whole.
 */
export const parseSplitLayout = (
  raw: string | null,
  minStart: number,
  minEnd: number,
): Layout | null => {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const start: unknown = Reflect.get(value, "start");
  const end: unknown = Reflect.get(value, "end");
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < minStart || end < minEnd || Math.abs(start + end - 100) > 0.5) return null;
  return { start, end };
};

const readSaved = (key: string, minStart: number, minEnd: number): Layout | null => {
  try {
    return parseSplitLayout(window.localStorage.getItem(storageKeyOf(key)), minStart, minEnd);
  } catch {
    return null;
  }
};

const save = (key: string, layout: Layout) => {
  try {
    window.localStorage.setItem(storageKeyOf(key), JSON.stringify(layout));
  } catch {
    // Private browsing or a full quota: the layout still holds until the page reloads.
  }
};

/**
 * Two panes and the `.rsz` divider between them. Drag the handle, or focus it with Tab and use
 * the arrow keys (Home and End jump to the limits); the separator role and its value come from
 * react-resizable-panels. The sizes are percentages. The server and the first paint always show
 * `defaultStart`; the layout this browser saved under `storageKey` replaces it before the first
 * client paint, and a saved value that is unreadable or out of bounds is ignored.
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
  startOnlyWhenNarrow = false,
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
  /** Below `md` (a phone) only the start pane shows: the divider and the end pane are hidden. */
  readonly startOnlyWhenNarrow?: boolean;
  readonly className?: string;
}) {
  // A pixel-sized end pane keeps its own limits, so a saved layout is checked against the start's.
  const savedMinEnd = endSize === undefined ? minEnd : 0;
  const groupRef = useGroupRef();
  // The saved layout lives in this browser only, so it is applied after hydration, never during.
  useLayoutEffect(() => {
    const saved = readSaved(storageKey, minStart, savedMinEnd);
    if (saved !== null) groupRef.current?.setLayout(saved);
  }, [groupRef, storageKey, minStart, savedMinEnd]);
  return (
    <Group
      groupRef={groupRef}
      orientation="horizontal"
      {...(endSize === undefined
        ? { defaultLayout: { start: defaultStart, end: 100 - defaultStart } }
        : {})}
      onLayoutChanged={(layout) => {
        // A phone's single pane is no layout to keep for a wider window.
        if (!(startOnlyWhenNarrow && window.matchMedia(NARROW).matches)) save(storageKey, layout);
      }}
      // The panes carry their own inline `display`, so the end pane is hidden from the group.
      className={cn(
        "flex min-h-0 min-w-0 flex-1",
        startOnlyWhenNarrow && "max-md:[&>[data-panel]~[data-panel]]:hidden!",
        className,
      )}
    >
      <Panel id="start" minSize={`${minStart}%`} className="flex min-w-0 flex-col">
        {start}
      </Panel>
      <SplitDivider label={label} className={startOnlyWhenNarrow ? "max-md:hidden!" : undefined} />
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
export function SplitDivider({
  label,
  className,
}: {
  readonly label: string;
  readonly className?: string | undefined;
}) {
  return (
    <Separator
      aria-label={label}
      title="Drag to resize"
      className={cn(
        "group/rsz relative z-[3] -mx-1.5 flex w-[11px] shrink-0 cursor-col-resize items-center justify-center outline-none before:absolute before:inset-y-0 before:left-[5px] before:w-px before:bg-rule data-[separator=active]:before:bg-primary data-[separator=focus]:before:bg-primary data-[separator=hover]:before:bg-primary",
        className,
      )}
    >
      {/* The grip shows while the divider is hovered, focused or dragged: at rest, a grey pill at
          a pane's edge reads as a scrollbar. The hairline marks the divider meanwhile. */}
      <i className="h-10 w-1 rounded-[3px] bg-rule opacity-0 shadow-[0_0_0_2px_var(--sw-bg)] transition-opacity group-data-[separator=active]/rsz:bg-primary group-data-[separator=active]/rsz:opacity-100 group-data-[separator=focus]/rsz:bg-primary group-data-[separator=focus]/rsz:opacity-100 group-data-[separator=hover]/rsz:bg-primary group-data-[separator=hover]/rsz:opacity-100 motion-reduce:transition-none" />
    </Separator>
  );
}
