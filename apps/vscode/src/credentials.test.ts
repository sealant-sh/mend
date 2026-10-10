import { describe, expect, it } from "vitest";

import { parseStoredCredential, serializeStoredCredential, tokenFor } from "./credentials.js";

const URL_MINI = "http://mend-mini.local:3105";
const cli = { url: URL_MINI, token: "mdt_cli" };

describe("which token the editor sends", () => {
  it("uses its own sign-in for its URL, and the CLI's only where it has none", () => {
    const own = parseStoredCredential(
      serializeStoredCredential({
        kind: "token",
        url: URL_MINI,
        token: "mdt_editor",
        deviceId: "d",
      }),
    );
    expect(tokenFor(URL_MINI, own, cli)).toBe("mdt_editor");
    expect(tokenFor(URL_MINI, null, cli)).toBe("mdt_cli");
    // Another server's entry says nothing about this one.
    expect(tokenFor("https://other.example", own, cli)).toBeNull();
  });

  it("after a sign-out, or a connect with no token, does not fall back to the CLI's sign-in", () => {
    const signedOut = parseStoredCredential(
      serializeStoredCredential({ kind: "none", url: URL_MINI }),
    );
    expect(signedOut).toEqual({ kind: "none", url: URL_MINI });
    expect(tokenFor(URL_MINI, signedOut, cli)).toBeNull();
  });

  it("reads entries written before the signed-out state existed as tokens", () => {
    expect(parseStoredCredential(JSON.stringify({ url: URL_MINI, token: "mdt_old" }))).toEqual({
      kind: "token",
      url: URL_MINI,
      token: "mdt_old",
      deviceId: null,
    });
    expect(parseStoredCredential("not json")).toBeNull();
    expect(parseStoredCredential(JSON.stringify({ token: "no url" }))).toBeNull();
  });
});
