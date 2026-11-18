// @vitest-environment jsdom
import { Conversation, ConversationItem } from "@mend/ui/components/conversation";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { render } from "./render.tsx";

// jsdom lays nothing out, so the thread's geometry is faked here: a 400px viewport over messages
// 300px tall each, stacked from the top. The scroller reads only these numbers.
const VIEWPORT = 400;
const MESSAGE = 300;

const scrollTops = new WeakMap<Element, number>();
const isViewport = (element: Element) =>
  element.getAttribute("data-slot") === "message-scroller-viewport";
const messageCount = (viewport: Element) => viewport.querySelectorAll("[data-message-id]").length;

function rectAt(top: number, height: number): DOMRect {
  return DOMRect.fromRect({ x: 0, y: top, width: 600, height });
}

const originals = new Map<string, PropertyDescriptor | undefined>();
function fake(name: string, descriptor: PropertyDescriptor) {
  originals.set(name, Object.getOwnPropertyDescriptor(Element.prototype, name));
  Object.defineProperty(Element.prototype, name, { configurable: true, ...descriptor });
}

beforeEach(() => {
  fake("scrollTop", {
    get(this: Element) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: Element, top: number) {
      scrollTops.set(this, top);
    },
  });
  fake("clientHeight", {
    get(this: Element) {
      return isViewport(this) ? VIEWPORT : 0;
    },
  });
  fake("scrollHeight", {
    get(this: Element) {
      return isViewport(this) ? messageCount(this) * MESSAGE : 0;
    },
  });
  fake("scrollTo", {
    value(this: Element, options: ScrollToOptions) {
      scrollTops.set(this, options.top ?? 0);
    },
  });
  fake("getBoundingClientRect", {
    value(this: Element) {
      if (isViewport(this)) return rectAt(0, VIEWPORT);
      const viewport = this.closest("[data-slot=message-scroller-viewport]");
      const id = this.getAttribute("data-message-id");
      if (viewport === null || id === null) return rectAt(0, 0);
      const index = [...viewport.querySelectorAll("[data-message-id]")].indexOf(this);
      return rectAt(index * MESSAGE - (scrollTops.get(viewport) ?? 0), MESSAGE);
    },
  });
});

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, name);
    else Object.defineProperty(Element.prototype, name, descriptor);
  }
  originals.clear();
});

function Thread({ count }: { count: number }) {
  return (
    <Conversation label="Fix flaky checkout retry">
      {Array.from({ length: count }, (_, index) => (
        <ConversationItem key={`m${index}`} messageId={`m${index}`}>
          Message {index + 1}
        </ConversationItem>
      ))}
    </Conversation>
  );
}

/** Lets the scroller's MutationObserver and animation frames run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

/** The person scrolls the thread to `top` with the wheel. */
function scrollBy(viewport: Element, top: number) {
  act(() => {
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
    scrollTops.set(viewport, top);
    viewport.dispatchEvent(new Event("scroll"));
  });
}

const bottomFor = (count: number) => count * MESSAGE - VIEWPORT;

describe("Conversation", () => {
  it("follows the newest message until the person scrolls up, and again once they're back", async () => {
    const { host, rerender } = render(<Thread count={3} />);
    const viewport = host.querySelector("[data-slot=message-scroller-viewport]");
    if (viewport === null) throw new Error("no viewport");
    await settle();
    expect(viewport.scrollTop).toBe(bottomFor(3));

    rerender(<Thread count={4} />);
    await settle();
    expect(viewport.scrollTop).toBe(bottomFor(4));

    // Scrolled up to read: a new message doesn't pull the thread away.
    scrollBy(viewport, 200);
    await settle();
    rerender(<Thread count={5} />);
    await settle();
    expect(viewport.scrollTop).toBe(200);

    // Back at the bottom: it follows again.
    scrollBy(viewport, bottomFor(5));
    await settle();
    rerender(<Thread count={6} />);
    await settle();
    expect(viewport.scrollTop).toBe(bottomFor(6));
  });
});
