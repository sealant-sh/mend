import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLAUDE_AGENT_HOOKS } from "./claude-settings.ts";
import { CLAUDE_NEUTRAL_ENV, conversationArgv } from "./conversation-home.ts";
import { PersonalMcp } from "./mend-mcp/personal.ts";

const SESSION = "s-shared-1";
const FAKE_KEY = "sk-ant-api03-FAKE-not-a-real-key-0000000000a1b2";
const KEY_PATH = `/run/mend/conv/${SESSION}/.sealant/keys/plc_key`;
const KEY_LOGIN = { kind: "api-key", suffix: "a1b2", keyPath: KEY_PATH } as const;

const temps: Array<string> = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const settingsOf = (argv: ReadonlyArray<string>): unknown =>
  JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "null");

const claudeIn = (terminal: boolean, login: Parameters<typeof conversationArgv>[0]["login"]) =>
  conversationArgv({
    harness: "claude",
    argv: terminal
      ? ["claude", "--session-id", "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11"]
      : ["claude", "--print", "--session-id", "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11"],
    resumePath: null,
    terminal,
    login,
    mcp: PersonalMcp.none("no person"),
  });

describe("Claude on a placed API key in a conversation home (docs/adr/0018, decision 1)", () => {
  it.each([false, true])(
    "reads the sender's key through apiKeyHelper (terminal: %s)",
    (terminal) => {
      const argv = claudeIn(terminal, KEY_LOGIN);
      expect(settingsOf(argv)).toEqual({
        autoMemoryEnabled: false,
        env: CLAUDE_NEUTRAL_ENV,
        apiKeyHelper: `cat '${KEY_PATH}'`,
        ...(terminal ? { hooks: CLAUDE_AGENT_HOOKS } : {}),
      });
      expect(argv.join(" ")).not.toContain(FAKE_KEY);
    },
  );

  it.each([false, true])(
    "keeps a subscription's settings as they were (terminal: %s)",
    (terminal) => {
      const expected = {
        autoMemoryEnabled: false,
        env: CLAUDE_NEUTRAL_ENV,
        ...(terminal ? { hooks: CLAUDE_AGENT_HOOKS } : {}),
      };
      expect(settingsOf(claudeIn(terminal, { kind: "subscription" }))).toEqual(expected);
      expect(settingsOf(claudeIn(terminal, undefined))).toEqual(expected);
    },
  );

  it("names no helper for a key whose file Core did not report", () => {
    const settings = settingsOf(claudeIn(false, { kind: "api-key", suffix: "a1b2" }));
    expect(settings).toEqual({ autoMemoryEnabled: false, env: CLAUDE_NEUTRAL_ENV });
  });

  it("runs as a shell command that prints the key file, whatever its path holds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-key-helper."));
    temps.push(dir);
    const keyPath = path.join(dir, "it's a key $(echo no)");
    fs.writeFileSync(keyPath, FAKE_KEY, { mode: 0o600 });
    const settings = settingsOf(claudeIn(false, { kind: "api-key", suffix: "a1b2", keyPath }));
    const helper =
      typeof settings === "object" && settings !== null && "apiKeyHelper" in settings
        ? String(settings.apiKeyHelper)
        : "";
    const ran = spawnSync("sh", ["-c", helper], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe(FAKE_KEY);
  });
});
