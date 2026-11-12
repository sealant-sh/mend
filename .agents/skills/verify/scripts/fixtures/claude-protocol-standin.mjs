#!/usr/bin/env node
//   node claude-protocol-standin.mjs claude --print --verbose --input-format stream-json \
//       --output-format stream-json --include-partial-messages --permission-prompt-tool stdio \
//       --session-id <uuid> | --resume <uuid> [...]
//   node claude-protocol-standin.mjs --version
//
// The process behind the name `claude` in a workspace, for a conversation that must ask: Mend
// launches it with the protocol argv of `composeProtocolArgv` (packages/domain/src/workbench/
// harness-launch.ts) and talks Claude Code's stream-json on stdio, as ClaudeAdapter
// (packages/agent-protocol/src/claude.ts) reads it and provider-peer.mjs (its test oracle) speaks
// it. Only the decision to ask is the stand-in's; every byte after it is Mend's own path.
//
// On start it says `system init` with its session id. Each user message opens a turn that asks
// one `control_request` `can_use_tool`, waits for Mend's `control_response`, then ends the turn
// with an assistant message and a `result`. The text of the message picks the request:
// `mend-ask:permission` (Bash `pnpm db:migrate`), `mend-ask:question` (AskUserQuestion, one
// single-select question with two options), `mend-ask:text` (AskUserQuestion with no options) or
// `mend-ask:none`; without one, the turns ask permission, question, text in turn. A control request
// Mend sends (interrupt, initialize, stop_task) is answered success; an interrupt ends the open turn.
//
// stdout carries protocol and nothing else. Every invocation, line received and line sent is one
// JSON line of the record file: $MEND_STANDIN_RECORD, else record.jsonl beside this script.

import { appendFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const VERSION = "2.1.999 (Claude Code protocol stand-in)";

export const KINDS = ["permission", "question", "text"];

export const BASH_INPUT = {
  command: "pnpm db:migrate",
  description: "Run the database migrations",
};

export const QUESTION = {
  id: "target",
  header: "Database",
  question: "Which database?",
  options: [
    { label: "staging", description: "The shared staging database" },
    { label: "production", description: "The live database" },
  ],
  multiSelect: false,
};

export const FREE_TEXT = {
  id: "name",
  header: "Name",
  question: "What should the migration be called?",
  options: [],
  multiSelect: false,
};

/** The `request` of the `can_use_tool` control request a turn asks. */
export const requestFor = (kind) => {
  switch (kind) {
    case "permission":
      return {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: BASH_INPUT,
        permission_suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: BASH_INPUT.command }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      };
    case "question":
      return {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [QUESTION] },
      };
    case "text":
      return {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [FREE_TEXT] },
      };
    default:
      throw new Error(`no request for ${kind}`);
  }
};

const DIRECTIVE = /mend-ask:(permission|question|text|none)\b/;

/** What a turn asks: the message's directive, else the next kind in turn. */
export const kindFor = (text, ordinal) =>
  DIRECTIVE.exec(text)?.[1] ?? KINDS[(ordinal - 1) % KINDS.length];

export const textOf = (message) => {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
};

const PROTOCOL_FLAGS = [
  ["--input-format", "stream-json"],
  ["--output-format", "stream-json"],
  ["--permission-prompt-tool", "stdio"],
];

/** The session id Mend named on the argv, and whether the argv is the protocol launch at all. */
export const parseClaudeArgv = (argv) => {
  if (argv.includes("--version") || argv.includes("-v")) return { mode: "version" };
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : (argv[at + 1] ?? null);
  };
  const missing = PROTOCOL_FLAGS.filter(([name, value]) => flag(name) !== value).map(
    ([name, value]) => `${name} ${value}`,
  );
  if (missing.length > 0) return { mode: "refused", missing };
  const resumed = flag("--resume");
  const sessionId = resumed ?? flag("--session-id");
  if (sessionId === null) return { mode: "refused", missing: ["--session-id or --resume"] };
  return { mode: "protocol", sessionId, resumed: resumed !== null };
};

const answerOf = (kind, response) => {
  if (kind === "permission")
    return {
      behavior: response?.behavior ?? null,
      updatedPermissions: response?.updatedPermissions ?? null,
      message: response?.message ?? null,
    };
  return { behavior: response?.behavior ?? null, answers: response?.updatedInput?.answers ?? null };
};

/**
 * One protocol conversation: `receive` takes each line Mend writes, `write` sends a line to Mend,
 * `record` keeps one JSON object. Returns `receive` and a promise that settles when the input ends.
 */
export const conversation = ({ sessionId, write, record }) => {
  const send = (value) => {
    record({ sent: value });
    write(`${JSON.stringify(value)}\n`);
  };
  const queue = [];
  let ordinal = 0;
  let asked = 0;
  let open = null;

  const endTurn = (text, subtype = "success") => {
    send({
      type: "assistant",
      session_id: sessionId,
      message: {
        id: `msg-standin-${ordinal}`,
        role: "assistant",
        content: [{ type: "text", text }],
      },
    });
    send(
      subtype === "success"
        ? { type: "result", subtype, session_id: sessionId, is_error: false, result: text }
        : {
            type: "result",
            subtype,
            session_id: sessionId,
            is_error: true,
            errors: [text],
          },
    );
    open = null;
    next();
  };

  const next = () => {
    if (open !== null || queue.length === 0) return;
    const message = queue.shift();
    ordinal += 1;
    const kind = kindFor(textOf(message), ordinal);
    if (kind === "none") {
      open = { kind, requestId: null };
      endTurn("Nothing to ask.");
      return;
    }
    asked += 1;
    const requestId = `standin-${asked}-${kind}`;
    const request = requestFor(kind);
    open = { kind, requestId };
    record({ asked: { ordinal, kind, requestId, tool: request.tool_name } });
    send({ type: "control_request", request_id: requestId, request });
  };

  const receive = (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      record({ unreadable: line });
      return;
    }
    record({ received: value });
    if (value?.type === "user") {
      queue.push(value);
      next();
      return;
    }
    if (value?.type === "control_response") {
      const requestId = value.response?.request_id ?? null;
      if (open === null || requestId !== open.requestId) {
        record({ stray: { requestId } });
        return;
      }
      const answer = answerOf(open.kind, value.response?.response);
      record({ responded: { requestId, kind: open.kind, ...answer } });
      endTurn(
        answer.behavior === "allow"
          ? `Done: ${open.kind === "permission" ? BASH_INPUT.command : JSON.stringify(answer.answers)}.`
          : "Understood, I will not run it.",
      );
      return;
    }
    if (value?.type === "control_request") {
      const requestId = value.request_id ?? null;
      send({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: {} },
      });
      if (value.request?.subtype === "interrupt" && open !== null) {
        record({ interrupted: { requestId: open.requestId } });
        endTurn("Interrupted.", "error_during_execution");
      }
    }
  };

  send({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    tools: ["Bash", "AskUserQuestion"],
    model: "claude-protocol-standin",
    permissionMode: "default",
  });
  return { receive };
};

const defaultRecord = () =>
  process.env.MEND_STANDIN_RECORD ?? join(dirname(fileURLToPath(import.meta.url)), "record.jsonl");

export const main = async (
  argv,
  {
    input = process.stdin,
    write = (line) => process.stdout.write(line),
    error = (line) => process.stderr.write(line),
    recordFile = defaultRecord(),
  } = {},
) => {
  const record = (fields) =>
    appendFileSync(recordFile, `${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`);
  const args = argv[0] === "claude" || /(^|\/)claude$/.test(argv[0] ?? "") ? argv.slice(1) : argv;
  const parsed = parseClaudeArgv(args);
  const user = userInfo();
  record({
    start: {
      argv: args,
      mode: parsed.mode,
      pid: process.pid,
      uid: user.uid,
      gid: user.gid,
      user: user.username,
      cwd: process.cwd(),
    },
  });
  if (parsed.mode === "version") {
    write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.mode === "refused") {
    error(`claude-protocol-standin: not a protocol launch (needs ${parsed.missing.join(", ")})\n`);
    return 2;
  }
  const { receive } = conversation({ sessionId: parsed.sessionId, write, record });
  for await (const line of createInterface({ input, crlfDelay: Infinity }))
    if (line.trim() !== "") receive(line);
  record({ end: { reason: "stdin closed" } });
  return 0;
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (cause) => {
      process.stderr.write(`claude-protocol-standin: ${cause?.message ?? cause}\n`);
      process.exit(1);
    },
  );
}
