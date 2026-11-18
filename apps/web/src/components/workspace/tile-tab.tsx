import { Lump, type LumpPr, type LumpStatus } from "@mend/ui/components/lump";
import { TabsTrigger } from "@mend/ui/components/ui/tabs";
import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

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

/**
 * One tab in a Tile's strip, or in the phone's strip (`size="touch"`): Doop "Tile tab". A session
 * tab shows its lump (shape is the status, colour the pull request, amber while it waits on you)
 * and its title; a view tab its icon and name, with its facts. The active tab of the focused tile
 * has the cobalt underline; the Tile turns it grey when the tile loses focus.
 *
 * `value` is the tab's key in the Tile's Tabs. Closing, dragging and the tab's menu are PR 15's
 * and PR 13's; they attach here.
 */
export function TileTab({
  value,
  label,
  size = "default",
  className,
  ...tab
}: TileTabKind & {
  readonly value: string;
  readonly label: string;
  readonly size?: "default" | "touch";
  readonly className?: string;
}) {
  return (
    <TabsTrigger
      value={value}
      data-size={size}
      // A session tab's name carries its status, which the lump only draws.
      aria-label={tab.kind === "session" ? `${label}, ${tab.statusWords}` : undefined}
      className={cn(
        // The kit's trigger, reset to the canvas's tab: no pill, a 2px underline inset 10px.
        "h-full flex-none gap-1.75 rounded-none border-0 px-2.5 py-0 text-control font-medium text-muted-foreground tabular-nums",
        "hover:text-foreground data-active:bg-transparent data-active:text-foreground dark:data-active:border-transparent dark:data-active:bg-transparent",
        "after:inset-x-2.5! after:bottom-[-1px]! after:h-0.5 after:rounded-full after:bg-[var(--tile-accent,var(--color-ring))] data-active:after:opacity-100",
        "focus-visible:ring-inset",
        tab.kind === "session" && "min-w-30 shrink",
        // The phone strip scrolls sideways and clips what hangs below it: the underline sits inside.
        size === "touch" && "h-11 text-lead after:bottom-0!",
        className,
      )}
    >
      {tab.kind === "session" ? (
        <Lump
          status={tab.status}
          pr={tab.pr}
          moving
          className={size === "touch" ? "size-3.75" : "size-3.5"}
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            "flex shrink-0 text-muted-foreground",
            size === "touch" ? "[&_svg]:size-4" : "[&_svg]:size-3.5",
          )}
        >
          {tab.icon}
        </span>
      )}
      <span className={cn("min-w-0 leading-tight", size === "default" && "truncate")}>{label}</span>
      {tab.kind === "view" && tab.added !== undefined ? (
        <span className="font-mono text-2xs font-normal text-success">+{tab.added}</span>
      ) : null}
      {tab.kind === "view" && tab.removed !== undefined ? (
        <span className="-ml-0.75 font-mono text-2xs font-normal text-destructive">
          −{tab.removed}
        </span>
      ) : null}
      {tab.kind === "view" && tab.fact !== undefined ? (
        <span className="font-mono text-2xs font-normal text-muted-foreground">{tab.fact}</span>
      ) : null}
    </TabsTrigger>
  );
}
