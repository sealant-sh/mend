import assert from "node:assert/strict";

// Alter only this disposable child's prototype before loading production modules,
// so module initialization is held to the same legacy runtime contract.
const missingMethods = ["toSorted", "toReversed", "toSpliced", "with"];
for (const method of missingMethods) {
  assert.ok(Reflect.deleteProperty(Array.prototype, method));
  assert.equal(Array.prototype[method], undefined);
}
const { buildAgentConversation } = await import("../../src/feed.ts");
const { agentTaskOf, taskPhaseGroups } = await import("../../src/tasks.ts");

const freeze = (value) => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const turn = (id, ordinal) => ({
  id,
  ordinal,
  input: id,
  status: "completed",
  error: null,
  createdAt: "2026-10-13T00:00:00Z",
});
const item = (id, turnId, kind = "assistant-message") => ({
  id,
  turnId,
  kind,
  seq: 1,
  status: "completed",
  title: null,
  text: id,
  createdAt: "2026-10-13T00:00:02Z",
  updatedAt: "2026-10-13T00:00:02Z",
});
const request = (id, at, turnId = "turn-1") => ({
  id,
  turnId,
  kind: "command-approval",
  title: null,
  detail: null,
  questions: null,
  status: "answered",
  decision: "accept",
  answers: null,
  createdAt: at,
});
const conversation = freeze({
  turns: [turn("turn-2", 2), turn("turn-1", 1)],
  items: [
    item("orphan", "missing"),
    item("user-copy", "turn-1", "user-message"),
    item("a-child", "turn-1"),
  ],
  requests: [
    request("b-request", "2026-10-13T00:00:02Z"),
    request("early", "2026-10-13T00:00:01Z"),
    request("orphan-request", "2026-10-13T00:00:00Z", "missing"),
  ],
});
const taskItem = freeze({
  ...item("task", "turn-1", "task"),
  data: {
    taskId: "workflow",
    taskType: "local_workflow",
    status: "running",
    phases: [
      { index: 2, title: "Verify" },
      { index: 1, title: "Review" },
    ],
    agents: [
      { index: 4, label: "loose", phaseIndex: 99, state: "queued" },
      { index: 3, label: "verify", phaseIndex: 2, state: "queued" },
      { index: 2, label: "review-b", phaseIndex: 1, state: "running" },
      { index: 1, label: "review-a", phaseIndex: 1, state: "done" },
    ],
  },
});
const originalConversation = JSON.stringify(conversation);
const originalTaskItem = JSON.stringify(taskItem);

assert.deepEqual(
  buildAgentConversation(conversation).map((entry) => entry.key),
  [
    "turn:turn-1",
    "request:early",
    "item:a-child",
    "request:b-request",
    "turn:turn-2",
    "item:orphan",
    "request:orphan-request",
  ],
);
const task = agentTaskOf(taskItem);
assert.ok(task);
freeze(task);
const originalTask = JSON.stringify(task);
assert.deepEqual(
  taskPhaseGroups(task).map((group) => [group.title, group.agents.map((agent) => agent.index)]),
  [
    [null, [4]],
    ["Review", [1, 2]],
    ["Verify", [3]],
  ],
);
assert.equal(JSON.stringify(conversation), originalConversation);
assert.equal(JSON.stringify(taskItem), originalTaskItem);
assert.equal(JSON.stringify(task), originalTask);
console.log(JSON.stringify({ missingMethods, orderingChecked: true, inputsUnchanged: true }));
