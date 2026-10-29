// @vitest-environment jsdom
import { pageLinkResult, pageThemeMessage } from "@mend/ui/page-frame";
import { pageThemes } from "@mend/ui/page-theme";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pageHostDocument,
  pageHostPostCall,
  pageHostSecret,
  pageHostThemeCall,
  pageNavigationAllowed,
  readPageHostRequest,
} from "./page-host";

const SRC = "https://mend.example.com/api/page-view?view=tok#t3-theme=%7B%7D";
const SECRET = "0123456789abcdef0123456789abcdef";

const loadHost = (src = SRC, secret = SECRET) => {
  const sent: string[] = [];
  const html = pageHostDocument({
    src,
    title: 'Latency "by" <route>',
    theme: pageThemes.light,
    height: 420,
    secret,
  });
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const host = frame.contentWindow;
  if (host === null) throw new Error("no host window");
  Object.defineProperty(host, "ReactNativeWebView", {
    value: { postMessage: (data: string) => sent.push(data) },
  });
  host.document.open();
  host.document.write(html);
  host.document.close();
  const page = host.document.querySelector("iframe");
  if (page === null || page.contentWindow === null) throw new Error("no page frame");
  const pageWindow = page.contentWindow;
  const fromPage = (data: unknown, source: MessageEventSource | null = pageWindow) =>
    host.dispatchEvent(new MessageEvent("message", { data, source, origin: "null" }));
  const events = () => sent.map((raw) => readPageHostRequest(raw, secret));
  const inject = (script: string) => {
    const tag = host.document.createElement("script");
    tag.textContent = script;
    host.document.body.append(tag);
  };
  return { host, page, pageWindow, fromPage, sent, events, inject };
};

const size = (height: unknown) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/size-changed",
  params: { height },
});
const link = (url: string) => ({
  jsonrpc: "2.0",
  id: "t3-link-1",
  method: "ui/open-link",
  params: { url },
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("the host document", () => {
  it("frames the page URL with exactly allow-scripts and allow-forms, and no referrer", () => {
    const { page } = loadHost();
    expect(page.getAttribute("src")).toBe(SRC);
    expect(page.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(page.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(page.getAttribute("title")).toBe('Latency "by" <route>');
    expect(page.style.height).toBe("420px");
    expect(page.ownerDocument.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("lets the page's frame hold only the page view, and runs only its own script and style", () => {
    const { host } = loadHost();
    const policy = host.document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(policy?.getAttribute("content")).toBe(
      `default-src 'none'; script-src 'nonce-${SECRET}'; style-src 'nonce-${SECRET}'; ` +
        "frame-src https://mend.example.com/api/page-view",
    );
    expect(host.document.head.firstElementChild).toBe(policy);
    for (const element of host.document.querySelectorAll("script, style")) {
      expect(element.getAttribute("nonce")).toBe(SECRET);
    }
  });

  it("keeps the page view's address one source in the policy, whatever its path holds", () => {
    const { host } = loadHost("http://10.0.0.40:3105/api/page-view;x=1,y 2?view=tok");
    const policy = host.document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(policy?.getAttribute("content")?.split("; ").at(-1)).toBe(
      "frame-src http://10.0.0.40:3105/api/page-view%3Bx=1%2Cy%202",
    );
  });

  it("writes the secret and the theme into its script as values, whatever they hold", () => {
    const secret = "THEME SECRET";
    const { host, page, pageWindow, fromPage, events } = loadHost(SRC, secret);
    fromPage(size(300));
    expect(events()).toEqual([{ kind: "size", height: 300 }]);
    const posted = vi.spyOn(pageWindow, "postMessage");
    page.dispatchEvent(new Event("load"));
    expect(posted).toHaveBeenLastCalledWith(pageThemeMessage(pageThemes.light), "*");
    expect(host.document.documentElement.style.colorScheme).toBe("light");
  });

  it("keeps a hostile URL inside the src attribute", () => {
    const { page } = loadHost('https://x.example/"><script>alert(1)</script>');
    expect(page.getAttribute("src")).toBe('https://x.example/"><script>alert(1)</script>');
    expect(page.ownerDocument.querySelectorAll("script")).toHaveLength(1);
  });

  it("relays the page's size and fits its frame to it", () => {
    const { page, fromPage, events } = loadHost();
    fromPage(size(812.4));
    expect(page.style.height).toBe("813px");
    fromPage(size(0));
    expect(page.style.height).toBe("80px");
    expect(events()).toEqual([
      { kind: "size", height: 812.4 },
      { kind: "size", height: 0 },
    ]);
  });

  it("ignores every message that does not come from the page's own frame", () => {
    const { host, fromPage, sent } = loadHost();
    const stranger = document.createElement("iframe");
    host.document.body.append(stranger);
    fromPage(size(500), host);
    fromPage(size(500), stranger.contentWindow);
    fromPage(size(500), null);
    fromPage(link("https://example.com"), host);
    expect(sent).toEqual([]);
  });

  it("relays only the requests a page may make", () => {
    const { page, fromPage, events } = loadHost();
    page.focus();
    fromPage({ jsonrpc: "2.0", method: "t3/notifications/open-image", params: { src: "x" } });
    fromPage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: {} });
    fromPage({ method: "ui/notifications/size-changed", params: { height: 10 } });
    fromPage(size("tall"));
    fromPage(JSON.stringify(size(10)));
    for (const url of ["javascript:alert(1)", "intent://scan#Intent;end", "tel:+15550100"]) {
      fromPage(link(url));
    }
    fromPage(link("https://example.com/docs"));
    fromPage(link("https://mend_server.example.com/docs"));
    fromPage(link("http://10.0.0.40:3105/report?q=1"));
    expect(events()).toEqual([
      undefined,
      undefined,
      undefined,
      ...[
        "https://example.com/docs",
        "https://mend_server.example.com/docs",
        "http://10.0.0.40:3105/report?q=1",
      ].map((url) => ({ kind: "link", id: "t3-link-1", url })),
    ]);
  });

  it("relays a link only while the reader is using the page", () => {
    const { host, page, fromPage, events } = loadHost();
    const activation = { isActive: true };
    Object.defineProperty(host.navigator, "userActivation", { value: activation });
    fromPage(link("https://example.com/unfocused"));
    page.focus();
    activation.isActive = false;
    fromPage(link("https://example.com/no-tap"));
    activation.isActive = true;
    fromPage(link("https://example.com/docs"));
    expect(events()).toEqual([{ kind: "link", id: "t3-link-1", url: "https://example.com/docs" }]);
  });

  it("signs what it sends, so React Native ignores a page posting to the bridge itself", () => {
    const { fromPage, sent } = loadHost();
    fromPage(size(300));
    expect(sent).toHaveLength(1);
    expect(readPageHostRequest(sent[0] ?? "", SECRET)).toEqual({ kind: "size", height: 300 });
    expect(readPageHostRequest(sent[0] ?? "", "another secret")).toBeUndefined();
    expect(readPageHostRequest(JSON.stringify({ data: size(300) }), SECRET)).toBeUndefined();
    expect(readPageHostRequest("not json", SECRET)).toBeUndefined();
  });

  it("posts the theme to a loaded page and repaints, without reloading it", () => {
    const { host, page, pageWindow, inject } = loadHost();
    const posted = vi.spyOn(pageWindow, "postMessage");
    page.dispatchEvent(new Event("load"));
    expect(posted).toHaveBeenLastCalledWith(pageThemeMessage(pageThemes.light), "*");
    inject(pageHostThemeCall(pageThemes.dark));
    expect(posted).toHaveBeenLastCalledWith(pageThemeMessage(pageThemes.dark), "*");
    expect(host.document.documentElement.style.colorScheme).toBe("dark");
    expect(page.getAttribute("src")).toBe(SRC);
    inject(pageHostPostCall(pageLinkResult("t3-link-1")));
    expect(posted).toHaveBeenLastCalledWith(pageLinkResult("t3-link-1"), "*");
    page.dispatchEvent(new Event("load"));
    expect(posted).toHaveBeenLastCalledWith(pageThemeMessage(pageThemes.dark), "*");
  });

  it("makes a new secret each time", () => {
    const secrets = new Set(Array.from({ length: 20 }, pageHostSecret));
    expect(secrets.size).toBe(20);
    for (const secret of secrets) expect(secret).toMatch(/^[0-9a-f]{32}$/);
  });
});

const navigation = (url: string, isTopFrame?: boolean) =>
  isTopFrame === undefined ? { url } : { url, isTopFrame };

describe("the WebView's navigation", () => {
  it("keeps the top frame on the host document", () => {
    expect(pageNavigationAllowed(navigation("about:blank", true), SRC)).toBe(true);
    for (const url of [
      SRC,
      "https://example.com/",
      "javascript:alert(1)",
      "tel:+15550100",
      "intent://scan#Intent;end",
      "mend://session/1",
      "file:///etc/passwd",
      "data:text/html,<p>",
    ]) {
      expect(pageNavigationAllowed(navigation(url, true), SRC)).toBe(false);
    }
  });

  it("leaves a frame below the top one to the host's policy, as iOS reports it", () => {
    for (const url of [
      "HTTPS://Mend.Example.com:443/api/page-view?view=tok",
      "about:srcdoc",
      "blob:null/4b1c",
      "data:text/html,<p>",
    ]) {
      expect(pageNavigationAllowed(navigation(url, false), SRC)).toBe(true);
    }
  });

  it("allows a navigation Android does not place only to the page view's path and token", () => {
    for (const url of [
      "about:blank",
      "https://mend.example.com/api/page-view?view=tok",
      "https://mend.example.com/api/page-view?view=tok#top",
      "https://mend.example.com/api/page-view?a=1&view=tok",
    ]) {
      expect(pageNavigationAllowed(navigation(url), SRC)).toBe(true);
    }
    for (const url of [
      "https://mend.example.com/api/page-view?view=other",
      "https://mend.example.com/api/page-view?view=tokx",
      "https://mend.example.com/api/page-view",
      "https://mend.example.com/",
      "https://example.com/",
      "javascript:alert(1)",
      "intent://scan#Intent;end",
    ]) {
      expect(pageNavigationAllowed(navigation(url), SRC)).toBe(false);
    }
  });
});
