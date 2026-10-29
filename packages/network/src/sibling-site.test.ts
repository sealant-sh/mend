import { describe, expect, it } from "vitest";

import { makePublicNetwork, PublicOrigin } from "./public-network.ts";
import { type BrowserSource, siblingSiteRefused } from "./sibling-site.ts";

const network = makePublicNetwork(PublicOrigin.make("https://mend.tail1234.ts.net"), [
  PublicOrigin.make("https://mend.example.com"),
]);

const from = (source: Partial<BrowserSource>): BrowserSource => ({
  method: "GET",
  upgrade: false,
  origin: undefined,
  sessionCookie: true,
  fetchSite: "same-site",
  fetchMode: "cors",
  fetchDest: "empty",
  ...source,
});

describe("a request carrying Mend's session cookie from another site or a sibling host", () => {
  it.each<[string, Partial<BrowserSource>]>([
    ["a fetch", {}],
    ["a no-cors image", { fetchMode: "no-cors", fetchDest: "image" }],
    ["a form POST", { method: "POST", fetchMode: "navigate", fetchDest: "document" }],
    ["an iframe", { fetchMode: "navigate", fetchDest: "iframe" }],
    ["an upgrade", { upgrade: true, fetchMode: "websocket" }],
    ["a fetch naming a sibling origin", { origin: "https://mend-preview.tail1234.ts.net:20001" }],
    ["a cross-site script", { fetchSite: "cross-site", fetchMode: "no-cors", fetchDest: "script" }],
    [
      "a HEAD that says it navigates, which no browser sends",
      { method: "HEAD", fetchMode: "navigate", fetchDest: "document" },
    ],
  ])("is refused: %s", (_, source) => {
    expect(siblingSiteRefused(network, from(source))).toBe(true);
  });

  it.each<[string, Partial<BrowserSource>]>([
    ["a top-level navigation", { fetchMode: "navigate", fetchDest: "document" }],
    ["a request naming an allowed origin", { origin: "https://mend.example.com" }],
    ["a request without Mend's session cookie", { sessionCookie: false }],
    ["Mend's own page", { fetchSite: "same-origin" }],
    ["an address typed by the person", { fetchSite: "none" }],
    ["a client that sends no Fetch Metadata", { fetchSite: undefined }],
  ])("is kept: %s", (_, source) => {
    expect(siblingSiteRefused(network, from(source))).toBe(false);
  });
});
