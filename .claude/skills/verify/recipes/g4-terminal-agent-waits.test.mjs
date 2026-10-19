//   node --test .claude/skills/verify/recipes/g4-terminal-agent-waits.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HELPER,
  claudeHookCheck,
  claudeLoginOf,
  codexHookCheck,
  sessionIdOfArgv,
  settingsOfArgv,
} from "./g4-terminal-agent-waits.mjs";

const hook = (command) => ({ type: "command", command, timeout: 5 });

const MEND_CLAUDE = {
  env: { CLAUDE_CONFIG_DIR: "/home/person/.claude" },
  hooks: {
    SessionStart: [{ hooks: [hook(HELPER.claude)] }],
    PermissionRequest: [{ hooks: [hook(HELPER.claude)] }],
    Notification: [
      {
        matcher: "permission_prompt|elicitation_dialog|idle_prompt",
        hooks: [hook(HELPER.claude)],
      },
    ],
    Stop: [{ hooks: [hook(HELPER.claude)] }],
    UserPromptSubmit: [{ hooks: [hook(HELPER.claude)] }],
    PostToolUse: [{ hooks: [hook(HELPER.claude)] }],
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

test("the pin comes off the argv as the word after --session-id, or null", () => {
  const id = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
  assert.equal(sessionIdOfArgv(["claude", "--session-id", id, "--settings", "{}"]), id);
  assert.equal(sessionIdOfArgv(["claude", "--settings", "{}"]), null);
  assert.equal(sessionIdOfArgv(["claude", "--session-id"]), null);
});

test("the helper is named by its absolute path, so a bare mend on PATH is not it", () => {
  assert.equal(HELPER.claude, "/run/mend/bin/mend hook claude");
  assert.equal(HELPER.codex, "/run/mend/bin/mend hook codex");
  assert.deepEqual(
    claudeHookCheck({
      hooks: { ...MEND_CLAUDE.hooks, Stop: [{ hooks: [hook("mend hook claude")] }] },
    }).missing,
    ["Stop"],
  );
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
    hooks: { ...MEND_CLAUDE.hooks, PostToolUse: [{ hooks: [hook(HELPER.codex)] }] },
  };
  assert.deepEqual(claudeHookCheck(other).missing, ["PostToolUse"]);
  const idleOnly = {
    hooks: {
      ...MEND_CLAUDE.hooks,
      Notification: [{ matcher: "idle_prompt", hooks: [hook(HELPER.claude)] }],
    },
  };
  assert.deepEqual(claudeHookCheck(idleOnly).missing, ["Notification"]);
  const resumeOnly = {
    hooks: {
      ...MEND_CLAUDE.hooks,
      SessionStart: [{ matcher: "resume", hooks: [hook(HELPER.claude)] }],
    },
  };
  assert.deepEqual(
    claudeHookCheck(resumeOnly).missing,
    ["SessionStart"],
    "a fresh claude's SessionStart has source startup",
  );
  assert.deepEqual(claudeHookCheck({}).missing, [
    "SessionStart",
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
    ...["SessionStart", "PermissionRequest", "Stop", "UserPromptSubmit", "PostToolUse"].flatMap(
      (event) => [
        `[[hooks.${event}]]`,
        `hooks = [{ type = "command", command = "${HELPER.codex}", timeout = 5 }]`,
        "",
      ],
    ),
  ].join("\r\n");
  assert.deepEqual(codexHookCheck(tables), {
    hooksTable: true,
    wired: ["SessionStart", "PermissionRequest", "Stop", "UserPromptSubmit", "PostToolUse"],
    missing: [],
  });

  const nested = [
    "[[hooks.PermissionRequest]]",
    "[[hooks.PermissionRequest.hooks]]",
    'type = "command"',
    `command = "${HELPER.codex}"`,
    "[hooks]",
    "Stop = [",
    `  { hooks = [{ type = "command", command = "${HELPER.codex}" }] },`,
    "]",
    'UserPromptSubmit = [{ hooks = [{ type = "command", command = "mend hook codex" }] }]',
  ].join("\n");
  assert.deepEqual(codexHookCheck(nested).wired, ["PermissionRequest", "Stop"]);
  assert.deepEqual(codexHookCheck(nested).missing, [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
  ]);

  assert.deepEqual(codexHookCheck('approval_policy = "never"\n[features]\nx = 1\n'), {
    hooksTable: false,
    wired: [],
    missing: ["SessionStart", "PermissionRequest", "Stop", "UserPromptSubmit", "PostToolUse"],
  });
});

const account = (provider, status, name = "default") => ({ provider, name, status });

test("the claude login reads missing when no claude account is named default", () => {
  assert.equal(claudeLoginOf([]), "missing");
  assert.equal(claudeLoginOf([account("codex", "active"), account("github", "active")]), "missing");
  assert.equal(claudeLoginOf([account("claude", "active", "work")]), "missing");
});

test("the claude login reads active for a freshly connected default, beside an archived one", () => {
  assert.equal(claudeLoginOf([account("codex", "invalid"), account("claude", "active")]), "active");
  assert.equal(
    claudeLoginOf([account("claude", "archived"), account("claude", "active")]),
    "active",
  );
});

test("a spent fake reads invalid, not connected, so the step reconnects it", () => {
  assert.equal(claudeLoginOf([account("claude", "invalid")]), "invalid");
  assert.equal(
    claudeLoginOf([account("claude", "archived"), account("claude", "invalid")]),
    "invalid",
  );
  assert.equal(
    claudeLoginOf([account("claude", "invalid"), account("claude", "active", "work")]),
    "invalid",
  );
});

test("any other status is read back as it is, never as active", () => {
  assert.equal(claudeLoginOf([account("claude", "archived")]), "archived");
  assert.equal(claudeLoginOf([account("claude", "suspended")]), "suspended");
});
