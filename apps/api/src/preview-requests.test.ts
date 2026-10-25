import { PreviewId, PreviewLabel } from "@mend/domain";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  browserAdmits,
  type BrowserHead,
  mustNotForward,
  parsePreviewPath,
  strictQuery,
} from "./preview-requests.ts";
import { previewOriginOf } from "./preview-routing.ts";

const addressed = previewOriginOf(
  { mode: "domain-https", domain: "preview.example", port: 443 },
  { id: PreviewId.make("pv-1"), label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa") },
);
if (addressed === null) throw new Error("a domain routing addresses every preview");
const OWN = addressed;

const head = (overrides: Partial<BrowserHead>): BrowserHead => ({
  method: "GET",
  upgrade: false,
  origins: [],
  fetchSite: undefined,
  fetchMode: undefined,
  fetchDest: undefined,
  ...overrides,
});

describe("the gateway's own paths", () => {
  it("are /__mend and below, however percent-encoded, and anything that does not decode", () => {
    for (const pathname of [
      "/__mend",
      "/__mend/auth",
      "/%5F%5Fmend/auth",
      "/%5f_mend/x",
      "/_%5Fmend",
      "/__m%65nd/auth",
      "/%E0%A4%A",
    ]) {
      expect(mustNotForward(pathname), pathname).toBe(true);
    }
    for (const pathname of ["/", "/__mendx", "/x/__mend", "/%255F%255Fmend/auth", "/__Mend"]) {
      expect(mustNotForward(pathname), pathname).toBe(false);
    }
  });
});

describe("redirect targets", () => {
  it("keeps a local path with its query and fragment", () => {
    expect(parsePreviewPath("/pricing?tab=2#plans")).toBe("/pricing?tab=2#plans");
    expect(parsePreviewPath("/a/../b")).toBe("/b");
    expect(parsePreviewPath("/")).toBe("/");
  });

  it("refuses every way to name another origin or the gateway's own paths", () => {
    for (const raw of [
      "",
      "pricing",
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/%5Cevil.example",
      "/%2F/evil.example",
      "/x%0d%0aSet-Cookie:a=b",
      "/x\r\nSet-Cookie:a=b",
      "/__mend/auth?ticket=x",
      "/__mend",
      "/a/../__mend/auth",
      "/%5F%5Fmend/auth",
      "/%E0%A4%A",
      `/${"a".repeat(2048)}`,
    ]) {
      expect(parsePreviewPath(raw), raw).toBeNull();
    }
  });

  it("only ever accepts what resolves to the preview's own origin", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom("/", "\\", "%2F", "%5C", "%2f", "..", ".", ":", "@", "?", "#", "\t"),
            fc.constantFrom("%00", "%0A", "%E2%80%AE", "%C0%AF", "evil.example", "__mend", "a"),
            fc.string({ maxLength: 4 }),
          ),
          { maxLength: 8 },
        ),
        (parts) => {
          const raw = parts.join("");
          const accepted = parsePreviewPath(raw);
          if (accepted === null) return;
          const resolved = new URL(accepted, OWN);
          expect(resolved.origin).toBe(OWN);
          expect(mustNotForward(resolved.pathname)).toBe(false);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("the query a sign-in reads", () => {
  it("takes each known parameter once and refuses repeats and strangers, however spelled", () => {
    expect(strictQuery("ticket=t&path=%2F", ["ticket", "path"])).toEqual(
      new Map([
        ["ticket", "t"],
        ["path", "/"],
      ]),
    );
    for (const search of [
      "ticket=a&ticket=a",
      "ticket=a&tick%65t=b",
      "path=%2F&ticket=a&path=%2Fx",
      "ticket=a&origin=https%3A%2F%2Fevil.example",
    ]) {
      expect(strictQuery(search, ["ticket", "path"]), search).toBeNull();
    }
  });
});

describe("which browser requests may act with a grant", () => {
  const own = OWN;
  const navigation = { fetchMode: "navigate", fetchDest: "document" } as const;

  it.each([
    ["an Origin-less GET", head({}), true],
    ["a cross-site top-level navigation", head({ fetchSite: "cross-site", ...navigation }), true],
    ["a same-origin fetch", head({ fetchSite: "same-origin", fetchMode: "cors" }), true],
    ["a write from its own page", head({ method: "POST", origins: [own] }), true],
    ["an upgrade from its own page", head({ upgrade: true, origins: [own] }), true],
    ["a foreign Origin, even on GET", head({ origins: ["https://other.preview.example"] }), false],
    ["Origin: null", head({ origins: ["null"] }), false],
    ["two Origins", head({ origins: [own, own] }), false],
    ["an Origin-less write", head({ method: "POST" }), false],
    ["an Origin-less upgrade", head({ upgrade: true }), false],
    ["a same-site fetch", head({ fetchSite: "same-site", fetchMode: "cors" }), false],
    ["a cross-site subresource", head({ fetchSite: "cross-site", fetchDest: "image" }), false],
    [
      "a cross-site navigation that upgrades",
      head({ fetchSite: "cross-site", upgrade: true, origins: [own], ...navigation }),
      false,
    ],
    ["malformed Fetch Metadata", head({ fetchSite: "elsewhere" }), false],
  ])("%s: %s", (_name, request, admitted) => {
    expect(browserAdmits(request, own)).toBe(admitted);
  });
});
