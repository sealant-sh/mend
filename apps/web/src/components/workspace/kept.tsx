import { type ReactNode, useCallback, useState } from "react";
import { createPortal } from "react-dom";

/**
 * DOM nodes that outlive where they are shown, one per key: what `Kept` renders into a node stays
 * mounted (a terminal's socket, a conversation's place in its thread) while the node moves from
 * one `KeptSlot` to another, as tabs move between tiles. A node no slot holds leaves the page and
 * keeps its React tree. Nodes exist only in the browser; the server renders in place.
 */
export const useKeptNodes = (className: string): ((key: string) => HTMLDivElement) => {
  const [nodes] = useState(() => new Map<string, HTMLDivElement>());
  return useCallback(
    (key: string) => {
      const known = nodes.get(key);
      if (known !== undefined) return known;
      const node = document.createElement("div");
      node.className = className;
      nodes.set(key, node);
      return node;
    },
    [nodes, className],
  );
};

/** Renders `children` into the kept node, from a place in the tree that never changes. */
export function Kept({
  node,
  children,
}: {
  readonly node: HTMLDivElement;
  readonly children: ReactNode;
}) {
  return createPortal(children, node);
}

/** Where a kept node shows now. A slot that goes takes the node with it only if it still holds it. */
export function KeptSlot({
  node,
  className,
}: {
  readonly node: HTMLDivElement;
  readonly className?: string;
}) {
  // Stable for the node's life: a new callback each render would take the node out and put it back.
  const place = useCallback(
    (slot: HTMLDivElement | null) => {
      if (slot === null) return;
      slot.append(node);
      return () => {
        if (node.parentElement === slot) node.remove();
      };
    },
    [node],
  );
  return <div className={className} ref={place} />;
}
