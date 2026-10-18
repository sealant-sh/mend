#!/usr/bin/env node
// A stand-in for Claude Code's hook runner: given the `--settings` Mend composes for a claude it
// launches, it fires a scripted list of hook events and runs every matching command hook the way
// Claude Code runs one. It proves Mend's side of G4 (the settings' shape, the in-workspace `mend
// hook claude` helper, the session channel, the session's status); it does not prove that a real
// claude fires these hooks, when, or with these exact fields.
//
//   node claude-standin.mjs --settings '<json or path>' --events PermissionRequest,Notification:permission_prompt,PostToolUse,Stop,UserPromptSubmit
//       [--pause-ms <ms>] [--cwd <dir>] [--marker <word>] [--session-id <id>]
//
// Everything below follows https://code.claude.com/docs/en/hooks (read 2026-10-19), by section:
//
// - "Configuration": `hooks` is `{ "<Event>": [{ "matcher"?, "hooks": [{ "type": "command",
//   "command", "timeout"?, "args"?, "shell"? }] }] }`; only `command` handlers run here.
// - "Matcher patterns": `*`, `""` or no matcher match all; a matcher of only letters, digits, `_`,
//   `-`, spaces, `,` and `|` is an exact string or a `|`/`,` list of them; anything else is an
//   unanchored JavaScript regular expression. Tool events match `tool_name`, `Notification` matches
//   the notification type; `Stop` and `UserPromptSubmit` have no matcher support, so a matcher on
//   them is ignored.
// - "Hook handler fields": all matching hooks run in parallel; the same handler runs once.
// - "Common fields": `timeout` is in seconds, 600 by default for a command hook, 30 on
//   `UserPromptSubmit`; a timed-out hook is cancelled ("Timeouts").
// - "Exec form and shell form": without `args` the command runs under `sh -c` (`bash -c` with
//   `"shell": "bash"`); with `args` it is spawned directly. Input arrives on stdin as JSON ("Hook
//   lifecycle"); the process inherits the environment and gets `CLAUDE_PROJECT_DIR`; it runs in its
//   own session without a controlling terminal ("Hook input and output").
// - "Common input fields": `session_id`, `transcript_path`, `cwd`, `permission_mode`,
//   `hook_event_name`. Per event, the example payloads of "PermissionRequest input", "Notification
//   input", "PostToolUse input", "Stop input" and "UserPromptSubmit input".
//
// Each event fired prints one line `<marker>:{json}` on stdout (its hooks' exit codes, timeouts and
// output sizes, never their output); `<marker>:{"start":…}` and `<marker>:{"done":…}` bracket them.
// `--pause-ms` waits before each event, so an observer can read the state each one leaves.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASH_COMMAND = { command: "pnpm db:migrate", description: "Run the database migrations" };

const NOTIFICATION_MESSAGES = {
  permission_prompt: {
    message: "Claude needs your permission to use Bash",
    title: "Permission needed",
  },
  idle_prompt: { message: "Claude is waiting for your input", title: "Waiting for input" },
  elicitation_dialog: { message: "Claude has a question for you", title: "Question" },
  auth_success: { message: "Signed in", title: "Authentication" },
};

/**
 * The events the stand-in fires: the payload Claude Code sends (the docs' example, with this run's
 * session and cwd), the field its matcher is tested against (null: no matcher support), and the
 * default command timeout in seconds.
 */
export const EVENTS = {
  PermissionRequest: {
    matcherField: "tool_name",
    timeout: 600,
    payload: (common) => ({
      ...common,
      permission_mode: "default",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: BASH_COMMAND,
      permission_suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: BASH_COMMAND.command }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    }),
  },
  Notification: {
    matcherField: "notification_type",
    timeout: 600,
    payload: (common, variant = "permission_prompt") => ({
      ...common,
      hook_event_name: "Notification",
      ...(NOTIFICATION_MESSAGES[variant] ?? { message: `Claude notification ${variant}` }),
      notification_type: variant,
    }),
  },
  PostToolUse: {
    matcherField: "tool_name",
    timeout: 600,
    payload: (common) => ({
      ...common,
      permission_mode: "default",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: BASH_COMMAND,
      tool_response: { stdout: "Applied 3 migrations.", stderr: "", interrupted: false },
      tool_use_id: `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      duration_ms: 1840,
    }),
  },
  Stop: {
    matcherField: null,
    timeout: 600,
    payload: (common) => ({
      ...common,
      permission_mode: "default",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "The migrations ran: 3 applied, none pending.",
      background_tasks: [],
      session_crons: [],
    }),
  },
  UserPromptSubmit: {
    matcherField: null,
    timeout: 30,
    payload: (common) => ({
      ...common,
      permission_mode: "default",
      hook_event_name: "UserPromptSubmit",
      prompt: "Run the migrations again against a fresh database",
    }),
  },
};

export class StandinError extends Error {}

/** `Event` or `Event:variant` (a Notification's type); an event this stand-in lacks is refused. */
export const parseEventSpec = (spec) => {
  const [event, variant, ...rest] = spec.trim().split(":");
  if (!(event in EVENTS) || rest.length > 0)
    throw new StandinError(`unknown event ${spec}: one of ${Object.keys(EVENTS).join(", ")}`);
  if (variant !== undefined && event !== "Notification")
    throw new StandinError(`only Notification takes a type: ${spec}`);
  return { event, variant: variant ?? null };
};

const EXACT_MATCHER = /^[A-Za-z0-9_\- ,|]*$/;

/** Whether a matcher admits `value`, by the docs' three cases. */
export const matcherMatches = (matcher, value) => {
  if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
  if (EXACT_MATCHER.test(matcher))
    return matcher
      .split(/[|,]/)
      .map((word) => word.trim())
      .includes(value);
  return new RegExp(matcher).test(value);
};

/** The settings object: `--settings` takes inline JSON or a path to it, as claude's flag does. */
export const readSettings = (value) => {
  const inline = /^\s*[[{]/.test(value);
  if (!inline && !existsSync(resolve(value)))
    throw new StandinError(`--settings is neither JSON nor a file: ${value}`);
  const text = inline ? value : readFileSync(resolve(value), "utf8");
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new StandinError(`--settings is not JSON: ${error.message}`);
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings))
    throw new StandinError("--settings is not a JSON object");
  return settings;
};

/** The command handlers one fired event runs: matched, then deduplicated by command and args. */
export const handlersFor = (settings, event, payload) => {
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) return [];
  const field = EVENTS[event].matcherField;
  const seen = new Set();
  const handlers = [];
  for (const group of groups) {
    if (field !== null && !matcherMatches(group?.matcher, payload[field])) continue;
    for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (handler?.type !== "command" || typeof handler.command !== "string") continue;
      const key = JSON.stringify([handler.command, handler.args ?? null, handler.shell ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      handlers.push(handler);
    }
  }
  return handlers;
};

/** One handler run with the payload on stdin; what it did, never what it printed. */
export const runHandler = async (handler, payload, { cwd, env, defaultTimeout }) => {
  const startedAt = Date.now();
  const [program, args] = Array.isArray(handler.args)
    ? [handler.command, handler.args.map(String)]
    : [handler.shell === "bash" ? "bash" : "sh", ["-c", handler.command]];
  const child = spawn(program, args, {
    cwd,
    env: { ...env, CLAUDE_PROJECT_DIR: cwd },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  // A program that cannot start emits `error`, then `close` (code -2): the end is read from `close`.
  let spawnError = null;
  child.on("error", (error) => (spawnError = error.message));
  const ended = new Promise((resolveEnd) =>
    child.on("close", (exitCode, signal) => resolveEnd({ exitCode, signal })),
  );
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  child.stdout.on("data", (chunk) => (stdoutBytes += chunk.length));
  child.stderr.on("data", (chunk) => (stderrBytes += chunk.length));
  const seconds = typeof handler.timeout === "number" ? handler.timeout : defaultTimeout;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, seconds * 1000);
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify(payload));
  const { exitCode, signal } = await ended;
  clearTimeout(timer);
  return {
    command: handler.command,
    exitCode,
    signal,
    timedOut,
    stdoutBytes,
    stderrBytes,
    ms: Date.now() - startedAt,
    ...(spawnError === null ? {} : { spawnError }),
  };
};

/** Fires one event: its payload built, its handlers run in parallel, their results returned. */
export const fire = async (settings, { event, variant }, context) => {
  const common = {
    session_id: context.sessionId,
    transcript_path: join(
      homedir(),
      ".claude",
      "projects",
      context.cwd.replaceAll("/", "-"),
      `${context.sessionId}.jsonl`,
    ),
    cwd: context.cwd,
  };
  const payload =
    variant === null ? EVENTS[event].payload(common) : EVENTS[event].payload(common, variant);
  const handlers = handlersFor(settings, event, payload);
  const hooks = await Promise.all(
    handlers.map((handler) =>
      runHandler(handler, payload, {
        cwd: context.cwd,
        env: context.env,
        defaultTimeout: EVENTS[event].timeout,
      }),
    ),
  );
  return { event, notificationType: payload.notification_type ?? null, hooks };
};

const FLAGS = new Set(["settings", "events", "pause-ms", "cwd", "marker", "session-id"]);

export const parseArgs = (argv) => {
  const options = {};
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at];
    const name = word.startsWith("--") ? word.slice(2) : null;
    if (name === null || !FLAGS.has(name)) throw new StandinError(`unknown argument ${word}`);
    const value = argv[(at += 1)];
    if (value === undefined) throw new StandinError(`--${name} needs a value`);
    options[name] = value;
  }
  if (options.settings === undefined) throw new StandinError("--settings is required");
  if (options.events === undefined) throw new StandinError("--events is required");
  const pauseMs = Number(options["pause-ms"] ?? 0);
  if (!Number.isInteger(pauseMs) || pauseMs < 0)
    throw new StandinError("--pause-ms is a whole number of milliseconds");
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!existsSync(cwd)) throw new StandinError(`--cwd ${cwd} does not exist`);
  return {
    settings: readSettings(options.settings),
    events: options.events
      .split(",")
      .filter((spec) => spec.trim() !== "")
      .map(parseEventSpec),
    pauseMs,
    cwd,
    marker: options.marker ?? "claude-standin",
    sessionId: options["session-id"] ?? randomUUID(),
  };
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export const main = async (
  argv,
  { env = process.env, write = (line) => process.stdout.write(line) } = {},
) => {
  const run = parseArgs(argv);
  const say = (fields) => write(`${run.marker}:${JSON.stringify(fields)}\n`);
  say({
    start: true,
    cwd: run.cwd,
    events: run.events.length,
    pauseMs: run.pauseMs,
    hookEvents: Object.keys(run.settings.hooks ?? {}),
  });
  for (const [index, spec] of run.events.entries()) {
    await sleep(run.pauseMs);
    say({
      index,
      ...(await fire(run.settings, spec, { ...run, env })),
      at: new Date().toISOString(),
    });
  }
  say({ done: true, events: run.events.length });
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`claude-standin: ${error.message}\n`);
    process.exit(error instanceof StandinError ? 2 : 1);
  });
}
