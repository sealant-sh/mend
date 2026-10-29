import * as vm from "node:vm";

import {
  htmlRenderTheme,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  injectHtmlRenderBootstrap,
} from "@mend/t3-contracts/html-render";
import { T3_CODE_DARK_THEME_COLORS } from "@mend/t3-contracts/theme-palettes";
import { pageThemes } from "@mend/ui/page-theme";
import { lightColors } from "@mend/ui/tokens";
import { describe, expect, it } from "vitest";

import { T3_CODE_THEME_RULES, injectPageBootstrap, pageDocument } from "./page-document.ts";

const PAGES = [
  "",
  "<p>no document at all</p>",
  "<!doctype html><p>a doctype only</p>",
  "<!DOCTYPE html>\n<html lang=en><body><p>html, no head</p></body></html>",
  '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>x</body></html>',
  '<html><HEAD class="x"><meta name=viewport content="width=device-width"></HEAD><body></body></html>',
  "<!-- <head> in a comment --><html><head></head><body></body></html>",
  "<script>const s = '<head>';</script><head><style>p{color:red}</style></head>",
  "<template><head></head></template><html><body>templated</body></html>",
  "<textarea><head></textarea><body>raw text</body>",
  "<plaintext><head>everything after is text",
  `<!doctype html><head></head><body>${"<div>row</div>".repeat(2_000)}</body>`,
];

const scriptOf = (document: string) => document.slice(document.indexOf("<script>"));

describe("the page document", () => {
  it("injects exactly what t3code's injectHtmlRenderBootstrap does, given t3code's palette", () => {
    for (const html of PAGES) {
      expect(injectPageBootstrap(html, T3_CODE_THEME_RULES)).toBe(injectHtmlRenderBootstrap(html));
    }
  });

  it("is in Mend's palette for the appearance asked, with t3code's script and base styles", () => {
    const html = "<!doctype html><html><head></head><body><p>p99</p></body></html>";
    const light = pageDocument(html, "light");
    const dark = pageDocument(html, "dark");
    expect(light).toContain(
      `<style id="t3-theme">:root{color-scheme:light;--background:${lightColors.bg};`,
    );
    expect(dark).toContain(":root{color-scheme:dark;");
    expect(light).not.toContain("prefers-color-scheme");
    const t3 = injectHtmlRenderBootstrap(html);
    expect(scriptOf(light)).toBe(scriptOf(t3));
    expect(light.endsWith("<body><p>p99</p></body></html>")).toBe(true);
  });

  it("names every variable t3code's theme names", () => {
    const t3 = Object.keys(htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark").variables).toSorted();
    expect(Object.keys(pageThemes.light.variables).toSorted()).toEqual(t3);
    expect(Object.keys(pageThemes.dark.variables).toSorted()).toEqual(t3);
  });

  it("gives way to a t3code client's #t3-theme= fragment and host-context messages", () => {
    const document = pageDocument("<!doctype html><head></head><body></body>", "light");
    const script = /<script>([\s\S]*)<\/script><\/head>/.exec(document)?.[1] ?? "";
    const initial = /<style id="t3-theme">([^<]*)<\/style>/.exec(document)?.[1] ?? "";
    const t3Dark = htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark");
    const style = { textContent: initial };
    const listeners: Array<(event: { readonly data: unknown }) => void> = [];
    const replaced: Array<string> = [];
    const page = {
      document: {
        getElementById: (id: string) => (id === "t3-theme" ? style : null),
        addEventListener: () => undefined,
        documentElement: {},
      },
      location: {
        hash: htmlRenderThemeFragment(t3Dark),
        pathname: "/api/page-view",
        search: "?view=token",
      },
      history: {
        state: null,
        replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url),
      },
      addEventListener: (type: string, listener: (event: { readonly data: unknown }) => void) => {
        if (type === "message") listeners.push(listener);
      },
    };
    const context = vm.createContext({ ...page, window: page });
    vm.runInContext(script, context);
    expect(
      style.textContent.startsWith(
        `:root{color-scheme:dark;--background:${t3Dark.variables["--background"]};`,
      ),
    ).toBe(true);
    expect(replaced).toEqual(["/api/page-view?view=token"]);

    const t3Light = htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "light");
    for (const listener of listeners) listener({ data: htmlRenderThemeMessage(t3Light) });
    expect(style.textContent.startsWith(":root{color-scheme:light;")).toBe(true);
  });
});
