import { Lump } from "@mend/ui/components/lump";
import { Button } from "@mend/ui/components/ui/button";
import { Tabs, TabsContent, TabsList } from "@mend/ui/components/ui/tabs";
import { cn } from "@mend/ui/lib/utils";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

/** One tab of a tile: what its strip shows, and what the tile's body shows while it is active. */
export interface TileTabEntry {
  readonly value: string;
  /** The Tile tab in the strip (`TileTab`). */
  readonly tab: ReactNode;
  /** What the tile's body holds while this tab is active. */
  readonly body: ReactNode;
}

/** Where a dragged tab lands on this tile: an edge splits it, the centre adds the tab to it. */
export type TileDrop = "left" | "right" | "top" | "bottom" | "centre";

const DROP_WORDS: Readonly<Record<TileDrop, string>> = {
  left: "Split left",
  right: "Split right",
  top: "Split above",
  bottom: "Split below",
  centre: "Add to this tile",
};

/**
 * One tile of the workspace sheet (Doop "Tile"): a 40px strip of tabs, and under it the body of
 * the active tab, filling the tile. Lay tiles out edge to edge with hairlines between them, never
 * as cards. The phone's strip, under 1024px, is `PhoneTabStrip`.
 *
 * `focused` marks the one focused tile: its active tab gets the cobalt underline, an unfocused
 * tile's turns grey. In the strip, after the tabs, `add` holds the "+" view menu; on the right,
 * `actions` holds the active tab's "…" (PR 13), then the maximise button. A maximised tile shows,
 * instead of maximise, `waiting` (the other session waiting on you) and Restore layout.
 *
 * Every tab's body stays in the page while another shows, so a tab's place and state survive a
 * switch.
 */
export function Tile({
  id,
  label,
  tabs,
  active,
  onActiveChange,
  focused = true,
  add,
  actions,
  maximised = false,
  onMaximise,
  onRestore,
  waiting = null,
  drop = null,
  className,
}: {
  /** The tile's id in the arrangement, for a dragged tab to find the tile under it. */
  readonly id: string;
  /** The tile's name for screen readers, such as "Tile 1". */
  readonly label: string;
  readonly tabs: ReadonlyArray<TileTabEntry>;
  readonly active: string;
  readonly onActiveChange?: (value: string) => void;
  readonly focused?: boolean;
  readonly add?: ReactNode;
  readonly actions?: ReactNode;
  readonly maximised?: boolean;
  /** Maximise the tile; left out when it is the only tile, with nothing to maximise over. */
  readonly onMaximise?: () => void;
  readonly onRestore?: () => void;
  /** Maximised only: the title of another session in the workspace that is waiting on you. */
  readonly waiting?: string | null;
  readonly drop?: TileDrop | null;
  readonly className?: string;
}) {
  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        if (typeof value === "string") onActiveChange?.(value);
      }}
      data-slot="tile"
      data-tile={id}
      data-focus={focused}
      className={cn(
        "relative flex size-full min-h-0 min-w-0 flex-col gap-0 bg-background",
        "[--tile-accent:var(--color-ring)] data-[focus=false]:[--tile-accent:var(--underline)]",
        className,
      )}
    >
      <div
        data-tile-strip
        className="box-content flex h-tab-strip shrink-0 items-stretch border-b pr-2 pl-2.5"
      >
        <TabsList
          variant="line"
          aria-label={label}
          className="h-full min-w-0 items-stretch gap-0.5 overflow-hidden rounded-none p-0"
        >
          {tabs.map((entry) => (
            <Fragment key={entry.value}>{entry.tab}</Fragment>
          ))}
        </TabsList>
        {add === undefined ? null : <div className="ml-0.5 flex shrink-0 items-center">{add}</div>}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
          {maximised && waiting !== null ? (
            <p className="mr-2.5 flex min-w-0 items-center gap-1.75 text-control whitespace-nowrap text-muted-foreground">
              <Lump status="wait" pr="none" className="size-3.25" />
              <span className="truncate">{waiting} is waiting on you</span>
            </p>
          ) : null}
          {maximised && onRestore !== undefined ? (
            <Button variant="outline" size="sm" className="mr-0.5" onClick={onRestore}>
              <Minimize2Icon aria-hidden className="text-muted-foreground" />
              Restore layout
            </Button>
          ) : null}
          {actions}
          {!maximised && onMaximise !== undefined ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Maximise tile"
              className="text-muted-foreground"
              onClick={onMaximise}
            >
              <Maximize2Icon aria-hidden className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
      {tabs.map((entry) => (
        <TabsContent
          key={entry.value}
          value={entry.value}
          keepMounted
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden data-hidden:hidden"
        >
          {entry.body}
        </TabsContent>
      ))}
      {drop === null ? null : (
        <div
          aria-hidden
          data-drop={drop}
          className={cn(
            "pointer-events-none absolute inset-1.5 top-[calc(var(--spacing-tab-strip)+7px)] z-10 flex items-center justify-center rounded-pop border-[1.5px] border-dashed border-ring bg-ring/9",
            drop === "left" && "right-[calc(50%+3px)]",
            drop === "right" && "left-[calc(50%+3px)]",
            drop === "top" && "bottom-[calc((100%-var(--spacing-tab-strip))/2+3px)]",
            drop === "bottom" &&
              "top-[calc(var(--spacing-tab-strip)+(100%-var(--spacing-tab-strip))/2+3px)]",
          )}
        >
          <span className="rounded-md bg-card px-2.5 py-1.25 text-control font-medium whitespace-nowrap text-ring shadow-pop">
            {DROP_WORDS[drop]}
          </span>
        </div>
      )}
    </Tabs>
  );
}
