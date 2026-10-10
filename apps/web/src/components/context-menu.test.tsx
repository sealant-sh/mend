// @vitest-environment jsdom
import { useContextMenu } from "@mend/ui/context-menu";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/** One row with a context menu, as the Now page and the Worktrees tab carry them. */
function Row() {
  const { openMenu, menuElement } = useContextMenu();
  return (
    <>
      <a
        href="/sessions/session-1"
        onContextMenu={(event) =>
          openMenu(event, {
            title: "session-1",
            entries: [
              { label: "Open session", onSelect: () => {} },
              { label: "Open review", onSelect: () => {} },
            ],
          })
        }
      >
        session-1
      </a>
      {menuElement}
    </>
  );
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.restoreAllMocks();
});

const render = () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  act(() => mounted.render(<Row />));
  const link = host.querySelector("a");
  if (link === null) throw new Error("no row");
  return link;
};

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');

describe("context menu focus (verify 2026-10-10)", () => {
  it("takes focus once it is shown, so Escape closes it", () => {
    const link = render();
    // A browser gives no focus to a `visibility: hidden` element; jsdom does, so record what the
    // panel looked like at each call.
    const focusedWhile: Array<string> = [];
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "menu") focusedWhile.push(this.style.visibility);
      focus.call(this);
    });
    link.focus();

    act(() => {
      link.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }),
      );
    });

    expect(menu()).not.toBeNull();
    expect(focusedWhile).toEqual([""]);
    expect(document.activeElement).toBe(menu());

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(menu()).toBeNull();
  });

  it("moves into its items on ArrowDown", () => {
    const link = render();
    act(() => {
      link.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }),
      );
    });
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe("Open session");
  });
});
