import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";
import { providerAuthorizeUrl } from "./provider-login.ts";

const { json, spawning, startCli, startFakeMend } = mainTestFixtures();

describe("provider authorization in a shell", spawning, () => {
  it.each(["claude", "codex"] as const)(
    "%s emits only authorization and a safe connected receipt",
    async (provider) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-provider-json-"));
      const bin = path.join(home, "provider");
      const url =
        provider === "claude"
          ? "https://claude.ai/oauth/authorize?code_challenge=public"
          : "https://auth.openai.com/codex/device";
      fs.writeFileSync(
        bin,
        `#!/bin/sh
test -z "$ANTHROPIC_AUTH_TOKEN" || exit 9
test -z "$OPENAI_API_KEY" || exit 9
printf '%s\\n' 'private-output-sentinel' '${url}' 'ABCD-EFGHJ'
${provider === "claude" ? `printf '%s' '{"claudeAiOauth":{"refreshToken":"private-refresh-sentinel"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"` : `printf '%s' '{"tokens":{"refresh_token":"private-refresh-sentinel"}}' > "$CODEX_HOME/auth.json"`}
`,
        { mode: 0o755 },
      );
      let uploaded = "";
      const fake = await startFakeMend((request, response) => {
        request.on("data", (chunk: Buffer) => {
          uploaded += chunk.toString();
        });
        request.on("end", () =>
          json(response, {
            id: "account",
            provider,
            name: "Mira",
            status: "active",
            metadata: { token: "private-output-sentinel" },
          }),
        );
      });
      try {
        const config = path.join(home, "config");
        const cli = startCli(fake.url, ["connect", provider, "--json"], {
          XDG_CONFIG_HOME: config,
          [provider === "claude" ? "MEND_CLAUDE_BIN" : "MEND_CODEX_BIN"]: bin,
          ANTHROPIC_AUTH_TOKEN: "private-ambient",
          OPENAI_API_KEY: "private-ambient",
        });
        expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
        const events = cli
          .stdout()
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events[0]).toMatchObject({ v: 1, event: "authorize", provider, url });
        if (provider === "codex") expect(events.at(-2)?.code).toBe("ABCD-EFGHJ");
        expect(events.at(-1)).toMatchObject({
          v: 1,
          status: "done",
          data: { provider, account: { id: "account", name: "Mira", status: "active" } },
        });
        expect(uploaded).toContain("private-refresh-sentinel");
        expect(cli.stdout() + cli.stderr()).not.toContain("private-");
        expect(
          fs
            .readdirSync(path.join(config, "mend"))
            .filter((name) => name.startsWith(`${provider}-login-`)),
        ).toEqual([]);
      } finally {
        await fake.close();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("stops and reaps a provider on timeout, then removes its temporary login", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-provider-timeout-"));
    const bin = path.join(home, "provider");
    fs.writeFileSync(
      bin,
      '#!/bin/sh\nprintf "%s\\n" "https://auth.openai.com/codex/device"\nsleep 60\n',
      { mode: 0o755 },
    );
    try {
      const cli = startCli(
        "http://127.0.0.1:9",
        ["connect", "codex", "--json", "--timeout", ".05s"],
        { XDG_CONFIG_HOME: home, MEND_CODEX_BIN: bin },
      );
      expect(await cli.exited).toEqual({ kind: "exit", code: 124 });
      const last = JSON.parse(cli.stdout().trim().split("\n").at(-1) ?? "{}");
      expect(last).toMatchObject({ v: 1, status: "timeout", error: { code: "timeout" } });
      expect(
        fs.readdirSync(path.join(home, "mend")).filter((name) => name.startsWith("codex-login-")),
      ).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("suppresses token endpoints, lookalike hosts and credential-bearing URLs", () => {
    for (const text of [
      "https://claude.ai.evil.invalid/oauth/authorize",
      "https://user:private@claude.ai/oauth/authorize",
      "https://claude.ai/oauth/token?token=private",
    ])
      expect(providerAuthorizeUrl("claude", text)).toBeNull();
  });
});
