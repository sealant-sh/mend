import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ConnectAccountInput, ConnectedAccount } from "./accounts.ts";

const wire = <S extends Schema.Top>(schema: S) => Schema.toCodecJson(schema);

const account = {
  id: "cacc_1",
  provider: "claude",
  name: "api-key",
  kind: "api-key",
  status: "active",
  metadata: {},
  connectedAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
  lastUsedAt: null,
  isDefault: false,
};

const decodeAccount = Schema.decodeUnknownSync(wire(ConnectedAccount));
const decodeConnect = Schema.decodeUnknownSync(wire(ConnectAccountInput));

describe("a connected account's login class", () => {
  it("decodes a key with its last four characters and encodes it back the same", () => {
    const decoded = decodeAccount({ ...account, login: { kind: "api-key", suffix: "a1b2" } });
    expect(decoded.login).toEqual({ kind: "api-key", suffix: "a1b2" });
    expect(Schema.encodeSync(wire(ConnectedAccount))(decoded)).toMatchObject({
      login: { kind: "api-key", suffix: "a1b2" },
    });
  });

  it("leaves it absent when the platform sends none, as an older one does", () => {
    expect(decodeAccount(account).login).toBeUndefined();
  });

  it("refuses a class Mend does not know", () => {
    expect(() => decodeAccount({ ...account, login: { kind: "oauth" } })).toThrow();
  });
});

describe("connecting a login", () => {
  it("carries the class and the default choice to the platform", () => {
    const input = decodeConnect({
      provider: "codex",
      secret: "sk-proj-fake",
      login: "api-key",
      makeDefault: true,
    });
    expect(input).toMatchObject({ login: "api-key", makeDefault: true });
  });

  it("refuses a key with whitespace in it before anything is sent", () => {
    expect(() =>
      decodeConnect({ provider: "claude", secret: "sk-ant-api03-fake\nmore", login: "api-key" }),
    ).toThrow("An API key has no spaces or line breaks.");
  });

  it("takes a subscription's credentials file, whitespace and all", () => {
    const secret = '{\n  "claudeAiOauth": {}\n}';
    expect(decodeConnect({ provider: "claude", secret, login: "subscription" }).secret).toBe(
      secret,
    );
  });

  it("refuses an API key for GitHub", () => {
    expect(() =>
      decodeConnect({ provider: "github", secret: "gho_fake", login: "api-key" }),
    ).toThrow("GitHub takes a token, not an API key.");
  });

  it("refuses an empty secret", () => {
    expect(() => decodeConnect({ provider: "claude", secret: "", login: "api-key" })).toThrow();
  });
});

describe("connecting a key to an endpoint", () => {
  it("carries the endpoint the platform would store, without its trailing slash", () => {
    const input = decodeConnect({
      provider: "claude",
      secret: "placeholder",
      login: "api-key",
      endpoint: "http://gateway.internal:8080/anthropic/",
    });
    expect(input.endpoint).toBe("http://gateway.internal:8080/anthropic");
  });

  it("refuses an endpoint that is not an absolute http or https URL, in the platform's words", () => {
    expect(() =>
      decodeConnect({
        provider: "codex",
        secret: "sk-proj-fake",
        login: "api-key",
        endpoint: "gateway.example.com/v1",
      }),
    ).toThrow("must be an absolute http: or https: URL");
    expect(() =>
      decodeConnect({
        provider: "codex",
        secret: "sk-proj-fake",
        login: "api-key",
        endpoint: "https://gateway.example.com/v1?team=a",
      }),
    ).toThrow("must not have a query string");
  });

  it("refuses an endpoint beside a subscription or a connect that names no class", () => {
    for (const login of ["subscription", undefined] as const) {
      expect(() =>
        decodeConnect({
          provider: "claude",
          secret: "sk-ant-oat01-fake",
          ...(login === undefined ? {} : { login }),
          endpoint: "https://gateway.example.com",
        }),
      ).toThrow("Only an API key sends its requests to an endpoint.");
    }
  });
});
