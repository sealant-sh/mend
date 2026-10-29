import { useCallback, useEffect, useEffectEvent, useState } from "react";

import type { PageTheme } from "./page-theme.ts";

/**
 * The whole grant a page's frame gets. Never `allow-same-origin`: the page would then share its
 * host's origin, and a client that keeps its credential in browser storage would hand it over.
 */
export const PAGE_FRAME_SANDBOX = "allow-scripts allow-forms";

export const PAGE_MIN_HEIGHT = 80;
// A frame fits the live page up to this height; it only stops a page that grows with its frame.
export const PAGE_MAX_FIT_HEIGHT = 20_000;

export const fitPageHeight = (height: number): number =>
  Math.min(PAGE_MAX_FIT_HEIGHT, Math.max(PAGE_MIN_HEIGHT, Math.ceil(height)));

const PAGE_LOAD_TIMEOUT_MS = 15_000;

/**
 * Calls `onExpired` when the frame's page has not reported its size within PAGE_LOAD_TIMEOUT_MS of
 * the frame getting its URL. A browser fires an iframe's `load` even for an HTTP error page, and
 * never for a request that stalls, so only the page's own size report counts as loaded.
 */
export const usePageLoadDeadline = (onExpired: () => void) => {
  const [met, setMet] = useState(false);
  const expire = useEffectEvent(onExpired);
  useEffect(() => {
    if (met) return;
    const timer = setTimeout(expire, PAGE_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [met]);
  return useCallback(() => setMet(true), []);
};

export type PageFrameRequest =
  | { readonly kind: "size"; readonly height: number }
  | { readonly kind: "link"; readonly id: string | number; readonly url: string };

// t3code's page protocol (MCP Apps notifications), as its v0.1.2 bootstrap speaks it.
const SIZE_CHANGED = "ui/notifications/size-changed";
const OPEN_LINK = "ui/open-link";
const HOST_CONTEXT_CHANGED = "ui/notifications/host-context-changed";
const THEME_FRAGMENT_KEY = "t3-theme";

type Row = Readonly<Record<string, unknown>>;

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// t3code's own rule. A browser host still parses the URL before opening it; React Native's URL
// cannot, and the system browser it hands the link to parses it instead.
const linkOf = (url: unknown): string | undefined =>
  typeof url === "string" && /^https?:\/\//i.test(url) ? url : undefined;

export const readPageFrameRequest = (data: unknown): PageFrameRequest | undefined => {
  if (!isRow(data) || data["jsonrpc"] !== "2.0") return undefined;
  const params = data["params"];
  if (!isRow(params)) return undefined;
  if (data["method"] === SIZE_CHANGED) {
    const height = params["height"];
    // t3code's own reader drops a height of 0, which its bootstrap reports for a page whose
    // content is all fixed-position; that page still loaded.
    return typeof height === "number" && Number.isFinite(height) && height >= 0
      ? { kind: "size", height }
      : undefined;
  }
  if (data["method"] === OPEN_LINK) {
    const id = data["id"];
    const url = linkOf(params["url"]);
    return (typeof id === "string" || typeof id === "number") && url !== undefined
      ? { kind: "link", id, url }
      : undefined;
  }
  return undefined;
};

export const pageLinkResult = (id: string | number) =>
  ({ jsonrpc: "2.0", id, result: {} }) as const;

/**
 * Opens the link a page in `frame` asked for and answers the page, only while the reader is using
 * that frame. The host window's user activation alone is not enough: a tap on any other control in
 * the app grants it too.
 */
export const openPageLink = (
  frame: HTMLIFrameElement,
  request: { readonly id: string | number; readonly url: string },
): void => {
  const url = URL.parse(request.url);
  if (
    url === null ||
    frame.ownerDocument.activeElement !== frame ||
    navigator.userActivation?.isActive === false
  ) {
    return;
  }
  window.open(url.href, "_blank", "noopener,noreferrer");
  frame.contentWindow?.postMessage(pageLinkResult(request.id), "*");
};

export const pageThemeMessage = (theme: PageTheme) =>
  ({
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  }) as const;

/** The frame URL with the theme its first paint uses; the bootstrap drops the fragment. */
export const pageFrameSrc = (url: string, theme: PageTheme): string =>
  `${url.split("#", 1)[0]}#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
