// The G4 recipe's offline parts: the claude settings on an argv and the codex config.toml, each
// checked the way the live run checks them. No world, no network.
//
//   node --test .claude/skills/verify/recipes/g4-terminal-agent-waits.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeHookCheck, codexHookCheck, settingsOfArgv } from "./g4-terminal-agent-waits.mjs";

const hook = (command) => ({ type: "command", command, timeout: 5 });

const MEND_CLAUDE = {
  env: { CLAUDE_CONFIG_DIR: "/home/person/.claude" },
  hooks: {
    PermissionRequest: [{ hooks: [hook("mend hook claude")] }],
    Notification: [
      {
        matcher: "permission_prompt|elicitation_dialog|idle_prompt",
        hooks: [hook("mend hook claude")],
      },
    ],
    Stop: [{ hooks: [hook("mend hook claude")] }],
    UserPromptSubmit: [{ hooks: [hook("mend hook claude")] }],
    PostToolUse: [{ hooks: [hook("mend hook claude")] }],
  },
};

test("the settings come off the argv, as the next word or after =", () => {
  const json = JSON.stringify(MEND_CLAUDE);
  assert.deepEqual(
    settingsOfArgv(["claude", "--settings", json, "--permission-mode", "auto"]),
    MEND_CLAUDE,
  );
  assert.deepEqual(settingsOfArgv(["claude", `--settings=${json}`]), MEND_CLAUDE);
  assert.throws(
    () => settingsOfArgv(["claude", "--dangerously-skip-permissions"]),
    /no --settings/,
  );
  assert.throws(() => settingsOfArgv(["claude", "--settings", "/etc/x.json"]), /not inline JSON/);
});

test("Mend's claude settings wire every event, and the matcher admits the waits but not auth", () => {
  const check = claudeHookCheck(MEND_CLAUDE);
  assert.deepEqual(check.missing, []);
  assert.deepEqual(check.notificationTypes, {
    permission_prompt: true,
    elicitation_dialog: true,
    idle_prompt: true,
    auth_success: false,
  });
});

test("an event missing, another command, or a matcher that excludes the type is named", () => {
  const { Stop: _stop, ...withoutStop } = MEND_CLAUDE.hooks;
  assert.deepEqual(claudeHookCheck({ hooks: withoutStop }).missing, ["Stop"]);
  const other = {
    hooks: { ...MEND_CLAUDE.hooks, PostToolUse: [{ hooks: [hook("mend hook codex")] }] },
  };
  assert.deepEqual(claudeHookCheck(other).missing, ["PostToolUse"]);
  const idleOnly = {
    hooks: {
      ...MEND_CLAUDE.hooks,
      Notification: [{ matcher: "idle_prompt", hooks: [hook("mend hook claude")] }],
    },
  };
  assert.deepEqual(claudeHookCheck(idleOnly).missing, ["Notification"]);
  assert.deepEqual(claudeHookCheck({}).missing, [
    "PermissionRequest",
    "Notification",
    "Stop",
    "UserPromptSubmit",
    "PostToolUse",
  ]);
});

test("codex: arrays of tables, nested handler tables and inline keys of [hooks] all count", () => {
  const tables = [
    "# Mend's system defaults",
    'approval_policy = "never"',
    "",
    ...["PermissionRequest", "Stop", "UserPromptSubmit", "PostToolUse"].flatMap((event) => [
      `[[hooks.${event}]]`,
      'hooks = [{ type = "command", command = "mend hook codex", timeout = 5 }]',
      "",
    ]),
  ].join("\r\n");
  assert.deepEqual(codexHookCheck(tables), {
    hooksTable: true,
    wired: ["PermissionRequest", "Stop", "UserPromptSubmit", "PostToolUse"],
    missing: [],
  });

  const nested = [
    "[[hooks.PermissionRequest]]",
    "[[hooks.PermissionRequest.hooks]]",
    'type = "command"',
    'command = "mend hook codex"',
    "[hooks]",
    "Stop = [",
    '  { hooks = [{ type = "command", command = "mend hook codex" }] },',
    "]",
    'UserPromptSubmit = [{ hooks = [{ type = "command", command = "something else" }] }]',
  ].join("\n");
  assert.deepEqual(codexHookCheck(nested).wired, ["PermissionRequest", "Stop"]);
  assert.deepEqual(codexHookCheck(nested).missing, ["UserPromptSubmit", "PostToolUse"]);

  assert.deepEqual(codexHookCheck('approval_policy = "never"\n[features]\nx = 1\n'), {
    hooksTable: false,
    wired: [],
    missing: ["PermissionRequest", "Stop", "UserPromptSubmit", "PostToolUse"],
  });
});
