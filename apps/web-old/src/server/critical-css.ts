/**
 * The CSS a server-rendered page paints with before its stylesheet arrives: the rules of the full
 * sheet that can apply to the classes the page's HTML holds, and every rule that names no class
 * (the base layer, the theme's variables, font faces, keyframes). The page inlines it in its head
 * and loads the full sheet at the end of its body (routes/__root.tsx), so a page opened cold from a
 * link paints from its own response, one round trip, and hydrates once the full sheet has applied.
 *
 * The match is by class names alone, so it keeps a rule that its classes allow even where the
 * page's structure would not: a little more CSS, never a missing rule for a class the page has.
 */

/** The element the page renders for the inlined sheet, empty until the server fills it. */
export const CRITICAL_CSS_ID = "critical-css";

const PLACEHOLDER = `<style id="${CRITICAL_CSS_ID}"></style>`;

/** A rule of the sheet: kept whole when every class of one of its selectors is on the page. */
type Rule =
  | { readonly kind: "always"; readonly text: string }
  | {
      readonly kind: "style";
      readonly text: string;
      readonly selectors: ReadonlyArray<ReadonlyArray<string>>;
    }
  | { readonly kind: "group"; readonly open: string; readonly rules: ReadonlyArray<Rule> };

/** At-rules whose blocks hold rules: kept with whichever of their rules the page needs. */
const GROUPS = /^@(media|supports|layer|container|scope|starting-style|document)\b/;

/**
 * Classes the page adds before its scripts run, so its HTML never carries them: `dark` is the
 * theme, set on `<html>` by the head's no-flash script.
 */
const ADDED_BEFORE_PAINT: ReadonlySet<string> = new Set(["dark"]);

/** The index just past the block that opens at `open` (a `{`), skipping strings and comments. */
const blockEnd = (css: string, open: number): number => {
  let depth = 0;
  for (let at = open; at < css.length; at += 1) {
    const char = css[at];
    // An escaped character (`\'` in `.\[class\*\=\'size-\'\]`) is never a quote or a brace.
    if (char === "\\") at += 1;
    else if (char === "/" && css[at + 1] === "*") {
      at = css.indexOf("*/", at + 2);
      if (at === -1) return css.length;
      at += 1;
    } else if (char === '"' || char === "'") {
      at = stringEnd(css, at);
    } else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return css.length;
};

const stringEnd = (css: string, open: number): number => {
  const quote = css[open];
  for (let at = open + 1; at < css.length; at += 1) {
    if (css[at] === "\\") at += 1;
    else if (css[at] === quote) return at;
  }
  return css.length;
};

/** `a, b:is(c, d)` → `["a", "b:is(c, d)"]`: the commas outside parentheses and brackets. */
const splitSelectors = (selector: string): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < selector.length; at += 1) {
    const char = selector[at];
    if (char === "\\") at += 1;
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts;
};

const CLASS_NAME = /\.((?:\\[0-9a-fA-F]{1,6} ?|\\[^0-9a-fA-F]|[\w-])+)/g;

const unescape = (name: string): string =>
  name.replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (_, hex: string | undefined, char: string) =>
    hex === undefined ? char : String.fromCodePoint(Number.parseInt(hex, 16)),
  );

/** The classes a selector needs, leaving out those it excludes (`:not(.x)`). */
const classesOf = (selector: string): ReadonlyArray<string> =>
  [...selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "").matchAll(CLASS_NAME)].map((match) =>
    unescape(match[1] ?? ""),
  );

/**
 * A face the first paint can use: one for Latin text, or one with no range. The faces for other
 * scripts (Cyrillic, Greek, Vietnamese) come with the full sheet; text in them paints in a fallback
 * font until then, as it would while any face loads.
 */
const paintsLatin = (fontFace: string): boolean =>
  !fontFace.includes("unicode-range") ||
  // Basic Latin first, as `U+0000-00FF` or, minified, `U+??`.
  /unicode-range:\s*U\+(?:0{0,2}00-0{0,2}FF|\?\?)[,;}]/i.test(fontFace);

const parse = (css: string): ReadonlyArray<Rule> => {
  const rules: Array<Rule> = [];
  let at = 0;
  while (at < css.length) {
    while (at < css.length && /\s/.test(css[at] ?? "")) at += 1;
    if (at >= css.length) break;
    if (css.startsWith("/*", at)) {
      const end = css.indexOf("*/", at + 2);
      at = end === -1 ? css.length : end + 2;
      continue;
    }
    // The prelude runs to the block it opens, or to `;` for a statement (`@layer a, b;`).
    let cursor = at;
    while (cursor < css.length && css[cursor] !== "{" && css[cursor] !== ";") {
      if (css[cursor] === "\\") cursor += 1;
      else if (css[cursor] === '"' || css[cursor] === "'") cursor = stringEnd(css, cursor);
      cursor += 1;
    }
    if (cursor >= css.length || css[cursor] === ";") {
      rules.push({ kind: "always", text: css.slice(at, cursor + 1) });
      at = cursor + 1;
      continue;
    }
    const prelude = css.slice(at, cursor).trim();
    const end = blockEnd(css, cursor);
    if (GROUPS.test(prelude))
      rules.push({
        kind: "group",
        open: `${prelude}{`,
        rules: parse(css.slice(cursor + 1, end - 1)),
      });
    else if (prelude.startsWith("@font-face")) {
      const text = css.slice(at, end);
      if (paintsLatin(text)) rules.push({ kind: "always", text });
    } else if (prelude.startsWith("@")) rules.push({ kind: "always", text: css.slice(at, end) });
    else
      rules.push({
        kind: "style",
        text: css.slice(at, end),
        selectors: splitSelectors(prelude).map(classesOf),
      });
    at = end;
  }
  return rules;
};

const pick = (rules: ReadonlyArray<Rule>, present: ReadonlySet<string>): string => {
  let out = "";
  for (const rule of rules) {
    if (rule.kind === "always") out += rule.text;
    else if (rule.kind === "style") {
      if (rule.selectors.some((classes) => classes.every((name) => present.has(name))))
        out += rule.text;
    } else {
      const inner = pick(rule.rules, present);
      if (inner !== "") out += `${rule.open}${inner}}`;
    }
  }
  return out;
};

/** Every class the page's HTML holds, from its `class` attributes. */
export const classesInHtml = (html: string): ReadonlySet<string> => {
  const present = new Set(ADDED_BEFORE_PAINT);
  for (const match of html.matchAll(/\sclass="([^"]*)"/g))
    for (const name of (match[1] ?? "").split(/\s+/))
      if (name !== "") present.add(name.replaceAll("&amp;", "&").replaceAll("&quot;", '"'));
  return present;
};

/** The sheet parsed once per server, and the rules a page needs from it. */
export const makeCriticalCss = (fullCss: string) => {
  let parsed: ReadonlyArray<Rule> | null = null;
  return (html: string): string => {
    parsed ??= parse(fullCss);
    return pick(parsed, classesInHtml(html));
  };
};

/** The page with its inlined sheet filled in; a page without the placeholder is left as it is. */
export const fillCriticalCss = (html: string, critical: (html: string) => string): string => {
  const at = html.indexOf(PLACEHOLDER);
  if (at === -1) return html;
  // `</style` cannot appear in Tailwind's output; escaped anyway so the page's markup holds.
  const css = critical(html).replaceAll("</style", "<\\/style");
  return `${html.slice(0, at)}<style id="${CRITICAL_CSS_ID}">${css}</style>${html.slice(at + PLACEHOLDER.length)}`;
};
