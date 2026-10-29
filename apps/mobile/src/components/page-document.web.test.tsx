// @vitest-environment jsdom
import { pageThemes } from "@mend/ui/page-theme";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageDocument } from "./page-document.web";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const show = (onLoadError: () => void) =>
  act(() =>
    root.render(
      <PageDocument
        title="Latency by route"
        src="https://mend.example.com/api/page-view?view=t#t3-theme=%7B%7D"
        theme={pageThemes.light}
        initialHeight={420}
        fill={false}
        onLoadError={onLoadError}
      />,
    ),
  );

const frame = () => {
  const found = host.querySelector("iframe");
  if (found === null) throw new Error("no page frame");
  return found;
};

const fromPage = (data: unknown) =>
  act(() =>
    window.dispatchEvent(new MessageEvent("message", { data, source: frame().contentWindow })),
  );

describe("the page document on the web build", () => {
  it("fails a page whose request never completes, counted from when the frame gets its URL", () => {
    const failed = vi.fn();
    show(failed);
    act(() => vi.advanceTimersByTime(14_990));
    expect(failed).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(20));
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("counts a page that reports its size as loaded", () => {
    const failed = vi.fn();
    show(failed);
    fromPage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 0 } });
    act(() => vi.advanceTimersByTime(60_000));
    expect(failed).not.toHaveBeenCalled();
    expect(frame().style.height).toBe("80px");
  });
});

describe("a link the page asks for on the web build", () => {
  const link = { jsonrpc: "2.0", id: "t3-link-1", method: "ui/open-link", params: {} };
  const ask = (url: string) => fromPage({ ...link, params: { url } });

  it("opens only while the reader is using the page's frame", () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    show(() => undefined);
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    ask("https://example.com/composer");
    expect(opened).not.toHaveBeenCalled();

    frame().focus();
    expect(document.activeElement).toBe(frame());
    ask("https://example.com/docs");
    expect(opened).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
    composer.remove();
    opened.mockRestore();
  });
});
