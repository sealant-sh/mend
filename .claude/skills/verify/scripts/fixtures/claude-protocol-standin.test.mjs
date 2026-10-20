//   node --test .claude/skills/verify/scripts/fixtures/claude-protocol-standin.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { kindFor, parseClaudeArgv } from "./claude-protocol-standin.mjs";

const STANDIN = fileURLToPath(new URL("./claude-protocol-standin.mjs", import.meta.url));
const SESSION = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";

/** Mend's protocol argv for claude with permission mode `ask` (composeProtocolArgv). */
const PROTOCOL_ARGV = [
  "--print",
  "--verbose",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--permission-prompt-tool",
  "stdio",
  "--session-id",
  SESSION,
];

const userTurn = (text) => ({
  type: "user",
  session_id: SESSION,
  parent_tool_use_id: null,
  origin: { kind: "human" },
  message: { role: "user", content: [{ type: "text", text }] },
});

const success = (requestId, response) => ({
  type: "control_response",
  response: { subtype: "success", request_id: requestId, response },
});

/** The stand-in as Mend runs it: lines in on stdin, every stdout line parsed as it arrives. */
const peer = (t, argv = PROTOCOL_ARGV) => {
  const dir = mkdtempSync(join(tmpdir(), "claude-protocol-standin-"));
  const recordFile = join(dir, "record.jsonl");
  const child = spawn(process.execPath, [STANDIN, ...argv], {
    env: { ...process.env, MEND_STANDIN_RECORD: recordFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  const out = [];
  const raw = [];
  let wake = null;
  createInterface({ input: child.stdout }).on("line", (line) => {
    raw.push(line);
    out.push(JSON.parse(line));
    wake?.();
  });
  const exited = new Promise((resolveExit) => child.on("close", (code) => resolveExit(code)));
  const next = async (predicate, what) => {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline; ) {
      const found = out.find(predicate);
      if (found !== undefined) {
        out.splice(out.indexOf(found), 1);
        return found;
      }
      await new Promise((resolveWake) => {
        wake = resolveWake;
        setTimeout(resolveWake, 100);
      });
    }
    throw new Error(`no ${what} within 5 s; saw ${JSON.stringify(out)}`);
  };
  return {
    send: (value) => child.stdin.write(`${JSON.stringify(value)}\n`),
    end: () => child.stdin.end(),
    next,
    raw,
    exited,
    record: () =>
      readFileSync(recordFile, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line)),
  };
};

const request = (one) => (line) => line.type === "control_request" && one(line);
const result = (line) => line.type === "result";

test("on start it says system init with the session id Mend named, and records its argv and uid", async (t) => {
  const standin = peer(t);
  const init = await standin.next((line) => line.type === "system", "system init");
  assert.equal(init.subtype, "init");
  assert.equal(init.session_id, SESSION);
  standin.end();
  assert.equal(await standin.exited, 0);
  const [start] = standin.record();
  assert.deepEqual(start.start.argv, PROTOCOL_ARGV);
  assert.equal(start.start.mode, "protocol");
  assert.equal(start.start.uid, process.getuid());
  assert.equal(standin.record().at(-1).end.reason, "stdin closed");
});

test("a turn asking permission sends can_use_tool for Bash pnpm db:migrate and waits for the answer", async (t) => {
  const standin = peer(t);
  standin.send(userTurn("mend-ask:permission run the migrations"));
  const asked = await standin.next(
    request(() => true),
    "a control request",
  );
  assert.equal(asked.request.subtype, "can_use_tool");
  assert.equal(asked.request.tool_name, "Bash");
  assert.deepEqual(asked.request.input, {
    command: "pnpm db:migrate",
    description: "Run the database migrations",
  });
  await new Promise((wait) => setTimeout(wait, 300));
  assert.equal(
    standin.raw.some((line) => JSON.parse(line).type === "result"),
    false,
    "the turn ended before Mend answered",
  );
  standin.send(success(asked.request_id, { behavior: "allow", updatedInput: asked.request.input }));
  const done = await standin.next(result, "the turn's result");
  assert.equal(done.subtype, "success");
  assert.equal(done.session_id, SESSION);
  const responded = standin.record().find((line) => line.responded)?.responded;
  assert.deepEqual(
    { requestId: responded.requestId, kind: responded.kind, behavior: responded.behavior },
    { requestId: asked.request_id, kind: "permission", behavior: "allow" },
  );
});

test("a declined permission is recorded as deny with Mend's message", async (t) => {
  const standin = peer(t);
  standin.send(userTurn("mend-ask:permission"));
  const asked = await standin.next(
    request(() => true),
    "a control request",
  );
  standin.send(
    success(asked.request_id, { behavior: "deny", message: "Declined by user", interrupt: false }),
  );
  await standin.next(result, "the turn's result");
  const responded = standin.record().find((line) => line.responded).responded;
  assert.equal(responded.behavior, "deny");
  assert.equal(responded.message, "Declined by user");
});

test("a question asks one single-select question, a text request one with no options; answers are recorded by id", async (t) => {
  const standin = peer(t);
  standin.send(userTurn("mend-ask:question"));
  const question = await standin.next(
    request(() => true),
    "the question",
  );
  assert.equal(question.request.tool_name, "AskUserQuestion");
  assert.deepEqual(
    question.request.input.questions.map(({ id, question: text, options, multiSelect }) => ({
      id,
      text,
      options: options.map((option) => option.label),
      multiSelect,
    })),
    [
      {
        id: "target",
        text: "Which database?",
        options: ["staging", "production"],
        multiSelect: false,
      },
    ],
  );
  standin.send(
    success(question.request_id, {
      behavior: "allow",
      updatedInput: { ...question.request.input, answers: { target: ["staging"] } },
    }),
  );
  await standin.next(result, "the question's result");
  standin.send(userTurn("mend-ask:text"));
  const text = await standin.next(
    request(() => true),
    "the free-text request",
  );
  assert.equal(text.request.tool_name, "AskUserQuestion");
  assert.deepEqual(text.request.input.questions[0].options, []);
  assert.notEqual(text.request_id, question.request_id);
  standin.send(
    success(text.request_id, {
      behavior: "allow",
      updatedInput: { ...text.request.input, answers: { name: ["add_rate_limits"] } },
    }),
  );
  await standin.next(result, "the text's result");
  assert.deepEqual(
    standin
      .record()
      .filter((line) => line.responded)
      .map((line) => line.responded.answers),
    [{ target: ["staging"] }, { name: ["add_rate_limits"] }],
  );
});

test("one request at a time: a second turn's request waits until the first is answered", async (t) => {
  const standin = peer(t);
  standin.send(userTurn("mend-ask:permission"));
  standin.send(userTurn("mend-ask:question"));
  const first = await standin.next(
    request(() => true),
    "the first request",
  );
  await new Promise((wait) => setTimeout(wait, 300));
  assert.equal(
    standin.raw.filter((line) => JSON.parse(line).type === "control_request").length,
    1,
    "the second request was asked before the first was answered",
  );
  standin.send(success(first.request_id, { behavior: "allow", updatedInput: first.request.input }));
  const second = await standin.next(
    request(() => true),
    "the second request",
  );
  assert.equal(second.request.tool_name, "AskUserQuestion");
});

test("an answer for another request id is not taken as this one's", async (t) => {
  const standin = peer(t);
  standin.send(userTurn("mend-ask:permission"));
  const asked = await standin.next(
    request(() => true),
    "a control request",
  );
  standin.send(success("someone-else", { behavior: "allow", updatedInput: {} }));
  await new Promise((wait) => setTimeout(wait, 300));
  assert.equal(
    standin.record().some((line) => line.responded),
    false,
  );
  assert.deepEqual(standin.record().find((line) => line.stray).stray, {
    requestId: "someone-else",
  });
  standin.send(success(asked.request_id, { behavior: "allow", updatedInput: asked.request.input }));
  await standin.next(result, "the result");
});

test("Mend's own control requests are answered success; an interrupt ends the open turn", async (t) => {
  const standin = peer(t);
  standin.send({
    type: "control_request",
    request_id: "init-1",
    request: { subtype: "initialize" },
  });
  const ack = await standin.next((line) => line.type === "control_response", "the initialize ack");
  assert.deepEqual(ack.response, { subtype: "success", request_id: "init-1", response: {} });
  standin.send(userTurn("mend-ask:permission"));
  await standin.next(
    request(() => true),
    "a control request",
  );
  standin.send({ type: "control_request", request_id: "int-1", request: { subtype: "interrupt" } });
  await standin.next(
    (line) => line.type === "control_response" && line.response.request_id === "int-1",
    "the interrupt ack",
  );
  const ended = await standin.next(result, "the interrupted result");
  assert.equal(ended.subtype, "error_during_execution");
  assert.equal(ended.is_error, true);
});

test("without a directive the turns ask permission, question, text in turn; mend-ask:none asks nothing", () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((ordinal) => kindFor("go on", ordinal)),
    ["permission", "question", "text", "permission"],
  );
  assert.equal(kindFor("please mend-ask:none", 1), "none");
  assert.equal(kindFor("mend-ask:text", 1), "text");
});

test("stdout carries protocol only: every line is JSON", async (t) => {
  const standin = peer(t);
  standin.send(userTurn("mend-ask:none"));
  await standin.next(result, "the result");
  standin.end();
  await standin.exited;
  for (const line of standin.raw) assert.doesNotThrow(() => JSON.parse(line), line);
});

test("--version answers and exits 0, as Mend's warm-up asks; a launch without the protocol flags is refused", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "claude-protocol-standin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, MEND_STANDIN_RECORD: join(dir, "record.jsonl") };
  const version = spawnSync(process.execPath, [STANDIN, "--version"], { env, encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /Claude Code/);
  const tui = spawnSync(process.execPath, [STANDIN, "--session-id", SESSION], {
    env,
    encoding: "utf8",
  });
  assert.equal(tui.status, 2);
  assert.equal(tui.stdout, "");
  assert.match(tui.stderr, /not a protocol launch/);
  assert.deepEqual(parseClaudeArgv(["--resume", SESSION, ...PROTOCOL_ARGV.slice(0, 9)]), {
    mode: "protocol",
    sessionId: SESSION,
    resumed: true,
  });
});
