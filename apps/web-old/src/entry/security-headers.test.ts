import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { makePublicNetwork, PAGE_VIEW_PATH, previewFrameSource, PublicOrigin } from "@mend/network";
import { describe, expect, it } from "vitest";

import {
  contentSecurityPolicy,
  PERMISSIONS_POLICY,
  POLICY_ONLY_HEADERS,
  securityHeaders,
} from "./security-headers.ts";

const at = (appUrl: string, ...alternates: ReadonlyArray<string>) =>
  makePublicNetwork(
    PublicOrigin.make(appUrl),
    alternates.map((origin) => PublicOrigin.make(origin)),
  );

const routedSpellings = (target: string) => [
  target,
  target.toUpperCase(),
  `/${target}`,
  target.replaceAll("/", "//"),
  target.replace("/", "/%2F"),
  target.replace(/^\/(\w)/, (_, first: string) => `/%${first.charCodeAt(0).toString(16)}`),
  target.replace(/(\?|$)/, "/$1"),
  `https://mend.example${target}`,
];

describe("the browser header policy (MEND-11)", () => {
  it("lets only this origin supply scripts, connections, frames and form targets", () => {
    const csp = contentSecurityPolicy(at("https://mend.example"), null, "none");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'self' data: wss://mend.example");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // No wildcard and no other origin anywhere in it.
    expect(csp).not.toMatch(/\*|https?:\/\/(?!mend\.example)/);
    expect(contentSecurityPolicy(at("http://localhost:3105"), null, "none")).toContain(
      "connect-src 'self' data: ws://localhost:3105",
    );
  });

  it("claims HSTS only over https", () => {
    expect(
      securityHeaders({ target: "/", network: at("https://mend.example"), previewFrames: null }),
    ).toHaveProperty("strict-transport-security", "max-age=31536000");
    expect(
      securityHeaders({ target: "/", network: at("http://localhost:3105"), previewFrames: null }),
    ).not.toHaveProperty("strict-transport-security");
  });

  it("forbids framing everywhere, the terminal embed included", () => {
    for (const pathname of ["/", "/tty-embed", "/api/events"]) {
      const headers = securityHeaders({
        target: pathname,
        network: at("https://mend.example"),
        previewFrames: null,
      });
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
  });

  it("the terminal embed still loads under the policy: it is a top-level document", () => {
    // What the embed needs: its own scripts and wasm, its own socket, its own ticket exchange.
    const headers = securityHeaders({
      target: "/tty-embed",
      network: at("https://mend.example"),
      previewFrames: null,
    });
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain("wss://mend.example");
    expect(csp).toContain("connect-src 'self'");
    // frame-ancestors governs who may FRAME a page; a WebView navigating to it is not a frame.
    expect(csp).not.toContain("sandbox");
  });

  it("allows the way the installed terminal library loads its WebAssembly", async () => {
    // ghostty-web inlines its wasm as a `data:` URL and loads it with `fetch`, which `connect-src`
    // governs: without `data:` there the terminal and the embed load nothing. Read from the
    // installed library, so an upgrade that changes how it loads fails here, not in a browser.
    const entry = createRequire(import.meta.url).resolve("ghostty-web");
    const library = await readFile(join(dirname(entry), "ghostty-web.js"), "utf8");
    const inlined = library.includes("data:application/wasm");
    const connect =
      contentSecurityPolicy(at("https://mend.example"), null, "none")
        .split("; ")
        .find((directive) => directive.startsWith("connect-src")) ?? "";
    expect(inlined).toBe(true);
    expect(connect.split(" ")).toContain("data:");
    // Compiling it needs this, and nothing looser.
    expect(contentSecurityPolicy(at("https://mend.example"), null, "none")).not.toContain(
      "'unsafe-eval'",
    );
  });

  it("keeps every page whose URL carries a credential out of caches and Referers, however it is spelled", () => {
    const pages = [
      "/tty-embed?ticket=SYN_TICKET",
      "/pair?code=SYN_CODE",
      "/authorize?code=SYN_CODE",
      "/preview-auth?grant=SYN_GRANT",
      "/api/preview-auth?grant=SYN_GRANT",
      "/join",
      "/join/SYN_INVITATION",
      "/reset",
      "/reset/SYN_RESET",
      "/slack/link",
      "/slack/link/msl_SYN_SLACK_CODE",
    ];
    for (const page of pages) {
      for (const target of routedSpellings(page)) {
        const headers = securityHeaders({
          target,
          network: at("https://mend.example"),
          previewFrames: null,
        });
        expect.soft(headers["referrer-policy"], target).toBe("no-referrer");
        expect.soft(headers["cache-control"], target).toBe("no-store");
      }
    }
    for (const target of ["/", "/settings", "/joined", "/slack", "/api/auth/reset-password"]) {
      const headers = securityHeaders({
        target,
        network: at("https://mend.example"),
        previewFrames: null,
      });
      expect(headers["referrer-policy"], target).toBe("strict-origin-when-cross-origin");
      expect(headers["cache-control"], target).toBeUndefined();
    }
  });
});

describe("an agent's page (docs/adr/0004, Agent pages)", () => {
  it("lets the app frame only the page-view route, without relaxing its other directives", () => {
    expect(contentSecurityPolicy(at("https://mend.example"), null, "none").split("; ")).toEqual([
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' data: wss://mend.example",
      "worker-src 'self' blob:",
      `frame-src https://mend.example${PAGE_VIEW_PATH}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]);
  });

  it("frames the page-view route on every origin the front accepts, and on no other", () => {
    const network = at(
      "https://mend.example",
      "https://mend.internal:8443",
      "http://10.0.0.40:3105",
    );
    const frameSrc = (target: string) => {
      const csp =
        securityHeaders({ target, network, previewFrames: null })["content-security-policy"] ?? "";
      return csp
        .split("; ")
        .filter(
          (directive) => directive.startsWith("frame-src") || directive.startsWith("child-src"),
        );
    };
    for (const target of ["/", "/sessions/session-1"]) {
      expect(frameSrc(target)).toEqual([
        `frame-src https://mend.example${PAGE_VIEW_PATH} https://mend.internal:8443${PAGE_VIEW_PATH} http://10.0.0.40:3105${PAGE_VIEW_PATH}`,
      ]);
    }
  });

  it("keeps the API's sandbox policy, and only its route may be framed", () => {
    for (const target of [
      `${PAGE_VIEW_PATH}?view=token`,
      `https://mend.example${PAGE_VIEW_PATH}`,
    ]) {
      expect(
        securityHeaders({ target, network: at("https://mend.example"), previewFrames: null }),
      ).toEqual({
        "content-security-policy": "sandbox allow-scripts allow-forms",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "private, no-store",
        "permissions-policy": PERMISSIONS_POLICY,
        "strict-transport-security": "max-age=31536000",
      });
    }
    for (const target of [
      `${PAGE_VIEW_PATH}/x`,
      "/api/page-viewer",
      "/page-view",
      "/api/pages",
      "/sessions/%2e%2e/api/page-view?view=token",
      "/sessions/../api/page-view?view=token",
      "/api/auth/%2e%2e/page-view?view=token",
      "//api/page-view?view=token",
      "/api//page-view?view=token",
      "/API/page-view?view=token",
    ]) {
      const other = securityHeaders({
        target,
        network: at("https://mend.example"),
        previewFrames: null,
      });
      expect(other["x-frame-options"], target).toBe("DENY");
      expect(other["content-security-policy"], target).toContain("frame-ancestors 'none'");
    }
  });
});

describe("a preview in Mend's own frame (docs/adr/0017, decision log 15)", () => {
  const network = at("https://alpha.mend.run", "https://mend-box.tail1.ts.net:8443");
  const previewFrames = previewFrameSource(
    { mode: "domain-https", domain: "previews.mend.run", port: 443 },
    network.appUrl,
  );
  const directive = (target: string, name: string, frames: string | null = previewFrames) =>
    (securityHeaders({ target, network, previewFrames: frames })["content-security-policy"] ?? "")
      .split("; ")
      .filter((entry) => entry.startsWith(`${name} `));

  it("allows the preview hosts and Mend's /preview-auth, and nothing else new", () => {
    expect(previewFrames).toBe("https://*.previews.mend.run");
    expect(directive("/sessions/s-1", "frame-src")).toEqual([
      [
        "frame-src",
        `https://alpha.mend.run${PAGE_VIEW_PATH}`,
        `https://mend-box.tail1.ts.net:8443${PAGE_VIEW_PATH}`,
        "https://alpha.mend.run/preview-auth",
        "https://mend-box.tail1.ts.net:8443/preview-auth",
        "https://*.previews.mend.run",
      ].join(" "),
    ]);
    // Every other directive is the policy without previews, word for word.
    const others = (frames: string | null) =>
      contentSecurityPolicy(network, frames, "none")
        .split("; ")
        .filter((entry) => !entry.startsWith("frame-src "));
    expect(others(previewFrames)).toEqual(others(null));
  });

  it("adds nothing while previews are on another site", () => {
    const crossSite = previewFrameSource(
      { mode: "domain-https", domain: "previews.example.net", port: 443 },
      network.appUrl,
    );
    expect(crossSite).toBeNull();
    expect(directive("/sessions/s-1", "frame-src", crossSite)).toEqual([
      `frame-src https://alpha.mend.run${PAGE_VIEW_PATH} https://mend-box.tail1.ts.net:8443${PAGE_VIEW_PATH}`,
    ]);
    expect(directive("/preview-auth?preview=p&path=%2F", "frame-ancestors", crossSite)).toEqual([
      "frame-ancestors 'none'",
    ]);
  });

  it("lets only Mend's own pages frame /preview-auth, with no X-Frame-Options", () => {
    for (const target of [
      "/preview-auth?preview=pv-web&path=%2F",
      "https://alpha.mend.run/preview-auth?preview=pv-web&path=%2Flogin",
    ]) {
      const headers = securityHeaders({ target, network, previewFrames });
      expect(directive(target, "frame-ancestors")).toEqual(["frame-ancestors 'self'"]);
      expect(headers).not.toHaveProperty("x-frame-options");
      expect(headers["referrer-policy"]).toBe("no-referrer");
    }
    // The upstream's DENY is dropped by the front, so it cannot outlive the exception.
    expect(POLICY_ONLY_HEADERS.has("x-frame-options")).toBe(true);
  });

  it("keeps frame-ancestors 'none' on every other route", () => {
    for (const target of [
      "/",
      "/sessions/s-1",
      "/login",
      "/tty-embed?ticket=t",
      "/api/preview-auth?preview=p&path=%2F",
      "/api/events",
      "/preview-authorize",
      "/preview-auth/x",
      "/x/preview-auth",
    ]) {
      const headers = securityHeaders({ target, network, previewFrames });
      expect.soft(directive(target, "frame-ancestors"), target).toEqual(["frame-ancestors 'none'"]);
      expect.soft(headers["x-frame-options"], target).toBe("DENY");
    }
  });
});
