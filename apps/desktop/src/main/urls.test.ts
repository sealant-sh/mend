import { describe, expect, it } from "vitest";

import { isAllowedExternalUrl, isLocalShellUrl, isSameOrigin, normalizeServerUrl } from "./urls.ts";

describe("normalizeServerUrl", () => {
  it("defaults bare loopback hostnames to http and remote hostnames to https", () => {
    expect(normalizeServerUrl("localhost:3115")).toEqual({
      ok: true,
      url: "http://localhost:3115",
      origin: "http://localhost:3115",
    });
    expect(normalizeServerUrl("127.0.0.1:3105/")).toEqual({
      ok: true,
      url: "http://127.0.0.1:3105",
      origin: "http://127.0.0.1:3105",
    });
    expect(normalizeServerUrl("mend.example.com///")).toEqual({
      ok: true,
      url: "https://mend.example.com",
      origin: "https://mend.example.com",
    });
  });

  it("preserves explicit http/https schemes and subpaths while dropping trailing slashes", () => {
    expect(normalizeServerUrl("  http://mend.internal:8080/app/  ")).toEqual({
      ok: true,
      url: "http://mend.internal:8080/app",
      origin: "http://mend.internal:8080",
    });
  });

  it("rejects empty input, non-http schemes, embedded credentials, and malformed URLs", () => {
    expect(normalizeServerUrl("   ").ok).toBe(false);
    expect(normalizeServerUrl("file:///etc/passwd").ok).toBe(false);
    expect(normalizeServerUrl("javascript:alert(1)").ok).toBe(false);
    expect(normalizeServerUrl("https://user:pass@mend.example.com").ok).toBe(false);
    expect(normalizeServerUrl("not a url at all").ok).toBe(false);
  });
});

describe("isSameOrigin", () => {
  it("matches exact http(s) origins and rejects different ports, hosts, or non-http schemes", () => {
    expect(isSameOrigin("https://mend.example.com/sessions/1", "https://mend.example.com")).toBe(
      true,
    );
    expect(isSameOrigin("http://localhost:3115/login", "http://localhost:3115")).toBe(true);
    expect(isSameOrigin("http://localhost:3105/login", "http://localhost:3115")).toBe(false);
    expect(isSameOrigin("https://evil.example.com/", "https://mend.example.com")).toBe(false);
    expect(isSameOrigin("file:///tmp/index.html", "http://localhost:3115")).toBe(false);
  });
});

describe("isAllowedExternalUrl", () => {
  it("allows web, editor, and mailto protocols and blocks local or script schemes", () => {
    expect(isAllowedExternalUrl("https://github.com/sealant-sh/mend")).toBe(true);
    expect(isAllowedExternalUrl("http://localhost:3000")).toBe(true);
    expect(isAllowedExternalUrl("vscode://sealant-sh.mend/open?session=abc")).toBe(true);
    expect(isAllowedExternalUrl("mailto:support@sealant.sh")).toBe(true);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("data:text/html,hi")).toBe(false);
  });
});

describe("isLocalShellUrl", () => {
  it("identifies the packaged file directory or dev renderer origin only", () => {
    const prod = {
      devRendererUrl: undefined,
      prodRendererDirUrl: "file:///app/out/renderer/",
    };
    expect(isLocalShellUrl("file:///app/out/renderer/index.html", prod)).toBe(true);
    expect(isLocalShellUrl("file:///etc/passwd", prod)).toBe(false);
    expect(isLocalShellUrl("https://mend.example.com/", prod)).toBe(false);

    const dev = {
      devRendererUrl: "http://localhost:5173",
      prodRendererDirUrl: "file:///app/out/renderer/",
    };
    expect(isLocalShellUrl("http://localhost:5173/index.html", dev)).toBe(true);
    expect(isLocalShellUrl("http://localhost:3115/", dev)).toBe(false);
  });
});
