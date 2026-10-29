import {
  type HtmlRenderTheme,
  htmlRenderTheme,
  injectHtmlRenderBootstrap,
} from "@mend/t3-contracts/html-render";
import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
} from "@mend/t3-contracts/theme-palettes";
import { type PageTheme, pageThemes } from "@mend/ui/page-theme";

export interface ThemeRule {
  readonly media: string | null;
  readonly theme: HtmlRenderTheme | PageTheme;
}

const rootRule = (theme: ThemeRule["theme"]): string =>
  `:root{color-scheme:${theme.appearance};${Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("")}}`;

const rulesCss = (rules: ReadonlyArray<ThemeRule>): string =>
  rules
    .map(({ media, theme }) =>
      media === null ? rootRule(theme) : `@media ${media}{${rootRule(theme)}}`,
    )
    .join("");

export const T3_CODE_THEME_RULES: ReadonlyArray<ThemeRule> = [
  { media: null, theme: htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark") },
  {
    media: "(prefers-color-scheme: light)",
    theme: htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS, "light"),
  },
];

// t3code exports neither its bootstrap script nor its base stylesheet, so both are read out of
// the vendored function's answer for an empty page.
let vendoredParts: { readonly baseCss: string; readonly script: string } | undefined;
const vendored = () => {
  if (vendoredParts !== undefined) return vendoredParts;
  const empty = injectHtmlRenderBootstrap("");
  const found = /<style id="t3-theme">([^<]*)<\/style><script>([\s\S]*)<\/script><\/head>$/.exec(
    empty,
  );
  const css = found?.[1];
  const script = found?.[2];
  const themed = rulesCss(T3_CODE_THEME_RULES);
  if (css === undefined || script === undefined || !css.startsWith(themed)) {
    throw new Error("the vendored t3code bootstrap no longer has the shape Mend reads");
  }
  vendoredParts = { baseCss: css.slice(themed.length), script };
  return vendoredParts;
};

interface PageShape {
  readonly head: number | null;
  readonly html: number | null;
  readonly charset: boolean;
  readonly viewport: boolean;
}

const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

const CHARSET_WITHIN = 4096;

const isSpace = (code: number) =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
const isLetter = (code: number) => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

interface StartTag {
  readonly name: string;
  readonly end: number;
  readonly attributes: ReadonlyArray<readonly [string, string]>;
}

const startTagAt = (page: string, at: number): StartTag | null => {
  let i = at + 1;
  while (i < page.length && !isSpace(page.charCodeAt(i)) && page[i] !== "/" && page[i] !== ">") {
    i += 1;
  }
  const name = page.slice(at + 1, i).toLowerCase();
  const attributes: Array<readonly [string, string]> = [];
  for (;;) {
    while (i < page.length && (isSpace(page.charCodeAt(i)) || page[i] === "/")) i += 1;
    if (i >= page.length) return null;
    if (page[i] === ">") return { name, end: i + 1, attributes };
    const nameStart = i;
    i += 1;
    while (
      i < page.length &&
      !isSpace(page.charCodeAt(i)) &&
      page[i] !== "/" &&
      page[i] !== ">" &&
      page[i] !== "="
    ) {
      i += 1;
    }
    const attribute = page.slice(nameStart, i).toLowerCase();
    while (i < page.length && isSpace(page.charCodeAt(i))) i += 1;
    if (page[i] !== "=") {
      attributes.push([attribute, ""]);
      continue;
    }
    i += 1;
    while (i < page.length && isSpace(page.charCodeAt(i))) i += 1;
    const quote = page[i];
    if (quote === '"' || quote === "'") {
      const close = page.indexOf(quote, i + 1);
      if (close === -1) return null;
      attributes.push([attribute, page.slice(i + 1, close)]);
      i = close + 1;
      continue;
    }
    const valueStart = i;
    while (i < page.length && !isSpace(page.charCodeAt(i)) && page[i] !== ">") i += 1;
    attributes.push([attribute, page.slice(valueStart, i)]);
  }
};

const shapeOf = (page: string): PageShape => {
  let head: number | null = null;
  let html: number | null = null;
  let charset = false;
  let viewport = false;
  let templates = 0;
  let i = 0;
  while (i < page.length) {
    const open = page.indexOf("<", i);
    if (open === -1) break;
    if (page.startsWith("<!--", open)) {
      const close = page.indexOf("-->", open + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    if (page[open + 1] === "/" && isLetter(page.charCodeAt(open + 2))) {
      const close = page.indexOf(">", open);
      if (close === -1) break;
      if (/^<\/template[\s/>]/i.test(page.slice(open, open + 11)) && templates > 0) templates -= 1;
      i = close + 1;
      continue;
    }
    if (page[open + 1] === "!" || page[open + 1] === "?") {
      const close = page.indexOf(">", open);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (!isLetter(page.charCodeAt(open + 1))) {
      i = open + 1;
      continue;
    }
    const tag = startTagAt(page, open);
    if (tag === null) break;
    i = tag.end;
    if (tag.name === "plaintext") break;
    if (RAW_TEXT.has(tag.name)) {
      const closing = new RegExp(`</${tag.name}[\\s/>]`, "gi");
      closing.lastIndex = tag.end;
      const close = closing.exec(page);
      if (close === null) break;
      i = close.index;
      continue;
    }
    if (tag.name === "template") {
      templates += 1;
      continue;
    }
    if (templates > 0) continue;
    if (tag.name === "head" && head === null) head = tag.end;
    if (tag.name === "html" && html === null) html = tag.end;
    if (tag.name === "meta") {
      if (
        open < CHARSET_WITHIN &&
        tag.attributes.some(([n, v]) => n === "charset" || /charset/i.test(v))
      ) {
        charset = true;
      }
      if (tag.attributes.some(([n, v]) => n === "name" && /^viewport/i.test(v))) viewport = true;
    }
  }
  return { head, html, charset, viewport };
};

const bootstrapMarkup = (shape: PageShape, rules: ReadonlyArray<ThemeRule>): string =>
  [
    shape.charset ? "" : '<meta charset="utf-8">',
    shape.viewport ? "" : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="t3-theme">${rulesCss(rules)}${vendored().baseCss}</style>`,
    `<script>${vendored().script}</script>`,
  ].join("");

const DOCTYPE = /^\s*<!doctype[^>]*>/i;

export const injectPageBootstrap = (html: string, rules: ReadonlyArray<ThemeRule>): string => {
  const shape = shapeOf(html);
  const markup = bootstrapMarkup(shape, rules);
  if (shape.head !== null) return html.slice(0, shape.head) + markup + html.slice(shape.head);
  if (shape.html !== null) {
    return `${html.slice(0, shape.html)}<head>${markup}</head>${html.slice(shape.html)}`;
  }
  const doctype = DOCTYPE.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
};

// A t3code client's `#t3-theme=` fragment and `host-context-changed` messages still replace Mend's
// palette: t3code's bootstrap script rewrites the `t3-theme` style element it finds.
export const pageDocument = (html: string, appearance: keyof typeof pageThemes): string =>
  injectPageBootstrap(html, [{ media: null, theme: pageThemes[appearance] }]);
