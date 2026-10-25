import {
  type SessionPageConflictError,
  SessionPagesRepo,
  type SessionPage,
  type SessionPageSessionNotFoundError,
  type SessionPageStorageError,
} from "@mend/db";
import { PageRef, clampPageHeight } from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parse } from "parse5";

import type { Caller } from "./caller.ts";

export interface PageInput {
  readonly html: string;
  readonly title: string;
  readonly height: number;
}

export class PageRejectedError extends Schema.TaggedError<PageRejectedError>()(
  "PageRejectedError",
  {
    reason: Schema.Literals(["nul-character", "viewport-height", "local-file"]),
    message: Schema.String,
  },
) {}

export class SessionPages extends Context.Service<
  SessionPages,
  {
    readonly publish: (
      caller: Caller,
      page: PageInput,
    ) => Effect.Effect<
      PageRef,
      | PageRejectedError
      | SessionPageConflictError
      | SessionPageSessionNotFoundError
      | SessionPageStorageError
    >;
  }
>()("@mend/sessions/SessionPages") {}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CSS_WHITESPACE = /[ \t\n\r\f]/;
const CSS_NEWLINE = /[\n\r\f]/;
const HEX_DIGIT = /[0-9a-f]/i;
const URL_FUNCTION_OPENED = /(?:^|[^\w\u0080-\ufffe-])url\($/i;
// A string stands in the scanned code as U+FFFF, its index, U+FFFF; a U+FFFF of the page reads as U+FFFD.
const VIEWPORT_HEIGHT =
  /(?<![\w.\u0080-\ufffe-])[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?[sld]?vh(?![\w\u0080-\ufffe-])/i;
const CSS_URL = /(?<![\w\u0080-\ufffe-])(?:url|src)\(\s*\uffff(\d+)\uffff/gi;
const CSS_IMPORT = /@import\s*\uffff(\d+)\uffff/gi;
const CSS_IMAGE_SET = /image-set\(([^)]*)/gi;
const CSS_STRING = /\uffff(\d+)\uffff/g;
const SCRIPT_IMAGE_PATH =
  /(["'`])((?:\/(?!\/)|[a-z]:[\\/])(?:(?!\1)[^\r\n]){0,2048}?\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico))\1/gi;
const NOT_A_FILE = /^(?:$|#|\/\/|(?!file:)[a-z][a-z\d+.-]+:)/i;
const FILE_ATTRIBUTES = new Set(["src", "poster", "background"]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);
const SVG_PRESENTATION_ATTRIBUTES = new Set([
  "width",
  "height",
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
]);

interface Stylesheet {
  readonly code: string;
  readonly strings: ReadonlyArray<string>;
}

// CSS Syntax 4.3.7: up to six hex digits and one optional whitespace, or any other code point.
const cssEscapeAt = (
  css: string,
  slash: number,
): { readonly char: string; readonly end: number } => {
  let end = slash + 1;
  while (end - slash <= 6 && HEX_DIGIT.test(css.charAt(end))) end++;
  if (end === slash + 1) {
    const char = String.fromCodePoint(css.codePointAt(end) ?? 0xfffd);
    return { char, end: end + char.length };
  }
  const point = parseInt(css.slice(slash + 1, end), 16);
  if (css.startsWith("\r\n", end)) end += 2;
  else if (CSS_WHITESPACE.test(css.charAt(end))) end++;
  const invalid = point === 0 || (point >= 0xd800 && point <= 0xdfff) || point > 0x10ffff;
  return { char: invalid ? "\ufffd" : String.fromCodePoint(point), end };
};

// Reads CSS as its tokenizer does: comments become whitespace, escapes decode, and each string or
// unquoted url() body moves to `strings` so a number or a url( inside one is not read as code.
const readStylesheet = (css: string): Stylesheet => {
  const strings: Array<string> = [];
  const code: Array<string> = [];
  let tail = "";
  let at = 0;
  const emit = (piece: string) => {
    const kept = piece === "￿" ? "�" : piece;
    code.push(kept);
    tail = (tail + kept).slice(-5);
  };
  const readUntil = (stop: (char: string) => boolean): string => {
    const value: Array<string> = [];
    while (at < css.length && !stop(css.charAt(at))) {
      if (css.charAt(at) !== "\\") {
        value.push(css.charAt(at++));
      } else if (at + 1 >= css.length || CSS_NEWLINE.test(css.charAt(at + 1))) {
        at += css.startsWith("\r\n", at + 1) ? 3 : 2;
      } else {
        const escape = cssEscapeAt(css, at);
        value.push(escape.char);
        at = escape.end;
      }
    }
    return value.join("");
  };
  const keep = (value: string) => {
    emit(`\uffff${strings.length}\uffff`);
    strings.push(value);
  };
  while (at < css.length) {
    const char = css.charAt(at);
    if (char === "/" && css.charAt(at + 1) === "*") {
      const close = css.indexOf("*/", at + 2);
      at = close === -1 ? css.length : close + 2;
      emit(" ");
    } else if (char === '"' || char === "'") {
      at++;
      keep(readUntil((each) => each === char || CSS_NEWLINE.test(each)));
      if (css.charAt(at) === char) at++;
    } else if (char === "\\" && (at + 1 >= css.length || CSS_NEWLINE.test(css.charAt(at + 1)))) {
      emit(" ");
      at++;
    } else if (char === "\\") {
      const escape = cssEscapeAt(css, at);
      emit(escape.char);
      at = escape.end;
    } else {
      emit(char);
      at++;
    }
    if (URL_FUNCTION_OPENED.test(tail)) {
      while (CSS_WHITESPACE.test(css.charAt(at))) at++;
      const next = css.charAt(at);
      if (next !== "" && next !== '"' && next !== "'") {
        keep(readUntil((each) => each === ")").trim());
        if (css.charAt(at) === ")") at++;
        emit(")");
      }
    }
  }
  return { code: code.join(""), strings };
};

const viewportHeightIn = (sheet: Stylesheet): string | null =>
  VIEWPORT_HEIGHT.exec(sheet.code)?.[0] ?? null;

const cssTargets = (sheet: Stylesheet): ReadonlyArray<string> => {
  const stringAt = (index: string | undefined) => sheet.strings[Number(index)] ?? "";
  return [
    ...Array.from(sheet.code.matchAll(CSS_URL), ([, index]) => stringAt(index)),
    ...Array.from(sheet.code.matchAll(CSS_IMPORT), ([, index]) => stringAt(index)),
    ...Array.from(sheet.code.matchAll(CSS_IMAGE_SET)).flatMap(([, args]) =>
      Array.from((args ?? "").matchAll(CSS_STRING), ([, index]) => stringAt(index)),
    ),
  ];
};

// The WHATWG URL parser drops a URL's tabs and newlines and trims its edges before reading it.
const fileIn = (reference: string): ReadonlyArray<string> => {
  const url = reference.replace(/[\t\n\r]/g, "").trim();
  return NOT_A_FILE.test(url) ? [] : [url];
};

// HTML's srcset grammar: a comma ends a candidate only after its URL, so a data: URI keeps its own.
const srcsetUrls = (value: string): ReadonlyArray<string> => {
  const urls: Array<string> = [];
  let at = 0;
  while (at < value.length) {
    while (at < value.length && /[\s,]/.test(value.charAt(at))) at++;
    let end = at;
    while (end < value.length && !/\s/.test(value.charAt(end))) end++;
    const word = value.slice(at, end);
    const url = word.replace(/,+$/, "");
    if (url !== word) {
      at = end;
    } else {
      const comma = value.indexOf(",", end);
      at = comma === -1 ? value.length : comma + 1;
    }
    if (url !== "") urls.push(url);
  }
  return urls;
};

interface PageReading {
  readonly sheets: Array<Stylesheet>;
  readonly files: Array<string>;
}

const textOf = (element: DefaultTreeAdapterTypes.Element): string =>
  element.childNodes
    .map((child) => (defaultTreeAdapter.isTextNode(child) ? child.value : ""))
    .join("");

// An href loads on a <link> and on every SVG element but <a>; on HTML's <a>, <area> and <base> it
// navigates or sets the base. Inside <svg>, the parser turns xlink:href into href with an xlink prefix.
const loadsHref = (element: DefaultTreeAdapterTypes.Element): boolean =>
  element.namespaceURI === SVG_NAMESPACE ? element.tagName !== "a" : element.tagName === "link";

const readElement = (element: DefaultTreeAdapterTypes.Element, reading: PageReading) => {
  const svg = element.namespaceURI === SVG_NAMESPACE;
  for (const { name, value } of element.attrs) {
    if (name === "style" || (svg && SVG_PRESENTATION_ATTRIBUTES.has(name))) {
      reading.sheets.push(readStylesheet(value));
    } else if (FILE_ATTRIBUTES.has(name) || (name === "href" && loadsHref(element))) {
      reading.files.push(...fileIn(value));
    } else if (name === "data" && element.tagName === "object") {
      reading.files.push(...fileIn(value));
    } else if (SRCSET_ATTRIBUTES.has(name)) {
      reading.files.push(...srcsetUrls(value).flatMap(fileIn));
    } else if (name === "srcdoc" && element.tagName === "iframe") {
      readDocument(value, reading);
    }
  }
  if (element.tagName === "style") reading.sheets.push(readStylesheet(textOf(element)));
  if (element.tagName === "script") {
    reading.files.push(
      ...Array.from(textOf(element).matchAll(SCRIPT_IMAGE_PATH), ([, , path]) => path ?? ""),
    );
  }
};

const readDocument = (html: string, reading: PageReading) => {
  const pending: Array<DefaultTreeAdapterTypes.ParentNode> = [parse(html)];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const child of node.childNodes) {
      if (!defaultTreeAdapter.isElementNode(child)) continue;
      readElement(child, reading);
      pending.push(child);
      if ("content" in child) pending.push(child.content);
    }
  }
};

const truncated = (value: string): string => (value.length > 80 ? `${value.slice(0, 79)}…` : value);

export const preparePage = (page: PageInput): Effect.Effect<PageInput, PageRejectedError> => {
  if (page.html.includes("\u0000") || page.title.includes("\u0000")) {
    return Effect.fail(
      new PageRejectedError({
        reason: "nul-character",
        message:
          "The page or its title holds a NUL character (U+0000), which Mend cannot store. Remove it and call the tool again.",
      }),
    );
  }
  const reading: PageReading = { sheets: [], files: [] };
  readDocument(page.html, reading);
  const unit = reading.sheets.map(viewportHeightIn).find((each) => each !== null);
  if (unit !== undefined) {
    return Effect.fail(
      new PageRejectedError({
        reason: "viewport-height",
        message: `The page uses a viewport height unit (${truncated(unit)}). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights.`,
      }),
    );
  }
  const files = [...reading.files, ...reading.sheets.flatMap(cssTargets).flatMap(fileIn)];
  if (files.length > 0) {
    const named = [...new Set(files)].slice(0, 5).map(truncated).join(", ");
    return Effect.fail(
      new PageRejectedError({
        reason: "local-file",
        message: `The page names local files (${named}). Mend does not read files from the workspace into a page: embed each image as a data: URI (src="data:image/png;base64,…"), put scripts and styles inline, or remove the reference.`,
      }),
    );
  }
  return Effect.succeed({
    html: page.html,
    title: page.title.trim() || "Page",
    height: clampPageHeight(page.height),
  });
};

const refOf = (row: SessionPage): PageRef =>
  new PageRef({
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    height: row.height,
    publishedAt: row.publishedAt,
  });

export const SessionPagesLive: Layer.Layer<SessionPages, never, SessionPagesRepo> = Layer.effect(
  SessionPages,
  Effect.gen(function* () {
    const repo = yield* SessionPagesRepo;

    const publish = Effect.fn("SessionPages.publish")(function* (caller: Caller, page: PageInput) {
      const prepared = yield* preparePage(page);
      const callKey = caller.callKey ?? `unkeyed:${crypto.randomUUID()}`;
      const row = yield* repo.publish({
        sessionId: caller.sessionId,
        callKey,
        accountId: caller.accountId,
        ...prepared,
      });
      return refOf(row);
    });

    return { publish };
  }),
);
