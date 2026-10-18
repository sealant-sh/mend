import { AGENT_HOOKS } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { CLAUDE_AGENT_HOOKS } from "./claude-settings.ts";

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
    expect(Object.keys(CLAUDE_AGENT_HOOKS)).toEqual([
      "PermissionRequest",
      "Notification",
      "Stop",
      "UserPromptSubmit",
      "PostToolUse",
    ]);
  });
});
