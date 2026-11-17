import { describe, expect, it } from "vitest";

import { type EndBox, sentSince, type SizeWatcher, stickToEnd } from "./conversation-follow.ts";

/** A scrolling box: its content, its window, and the scroll a reader or the rule moves. */
const box = (content: number, height: number, scrollTop: number) => {
  const listeners = new Set<() => void>();
  const state = { content, height, scrollTop };
  const children: Element[] = [];
  const element: EndBox = {
    get scrollTop() {
      return state.scrollTop;
    },
    set scrollTop(value: number) {
      state.scrollTop = Math.max(0, Math.min(value, state.content - state.height));
      for (const listener of listeners) listener();
    },
    get scrollHeight() {
      return state.content;
    },
    get clientHeight() {
      return state.height;
    },
    children,
    addEventListener: (_, listener) => void listeners.add(listener),
    removeEventListener: (_, listener) => void listeners.delete(listener),
  };
  return { element, state };
};

/** A ResizeObserver the test fires, as the browser does after layout and before the paint. */
const observer = () => {
  const made: Array<() => void> = [];
  class Observer {
    readonly #callback: () => void;
    constructor(callback: () => void) {
      this.#callback = callback;
      made.push(() => this.#callback());
    }
    observe() {}
    disconnect() {}
  }
  const Watcher: SizeWatcher = Observer;
  return { Observer: Watcher, laidOut: () => made.forEach((fire) => fire()) };
};

const attach = (target: ReturnType<typeof box>, resize: ReturnType<typeof observer>) =>
  stickToEnd(target.element, resize.Observer);

describe("a reader at the end of the conversation", () => {
  it("stays at the end as a reply grows, in the frame it is laid out", () => {
    const list = box(2000, 600, 1400);
    const resize = observer();
    attach(list, resize);
    list.state.content = 2080;
    resize.laidOut();
    expect(list.state.scrollTop).toBe(1480);
  });

  it("stays at the end when the composer grows and the conversation's window shrinks", () => {
    const list = box(2000, 600, 1400);
    const resize = observer();
    attach(list, resize);
    list.state.height = 520;
    resize.laidOut();
    expect(list.state.scrollTop).toBe(1480);
  });

  it("counts as at the end within a few pixels of it", () => {
    const list = box(2000, 600, 1394);
    const resize = observer();
    attach(list, resize);
    list.state.content = 2040;
    resize.laidOut();
    expect(list.state.scrollTop).toBe(1440);
  });
});

describe("a reader who scrolled up", () => {
  it("stays where they are as the reply grows", () => {
    const list = box(2000, 600, 1400);
    const resize = observer();
    attach(list, resize);
    list.element.scrollTop = 700;
    list.state.content = 2300;
    resize.laidOut();
    expect(list.state.scrollTop).toBe(700);
  });

  it("follows again once they scroll back to the end", () => {
    const list = box(2000, 600, 700);
    const resize = observer();
    attach(list, resize);
    list.element.scrollTop = 1400;
    list.state.content = 2100;
    resize.laidOut();
    expect(list.state.scrollTop).toBe(1500);
  });
});

describe("whether the person sent a message the list has not followed", () => {
  it("is a newer send of their own", () => {
    expect(sentSince("2026-11-03T10:00:00.000Z", "2026-11-03T10:00:05.000Z")).toBe(true);
    expect(sentSince(null, "2026-11-03T10:00:05.000Z")).toBe(true);
  });

  it("is not the message already shown, nor the outbox emptying as messages arrive", () => {
    expect(sentSince("2026-11-03T10:00:05.000Z", "2026-11-03T10:00:05.000Z")).toBe(false);
    expect(sentSince("2026-11-03T10:00:05.000Z", "2026-11-03T10:00:00.000Z")).toBe(false);
    expect(sentSince("2026-11-03T10:00:05.000Z", null)).toBe(false);
  });
});
