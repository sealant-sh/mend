import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@mend/ui/components/ui/resizable";
import { cn } from "@mend/ui/lib/utils";
import { MoveHorizontalIcon, MoveVerticalIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { holdsTile, type TileLeaf, type TileNode } from "#/lib/tiles";

/** The smallest a tile gets by its divider, in pixels: a strip's tab and its buttons. */
const TILE_MIN_PX = 220;

/**
 * The sheet's tiles as rows and columns, each divider draggable (and movable with the arrow keys
 * once focused). Only the tiles on screen show: the maximised one, and under 1024px the focused
 * one, whose tabs the one strip above lists. The rest stay in the page, hidden, at their sizes.
 */
export function TileTree({
  node,
  focus,
  maximised,
  renderTile,
  onResize,
}: {
  readonly node: TileNode;
  readonly focus: string;
  readonly maximised: string | null;
  readonly renderTile: (tile: TileLeaf) => ReactNode;
  /** A divider moved by the person: the split's new shares, in percent. */
  readonly onResize: (splitId: string, sizes: ReadonlyArray<number>) => void;
}) {
  if (node.kind === "tile") return renderTile(node);
  const ids = node.children.map((child) => child.id);
  const horizontal = node.direction === "row";
  return (
    <ResizablePanelGroup
      // A new tile or one fewer is a new group: the library reads sizes as it mounts. The tabs'
      // bodies are kept outside it, so nothing they hold restarts.
      key={ids.join(" ")}
      id={node.id}
      orientation={horizontal ? "horizontal" : "vertical"}
      defaultLayout={Object.fromEntries(ids.map((id, at) => [id, node.sizes[at] ?? 0]))}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction)
          onResize(
            node.id,
            ids.map((id) => layout[id] ?? 0),
          );
      }}
      className="min-h-0 min-w-0"
    >
      {node.children.map((child, at) => (
        <Fragment key={child.id}>
          {at === 0 ? null : (
            <ResizableHandle
              aria-label={
                horizontal ? "Resize tiles side by side" : "Resize tiles one over the other"
              }
              className={cn(
                "group/divider z-10 transition-colors data-[separator=active]:bg-ring data-[separator=focus]:bg-ring data-[separator=hover]:bg-ring",
                "max-lg:hidden",
                maximised !== null && "hidden",
              )}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-1/2 hidden size-6 -translate-1/2 place-items-center rounded-full border border-ring bg-card text-ring shadow-pop group-data-[separator=active]/divider:grid"
              >
                {horizontal ? (
                  <MoveHorizontalIcon className="size-3.5" />
                ) : (
                  <MoveVerticalIcon className="size-3.5" />
                )}
              </span>
            </ResizableHandle>
          )}
          <ResizablePanel
            id={child.id}
            minSize={TILE_MIN_PX}
            className={cn(
              "flex min-h-0 min-w-0",
              maximised !== null && !holdsTile(child, maximised) && "lg:hidden",
              !holdsTile(child, focus) && "max-lg:hidden",
            )}
          >
            <TileTree
              node={child}
              focus={focus}
              maximised={maximised}
              renderTile={renderTile}
              onResize={onResize}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}
