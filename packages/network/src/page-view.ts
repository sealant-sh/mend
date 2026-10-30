import { requestPathOf } from "./request-path.ts";

// The CSP `sandbox` directive without `allow-same-origin` runs the page in an opaque origin,
// framed or top-level, so it reads no cookie or storage of Mend's origin. Mend's app frames it, so
// this route alone sets no `X-Frame-Options` and no `frame-ancestors` (docs/adr/0004).
export const PAGE_VIEW_PATH = "/api/page-view";

export const PAGE_VIEW_TOKEN_PARAM = "view";

export const PAGE_VIEW_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "sandbox allow-scripts allow-forms",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
};

export const isPageViewTarget = (target: string): boolean =>
  requestPathOf(target) === PAGE_VIEW_PATH;
