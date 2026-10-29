import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { PAGE_VIEW_PATH } from "@mend/network";
import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, PERMISSIONS_POLICY, securityHeaders } from "./security-headers.ts";

describe("the browser header policy (MEND-11)", () => {
  it("lets only this origin supply scripts, connections, frames and form targets", () => {
    const csp = contentSecurityPolicy("https://mend.example");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'self' data: wss://mend.example");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // No wildcard and no other origin anywhere in it.
    expect(csp).not.toMatch(/\*|https?:\/\/(?!mend\.example)/);
    expect(contentSecurityPolicy("http://localhost:3105")).toContain(
      "connect-src 'self' data: ws://localhost:3105",
    );
  });

  it("claims HSTS only over https", () => {
    expect(securityHeaders({ target: "/", appUrl: "https://mend.example" })).toHaveProperty(
      "strict-transport-security",
      "max-age=31536000",
    );
    expect(securityHeaders({ target: "/", appUrl: "http://localhost:3105" })).not.toHaveProperty(
      "strict-transport-security",
    );
  });

  it("forbids framing everywhere, the terminal embed included", () => {
    for (const pathname of ["/", "/tty-embed", "/api/events"]) {
      const headers = securityHeaders({ target: pathname, appUrl: "https://mend.example" });
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
  });

  it("the terminal embed still loads under the policy: it is a top-level document", () => {
    // What the embed needs: its own scripts and wasm, its own socket, its own ticket exchange.
    const headers = securityHeaders({ target: "/tty-embed", appUrl: "https://mend.example" });
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
      contentSecurityPolicy("https://mend.example")
        .split("; ")
        .find((directive) => directive.startsWith("connect-src")) ?? "";
    expect(inlined).toBe(true);
    expect(connect.split(" ")).toContain("data:");
    // Compiling it needs this, and nothing looser.
    expect(contentSecurityPolicy("https://mend.example")).not.toContain("'unsafe-eval'");
  });

  it("sends no referrer from a page whose URL carries a credential", () => {
    for (const pathname of [
      "/tty-embed",
      "/pair",
      "/authorize",
      "/preview-auth",
      "/api/preview-auth",
    ]) {
      expect(
        securityHeaders({ target: pathname, appUrl: "https://mend.example" })["referrer-policy"],
      ).toBe("no-referrer");
    }
    expect(
      securityHeaders({ target: "/", appUrl: "https://mend.example" })["referrer-policy"],
    ).toBe("strict-origin-when-cross-origin");
  });
});

describe("an agent's page (docs/adr/0004, Agent pages)", () => {
  it("keeps the API's sandbox policy, and only its route may be framed", () => {
    for (const target of [
      `${PAGE_VIEW_PATH}?view=token`,
      `https://mend.example${PAGE_VIEW_PATH}`,
    ]) {
      expect(securityHeaders({ target, appUrl: "https://mend.example" })).toEqual({
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
      const other = securityHeaders({ target, appUrl: "https://mend.example" });
      expect(other["x-frame-options"], target).toBe("DENY");
      expect(other["content-security-policy"], target).toContain("frame-ancestors 'none'");
    }
  });
});
