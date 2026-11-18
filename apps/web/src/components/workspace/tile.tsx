import { Tabs, TabsContent, TabsList } from "@mend/ui/components/ui/tabs";
import { cn } from "@mend/ui/lib/utils";
import { Fragment, type ReactNode } from "react";

/** One tab of a tile: what its strip shows, and what the tile's body shows while it is active. */
export interface TileTabEntry {
  readonly value: string;
  /** The Tile tab in the strip (`TileTab`). */
  readonly tab: ReactNode;
  /** What the tile's body holds while this tab is active. */
  readonly body: ReactNode;
}

/**
 * One tile of the workspace sheet (Doop "Tile"): a 40px strip of tabs, and under it the body of
 * the active tab, filling the tile. Lay tiles out edge to edge with hairlines between them, never
 * as cards.
 *
 * `focused` marks the one focused tile: its active tab gets the cobalt underline, an unfocused
 * tile's turns grey. `actions` sits at the strip's right end.
 *
 * `size="touch"` is the phone's strip (Doop "Phone tab strip"), used under 1024px: 44px tabs whose
 * labels stay whole, the strip scrolling sideways instead.
 *
 * Still to come: the "+" view menu after the tabs and the maximise button (PR 15), the active
 * tab's "…" (PR 13) in `actions`, and dropping a dragged tab on the tile (PR 15).
 */
export function Tile({
  label,
  tabs,
  active,
  onActiveChange,
  focused = true,
  size = "default",
  actions,
  className,
}: {
  /** The tile's name for screen readers, such as "Tile 1". */
  readonly label: string;
  readonly tabs: ReadonlyArray<TileTabEntry>;
  readonly active: string;
  readonly onActiveChange?: (value: string) => void;
  readonly focused?: boolean;
  readonly size?: "default" | "touch";
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        if (typeof value === "string") onActiveChange?.(value);
      }}
      data-slot="tile"
      data-focus={focused}
      className={cn(
        "relative flex size-full min-h-0 min-w-0 flex-col gap-0 bg-background",
        "[--tile-accent:var(--color-ring)] data-[focus=false]:[--tile-accent:var(--underline)]",
        className,
      )}
    >
      <div
        className={cn(
          "box-content flex shrink-0 items-stretch border-b",
          size === "touch" ? "h-11 pr-1 pl-1.5" : "h-tab-strip pr-2 pl-2.5",
        )}
      >
        <TabsList
          variant="line"
          aria-label={label}
          className={cn(
            "h-full min-w-0 items-stretch gap-0.5 rounded-none p-0",
            size === "touch" ? "overflow-x-auto [scrollbar-width:none]" : "overflow-hidden",
          )}
        >
          {tabs.map((entry) => (
            <Fragment key={entry.value}>{entry.tab}</Fragment>
          ))}
        </TabsList>
        {actions === undefined ? null : (
          <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">{actions}</div>
        )}
      </div>
      {tabs.map((entry) => (
        <TabsContent
          key={entry.value}
          value={entry.value}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {entry.body}
        </TabsContent>
      ))}
    </Tabs>
  );
}
