import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalServerUrl,
  keptCredential,
  secretWriteOf,
  tokenFor,
  type CredentialChange,
} from "./credentials.js";

const MINI = "http://mend-mini.local:3105";
const EDGE = "https://mend.example.com";
const cli = { url: MINI, token: "mdt_cli" };

const secretsAfter = (
  changes: ReadonlyArray<CredentialChange>,
  legacy?: unknown,
): {
  readonly read: (key: string) => Promise<string | undefined>;
  readonly values: ReadonlyMap<string, string>;
} => {
  const values = new Map<string, string>();
  if (legacy !== undefined) values.set("mend.serverToken", JSON.stringify(legacy));
  for (const change of changes) {
    const { key, value } = secretWriteOf(change, randomUUID());
    values.set(key, value);
  }
  return { read: async (key) => values.get(key), values };
};

const signedIn = (url: string, token: string): CredentialChange => ({
  kind: "signedIn",
  url,
  token,
  deviceId: `device-${token}`,
});

describe("which token the editor sends", () => {
  it("uses its own sign-in for its URL, and the CLI's only where it has none", async () => {
    const { read } = secretsAfter([signedIn(MINI, "mdt_editor")]);
    expect(tokenFor(MINI, await keptCredential(read, MINI, cli), cli)).toBe("mdt_editor");
    expect(tokenFor(MINI, null, cli)).toBe("mdt_cli");
    // Another server's entry says nothing about this one.
    expect(tokenFor(EDGE, await keptCredential(read, EDGE, cli), cli)).toBeNull();
  });

  it("after a sign-out does not fall back to the CLI's sign-in; after Use it, does", async () => {
    const out = secretsAfter([signedIn(MINI, "mdt_editor"), { kind: "signedOut", url: MINI }]);
    expect(await keptCredential(out.read, MINI, cli)).toEqual({ kind: "none", url: MINI });
    expect(tokenFor(MINI, await keptCredential(out.read, MINI, cli), cli)).toBeNull();
    const used = secretsAfter([
      { kind: "signedOut", url: MINI },
      { kind: "useCli", url: MINI },
    ]);
    expect(tokenFor(MINI, await keptCredential(used.read, MINI, cli), cli)).toBe("mdt_cli");
  });

  it("writes each server under its own key, so a change at one never rewrites another", () => {
    const keys = (
      [
        signedIn(MINI, "mdt_mini"),
        { kind: "signedOut", url: EDGE },
        { kind: "useCli", url: "http://other.example" },
      ] satisfies ReadonlyArray<CredentialChange>
    ).map((change) => secretWriteOf(change, randomUUID()).key);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("a sign-in kept before 0.37, in the one blob", () => {
  it("reads every server's entry, and the single entry an older editor still kept", async () => {
    const both = secretsAfter([], {
      entries: [
        { url: EDGE, token: "mdt_edge", deviceId: "e" },
        { url: MINI, token: null },
      ],
    });
    expect(await keptCredential(both.read, EDGE, cli)).toEqual({
      kind: "token",
      url: EDGE,
      token: "mdt_edge",
      deviceId: "e",
    });
    expect(await keptCredential(both.read, MINI, cli)).toEqual({ kind: "none", url: MINI });
    const single = secretsAfter([], { url: MINI, token: "mdt_old" });
    expect(await keptCredential(single.read, MINI, null)).toEqual({
      kind: "token",
      url: MINI,
      token: "mdt_old",
      deviceId: null,
    });
  });

  it("gives way to the server's own key once anything is written there", async () => {
    const { read } = secretsAfter([{ kind: "signedOut", url: MINI }], {
      entries: [{ url: MINI, token: "mdt_old", deviceId: "d" }],
    });
    expect(await keptCredential(read, MINI, cli)).toEqual({ kind: "none", url: MINI });
  });

  it("collapses entries saved under different spellings, a sign-out winning", async () => {
    const CANONICAL = "http://review.example";
    const { read } = secretsAfter([], {
      entries: [
        { url: "http://review.example", token: "mdt_stale", deviceId: "device-stale" },
        { url: "HTTP://REVIEW.EXAMPLE:80/", token: null },
        { url: "http://review.example/", token: "mdt_later", deviceId: null },
      ],
    });
    expect(await keptCredential(read, CANONICAL, null)).toEqual({ kind: "none", url: CANONICAL });
  });
});

describe("one server, however its URL is spelled", () => {
  const CANONICAL = "http://review.example";

  it("finds, replaces and signs out the same entry by case, a default port or a trailing slash", async () => {
    for (const alias of [
      "HTTP://REVIEW.EXAMPLE",
      "http://review.example:80",
      "http://review.example/",
    ]) {
      expect(canonicalServerUrl(alias)).toBe(CANONICAL);
      const kept = secretsAfter([signedIn(CANONICAL, "mdt_editor")]);
      expect(await keptCredential(kept.read, alias, null)).toMatchObject({
        url: CANONICAL,
        token: "mdt_editor",
      });
      const out = secretsAfter([
        signedIn(CANONICAL, "mdt_editor"),
        { kind: "signedOut", url: alias },
      ]);
      expect(out.values.size).toBe(1);
      expect(await keptCredential(out.read, CANONICAL, null)).toEqual({
        kind: "none",
        url: CANONICAL,
      });
    }
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
});

describe("a token Mend refused", () => {
  it("reads as no token, so the CLI's sign-in does not quietly take over", async () => {
    const { read } = secretsAfter([
      signedIn(MINI, "mdt_editor"),
      { kind: "refused", url: MINI, token: "mdt_editor" },
    ]);
    expect(await keptCredential(read, MINI, cli)).toEqual({ kind: "none", url: MINI });
  });

  it("stops sending the CLI's refused token, and sends the next one the CLI holds", async () => {
    const { read, values } = secretsAfter([{ kind: "refused", url: MINI, token: "mdt_cli" }]);
    const entry = await keptCredential(read, MINI, cli);
    expect(entry?.kind).toBe("cliRefused");
    expect(JSON.stringify([...values])).not.toContain("mdt_cli");
    expect(tokenFor(MINI, entry, cli)).toBeNull();
    const next = { url: MINI, token: "mdt_cli_again" };
    expect(tokenFor(MINI, await keptCredential(read, MINI, next), next)).toBe("mdt_cli_again");
  });

  it("leaves a newer sign-in, and another server, alone, in whatever order the writes land", async () => {
    const refusal: CredentialChange = { kind: "refused", url: MINI, token: "mdt_before" };
    for (const changes of [
      [signedIn(MINI, "mdt_before"), signedIn(MINI, "mdt_editor"), refusal],
      [signedIn(MINI, "mdt_before"), refusal, signedIn(MINI, "mdt_editor")],
    ]) {
      const { read } = secretsAfter([...changes, signedIn(EDGE, "mdt_before")]);
      expect(await keptCredential(read, MINI, cli)).toMatchObject({ token: "mdt_editor" });
      expect(await keptCredential(read, EDGE, cli)).toMatchObject({ token: "mdt_before" });
    }
  });
});
