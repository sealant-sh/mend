import { describe, expect, it } from "vitest";

/** Durations hold each number to its unit with a no-break space; read them with plain ones. */
const plain = (text: string | null | undefined) => text?.replaceAll("\u00a0", " ");

import type { AgentItemDto } from "./feed.ts";
import {
  agentFacts,
  agentTaskOf,
  compactCount,
  durationWords,
  isHarnessTurn,
  taskFacts,
  taskPhaseGroups,
} from "./tasks.ts";

const taskItem = (data: unknown): AgentItemDto => ({
  id: "item-task",
  seq: 3,
  turnId: "turn-1",
  kind: "task",
  status: "in-progress",
  title: "Workflow review",
  text: "review the change",
  data,
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:05.000Z",
});

const agent = (index: number, phaseIndex: number | null, state: string) => ({
  index,
  label: `agent ${index}`,
  phaseIndex,
  state,
  model: "claude-haiku-4-5-20251001",
  tokens: state === "done" ? 10_818 : null,
  toolCalls: state === "queued" ? null : 4,
  durationMs: state === "done" ? 1943 : null,
  lastTool: state === "running" ? "Grep" : null,
  preview: state === "done" ? "pelican" : null,
});

const workflow = {
  taskId: "wf1",
  taskType: "local_workflow",
  workflow: "review",
  description: "review the change",
  status: "running",
  summary: null,
  error: null,
  phases: [
    { index: 2, title: "Verify" },
    { index: 1, title: "Review" },
  ],
  agents: [agent(3, 2, "queued"), agent(1, 1, "done"), agent(2, 1, "running")],
  totalTokens: 21_635,
  toolUses: 8,
  durationMs: 252_000,
};

describe("agentTaskOf", () => {
  it("reads a workflow's phases and agents from a task item", () => {
    const task = agentTaskOf(taskItem(workflow));
    expect(task).not.toBeNull();
    if (task === null) return;
    expect(
      taskPhaseGroups(task).map((group) => [group.title, group.agents.map((a) => a.index)]),
    ).toEqual([
      ["Review", [1, 2]],
      ["Verify", [3]],
    ]);
    expect(plain(taskFacts(task))).toBe("1/3 agents done · 22k tokens · 8 tool calls · 4 min 12 s");
    const [done, running, queued] = task.agents.toSorted((a, b) => a.index - b.index);
    expect(plain(done && agentFacts(done))).toBe("haiku-4-5 · 11k tokens · 4 tools · 1.9 s");
    expect(running && agentFacts(running)).toBe("haiku-4-5 · 4 tools · Grep");
    expect(queued && agentFacts(queued)).toBe("haiku-4-5");
  });

  it("keeps agents no phase claims, and skips entries it cannot read", () => {
    const task = agentTaskOf(
      taskItem({
        ...workflow,
        phases: [],
        agents: [agent(1, null, "done"), { index: "x" }, null],
      }),
    );
    expect(task?.agents).toHaveLength(1);
    expect(task && taskPhaseGroups(task)).toEqual([{ title: null, agents: task?.agents }]);
  });

  it("reads nothing from an item that is not a task, or carries no task", () => {
    expect(agentTaskOf({ ...taskItem(workflow), kind: "tool-call" })).toBeNull();
    expect(agentTaskOf(taskItem(null))).toBeNull();
    expect(agentTaskOf({ ...taskItem(workflow), data: undefined })).toBeNull();
    expect(agentTaskOf(taskItem({ taskId: "wf1" }))).toBeNull();
  });
});

describe("task words", () => {
  it("writes counts and durations short", () => {
    expect(compactCount(950)).toBe("950");
    expect(compactCount(1_250)).toBe("1.3k");
    expect(compactCount(21_635)).toBe("22k");
    expect(compactCount(3_400_000)).toBe("3.4M");
    expect(plain(durationWords(3_114))).toBe("3.1 s");
    expect(plain(durationWords(42_000))).toBe("42 s");
    expect(plain(durationWords(3_780_000))).toBe("1 h 3 min");
  });

  it("tells a turn the agent opened from one Mend sent", () => {
    expect(isHarnessTurn({ origin: "harness" })).toBe(true);
    expect(isHarnessTurn({ origin: "request" })).toBe(false);
    expect(isHarnessTurn({})).toBe(false);
  });
});
