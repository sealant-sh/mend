import { describe, expect, it } from "vitest";

import { fitPageHeight, readPageFrameRequest } from "./page-frame.ts";
import { pageThemeOf } from "./page-theme.ts";

const size = (height: unknown) =>
  readPageFrameRequest({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height },
  });

const link = (url: string) =>
  readPageFrameRequest({ jsonrpc: "2.0", id: 7, method: "ui/open-link", params: { url } });

describe("what a page's frame says to the app", () => {
  it("reads its size, a zero height included", () => {
    expect(size(420)).toEqual({ kind: "size", height: 420 });
    expect(size(0)).toEqual({ kind: "size", height: 0 });
    expect(size(-1)).toBeUndefined();
    expect(size("420")).toBeUndefined();
  });

  it("opens only http and https links", () => {
    expect(link("https://example.com/report")).toEqual({
      kind: "link",
      id: 7,
      url: "https://example.com/report",
    });
    expect(link("javascript:alert(1)")).toBeUndefined();
  });

  it("keeps a frame between its least and greatest height", () => {
    expect(fitPageHeight(10)).toBe(80);
    expect(fitPageHeight(420.2)).toBe(421);
    expect(fitPageHeight(1e9)).toBe(20_000);
  });
});

describe("the page theme", () => {
  it("names Sheet's tokens as t3code's pages read them, and leaves out a token not set", () => {
    const tokens: Readonly<Record<string, string>> = {
      "--background": " #ffffff",
      "--primary": "#2f5bea",
      "--muted": "#f3f4f6",
    };
    const theme = pageThemeOf((token) => tokens[token] ?? "", true);
    expect(theme.appearance).toBe("dark");
    expect(theme.variables["--background"]).toBe("#ffffff");
    expect(theme.variables["--accent"]).toBe("#2f5bea");
    expect(theme.variables["--code-background"]).toBe("#f3f4f6");
    expect("--foreground" in theme.variables).toBe(false);
  });
});
