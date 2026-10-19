// claude-standin.mjs against a fake `hooks` settings whose commands write their stdin to files:
// the payloads each event sends, the matcher's filtering, timeouts, the environment, the CLI's
// marker lines. No network, no Mend.
//
//   node --test .claude/skills/verify/scripts/fixtures/claude-standin.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fire, main, matcherMatches, parseEventSpec, StandinError } from "./claude-standin.mjs";

const STANDIN = fileURLToPath(new URL("./claude-standin.mjs", import.meta.url));

/** A scratch dir, and a hook command that appends its stdin, one JSON per line, to `<name>.jsonl`. */
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "claude-standin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = (name) => `{ cat; echo; } >> "${join(dir, `${name}.jsonl`)}"`;
  const read = (name) => {
    const file = join(dir, `${name}.jsonl`);
    return readdirSync(dir).includes(`${name}.jsonl`)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
      : [];
  };
  return { dir, record, read };
};

const command = (cmd, extra = {}) => ({ type: "command", command: cmd, ...extra });

/** The shape Mend composes: one `mend hook claude` command per event, Notification matched. */
const mendShaped = (record) => ({
  hooks: {
    SessionStart: [{ hooks: [command(record("SessionStart"), { timeout: 5 })] }],
    PermissionRequest: [{ hooks: [command(record("PermissionRequest"), { timeout: 5 })] }],
    Notification: [
      {
        matcher: "permission_prompt|elicitation_dialog|idle_prompt",
        hooks: [command(record("Notification"), { timeout: 5 })],
      },
    ],
    PostToolUse: [{ hooks: [command(record("PostToolUse"), { timeout: 5 })] }],
    Stop: [{ hooks: [command(record("Stop"), { timeout: 5 })] }],
    UserPromptSubmit: [{ hooks: [command(record("UserPromptSubmit"), { timeout: 5 })] }],
  },
});

const context = (dir, env = {}) => ({
  sessionId: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
  cwd: dir,
  env: { PATH: process.env.PATH, ...env },
});

test("each event sends the docs' payload on stdin, with this run's session and cwd", async (t) => {
  const { dir, record, read } = scratch(t);
  const settings = mendShaped(record);
  for (const spec of [
    "SessionStart",
    "PermissionRequest",
    "Notification",
    "PostToolUse",
    "Stop",
    "UserPromptSubmit",
  ])
    await fire(settings, parseEventSpec(spec), context(dir));

  const [start] = read("SessionStart");
  assert.equal(start.hook_event_name, "SessionStart");
  assert.equal(start.session_id, "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b");
  assert.equal(start.source, "startup");
  assert.equal(start.tool_name, undefined, "SessionStart names no tool");

  const [permission] = read("PermissionRequest");
  assert.equal(permission.hook_event_name, "PermissionRequest");
  assert.equal(permission.session_id, "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b");
  assert.equal(permission.cwd, dir);
  assert.equal(permission.tool_name, "Bash");
  assert.equal(permission.tool_input.command, "pnpm db:migrate");
  assert.equal(permission.tool_use_id, undefined, "PermissionRequest carries no tool_use_id");
  assert.match(permission.transcript_path, /\.claude\/projects\/.+\.jsonl$/);

  const [notification] = read("Notification");
  assert.equal(notification.notification_type, "permission_prompt");
  assert.equal(notification.message, "Claude needs your permission to use Bash");

  const [post] = read("PostToolUse");
  assert.equal(post.tool_name, "Bash");
  assert.match(post.tool_use_id, /^toolu_/);
  assert.equal(typeof post.tool_response, "object");

  const [stop] = read("Stop");
  assert.equal(stop.stop_hook_active, false);
  assert.equal(typeof stop.last_assistant_message, "string");

  const [prompt] = read("UserPromptSubmit");
  assert.equal(typeof prompt.prompt, "string");
});

test("a Notification runs only the groups whose matcher admits its type", async (t) => {
  const { dir, record, read } = scratch(t);
  const settings = mendShaped(record);
  const auth = await fire(settings, parseEventSpec("Notification:auth_success"), context(dir));
  assert.deepEqual(auth.hooks, [], "auth_success is not in Mend's matcher");
  assert.deepEqual(read("Notification"), []);

  const idle = await fire(settings, parseEventSpec("Notification:idle_prompt"), context(dir));
  assert.equal(idle.hooks.length, 1);
  assert.deepEqual(
    read("Notification").map((payload) => payload.notification_type),
    ["idle_prompt"],
  );
});

test("matchers: exact lists, unanchored regular expressions, and events without matcher support", async (t) => {
  assert.equal(matcherMatches(undefined, "Bash"), true);
  assert.equal(matcherMatches("*", "Bash"), true);
  assert.equal(matcherMatches("Edit|Write", "Edit"), true);
  assert.equal(matcherMatches("Edit, Write", "Write"), true);
  assert.equal(
    matcherMatches("Edit", "NotebookEdit"),
    false,
    "an exact matcher is not a substring",
  );
  assert.equal(matcherMatches("Edit.*", "NotebookEdit"), true, "a regex is unanchored");
  assert.equal(matcherMatches("^Ba", "Bash"), true);

  const { dir, record, read } = scratch(t);
  const settings = {
    hooks: {
      PermissionRequest: [
        { matcher: "Edit", hooks: [command(record("edit-only"))] },
        { matcher: "^Ba", hooks: [command(record("bash-regex"))] },
      ],
      Stop: [{ matcher: "never-matches-anything", hooks: [command(record("stop"))] }],
    },
  };
  await fire(settings, parseEventSpec("PermissionRequest"), context(dir));
  await fire(settings, parseEventSpec("Stop"), context(dir));
  assert.equal(read("edit-only").length, 0);
  assert.equal(read("bash-regex").length, 1);
  assert.equal(read("stop").length, 1, "Stop has no matcher support: the matcher is ignored");

  const sources = {
    hooks: {
      SessionStart: [
        { matcher: "startup", hooks: [command(record("startup"))] },
        { matcher: "resume|clear", hooks: [command(record("resume-or-clear"))] },
      ],
    },
  };
  await fire(sources, parseEventSpec("SessionStart"), context(dir));
  assert.equal(read("startup").length, 1, "SessionStart matches its source");
  assert.equal(read("resume-or-clear").length, 0);
});

test("matching handlers run in parallel, the same handler once, with the environment inherited", async (t) => {
  const { dir, record, read } = scratch(t);
  const env = join(dir, "env.txt");
  const settings = {
    hooks: {
      PostToolUse: [
        { hooks: [command(record("twice")), command(`sleep 0.5; ${record("slow-a")}`)] },
        {
          matcher: "Bash",
          hooks: [
            command(record("twice")),
            command(`sleep 0.5; ${record("slow-b")}`),
            command(`printf '%s|%s' "$STANDIN_PROBE" "$CLAUDE_PROJECT_DIR" > "${env}"`),
          ],
        },
      ],
    },
  };
  const started = Date.now();
  const result = await fire(
    settings,
    parseEventSpec("PostToolUse"),
    context(dir, { STANDIN_PROBE: "inherited" }),
  );
  assert.ok(Date.now() - started < 900, "two 0.5 s hooks ran side by side");
  assert.equal(result.hooks.length, 4, "the duplicate handler ran once");
  assert.equal(read("twice").length, 1);
  assert.equal(readFileSync(env, "utf8"), `inherited|${dir}`);
});

test("a hook past its timeout is killed and reported, and its output is counted, not kept", async (t) => {
  const { dir } = scratch(t);
  const settings = {
    hooks: {
      Stop: [
        {
          hooks: [
            command("sleep 30", { timeout: 1 }),
            command("printf 'out%.0s' 1 2 3; printf 'err%.0s' 1 2 >&2; exit 3"),
          ],
        },
      ],
    },
  };
  const started = Date.now();
  const { hooks } = await fire(settings, parseEventSpec("Stop"), context(dir));
  assert.ok(Date.now() - started < 5_000);
  const [slow, loud] = hooks;
  assert.equal(slow.timedOut, true);
  assert.equal(slow.signal, "SIGKILL");
  assert.equal(loud.exitCode, 3);
  assert.equal(loud.stdoutBytes, "outoutout".length);
  assert.equal(loud.stderrBytes, "errerr".length);
  assert.equal(JSON.stringify(hooks).includes("outoutout"), false);
});

test("the CLI takes --settings inline or as a path and prints one marker line per event", (t) => {
  const { dir, record, read } = scratch(t);
  const settings = JSON.stringify(mendShaped(record));
  const path = join(dir, "settings.json");
  writeFileSync(path, settings);
  for (const value of [settings, path]) {
    const ran = spawnSync(
      process.execPath,
      [
        STANDIN,
        "--settings",
        value,
        "--events",
        "PermissionRequest,Notification:auth_success,Stop",
        "--marker",
        "G4",
        "--cwd",
        dir,
      ],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 0, ran.stderr);
    const lines = ran.stdout
      .trim()
      .split("\n")
      .map((line) => {
        assert.ok(line.startsWith("G4:"), line);
        return JSON.parse(line.slice(3));
      });
    assert.equal(lines[0].start, true);
    assert.deepEqual(lines[0].hookEvents, [
      "SessionStart",
      "PermissionRequest",
      "Notification",
      "PostToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
    assert.deepEqual(
      lines.slice(1, 4).map((line) => [line.index, line.event, line.hooks.length]),
      [
        [0, "PermissionRequest", 1],
        [1, "Notification", 0],
        [2, "Stop", 1],
      ],
    );
    assert.deepEqual(lines[4], { done: true, events: 3 });
  }
  assert.equal(read("PermissionRequest").length, 2);
});

test("an unknown event, a type on a non-Notification and a non-object settings are refused", async () => {
  assert.throws(() => parseEventSpec("PreToolUse"), StandinError);
  assert.throws(() => parseEventSpec("Stop:idle_prompt"), StandinError);
  await assert.rejects(
    main(["--settings", "[]", "--events", "Stop"], { write: () => undefined }),
    /not a JSON object/,
  );
  await assert.rejects(main(["--events", "Stop"], { write: () => undefined }), /--settings/);
});
