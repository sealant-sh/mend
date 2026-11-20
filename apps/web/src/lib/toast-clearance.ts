import { useSyncExternalStore } from "react";

/**
 * Toasts sit in the bottom-right corner of the window (on a phone, across the bottom). A composer
 * is often there too: at the foot of a conversation, or of a narrow sheet where its column reaches
 * the right edge. A toast never covers it: while a composer reaches into the toasts' corner, the
 * toasts sit just above its top edge instead. Every composer card registers itself
 * (`keepToastsClear`); the toaster reads where they are (`useComposerBoxes`) and how far up to sit
 * (`toastClearance`).
 */

/** The toasts' place, in px, as the kit's viewport draws it (`ToastViewport`). */
export const TOAST_EDGE = 24;
export const TOAST_WIDTH = 416;
/** Room for one toast and the edges of the ones stacked behind it. */
export const TOAST_ZONE_HEIGHT = 96;
/** How far above a composer's top edge the toasts sit. */
export const TOAST_GAP = 12;

export interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
  /** On a phone the toasts take the width, so any composer at the bottom is in their way. */
  readonly phone: boolean;
  /** Where the toasts' bottom edge sits when nothing is in the way, from the window's bottom. */
  readonly bottom: number;
}

/**
 * How far from the window's bottom the toasts' bottom edge sits so they cover none of
 * `composers`; null when none reaches into their corner and they keep their own place.
 */
export const toastClearance = (
  composers: ReadonlyArray<Box>,
  viewport: Viewport,
): number | null => {
  const zoneTop = viewport.height - viewport.bottom - TOAST_ZONE_HEIGHT;
  const zoneLeft = viewport.phone ? 0 : viewport.width - TOAST_EDGE - TOAST_WIDTH;
  let clearance: number | null = null;
  for (const box of composers) {
    const shown = box.bottom > box.top && box.top < viewport.height && box.bottom > 0;
    const inTheWay = box.bottom > zoneTop && box.right > zoneLeft && box.left < viewport.width;
    if (!shown || !inTheWay) continue;
    const above = viewport.height - box.top + TOAST_GAP;
    if (above > viewport.bottom) clearance = Math.max(clearance ?? 0, above);
  }
  return clearance;
};

const composers = new Set<Element>();
const listeners = new Set<() => void>();
let boxes: ReadonlyArray<Box> = [];
let frame: number | null = null;
let observer: ResizeObserver | null = null;

const sameBoxes = (a: ReadonlyArray<Box>, b: ReadonlyArray<Box>): boolean =>
  a.length === b.length &&
  a.every(
    (box, index) =>
      box.top === b[index]?.top &&
      box.bottom === b[index]?.bottom &&
      box.left === b[index]?.left &&
      box.right === b[index]?.right,
  );

const measure = () => {
  frame = null;
  const next = [...composers].map((element) => {
    const { top, bottom, left, right } = element.getBoundingClientRect();
    return { top, bottom, left, right };
  });
  if (sameBoxes(next, boxes)) return;
  boxes = next;
  for (const listener of listeners) listener();
};

/** Measures again on the next frame: a composer grew, moved, or the window changed. */
const remeasure = () => {
  if (frame === null) frame = requestAnimationFrame(measure);
};

const watchWindow = () => {
  observer = new ResizeObserver(remeasure);
  window.addEventListener("resize", remeasure);
  // A composer in a page that scrolls moves without changing size.
  window.addEventListener("scroll", remeasure, { capture: true, passive: true });
};

const unwatchWindow = () => {
  observer?.disconnect();
  observer = null;
  window.removeEventListener("resize", remeasure);
  window.removeEventListener("scroll", remeasure, { capture: true });
};

/**
 * A composer card's ref: while it is on the page, toasts keep clear of it. Stable, so it can be
 * passed as `ref` from any render.
 */
export const keepToastsClear = (element: HTMLElement | null): (() => void) | undefined => {
  if (element === null) return undefined;
  if (composers.size === 0) watchWindow();
  composers.add(element);
  observer?.observe(element);
  remeasure();
  return () => {
    composers.delete(element);
    observer?.unobserve(element);
    if (composers.size === 0) unwatchWindow();
    remeasure();
  };
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const NO_BOXES: ReadonlyArray<Box> = [];

/** Where the composers on the page are now, measured once a frame at most. */
export const useComposerBoxes = (): ReadonlyArray<Box> =>
  useSyncExternalStore(
    subscribe,
    () => boxes,
    () => NO_BOXES,
  );
