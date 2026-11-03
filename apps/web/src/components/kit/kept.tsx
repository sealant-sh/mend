import { type ReactNode, useCallback, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A DOM node of its own that outlives where it is shown: what `Kept` renders into it stays
 * mounted, its sockets and its state included, while layouts and tabs come and go around it. The
 * node moves into whichever `KeptSlot` is on the page, and leaves the page when none is.
 *
 * ```tsx
 * const node = useKeptNode("flex min-h-0 flex-1 flex-col");
 * <Kept node={node}><Terminal /></Kept>
 * {layout === "split" ? <aside><KeptSlot node={node} /></aside> : <main><KeptSlot node={node} /></main>}
 * ```
 */
export const useKeptNode = (className: string): HTMLDivElement | null =>
  useState(() => {
    // A page rendered on the server has no DOM to keep a node in: what it holds mounts in the
    // browser (the caller renders a placeholder there until hydration).
    if (typeof document === "undefined") return null;
    const node = document.createElement("div");
    node.className = className;
    return node;
  })[0];

/** Renders `children` into the kept node, at a place in the tree that never changes. */
export function Kept({
  node,
  children,
}: {
  readonly node: HTMLDivElement;
  readonly children: ReactNode;
}) {
  return createPortal(children, node);
}

/** Where the kept node shows now. A slot that goes takes the node with it only if it still holds it. */
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
