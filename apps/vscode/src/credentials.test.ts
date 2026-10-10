import { describe, expect, it } from "vitest";

import {
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
