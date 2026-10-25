import { describe, expect, it } from "vitest";

import { apiTargetOf, devProxyRoutes, forwardHeaders } from "./proxy-headers.ts";

describe("forwardHeaders", () => {
  it("preserves the configured same-origin Host but strips address inference headers", () => {
    expect(
      forwardHeaders({
        headers: {
          host: "mac-mini.local:3105",
          forwarded: "host=evil.invalid;proto=https",
          "x-forwarded-host": "evil.invalid",
          "x-forwarded-proto": "https",
        },
        remoteAddress: "192.168.1.20",
      }),
    ).toEqual({
      host: "mac-mini.local:3105",
      "x-forwarded-for": "192.168.1.20",
    });
  });

  it("appends its observed peer after the untrusted forwarded-for prefix", () => {
    expect(
      forwardHeaders({
        headers: { "x-forwarded-for": "203.0.113.9" },
        remoteAddress: "100.84.1.2",
      })["x-forwarded-for"],
    ).toBe("203.0.113.9, 100.84.1.2");
  });
});

describe("apiTargetOf", () => {
  it("relays the API and the preview sign-in, and leaves every other path to the app", () => {
    expect(apiTargetOf("/api/upgrade-tickets")).toBe("/api/upgrade-tickets");
    expect(apiTargetOf("/preview-auth?preview=pv-1&path=%2Fpricing")).toBe(
      "/api/preview-auth?preview=pv-1&path=%2Fpricing",
    );
    expect(apiTargetOf("/preview-auth")).toBe("/api/preview-auth");
    for (const url of ["/", "/preview-authorize", "/preview-auth/x", "/apix", "/login"]) {
      expect(apiTargetOf(url)).toBeNull();
    }
  });
});

const upstreamOf = (url: string) => {
  const routes = devProxyRoutes("http://localhost:3101");
  const pathname = url.split("?")[0] ?? url;
  const matched = Object.entries(routes).find(([route]) =>
    route.endsWith("/**") ? pathname.startsWith(route.slice(0, -2)) : pathname === route,
  );
  if (matched === undefined) return null;
  const prefix = new URL(matched[1].target).pathname.replace(/\/$/, "");
  return `${prefix}${url}`;
};

describe("devProxyRoutes", () => {
  it("relays in development exactly what the production front relays", () => {
    for (const url of [
      "/api/upgrade-tickets",
      "/api/auth/get-session",
      "/preview-auth?preview=pv-1&path=%2Fpricing",
      "/preview-auth",
      "/preview-authorize",
      "/preview-auth/x",
      "/login",
      "/",
    ]) {
      expect(upstreamOf(url), url).toBe(apiTargetOf(url));
    }
  });
});
