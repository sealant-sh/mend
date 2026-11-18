import { Lump, type LumpPr, type LumpStatus } from "@mend/ui/components/lump";
import { TabsTrigger } from "@mend/ui/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mend/ui/components/ui/tooltip";
import { cn } from "@mend/ui/lib/utils";
import { XIcon } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactNode, Ref } from "react";

/** A desktop tile's strip, or the phone's (44px tabs, labels whole). */
export type TileSize = "default" | "touch";

/** What a tab holds: a session's conversation (its lump), or a workspace view (its icon). */
export type TileTabKind =
  | {
      readonly kind: "session";
      readonly status: LumpStatus;
      readonly pr: LumpPr;
      /** The session's status in words, for screen readers: "Waiting on you". */
      readonly statusWords: string;
    }
  | {
      readonly kind: "view";
      readonly icon: ReactNode;
      /** Change: lines added and removed, such as 84 and 12. */
      readonly added?: number;
      readonly removed?: number;
      /** A muted mono fact after the name: ":3000", "2 passed". */
      readonly fact?: string;
    };

/** What a tab's own handlers do: its tile's drag and its keyboard moves. */
export interface TileTabHandlers {
  readonly onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** The keys the tab answers to beyond the tab list's own, for screen readers. */
  readonly keyShortcuts?: string;
}

/**
 * One tab in a Tile's strip, or in the phone's strip (`size="touch"`): Doop "Tile tab". A session
 * tab shows its lump (shape is the status, colour the pull request, amber while it waits on you)
 * and its title; a view tab its icon and name, with its facts. The active tab of the focused tile
 * has the cobalt underline; the Tile turns it grey when the tile loses focus.
 *
 * `onClose` adds the close button, shown on the active tab and on hover; the keyboard closes with
 * Delete (the tile's handlers). `ghost` is the tab while it is dragged away.
 */
export function TileTab({
  value,
  label,
  size = "default",
  onClose,
  ghost = false,
  onPointerDown,
  onKeyDown,
  keyShortcuts,
  className,
  ...tab
}: TileTabKind &
  TileTabHandlers & {
    readonly value: string;
    readonly label: string;
    readonly size?: TileSize;
    readonly onClose?: () => void;
    readonly ghost?: boolean;
    readonly className?: string;
  }) {
  const touch = size === "touch";
  const closable = onClose !== undefined && !touch;
  return (
    <div
      data-tab={value}
      className={cn(
        "group/tab relative flex h-full shrink-0",
        // A session's title gives way first on a desktop strip; on the phone's, labels stay whole.
        tab.kind === "session" && !touch && "max-w-max min-w-30 shrink",
        ghost && "opacity-40",
        className,
      )}
    >
      <TabsTrigger
        value={value}
        data-size={size}
        // A session tab's name carries its status, which the lump only draws.
        aria-label={tab.kind === "session" ? `${label}, ${tab.statusWords}` : undefined}
        aria-keyshortcuts={keyShortcuts}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className={cn(
          // The kit's trigger, reset to the canvas's tab: no pill, a 2px underline inset 10px.
          "h-full min-w-0 flex-1 touch-none gap-1.75 rounded-none border-0 px-2.5 py-0 text-control font-medium text-muted-foreground tabular-nums",
          "hover:text-foreground data-active:bg-transparent data-active:text-foreground dark:data-active:border-transparent dark:data-active:bg-transparent",
          "after:inset-x-2.5! after:bottom-[-1px]! after:h-0.5 after:rounded-full after:bg-[var(--tile-accent,var(--color-ring))] data-active:after:opacity-100",
          "focus-visible:ring-inset",
          closable && "pr-7",
          // The phone strip scrolls sideways and clips what hangs below it: the underline sits inside.
          touch && "h-11 touch-auto text-lead after:bottom-0!",
        )}
      >
        {tab.kind === "session" ? (
          <Lump
            status={tab.status}
            pr={tab.pr}
            moving
            className={touch ? "size-3.75" : "size-3.5"}
          />
        ) : (
          <span
            aria-hidden
            className={cn(
              "flex shrink-0 text-muted-foreground",
              touch ? "[&_svg]:size-4" : "[&_svg]:size-3.5",
            )}
          >
            {tab.icon}
          </span>
        )}
        <span className={cn("min-w-0 leading-tight", !touch && "truncate")}>{label}</span>
        {tab.kind === "view" && tab.added !== undefined ? (
          <span className="font-mono text-2xs font-normal text-success">
            +{tab.added.toLocaleString("en")}
          </span>
        ) : null}
        {tab.kind === "view" && tab.removed !== undefined ? (
          <span className="-ml-0.75 font-mono text-2xs font-normal text-destructive">
            −{tab.removed.toLocaleString("en")}
          </span>
        ) : null}
        {tab.kind === "view" && tab.fact !== undefined ? (
          <span className="font-mono text-2xs font-normal text-muted-foreground">{tab.fact}</span>
        ) : null}
      </TabsTrigger>
      {closable ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                // The tab list moves between tabs with the arrow keys; Delete on a tab closes it.
                tabIndex={-1}
                aria-label={`Close ${label}`}
                onClick={onClose}
                className={cn(
                  "absolute top-1/2 right-1.5 grid size-4.5 -translate-y-1/2 place-items-center rounded-sm text-faint hover:bg-accent hover:text-foreground",
                  "invisible group-hover/tab:visible group-has-data-active/tab:visible",
                )}
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            }
          />
          <TooltipContent>Close tab</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** The floating tab that follows the pointer while a tab is dragged (Doop Tile tab, dragging). */
export function DraggedTab({
  label,
  at,
  ref,
  ...tab
}: TileTabKind & {
  readonly label: string;
  /** Its CSS transform, beside the pointer. */
  readonly at: string;
  readonly ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      aria-hidden
      style={{ transform: at }}
      className="pointer-events-none fixed top-0 left-0 z-50 flex h-8.5 items-center gap-1.75 rounded-md border border-input bg-card px-3 text-control font-medium whitespace-nowrap text-foreground shadow-pop"
    >
      {tab.kind === "session" ? (
        <Lump status={tab.status} pr={tab.pr} className="size-3.5" />
      ) : (
        <span className="flex shrink-0 text-muted-foreground [&_svg]:size-3.5">{tab.icon}</span>
      )}
      <span className="max-w-60 truncate">{label}</span>
      {tab.kind === "view" && tab.fact !== undefined ? (
        <span className="font-mono text-2xs font-normal text-muted-foreground">{tab.fact}</span>
      ) : null}
    </div>
  );
}
