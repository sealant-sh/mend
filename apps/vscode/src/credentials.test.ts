import { describe, expect, it } from "vitest";

import {
  canonicalServerUrl,
  credentialFor,
  parseCredentialStore,
  serializeCredentialStore,
  signOutOf,
  tokenFor,
  withCredential,
} from "./credentials.js";

const MINI = "http://mend-mini.local:3105";
const EDGE = "https://mend.example.com";
const cli = { url: MINI, token: "mdt_cli" };

const roundTrip = (store: Parameters<typeof serializeCredentialStore>[0]) =>
  parseCredentialStore(serializeCredentialStore(store));

describe("which token the editor sends", () => {
  it("uses its own sign-in for its URL, and the CLI's only where it has none", () => {
    const store = roundTrip(
      withCredential(new Map(), { kind: "token", url: MINI, token: "mdt_editor", deviceId: "d" }),
    );
    expect(tokenFor(MINI, store.get(MINI) ?? null, cli)).toBe("mdt_editor");
    expect(tokenFor(MINI, null, cli)).toBe("mdt_cli");
    // Another server's entry says nothing about this one.
    expect(tokenFor(EDGE, store.get(EDGE) ?? null, cli)).toBeNull();
  });

  it("after a sign-out, or a connect with no token, does not fall back to the CLI's sign-in", () => {
    const store = roundTrip(withCredential(new Map(), { kind: "none", url: MINI }));
    expect(store.get(MINI)).toEqual({ kind: "none", url: MINI });
    expect(tokenFor(MINI, store.get(MINI) ?? null, cli)).toBeNull();
  });

  it("keeps one entry per server, and reads the single entry an older editor kept", () => {
    const both = roundTrip(
      withCredential(
        withCredential(new Map(), { kind: "token", url: EDGE, token: "mdt_edge", deviceId: "e" }),
        { kind: "token", url: MINI, token: "mdt_mini", deviceId: null },
      ),
    );
    expect([...both.keys()].toSorted()).toEqual([EDGE, MINI].toSorted());
    expect(parseCredentialStore(JSON.stringify({ url: MINI, token: "mdt_old" })).get(MINI)).toEqual(
      {
        kind: "token",
        url: MINI,
        token: "mdt_old",
        deviceId: null,
      },
    );
    expect(parseCredentialStore("not json").size).toBe(0);
  });
});

describe("signing out", () => {
  it("acts on the server the editor is connected to, and leaves another server's sign-in alone", () => {
    // Signed in to the edge through the browser, then pointed at the mini, where the CLI signed in.
    const store = withCredential(new Map(), {
      kind: "token",
      url: EDGE,
      token: "mdt_edge",
      deviceId: "device-edge",
    });
    const { own, next } = signOutOf(MINI, store);
    // Nothing of the editor's own to revoke at the mini; the edge's device is not touched.
    expect(own).toBeNull();
    expect(next.get(EDGE)).toEqual(store.get(EDGE));
    // The mini is signed out in this editor: the CLI's token is no longer sent there.
    expect(tokenFor(MINI, next.get(MINI) ?? null, cli)).toBeNull();
  });

  it("revokes the editor's own device for the current server", () => {
    const store = withCredential(new Map(), {
      kind: "token",
      url: MINI,
      token: "mdt_mini",
      deviceId: "device-mini",
    });
    const { own, next } = signOutOf(MINI, store);
    expect(own?.deviceId).toBe("device-mini");
    expect(next.get(MINI)).toEqual({ kind: "none", url: MINI });
  });
});

describe("one server, however its URL is spelled", () => {
  const CANONICAL = "http://review.example";
  const token: { readonly kind: "token"; readonly token: string; readonly deviceId: string } = {
    kind: "token",
    token: "mdt_editor",
    deviceId: "device-review",
  };

  it("finds, replaces and signs out the same entry by case, a default port or a trailing slash", () => {
    const store = withCredential(new Map(), { ...token, url: CANONICAL });
    for (const alias of [
      "HTTP://REVIEW.EXAMPLE",
      "http://review.example:80",
      "http://review.example/",
    ]) {
      expect(canonicalServerUrl(alias)).toBe(CANONICAL);
      expect(credentialFor(store, alias)).toEqual({ ...token, url: CANONICAL });
      expect(tokenFor(alias, credentialFor(store, alias), null)).toBe("mdt_editor");
      // Signing out under the alias revokes the one device and leaves one signed-out entry.
      const { own, next } = signOutOf(alias, store);
      expect(own?.deviceId).toBe("device-review");
      expect([...next.entries()]).toEqual([[CANONICAL, { kind: "none", url: CANONICAL }]]);
    }
    const https = withCredential(new Map(), { ...token, url: "https://Review.Example:443/" });
    expect([...https.keys()]).toEqual(["https://review.example"]);
    expect(signOutOf("https://review.example", https).own?.deviceId).toBe("device-review");
    // The path is not a spelling: instances under different paths stay apart, case kept.
    expect(canonicalServerUrl("https://review.example/Team-A/")).toBe(
      "https://review.example/Team-A",
    );
  });

  it("compares the CLI's sign-in in the same form", () => {
    expect(
      tokenFor("http://review.example:80/", null, {
        url: "HTTP://Review.Example",
        token: "mdt_cli",
      }),
    ).toBe("mdt_cli");
  });

  it("collapses entries an older editor saved under different spellings, a sign-out winning", () => {
    const saved = JSON.stringify({
      entries: [
        { url: "http://review.example", token: "mdt_stale", deviceId: "device-stale" },
        { url: "HTTP://REVIEW.EXAMPLE:80/", token: null },
        { url: "http://review.example/", token: "mdt_later", deviceId: null },
      ],
    });
    const store = parseCredentialStore(saved);
    expect([...store.entries()]).toEqual([[CANONICAL, { kind: "none", url: CANONICAL }]]);
    // Among tokens alone, the last saved.
    const tokens = parseCredentialStore(
      JSON.stringify({
        entries: [
          { url: "http://review.example", token: "mdt_first", deviceId: null },
          { url: "http://REVIEW.example:80", token: "mdt_last", deviceId: "d" },
        ],
      }),
    );
    expect(credentialFor(tokens, CANONICAL)).toEqual({
      kind: "token",
      url: CANONICAL,
      token: "mdt_last",
      deviceId: "d",
    });
    // Saved again, the store holds canonical keys only.
    expect(serializeCredentialStore(tokens)).toBe(
      JSON.stringify({ entries: [{ url: CANONICAL, token: "mdt_last", deviceId: "d" }] }),
    );
  });
});
