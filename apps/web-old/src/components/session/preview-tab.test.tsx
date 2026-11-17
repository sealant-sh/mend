// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { joinPath, PreviewPane, previewShowing } from "./preview-tab.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

describe("the Preview tab's address", () => {
  it("opens a typed path through Mend's relative preview link", () => {
    expect(joinPath("/preview-auth?preview=pv-web&path=%2F", "docs/start")).toBe(
      "/preview-auth?preview=pv-web&path=%2Fdocs%2Fstart",
    );
    expect(joinPath("/preview-auth?preview=pv-web&path=%2F", "")).toBe(
      "/preview-auth?preview=pv-web&path=%2F",
    );
  });

  it("opens a typed path on a preview's own origin", () => {
    expect(joinPath("https://pv-web.preview.example.test/old?x=1", "/docs")).toBe(
      "https://pv-web.preview.example.test/docs",
    );
  });
});

const LINK = "/preview-auth?preview=pv-web&path=%2F";
const BOX = { protocol: "https:", hostname: "alpha.mend.run" } as const;

describe("whether the Preview tab shows the app in a frame", () => {
  it("frames a preview Mend serves on the site it shares with this page", () => {
    expect(previewShowing(LINK, "mend.run", BOX)).toEqual({ _tag: "Frame" });
    // Rendered on the server, the page is at APP_URL, which the server decided for.
    expect(previewShowing(LINK, "mend.run", null)).toEqual({ _tag: "Frame" });
  });

  it("offers the link where a frame could not stay signed in", () => {
    for (const [frameSite, page] of [
      [null, BOX],
      [null, null],
      ["mend.run", { protocol: "https:", hostname: "mend-box.tail1.ts.net" }],
      ["mend.run", { protocol: "http:", hostname: "alpha.mend.run" }],
      ["mend.run", { protocol: "https:", hostname: "xmend.run" }],
    ] as const) {
      const showing = previewShowing(LINK, frameSite, page);
      expect(showing._tag).toBe("Link");
      if (showing._tag === "Link") expect(showing.why).toMatch(/different site/);
    }
    const own = previewShowing("http://localhost:5173", "mend.run", BOX);
    expect(own._tag === "Link" && own.why).toMatch(/its own address/);
  });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const render = (showing: ReturnType<typeof previewShowing>) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <PreviewPane
        src={LINK}
        title="Preview of web"
        showing={showing}
        width={390}
        status="preview · web · answered HTTP 200 · observed 4 s ago"
      />,
    ),
  );
  return host;
};

describe("what sits under the Preview tab's bar", () => {
  it("frames the app sandboxed, never able to navigate Mend's tab", () => {
    const frame = render({ _tag: "Frame" }).querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(LINK);
    expect(frame?.getAttribute("sandbox")?.split(" ").toSorted()).toEqual([
      "allow-forms",
      "allow-modals",
      "allow-popups",
      "allow-same-origin",
      "allow-scripts",
    ]);
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.style.width).toBe("390px");
  });

  it("shows the Service's status and Open in a new tab where previews are on another site", () => {
    const page = render(previewShowing(LINK, null, BOX));
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.textContent).toContain("preview · web · answered HTTP 200 · observed 4 s ago");
    expect(page.textContent).toContain("previews are on a different site from this page");
    const open = page.querySelector("a");
    expect(open?.textContent).toBe("Open in a new tab");
    expect(open?.getAttribute("href")).toBe(LINK);
    expect(open?.getAttribute("target")).toBe("_blank");
  });
});
