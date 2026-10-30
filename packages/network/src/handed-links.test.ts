import { describe, expect, it } from "vitest";

import {
  type HandedLinkKind,
  handedLinkPath,
  isHandedLinkPage,
  readHandedLink,
  canonicalHandedLinkPath,
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
      expect(readHandedLink(kind, at(handedLinkPath(kind, secret)))).toEqual({
        _tag: "Fragment",
        secret,
      });
    }
  });

  it("reads a link issued before the fragment, and names its fragment form", () => {
    for (const [kind, page, secret] of KINDS) {
      const legacy = at(`${page}/${secret}`);
      expect(readHandedLink(kind, legacy)).toEqual({ _tag: "Path", secret });
      expect(canonicalHandedLinkPath(kind, legacy)).toBe(`${page}#${secret}`);
    }
  });

  it("decodes the secret once", () => {
    expect(readHandedLink("invitation", { pathname: "/join", hash: "#tok%2541" })).toEqual({
      _tag: "Fragment",
      secret: "tok%41",
    });
    expect(readHandedLink("invitation", { pathname: "/join/tok%2541", hash: "" })).toEqual({
      _tag: "Path",
      secret: "tok%41",
    });
  });

  it("finds no secret in a missing, malformed, oversized or ambiguous link", () => {
    for (const location of [
      { pathname: "/join", hash: "" },
      { pathname: "/join", hash: "#" },
      { pathname: "/join", hash: "#%E0%A4%A" },
      { pathname: "/join", hash: "#tok%20en" },
      { pathname: "/join", hash: "#tok%0A" },
      { pathname: "/join", hash: `#${"a".repeat(513)}` },
      { pathname: "/join/", hash: "" },
      { pathname: "/join/tok/more", hash: "" },
      { pathname: "/join/tok", hash: "#other" },
      { pathname: "/reset", hash: "#tok" },
    ]) {
      expect(readHandedLink("invitation", location), JSON.stringify(location)).toEqual({
        _tag: "Incomplete",
      });
    }
    expect(canonicalHandedLinkPath("invitation", { pathname: "/join/tok/more", hash: "" })).toBe(
      "/join",
    );
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
