import { type PointerEvent, useRef, useState } from "react";

import type { TileDrop } from "./tile.tsx";

/** Where a dragged tab would land: a tile, the part of it, and in a strip the place among its tabs. */
export interface DropTarget {
  readonly tileId: string;
  readonly drop: TileDrop;
  /** Over a strip: the index the tab goes in at. */
  readonly index: number | null;
}

export interface TabDrag {
  readonly tab: string;
  readonly target: DropTarget | null;
  /** Where the pointer was when the target last changed; the chip follows it from there. */
  readonly x: number;
  readonly y: number;
}

/** The chip's place beside the pointer, below and to the right of it as on the canvas (T04). */
export const chipAt = (x: number, y: number): string => `translate(${x + 12}px, ${y + 6}px)`;

/** How far the pointer moves, in pixels, before a press on a tab becomes a drag. */
const DRAG_AFTER_PX = 5;

/** How near an edge of a tile's body, as a share of its width or height, splits rather than adds. */
const EDGE_SHARE = 0.25;

/** The tile under the point, and where in it: the strip adds, an edge splits, the middle adds. */
export const dropAt = (x: number, y: number): DropTarget | null => {
  const tile = document
    .elementsFromPoint(x, y)
    .map((element) => element.closest<HTMLElement>("[data-tile]"))
    .find((element) => element !== null && element.getClientRects().length > 0);
  const tileId = tile?.dataset["tile"];
  if (tile === null || tile === undefined || tileId === undefined) return null;
  const strip = tile.querySelector<HTMLElement>("[data-tile-strip]");
  const stripBox = strip?.getBoundingClientRect();
  if (strip !== null && stripBox !== undefined && y <= stripBox.bottom) {
    const tabs = [...strip.querySelectorAll<HTMLElement>("[data-tab]")];
    const after = tabs.findIndex((tab) => {
      const box = tab.getBoundingClientRect();
      return x < box.left + box.width / 2;
    });
    return { tileId, drop: "centre", index: after === -1 ? tabs.length : after };
  }
  const box = tile.getBoundingClientRect();
  const top = stripBox?.bottom ?? box.top;
  const across = (x - box.left) / box.width;
  const down = (y - top) / Math.max(1, box.bottom - top);
  const edges: ReadonlyArray<readonly [TileDrop, number]> = [
    ["left", across],
    ["right", 1 - across],
    ["top", down],
    ["bottom", 1 - down],
  ];
  const nearest = edges.reduce((best, edge) => (edge[1] < best[1] ? edge : best));
  return { tileId, drop: nearest[1] < EDGE_SHARE ? nearest[0] : "centre", index: null };
};

/**
 * Dragging a tab by mouse or pen: a press that moves past a few pixels lifts the tab, a chip
 * follows the pointer (`chip`, moved without re-rendering the sheet), the tile under it shows where the tab
 * would land, and letting go there calls `onDrop`. Escape puts it back. `lands` says whether a drop
 * would change anything, so a drop that wouldn't shows no mark.
 */
export const useTabDrag = ({
  onDrop,
  lands,
}: {
  readonly onDrop: (tab: string, target: DropTarget) => void;
  readonly lands: (tab: string, target: DropTarget) => boolean;
}) => {
  const [drag, setDrag] = useState<TabDrag | null>(null);
  const chip = useRef<HTMLDivElement | null>(null);

  const begin = (tab: string) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    const from = { x: event.clientX, y: event.clientY };
    let lifted = false;
    let target: DropTarget | null = null;
    const move = (moved: globalThis.PointerEvent) => {
      if (!lifted) {
        if (Math.hypot(moved.clientX - from.x, moved.clientY - from.y) < DRAG_AFTER_PX) return;
        lifted = true;
        document.documentElement.dataset["dragging"] = "tab";
      }
      const found = dropAt(moved.clientX, moved.clientY);
      const next = found !== null && lands(tab, found) ? found : null;
      const same =
        next?.tileId === target?.tileId &&
        next?.drop === target?.drop &&
        next?.index === target?.index;
      if (same && chip.current !== null) {
        // Only the chip moves: nothing else on the sheet changes until the target does.
        chip.current.style.transform = chipAt(moved.clientX, moved.clientY);
        return;
      }
      target = next;
      setDrag({ tab, target, x: moved.clientX, y: moved.clientY });
    };
    const end = (drop: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      delete document.documentElement.dataset["dragging"];
      if (lifted) setDrag(null);
      if (drop && lifted && target !== null) onDrop(tab, target);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const escape = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
  };

  return { drag, chip, begin };
};
