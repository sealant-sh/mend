// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSeenAfterIdle } from "./seen.ts";

type Intersection = (entries: ReadonlyArray<{ readonly isIntersecting: boolean }>) => void;
const watching = new Set<Intersection>();
class FakeIntersectionObserver {
  constructor(private readonly callback: Intersection) {}
  observe() {
    watching.add(this.callback);
  }
  disconnect() {
    watching.delete(this.callback);
  }
}

const Row = ({ onRead }: { readonly onRead: () => void }) => {
  const box = useRef<HTMLSpanElement>(null);
  if (useSeenAfterIdle(box)) onRead();
  return <span ref={box} />;
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  // jsdom has no requestIdleCallback: `whenIdle` falls back to its timer.
  Reflect.deleteProperty(window, "requestIdleCallback");
});
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  watching.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a row's read waits until someone can see the row", () => {
  it("reads nothing for rows off screen, and reads a row only after the page settles once it is seen", () => {
    const reads = [
      { id: "a", onRead: vi.fn() },
      { id: "b", onRead: vi.fn() },
      { id: "c", onRead: vi.fn() },
    ];
    const host = document.body.appendChild(document.createElement("div"));
    act(() => {
      root = createRoot(host);
      root.render(
        <>
          {reads.map(({ id, onRead }) => (
            <Row key={id} onRead={onRead} />
          ))}
        </>,
      );
    });
    act(() => void vi.advanceTimersByTime(10_000));
    for (const read of reads) expect(read.onRead).not.toHaveBeenCalled();

    const [first] = watching;
    act(() => first?.([{ isIntersecting: true }]));
    expect(reads[0]?.onRead).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1_500));
    expect(reads[0]?.onRead).toHaveBeenCalled();
    expect(reads[1]?.onRead).not.toHaveBeenCalled();
    expect(reads[2]?.onRead).not.toHaveBeenCalled();
  });
});
