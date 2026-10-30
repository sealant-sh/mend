import { describe, expect, it } from "vitest";

import {
  fragmentFormOf,
  fragmentSecret,
  type HandedLinkKind,
  handedLinkPath,
  isHandedLinkPage,
  legacyPathSecret,
} from "./handed-links.ts";

const KINDS: ReadonlyArray<readonly [HandedLinkKind, string, string]> = [
  ["invitation", "/join", "Kq3v_9zX-2mB0aLwYtE7rN4cHdUjF8sPiQ1oGxVbZeA"],
  ["passwordReset", "/reset", "reset-carol"],
  ["slackLink", "/slack/link", "msl_Kq3v_9zX-2mB0aLwYtE7rN4cHdUjF8sPiQ1oGxVbZeA"],
];

const at = (path: string) => {
  const url = new URL(path, "https://mend.example");
  return { pathname: url.pathname, hash: url.hash };
};

describe("a link Mend hands to a person", () => {
  it("keeps its secret out of every part of the URL a browser sends", () => {
    for (const [kind, page, secret] of KINDS) {
      const url = new URL(handedLinkPath(kind, secret), "https://mend.example");
      expect(url.pathname, kind).toBe(page);
      expect(url.search, kind).toBe("");
      expect(url.hash, kind).toBe(`#${secret}`);
    }
  });

  it("reads back the secret it was built with", () => {
    for (const [kind, , secret] of KINDS) {
      expect(fragmentSecret(at(handedLinkPath(kind, secret)).hash), kind).toBe(secret);
    }
  });

  it("reads a link issued before the fragment, and names its fragment form", () => {
    for (const [kind, page, secret] of KINDS) {
      const legacy = at(`${page}/${secret}`);
      expect(legacyPathSecret(kind, legacy.pathname), kind).toBe(secret);
      expect(fragmentFormOf(kind, legacy), kind).toBe(`${page}#${secret}`);
    }
  });

  it("decodes the secret once", () => {
    expect(fragmentSecret("#reset%5Fcarol")).toBe("reset_carol");
    expect(legacyPathSecret("invitation", "/join/reset%5Fcarol")).toBe("reset_carol");
    expect(fragmentSecret("#reset%255Fcarol")).toBeNull();
    expect(legacyPathSecret("invitation", "/join/reset%255Fcarol")).toBeNull();
  });

  it("builds and reads only a secret of eight to 256 URL-safe base64 characters", () => {
    for (const secret of ["a".repeat(8), "a".repeat(256), "Az09_-Az09_-"]) {
      expect(fragmentSecret(handedLinkPath("invitation", secret).slice("/join".length))).toBe(
        secret,
      );
    }
    for (const secret of [
      "a".repeat(7),
      "a".repeat(257),
      "two#parts",
      "slash/ed",
      "spa ced!",
      "tok%41en",
    ]) {
      expect(() => handedLinkPath("invitation", secret), secret).toThrow();
    }
    for (const hash of [
      "#aaaaaaa",
      `#${"a".repeat(257)}`,
      "#aaaaaaaa#b",
      "#aaaa/aaaa",
      "#aaaa%2Faaaa",
      "#aaaa.aaaa",
    ]) {
      expect(fragmentSecret(hash), hash).toBeNull();
    }
    expect(legacyPathSecret("invitation", "/join/aaaaaaa")).toBeNull();
    expect(legacyPathSecret("invitation", "/join/aaaa%23aaaa")).toBeNull();
  });

  it("finds no secret in a missing, malformed or oversized fragment", () => {
    for (const hash of ["", "#", "#%E0%A4%A", "#tok%20en", "#tok%0A", `#${"a".repeat(513)}`]) {
      expect(fragmentSecret(hash), hash).toBeNull();
    }
  });

  it("moves an old link with no secret in its path, or with a fragment too, to the bare page", () => {
    for (const location of [
      { pathname: "/join", hash: "" },
      { pathname: "/join/", hash: "" },
      { pathname: "/join/tok/more", hash: "" },
      { pathname: "/join/%E0%A4%A", hash: "" },
      { pathname: "/join/tok", hash: "#other" },
      { pathname: "/reset/tok", hash: "" },
    ]) {
      expect(fragmentFormOf("invitation", location), JSON.stringify(location)).toBe("/join");
    }
  });

  it("names every page that reads one, in either form and however the router spells it", () => {
    for (const target of [
      "/join",
      "/join/",
      "/join/tok",
      "/reset#tok",
      "/reset/tok?x=1",
      "/slack/link",
      "/slack/link/msl_abc",
      "/JOIN/tok",
      "//reset/tok",
      "https://mend.example/slack//link/msl_abc",
    ]) {
      expect(isHandedLinkPage(target), target).toBe(true);
    }
    for (const target of ["/", "/joined", "/settings", "/slack", "/api/auth/reset-password"]) {
      expect(isHandedLinkPage(target), target).toBe(false);
    }
  });
});
