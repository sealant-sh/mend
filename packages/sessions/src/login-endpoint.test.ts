import { EndpointUrl } from "@mend/domain/endpoint-url";
import type { PlacedLogin } from "@mend/sealant";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CLAUDE_AGENT_HOOKS } from "./claude-settings.ts";
import { codexLoginOverridesOf, withCodexLogin } from "./codex-login.ts";
import { CLAUDE_NEUTRAL_ENV, conversationArgv } from "./conversation-home.ts";

const endpoint = (url: string) => Schema.decodeSync(EndpointUrl)(url);
const KEY_PATH = "/run/mend/conv/s-1/.sealant/keys/plc_key";
const CLAUDE_ON_ENDPOINT: PlacedLogin = {
  kind: "api-key",
  suffix: "a1b2",
  keyPath: KEY_PATH,
  baseUrl: endpoint("https://gateway.example.com/anthropic"),
};
const CODEX_ON_ENDPOINT: PlacedLogin = {
  kind: "api-key",
  suffix: "c3d4",
  baseUrl: endpoint("http://10.0.0.5:4000/v1"),
};

/** ADR 0018 decision 11: what a Claude key with an endpoint adds to its settings' `env`. */
const ENDPOINT_ENV = {
  ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_MAX_RETRIES: "3",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
};

const settingsOf = (argv: ReadonlyArray<string>): unknown =>
  JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "null");

describe("Claude on a key with an endpoint, in a conversation home", () => {
  it.each([false, true])(
    "sends its requests to the endpoint, with the key read by the helper (terminal: %s)",
    (terminal) => {
      const argv = conversationArgv({
        harness: "claude",
        argv: terminal ? ["claude"] : ["claude", "--print"],
        resumePath: null,
        terminal,
        login: CLAUDE_ON_ENDPOINT,
      });
      expect(settingsOf(argv)).toEqual({
        autoMemoryEnabled: false,
        env: { ...CLAUDE_NEUTRAL_ENV, ...ENDPOINT_ENV },
        apiKeyHelper: `cat '${KEY_PATH}'`,
        ...(terminal ? { hooks: CLAUDE_AGENT_HOOKS } : {}),
      });
    },
  );

  it("adds no endpoint to a key without one", () => {
    const argv = conversationArgv({
      harness: "claude",
      argv: ["claude", "--print"],
      resumePath: null,
      terminal: false,
      login: { kind: "api-key", suffix: "a1b2", keyPath: KEY_PATH },
    });
    expect(JSON.stringify(settingsOf(argv))).not.toContain("ANTHROPIC_BASE_URL");
  });
});

/** The `-c` pairs Codex 0.160.1 needs to send an auth.json key to a custom endpoint. */
const codexOverrides = (baseUrl: string) => [
  "-c",
  'model_provider="mend-endpoint"',
  "-c",
  'model_providers.mend-endpoint.name="Custom endpoint"',
  "-c",
  `model_providers.mend-endpoint.base_url="${baseUrl}"`,
  "-c",
  'model_providers.mend-endpoint.wire_api="responses"',
  "-c",
  "model_providers.mend-endpoint.requires_openai_auth=true",
  "-c",
  "features.unbounded_connection_retries=false",
  "-c",
  "analytics.enabled=false",
];

describe("Codex on a key with an endpoint", () => {
  it("selects a provider of Mend's own on the command line, ahead of app-server and the person's flags", () => {
    expect(withCodexLogin(["codex", "app-server"], CODEX_ON_ENDPOINT)).toEqual([
      "codex",
      ...codexOverrides("http://10.0.0.5:4000/v1"),
      "app-server",
    ]);
    expect(withCodexLogin(["codex", "--model", "gpt-x", "fix it"], CODEX_ON_ENDPOINT)).toEqual([
      "codex",
      ...codexOverrides("http://10.0.0.5:4000/v1"),
      "--model",
      "gpt-x",
      "fix it",
    ]);
  });

  it("never sends any other login to an endpoint", () => {
    for (const login of [
      { kind: "subscription" },
      { kind: "api-key", suffix: "c3d4" },
      undefined,
    ] as const) {
      expect(codexLoginOverridesOf(login)).toEqual([]);
      expect(withCodexLogin(["codex", "app-server"], login)).toEqual(["codex", "app-server"]);
    }
    expect(withCodexLogin(["claude"], CODEX_ON_ENDPOINT)).toEqual(["claude"]);
  });

  it("adds the overrides beside a conversation home's own switches", () => {
    const argv = conversationArgv({
      harness: "codex",
      argv: ["codex", "app-server"],
      resumePath: null,
      terminal: false,
      login: CODEX_ON_ENDPOINT,
    });
    expect(argv.slice(0, 1)).toEqual(["codex"]);
    expect(argv.at(-1)).toBe("app-server");
    expect(argv.join(" ")).toContain(codexOverrides("http://10.0.0.5:4000/v1").join(" "));
    expect(argv).toContain("features.memories=false");
  });

  it("quotes the URL as a TOML string, path and port included", () => {
    const [, , , , , baseUrl] = codexLoginOverridesOf({
      kind: "api-key",
      suffix: "c3d4",
      baseUrl: endpoint('https://gw.example.com:8443/team a/"v1"/'),
    });
    expect(baseUrl).toBe(
      'model_providers.mend-endpoint.base_url="https://gw.example.com:8443/team%20a/%22v1%22"',
    );
  });
});
