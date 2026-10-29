import { describe, expect, it } from "vitest";

import { previewDomainConflict, previewDomainOverlap } from "./preview-domain.ts";

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

  it("refuses an equal, parent or child domain, and a sibling on Mend's own site only without __Host- cookies", () => {
    for (const cookies of ["__Host-", ""] as const) {
      expect(previewDomainConflict("mend.example.com", "mend.example.com", cookies)).toEqual({
        kind: "holds",
      });
      expect(previewDomainConflict("example.com", "mend.example.com", cookies)).toEqual({
        kind: "holds",
      });
      expect(
        previewDomainConflict("previews.mend.example.com", "mend.example.com", cookies),
      ).toEqual({ kind: "under" });
      expect(previewDomainConflict("previews.example.net", "mend.example.com", cookies)).toBeNull();
    }
    expect(previewDomainConflict("previews.example.com", "mend.example.com", "__Host-")).toBeNull();
    expect(previewDomainConflict("previews.example.com", "mend.example.com", "")).toEqual({
      kind: "same-site",
      site: "example.com",
    });
  });
});
