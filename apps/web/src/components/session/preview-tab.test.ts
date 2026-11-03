import { describe, expect, it } from "vitest";

import { joinPath } from "./preview-tab.tsx";

describe("the Preview tab's address", () => {
  it("opens a typed path through Mend's relative preview link", () => {
    expect(joinPath("/preview-auth?preview=pv-web&path=%2F", "docs/start")).toBe(
      "/preview-auth?preview=pv-web&path=%2Fdocs%2Fstart",
    );
    expect(joinPath("/preview-auth?preview=pv-web&path=%2F", "")).toBe(
      "/preview-auth?preview=pv-web&path=%2F",
    );
  });

  it("opens a typed path on a preview's own origin", () => {
    expect(joinPath("https://pv-web.preview.example.test/old?x=1", "/docs")).toBe(
      "https://pv-web.preview.example.test/docs",
    );
  });
});
