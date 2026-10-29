// The document the phone's WebView loads around a page. The page itself never runs in the WebView's
// own document: that document holds the bridge to React Native (`window.ReactNativeWebView`).
// It runs in a sandboxed frame with an opaque origin, which cannot reach its parent's globals,
// and the host relays to React Native only the few requests a page may make.

import { PAGE_VIEW_TOKEN_PARAM } from "@mend/network";
import {
  PAGE_FRAME_SANDBOX,
  PAGE_MAX_FIT_HEIGHT,
  PAGE_MIN_HEIGHT,
  pageThemeMessage,
  readPageFrameRequest,
  type PageFrameRequest,
} from "@mend/ui/page-frame";
import type { PageTheme } from "@mend/ui/page-theme";

/**
 * An unguessable token per host document. Both platforms expose the bridge to every frame in the
 * WebView (WKScriptMessageHandler and Android's WebMessageListener with "*" are not main-frame
 * only), so a page could post to React Native directly; only the host knows this token. Math.random
 * is enough when Web Crypto is missing: the page runs in another JavaScript engine and never sees
 * its output.
 */
export const pageHostSecret = (): string => {
  const bytes = new Uint8Array(16);
  const crypto = globalThis.crypto;
  if (typeof crypto?.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.random() * 256;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

// JSON inside a <script>: `<`, `>` and `&` escaped, so no value closes the element.
const inline = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const attribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const hostScript = (secret: string, theme: PageTheme, height: number): string => `(function(){
var f=document.getElementById("page"),secret=${inline(secret)},theme=${inline(pageThemeMessage(theme))},MIN=${PAGE_MIN_HEIGHT},MAX=${PAGE_MAX_FIT_HEIGHT};
function send(m){window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,data:m}));}
function post(m){if(f.contentWindow)f.contentWindow.postMessage(m,"*");}
function paint(m){document.documentElement.style.colorScheme=m.params.theme;f.style.colorScheme=m.params.theme;document.documentElement.style.background=m.params.styles.variables["--background"];}
window.addEventListener("message",function(e){
if(!f.contentWindow||e.source!==f.contentWindow)return;
var d=e.data,p=d&&d.params;
if(!d||d.jsonrpc!=="2.0"||!p||typeof p!=="object")return;
if(d.method==="ui/notifications/size-changed"){
if(typeof p.height!=="number"||!(p.height>=0))return;
f.style.height=Math.min(MAX,Math.max(MIN,Math.ceil(p.height)))+"px";
send({jsonrpc:"2.0",method:d.method,params:{height:p.height}});
}else if(d.method==="ui/open-link"){
if(navigator.userActivation&&!navigator.userActivation.isActive)return;
send({jsonrpc:"2.0",id:d.id,method:d.method,params:{url:p.url}});
}
});
f.addEventListener("load",function(){post(theme);});
window.mendHost={theme:function(m){theme=m;paint(m);post(m);},post:post};
f.style.height=${Math.round(height)}+"px";
paint(theme);
})();`;

const withoutQuery = (url: string): string => url.split(/[?#]/, 1)[0] ?? url;

/**
 * The host document's Content-Security-Policy. The browser engine applies it to every navigation
 * of the page's frame, whoever starts it and whatever the native navigation callback reports:
 * the frame may hold only the page view's path on the page's origin. The host's own script and
 * style run by nonce; nothing else loads.
 */
export const pageHostPolicy = (src: string, nonce: string): string =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    `frame-src ${withoutQuery(src).replace(/[;,\s]/g, encodeURIComponent)}`,
  ].join("; ");

export const pageHostDocument = (options: {
  readonly src: string;
  readonly title: string;
  readonly theme: PageTheme;
  readonly height: number;
  readonly secret: string;
}): string =>
  [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${attribute(pageHostPolicy(options.src, options.secret))}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<style nonce="${attribute(options.secret)}">html,body{margin:0;padding:0}`,
    "iframe{display:block;width:100%;border:0}</style>",
    "</head><body>",
    `<iframe id="page" src="${attribute(options.src)}" title="${attribute(options.title)}"`,
    ` sandbox="${PAGE_FRAME_SANDBOX}" referrerpolicy="no-referrer"></iframe>`,
    `<script nonce="${attribute(options.secret)}">`,
    hostScript(options.secret, options.theme, options.height),
    "</script></body></html>",
  ].join("");

const isRow = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readPageHostRequest = (raw: string, secret: string): PageFrameRequest | undefined => {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRow(message) && message["secret"] === secret
    ? readPageFrameRequest(message["data"])
    : undefined;
};

export const pageHostThemeCall = (theme: PageTheme): string =>
  `window.mendHost&&window.mendHost.theme(${inline(pageThemeMessage(theme))});true;`;

export const pageHostPostCall = (message: unknown): string =>
  `window.mendHost&&window.mendHost.post(${inline(message)});true;`;

export interface PageNavigation {
  readonly url: string;
  /** iOS says whether the top frame navigates; Android leaves it out. */
  readonly isTopFrame?: boolean;
}

const pageViewOf = (url: string) => {
  const [address = "", query = ""] = url.split("#", 1)[0]?.split("?", 2) ?? [];
  const path = address.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  const view = query.split("&").find((pair) => pair.startsWith(`${PAGE_VIEW_TOKEN_PARAM}=`));
  return { path, view };
};

const isPageView = (url: string, src: string): boolean => {
  const asked = pageViewOf(url);
  const minted = pageViewOf(src);
  return minted.view !== undefined && asked.path === minted.path && asked.view === minted.view;
};

/**
 * Whether the WebView may start a navigation. The host document's CSP binds the page's frame on
 * both platforms; this gate keeps the top frame on the host document (about:blank).
 * - iOS asks for every frame and says which is the top one. A frame below it is left to the CSP,
 *   so a page's own srcdoc, blob: or data: frames load as they do on the web.
 * - Android asks only for some navigations, never says which frame, and allows the load when
 *   React Native has not answered within 250 ms. It may ask for the page's own frame, so that
 *   is allowed by its path and minted view token.
 */
export const pageNavigationAllowed = (navigation: PageNavigation, src: string): boolean =>
  navigation.url === "about:blank" ||
  navigation.isTopFrame === false ||
  (navigation.isTopFrame === undefined && isPageView(navigation.url, src));
