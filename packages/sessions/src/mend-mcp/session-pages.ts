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

const CSS_SOURCE =
  /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi;
const VIEWPORT_HEIGHT_UNIT =
  /(?<![\w.+/])\+?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?[sld]?vh(?![\w-])/i;

const viewportHeightIn = (html: string): string | null => {
  for (const [, sheet, doubleQuoted, singleQuoted, unquoted] of html.matchAll(CSS_SOURCE)) {
    const found = VIEWPORT_HEIGHT_UNIT.exec(
      sheet ?? doubleQuoted ?? singleQuoted ?? unquoted ?? "",
    );
    if (found !== null) return found[0];
  }
  return null;
};

const TAG_ATTRIBUTES = String.raw`((?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*)(?:>|$)`;
const MARKUP = new RegExp(
  String.raw`<!--[\s\S]*?(?:-->|$)|<(script|style)\b${TAG_ATTRIBUTES}([\s\S]*?)(?:<\/\1\s*>|$)` +
    String.raw`|<([a-z][^\s/>]*)${TAG_ATTRIBUTES}`,
  "gi",
);
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+)))?/g;
const CSS_URL = /\burl\(\s*(?:"([^"]*)|'([^']*)|([^\s"')]*))/gi;
const SCRIPT_IMAGE_PATH =
  /(["'`])((?:\/(?!\/)|[a-z]:[\\/])(?:(?!\1)[^\r\n]){0,2048}?\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico))\1/gi;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  bsol: "\\",
  colon: ":",
  gt: ">",
  lpar: "(",
  lt: "<",
  newline: "\n",
  num: "#",
  percnt: "%",
  period: ".",
  quot: '"',
  rpar: ")",
  sol: "/",
  tab: "\t",
};
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));?/gi;
const NOT_A_FILE = /^(?:$|#|data:|https?:|\/\/)/i;
const FILE_ATTRIBUTES = new Set(["src", "poster", "xlink:href"]);
const SVG_IMAGE_ELEMENTS = new Set(["image", "use", "feimage"]);

const decoded = (value: string): string =>
  value.replace(ENTITY, (entity, decimal?: string, hex?: string, name?: string) => {
    const code =
      decimal !== undefined ? Number(decimal) : hex !== undefined ? parseInt(hex, 16) : null;
    if (code !== null) return code <= 0x10ffff ? String.fromCodePoint(code) : "�";
    return NAMED_ENTITIES[name?.toLowerCase() ?? ""] ?? entity;
  });

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

const cssFiles = (css: string): ReadonlyArray<string> =>
  Array.from(css.matchAll(CSS_URL)).flatMap(([, ...values]) =>
    fileIn(values.find((each) => each !== undefined) ?? ""),
  );

const attributeFiles = (element: string, attributes: string): ReadonlyArray<string> =>
  Array.from(attributes.matchAll(ATTRIBUTE)).flatMap(([, rawName, ...values]) => {
    const name = rawName?.toLowerCase() ?? "";
    const value = decoded(values.find((each) => each !== undefined) ?? "");
    if (name === "style") return cssFiles(value);
    if (name === "srcset") return srcsetUrls(value).flatMap(fileIn);
    if (FILE_ATTRIBUTES.has(name) || (name === "href" && SVG_IMAGE_ELEMENTS.has(element))) {
      return fileIn(value);
    }
    return [];
  });

const localFilesIn = (html: string): ReadonlyArray<string> =>
  Array.from(html.matchAll(MARKUP)).flatMap(
    ([, rawText, rawTextAttributes, contents, element, attributes]) => {
      if (rawText === undefined) {
        return element === undefined ? [] : attributeFiles(element.toLowerCase(), attributes ?? "");
      }
      const inside =
        rawText.toLowerCase() === "style"
          ? cssFiles(contents ?? "")
          : Array.from((contents ?? "").matchAll(SCRIPT_IMAGE_PATH)).map(
              ([, , path]) => path ?? "",
            );
      return [...attributeFiles(rawText.toLowerCase(), rawTextAttributes ?? ""), ...inside];
    },
  );

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
  const unit = viewportHeightIn(page.html);
  if (unit !== null) {
    return Effect.fail(
      new PageRejectedError({
        reason: "viewport-height",
        message: `The page uses a viewport height unit (${unit}). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights.`,
      }),
    );
  }
  const files = localFilesIn(page.html);
  if (files.length > 0) {
    const named = [...new Set(files)].slice(0, 5).join(", ");
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
