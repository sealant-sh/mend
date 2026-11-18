// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { previewShowing } from "#/lib/previews";

import { Page } from "./preview-page.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const LINK = "/preview-auth?preview=pv-web&path=%2F";
const BOX = { protocol: "https:", hostname: "alpha.mend.run" } as const;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const render = (base: string, showing: ReturnType<typeof previewShowing>) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <Page
        base={base}
        name="web"
        port=":3000"
        showing={showing}
        layout="list"
        line="preview · web · answered HTTP 200 · observed 4 s ago"
      />,
    ),
  );
  return host;
};

const submitPath = (page: HTMLElement, path: string) => {
  const input = page.querySelector<HTMLInputElement>('input[aria-label="Path on web"]');
  if (input === null) throw new Error("no path field");
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(input, path);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => input.form?.requestSubmit());
};

describe("the page under the Preview view's address bar", () => {
  it("frames Mend's preview link sandboxed, never able to navigate Mend's tab", () => {
    const frame = render(LINK, previewShowing(LINK, "mend.run", BOX)).querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(LINK);
    expect(frame?.getAttribute("sandbox")?.split(" ").toSorted()).toEqual([
      "allow-forms",
      "allow-modals",
      "allow-popups",
      "allow-same-origin",
      "allow-scripts",
    ]);
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("title")).toBe("Preview of web");
  });

  it("opens a typed path in the frame and in a new tab", () => {
    const page = render(LINK, previewShowing(LINK, "mend.run", BOX));
    submitPath(page, "checkout");
    const opened = "/preview-auth?preview=pv-web&path=%2Fcheckout";
    expect(page.querySelector("iframe")?.getAttribute("src")).toBe(opened);
    expect(page.querySelector('a[aria-label="Open in a new tab"]')?.getAttribute("href")).toBe(
      opened,
    );
  });

  it("says why a preview on another site can't show here, and opens it in a new tab", () => {
    const page = render(LINK, previewShowing(LINK, null, BOX));
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.querySelector('button[aria-label="Reload"]')).toBeNull();
    expect(page.textContent).toContain("preview · web · answered HTTP 200 · observed 4 s ago");
    expect(page.textContent).toContain("Previews are on a different site from this page");
    const open = [...page.querySelectorAll("a")].find(
      (link) => link.textContent === "Open in a new tab",
    );
    expect(open?.getAttribute("href")).toBe(LINK);
    expect(open?.getAttribute("target")).toBe("_blank");
    expect(open?.getAttribute("rel")).toBe("noreferrer");
  });

  it("opens a Service's own address in a new tab rather than in the view", () => {
    const own = "http://127.0.0.1:41000/";
    const page = render(own, previewShowing(own, "mend.run", BOX));
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.textContent).toContain("web opens at its own address");
  });
});
