import { describe, expect, it } from "vitest";

import { previewDomainOverlap, SAME_SITE_PREVIEW_REASON } from "./preview-domain.ts";

describe("a preview domain beside one of Mend's hosts", () => {
  it.each([
    ["mend.example.com", "mend.example.com", { kind: "holds" }],
    ["example.com", "mend.example.com", { kind: "holds" }],
    ["previews.mend.example.com", "mend.example.com", { kind: "under" }],
    ["previews.example.com", "mend.example.com", { kind: "same-site", site: "example.com" }],
    ["previews.example.co.uk", "mend.example.co.uk", { kind: "same-site", site: "example.co.uk" }],
    ["previews.corp.internal", "mend.corp.internal", { kind: "same-site", site: "corp.internal" }],
    ["previews.example.net", "mend.example.com", null],
    ["xmend.example.com", "mend.example.com", { kind: "same-site", site: "example.com" }],
    ["previews.example.co.uk", "mend.other.co.uk", null],
    ["a.example.github.io", "mend.github.io", null],
    ["previews.example.net", "127.0.0.1", null],
    ["previews.example.net", "localhost", null],
  ] as const)("%s beside %s: %s", (domain, host, overlap) => {
    expect(previewDomainOverlap(domain, host)).toEqual(overlap);
  });

  it("names what a same-site pair needs and what to use until then", () => {
    expect(SAME_SITE_PREVIEW_REASON).toBe(
      "Previews on Mend's own site need Mend's cookies to move to __Host- names, which ships in ADR 0017 step 8b with the tailnet default. Until then, use a preview domain on a registrable domain of its own, or loopback (*.localhost).",
    );
  });
});
