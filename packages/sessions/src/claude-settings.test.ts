import { AGENT_HOOKS } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { CLAUDE_AGENT_HOOKS, withClaudeSessionId } from "./claude-settings.ts";

describe("Claude's hooks for a terminal agent", () => {
  it("wires every Claude event of AGENT_HOOKS to mend hook claude, with its matcher", () => {
    expect(CLAUDE_AGENT_HOOKS).toEqual(
      Object.fromEntries(
        AGENT_HOOKS.claude.map((hook) => [
          hook.event,
          [
            {
              ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
              hooks: [{ type: "command", command: "mend hook claude", timeout: 5 }],
            },
          ],
        ]),
      ),
    );
  });

  it("matches the notifications Mend reads, as Claude's notification types", () => {
    expect(CLAUDE_AGENT_HOOKS["Notification"]).toEqual([
      {
        matcher: "permission_prompt|elicitation_dialog|idle_prompt",
        hooks: [{ type: "command", command: "mend hook claude", timeout: 5 }],
      },
    ]);
    expect(CLAUDE_AGENT_HOOKS["SessionStart"]).toEqual([
      { hooks: [{ type: "command", command: "mend hook claude", timeout: 5 }] },
    ]);
    expect(Object.keys(CLAUDE_AGENT_HOOKS)).toEqual([
      "SessionStart",
      "PermissionRequest",
      "Notification",
      "Stop",
      "UserPromptSubmit",
      "PostToolUse",
    ]);
  });
});

describe("a terminal Claude's session id", () => {
  const FRESH = "0f8d5f2c-6c3e-4f63-9a51-2f0c7d4b9e11";

  it("pins a fresh Claude to the id Mend chose", () => {
    expect(withClaudeSessionId(["claude", "--model", "opus"], FRESH)).toEqual({
      argv: ["claude", "--model", "opus", "--session-id", FRESH],
      providerSessionId: FRESH,
    });
  });

  it("keeps an id the launch names, and leaves a resume or a continue alone", () => {
    expect(withClaudeSessionId(["claude", "--session-id", "mine"], FRESH)).toEqual({
      argv: ["claude", "--session-id", "mine"],
      providerSessionId: "mine",
    });
    for (const flags of [["--resume", "abc"], ["-r", "abc"], ["--continue"], ["-c"]]) {
      expect(withClaudeSessionId(["claude", ...flags], FRESH)).toEqual({
        argv: ["claude", ...flags],
        providerSessionId: null,
      });
    }
    expect(withClaudeSessionId(["codex"], FRESH)).toEqual({
      argv: ["codex"],
      providerSessionId: null,
    });
  });
});
