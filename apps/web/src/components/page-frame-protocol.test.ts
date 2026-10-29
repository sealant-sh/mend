import {
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "@mend/t3-contracts/html-render";
import {
  PAGE_MAX_FIT_HEIGHT,
  PAGE_MIN_HEIGHT,
  fitPageHeight,
  pageFrameSrc,
  pageLinkResult,
  pageThemeMessage,
  readPageFrameRequest,
} from "@mend/ui/page-frame";
import { pageThemes } from "@mend/ui/page-theme";
import { describe, expect, it } from "vitest";

const message = (method: string, params: unknown, id?: string | number) => ({
  jsonrpc: "2.0",
  method,
  params,
  ...(id === undefined ? {} : { id }),
});

describe("the page frame protocol both clients speak", () => {
  it("writes theme fragments, theme messages and link answers as the pinned t3code does", () => {
    for (const theme of [pageThemes.light, pageThemes.dark]) {
      expect(pageFrameSrc("/api/page-view?view=a#old", theme)).toBe(
        `/api/page-view?view=a${htmlRenderThemeFragment(theme)}`,
      );
      expect(pageThemeMessage(theme)).toEqual(htmlRenderThemeMessage(theme));
    }
    expect(pageLinkResult("t3-link-1")).toEqual(htmlRenderResult("t3-link-1"));
    expect(pageLinkResult(7)).toEqual(htmlRenderResult(7));
  });

  it("fits a frame inside the pinned t3code's bounds", () => {
    expect([PAGE_MIN_HEIGHT, PAGE_MAX_FIT_HEIGHT]).toEqual([
      HTML_RENDER_MIN_HEIGHT,
      HTML_RENDER_MAX_FIT_HEIGHT,
    ]);
    expect([0, 79.2, 412.1, 1e9].map(fitPageHeight)).toEqual([80, 80, 413, 20_000]);
  });

  it("reads sizes as t3code does, and a height of 0 as a page that loaded", () => {
    for (const height of [1, 412.5, 30_000]) {
      const data = message("ui/notifications/size-changed", { height });
      expect(readPageFrameRequest(data)).toEqual({
        kind: "size",
        height: readHtmlRenderContentHeight(data),
      });
    }
    expect(readPageFrameRequest(message("ui/notifications/size-changed", { height: 0 }))).toEqual({
      kind: "size",
      height: 0,
    });
    for (const height of [-1, Number.NaN, "12", null]) {
      expect(
        readPageFrameRequest(message("ui/notifications/size-changed", { height })),
      ).toBeUndefined();
    }
  });

  it("reads a link exactly as t3code's reader does: http(s) only, parsed by the host", () => {
    for (const url of [
      "https://example.com",
      "http://example.com/docs?q=1#top",
      "https://user@example.com:8443/a",
      "https://[::1]:3000/",
      "https://mend_server.example.com/docs",
      "HTTP://localhost:5173",
      "https://[",
      "https://exa mple.com",
      "javascript:alert(1)",
      "data:text/html,test",
      "file:///etc/passwd",
      "mend://session/1",
      "intent://scan#Intent;end",
      "//example.com",
      "/settings",
    ]) {
      const data = message("ui/open-link", { url }, "t3-link-1");
      const before = readHtmlRenderLinkRequest(data);
      const request = readPageFrameRequest(data);
      expect(request?.kind === "link" ? request.url : undefined).toBe(before?.url);
    }
    expect(
      readPageFrameRequest(message("ui/open-link", { url: "https://example.com" })),
    ).toBeUndefined();
  });

  it("asks for nothing else", () => {
    for (const data of [
      message("t3/notifications/open-image", { src: "https://example.com/a.png", name: "a" }),
      message("t3/notifications/keydown", { key: "Escape", code: "Escape" }),
      { method: "ui/notifications/size-changed", params: { height: 10 } },
      "ui/notifications/size-changed",
      null,
    ]) {
      expect(readPageFrameRequest(data)).toBeUndefined();
    }
  });
});
