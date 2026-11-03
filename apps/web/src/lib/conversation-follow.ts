import { useCallback, useRef } from "react";

// How the conversation follows its end (screens P1, C1, X6): a reader at the end stays there as
// messages arrive, a reader who scrolled up stays where they are, and the person's own send
// brings the end into view.

/** How near its end, in pixels, a reader counts as at the end (the list's own edge threshold). */
const AT_END_PX = 8;

/** The part of a scrolling box the rule reads and moves; a test hands it a plain object. */
export interface EndBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly children: Iterable<Element>;
  addEventListener(type: "scroll", listener: () => void, options: { passive: true }): void;
  removeEventListener(type: "scroll", listener: () => void): void;
}

/** The part of `ResizeObserver` the rule uses. */
export type SizeWatcher = new (changed: () => void) => {
  observe(target: EndBox | Element): void;
  disconnect(): void;
};

const fromEnd = (box: EndBox): number => box.scrollHeight - box.clientHeight - box.scrollTop;

/**
 * Keeps a reader who was at the end of `box` there as it or its content changes size, in the
 * frame the change is laid out: a new line of the agent's reply, the person's own message, a
 * composer growing a line or a bubble saying "sending". Where the reader was is read at their last
 * scroll, before the change, so a reader who scrolled up to read stays where they are. Returns
 * the cleanup.
 */
export const stickToEnd = (
  box: EndBox,
  Observer: SizeWatcher | undefined = globalThis.ResizeObserver,
): (() => void) | undefined => {
  if (Observer === undefined) return;
  let atEnd = fromEnd(box) <= AT_END_PX;
  const read = () => {
    atEnd = fromEnd(box) <= AT_END_PX;
  };
  const resized = () => {
    if (atEnd && fromEnd(box) > 0) box.scrollTop = box.scrollHeight - box.clientHeight;
  };
  const watch = new Observer(resized);
  watch.observe(box);
  // The content's own box: the list's children change its height, never the scroller's.
  for (const child of box.children) watch.observe(child);
  box.addEventListener("scroll", read, { passive: true });
  return () => {
    watch.disconnect();
    box.removeEventListener("scroll", read);
  };
};

/**
 * `stickToEnd` as a ref callback, for a scroller that merges its ref without React's cleanup (the
 * conversation's list): the rule stops when the element goes or changes.
 *
 * ```tsx
 * const stick = useStickToEnd();
 * <MessageScrollerViewport ref={stick}>…</MessageScrollerViewport>
 * ```
 */
export const useStickToEnd = () => {
  const stop = useRef<(() => void) | undefined>(undefined);
  return useCallback((box: HTMLDivElement | null) => {
    stop.current?.();
    stop.current = box === null ? undefined : stickToEnd(box);
  }, []);
};

/**
 * Whether the person sent a message after the newest one the list has followed: a send of their
 * own, never one that arrived or left the outbox. ISO times, so they compare as text.
 */
export const sentSince = (followed: string | null, newest: string | null): boolean =>
  newest !== null && (followed === null || newest > followed);
