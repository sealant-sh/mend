import { describe, expect, it } from "vitest";

import { fillCriticalCss, makeCriticalCss } from "./critical-css.ts";

const SHEET = String.raw`@layer theme, base, utilities;
@layer theme{:root{--sw-bg:#fbfaf8}}
@font-face{font-family:Inter;src:url(/assets/inter-latin.woff2);unicode-range:U+??,U+131}
@font-face{font-family:Inter;src:url(/assets/inter-cyrillic.woff2);unicode-range:U+400-45F}
@keyframes pulse{50%{opacity:.4}}
@layer utilities{.flex{display:flex}.grid{display:grid}.hover\:bg-wash:hover{background:var(--wash)}.\[\&_svg\:not\(\[class\*\=\'size-\'\]\)\]\:size-4 svg:not([class*='size-']){width:1rem}.dark\:text-ink:is(.dark *){color:#fff}.space-y-2>:not(:last-child,.flex){margin-bottom:.5rem}.group:hover .group-hover\:block{display:block}@media (width>=48rem){.md\:grid{display:grid}.md\:hidden{display:none}}}`;

const page = (classes: string) =>
  `<html><head><style id="critical-css"></style></head><body><div class="${classes}"></div></body></html>`;

const critical = makeCriticalCss(SHEET);
const inlined = (classes: string) =>
  /<style id="critical-css">(.*)<\/style>/s.exec(fillCriticalCss(page(classes), critical))?.[1] ??
  "";

describe("the CSS a page paints with before its stylesheet arrives", () => {
  it("keeps the rules for the classes the page holds and drops the rest", () => {
    const css = inlined("flex md:grid");
    expect(css).toContain(".flex{display:flex}");
    expect(css).toContain("@media (width>=48rem){.md\\:grid{display:grid}}");
    expect(css).not.toContain(".grid{");
    expect(css).not.toContain("md\\:hidden");
  });

  it("keeps what names no class: the layers, the theme's variables and the keyframes", () => {
    const css = inlined("");
    expect(css).toContain("@layer theme, base, utilities;");
    expect(css).toContain(":root{--sw-bg:#fbfaf8}");
    expect(css).toContain("@keyframes pulse");
    expect(css).not.toContain("@layer utilities");
  });

  it("reads escaped selectors, quotes inside them included, without losing the rules after", () => {
    const css = inlined("[&_svg:not([class*='size-'])]:size-4 hover:bg-wash");
    expect(css).toContain("svg:not([class*='size-']){width:1rem}");
    expect(css).toContain(".hover\\:bg-wash:hover");
    expect(css).not.toContain(".grid{");
  });

  it("counts the theme class the head's script adds, and not the classes a selector excludes", () => {
    expect(inlined("dark:text-ink")).toContain(".dark\\:text-ink:is(.dark *)");
    expect(inlined("space-y-2")).toContain(".space-y-2>:not(:last-child,.flex)");
    expect(inlined("group-hover:block")).not.toContain("group-hover");
    expect(inlined("group group-hover:block")).toContain(".group:hover .group-hover\\:block");
  });

  it("brings the Latin faces only; the full sheet brings the others", () => {
    const css = inlined("flex");
    expect(css).toContain("inter-latin.woff2");
    expect(css).not.toContain("inter-cyrillic.woff2");
  });

  it("leaves a page without the inlined sheet as it was", () => {
    const html = '<html><head></head><body class="flex"></body></html>';
    expect(fillCriticalCss(html, critical)).toBe(html);
  });
});
