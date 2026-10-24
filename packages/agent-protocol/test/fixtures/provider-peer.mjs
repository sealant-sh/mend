// Synthetic protocol peer, not a provider binary. These literal wire exchanges are an
// independent test oracle; this file imports no Mend adapter or launch implementation.
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const harness = args[0];
const record = process.env["FIXTURE_RECORD"];
assert.ok(record);
const scenario = process.env["FIXTURE_SCENARIO"];
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const STEER_ID = "6f1d2c3b-9a8e-4f70-8d61-5c4b3a291807";
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
const read = async () => {
  const next = await lines.next();
  assert.equal(next.done, false, "expected another protocol command");
  const value = JSON.parse(next.value);
  appendFileSync(record, `${JSON.stringify(value)}\n`);
  return value;
};
writeFileSync(record, `${JSON.stringify({ argv: args })}\n`);
if (scenario === "hang") {
  // A scoped cancellation must terminate a peer that neither replies nor exits on stdin EOF.
  input.close();
  process.stdin.resume();
  process.stderr.write("synthetic hang ready\n");
  setInterval(() => {}, 1000);
} else if (harness === "codex") {
  assert.deepEqual(args, ["codex", "app-server"]);
  const initialize = await read();
  assert.equal(initialize.method, "initialize");
  assert.equal(initialize.params.clientInfo.name, "mend");
  emit({ id: initialize.id, result: {} });
  assert.deepEqual(await read(), { method: "initialized" });
  const thread = await read();
  assert.equal(
    thread.method,
    scenario === "resume" || scenario === "resume-refused" ? "thread/resume" : "thread/start",
  );
  assert.equal(thread.params.cwd, process.env["FIXTURE_CWD"]);
  assert.equal(thread.params.approvalPolicy, "on-request");
  assert.equal(thread.params.sandbox, "danger-full-access");
  if (scenario === "resume" || scenario === "resume-refused") {
    assert.equal(thread.params.threadId, "thread-owned");
    assert.equal(thread.params.path, process.env["FIXTURE_RESUME_PATH"]);
    assert.equal(initialize.params.capabilities.experimentalApi, true);
  }
  if (scenario === "resume-refused") {
    emit({
      id: thread.id,
      error: { code: -32000, message: "no rollout found for thread id thread-owned" },
    });
  } else if (scenario === "steer") {
    emit({ id: thread.id, result: { thread: { id: "thread-owned" } } });
    const turn = await read();
    assert.equal(turn.method, "turn/start");
    emit({ id: turn.id, result: { turn: { id: "turn-1" } } });
    emit({ method: "turn/started", params: { threadId: "thread-owned", turn: { id: "turn-1" } } });
    const steer = await read();
    assert.deepEqual(steer, {
      method: "turn/steer",
      id: steer.id,
      params: {
        threadId: "thread-owned",
        input: [{ type: "text", text: "steer fixture" }],
        expectedTurnId: "turn-1",
      },
    });
    emit({ id: steer.id, result: { turnId: "turn-1" } });
    emit({
      method: "item/completed",
      params: {
        threadId: "thread-owned",
        turnId: "turn-1",
        item: { id: "steer-echo", type: "userMessage", clientId: null, content: [] },
      },
    });
    emit({
      method: "item/completed",
      params: {
        threadId: "thread-owned",
        turnId: "turn-1",
        item: { id: "message-steered", type: "agentMessage", text: "steered fixture" },
      },
    });
    emit({
      method: "turn/completed",
      params: { threadId: "thread-owned", turn: { id: "turn-1", status: "completed" } },
    });
  } else {
    emit({ id: thread.id, result: { thread: { id: "thread-owned" } } });
    for (const ordinal of [1, 2]) {
      const turn = await read();
      assert.equal(turn.method, "turn/start");
      assert.deepEqual(turn.params, {
        threadId: "thread-owned",
        input: [{ type: "text", text: ordinal === 1 ? "inspect fixture" : "interrupt fixture" }],
        model: "fixture-model",
        effort: "high",
      });
      const turnId = `turn-${ordinal}`;
      emit({ id: turn.id, result: { turn: { id: turnId } } });
      emit({ method: "turn/started", params: { threadId: "thread-owned", turn: { id: turnId } } });
      if (ordinal === 1) {
        emit({
          id: 41,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-owned",
            turnId,
            itemId: "tool-owned",
            command: ["echo", "fixture"],
          },
        });
        assert.deepEqual(await read(), { id: 41, result: { decision: "acceptForSession" } });
        emit({
          method: "item/completed",
          params: {
            threadId: "thread-owned",
            turnId,
            item: { id: "message-owned", type: "agentMessage", text: "héllo fixture" },
          },
        });
        emit({
          method: "turn/completed",
          params: { threadId: "thread-owned", turn: { id: turnId, status: "completed" } },
        });
      } else {
        const interrupt = await read();
        assert.equal(interrupt.method, "turn/interrupt");
        assert.deepEqual(interrupt.params, { threadId: "thread-owned", turnId });
        emit({ id: interrupt.id, result: {} });
        appendFileSync(record, `${JSON.stringify({ accepted: true })}\n`);
        emit({
          method: "turn/completed",
          params: { threadId: "thread-owned", turn: { id: turnId, status: "interrupted" } },
        });
      }
    }
  }
  for await (const line of input) assert.fail(`unexpected command after scenario: ${line}`);
} else {
  assert.equal(harness, "claude");
  const sessionFlag = scenario === "resume" ? "--resume" : "--session-id";
  const sessionId = args[args.indexOf(sessionFlag) + 1];
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(args, [
    "claude",
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    sessionFlag,
    sessionId,
    "--model",
    "fixture-model",
    "--effort",
    "high",
  ]);
  emit({ type: "system", subtype: "init", session_id: sessionId, tools: ["Edit"] });
  const human = (text, steer) => ({
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    origin: { kind: "human" },
    message: { role: "user", content: [{ type: "text", text }] },
    ...steer,
  });
  if (scenario === "steer") {
    assert.deepEqual(await read(), human("steer fixture start"));
    assert.deepEqual(await read(), human("steer fixture", { priority: "now", uuid: STEER_ID }));
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      uuid: "segment-aborted",
      session_id: sessionId,
      usage: { input_tokens: 0, output_tokens: 0 },
      errors: ["Error: Request was aborted."],
    });
    emit({ type: "system", subtype: "init", uuid: "segment-continued", session_id: sessionId });
    emit({
      type: "assistant",
      session_id: sessionId,
      message: { id: "message-steered", content: [{ type: "text", text: "steered fixture" }] },
    });
    emit({
      type: "result",
      subtype: "success",
      uuid: "segment-final",
      session_id: sessionId,
      usage: { input_tokens: 3, output_tokens: 6 },
    });
  }
  for (const ordinal of scenario === "steer" ? [] : [1, 2]) {
    assert.deepEqual(await read(), {
      type: "user",
      session_id: sessionId,
      parent_tool_use_id: null,
      origin: { kind: "human" },
      message: {
        role: "user",
        content: [{ type: "text", text: ordinal === 1 ? "inspect fixture" : "interrupt fixture" }],
      },
    });
    if (ordinal === 1) {
      emit({
        type: "control_request",
        request_id: "permission-owned",
        request: {
          subtype: "can_use_tool",
          tool_name: "Edit",
          input: { file_path: "fixture.txt" },
        },
      });
      assert.deepEqual(await read(), {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "permission-owned",
          response: {
            behavior: "allow",
            updatedInput: { file_path: "fixture.txt" },
            updatedPermissions: [
              {
                type: "addRules",
                rules: [{ toolName: "Edit" }],
                behavior: "allow",
                destination: "session",
              },
            ],
          },
        },
      });
      emit({
        type: "assistant",
        session_id: sessionId,
        message: { id: "message-owned", content: [{ type: "text", text: "héllo fixture" }] },
      });
      emit({ type: "result", subtype: "success", session_id: sessionId });
    } else {
      const interrupt = await read();
      assert.equal(interrupt.type, "control_request");
      assert.match(interrupt.request_id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(interrupt.request, { subtype: "interrupt" });
      appendFileSync(record, `${JSON.stringify({ accepted: true })}\n`);
      emit({
        type: "result",
        subtype: "error_during_execution",
        session_id: sessionId,
        is_error: true,
        errors: ["Synthetic interrupted turn"],
      });
    }
  }
  for await (const line of input) assert.fail(`unexpected command after scenario: ${line}`);
}
