// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { focusWhenShown } from "#/lib/focus-when-shown";

/** Frames run by hand: `next()` runs the one queued frame. */
const frames = () => {
  const queued = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    id += 1;
    queued.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => queued.delete(handle));
  return {
    pending: () => queued.size,
    next: () => {
      const [[handle, callback] = []] = queued;
      if (handle === undefined || callback === undefined) throw new Error("no frame queued");
      queued.delete(handle);
      callback(0);
    },
  };
};

/**
 * A textarea the browser does not render until `show()`: a browser gives no focus to it before
 * then (jsdom would, so its `focus` is gated by hand), as with the diff's composer before the
 * diff slots it in (verify 2026-10-10).
 */
const unrenderedTextarea = () => {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  let shown = false;
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(textarea, "focus").mockImplementation(() => {
    if (shown) focus.call(textarea);
  });
  return {
    textarea,
    show: () => {
      shown = true;
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("focusWhenShown", () => {
  it("focuses at once when the element is already shown", () => {
    const clock = frames();
    const { textarea, show } = unrenderedTextarea();
    show();
    focusWhenShown(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(clock.pending()).toBe(0);
  });

  it("keeps trying each frame until the element shows, then takes focus and stops", () => {
    const clock = frames();
    const { textarea, show } = unrenderedTextarea();
    focusWhenShown(textarea);
    expect(document.activeElement).toBe(document.body);
    clock.next();
    expect(document.activeElement).toBe(document.body);
    show();
    clock.next();
    expect(document.activeElement).toBe(textarea);
    expect(clock.pending()).toBe(0);
  });

  it("gives up after its frames, and the cancel stops it", () => {
    const clock = frames();
    const { textarea } = unrenderedTextarea();
    focusWhenShown(textarea, 2);
    clock.next();
    clock.next();
    expect(clock.pending()).toBe(0);

    const cancel = focusWhenShown(textarea);
    expect(clock.pending()).toBe(1);
    cancel();
    expect(clock.pending()).toBe(0);
  });
});
