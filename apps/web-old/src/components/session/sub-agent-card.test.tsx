// @vitest-environment jsdom
import type { AgentItemDto } from "@mend/agent-conversation";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ConversationView } from "#/lib/conversation";
import { conversationRows } from "#/lib/conversation-rows";

import { AgentSegments } from "./conversation.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});
const at = "2026-11-05T10:00:00.000Z";
const item = (id: string, data: unknown, extra: Partial<AgentItemDto> = {}): AgentItemDto => ({
  id,
  seq: 1,
  turnId: "turn",
  kind: "tool-call",
  status: "in-progress",
  title: "Agent",
  text: null,
  createdAt: at,
  updatedAt: at,
  data,
  ...extra,
});
const callData = {
  type: "tool_use",
  id: "toolu-parent",
  name: "Agent",
  input: {
    subagent_type: "Explore",
    description: "Find the entrypoint",
    prompt: "Read the source, then report the entrypoint.",
    model: "haiku",
  },
};
const call = item("call", callData);
const step = item(
  "step",
  {
    type: "tool_use",
    id: "toolu-child",
    parentToolUseId: "toolu-parent",
    name: "Read",
    input: { file_path: "index.ts" },
  },
  { title: "Read", status: "completed" },
);
const conversation = (
  items: ReadonlyArray<AgentItemDto>,
  status = "running",
): ConversationView => ({
  turns: [
    {
      id: "turn",
      sessionId: "s-1",
      ordinal: 1,
      origin: "request",
      author: "alice",
      input: "Inspect the source",
      status,
      error: null,
      createdAt: at,
      startedAt: at,
      endedAt: status === "running" ? null : at,
    },
  ],
  items,
  requests: [],
});
const show = async (host: HTMLElement, data: ConversationView) => {
  if (root === null) root = createRoot(host);
  const rows = conversationRows(data);
  await act(async () => {
    root?.render(
      rows.map((row) =>
        row.kind === "agent" ? (
          <div key={row.key}>
            <AgentSegments segments={row.segments} pages={new Map()} renderRequest={() => null} />
          </div>
        ) : null,
      ),
    );
  });
  return rows;
};

describe("reading delegated work", () => {
  it("keeps running and finished Agent calls as cards, with nested steps folded and result Markdown", async () => {
    const host = document.createElement("div");
    const rows = await show(host, conversation([call, step]));
    expect(host.textContent).toContain("Sub-agent · Explore");
    expect(host.textContent).toContain("running");
    expect(host.textContent).toContain("Find the entrypoint");
    expect(host.textContent).toContain("haiku");
    expect(host.textContent).toContain("1 nested step");
    expect(host.querySelector("details details")?.hasAttribute("open")).toBe(false);
    expect(rows.find((row) => row.kind === "agent")?.folded).toEqual([]);
    const outer = host.querySelector("details");
    if (outer) outer.open = true;
    await show(
      host,
      conversation(
        [
          {
            ...call,
            status: "completed",
            data: { ...callData, result: [{ type: "text", text: "**Found:** `index.ts`" }] },
          },
          step,
        ],
        "completed",
      ),
    );
    expect(host.querySelector("details")?.open).toBe(true);
    expect(host.textContent).toContain("completed");
    expect(host.querySelector("strong")?.textContent).toBe("Found:");
    expect(host.querySelector("code")?.textContent).toBe("index.ts");
    expect(host.querySelectorAll("li")).toHaveLength(1);
  });

  it("reads an unanswered Agent call as stopped once its turn was interrupted", async () => {
    const host = document.createElement("div");
    await show(host, conversation([call, step], "interrupted"));
    expect(host.textContent).toContain("stopped");
    expect(host.textContent).not.toContain("running");
  });

  it("reads a background Agent call and the task it started as one sub-agent", async () => {
    const host = document.createElement("div");
    const background = item(
      "background-call",
      {
        ...callData,
        input: { ...callData.input, run_in_background: true },
        result: [
          { type: "text", text: "Async agent launched. You'll get a completion notification." },
        ],
      },
      { status: "completed" },
    );
    const agentTask = (status: string, summary: string | null) =>
      item(
        "background-task",
        {
          taskId: "agent-1",
          taskType: "local_agent",
          workflow: null,
          description: "Find the entrypoint",
          status,
          summary,
          error: null,
          phases: [],
          agents: [],
          totalTokens: 15000,
          toolUses: 1,
          durationMs: 5500,
          toolUseId: "toolu-parent",
        },
        { kind: "task", title: null },
      );
    await show(host, conversation([background, agentTask("running", null)], "completed"));
    expect(host.textContent?.split("Find the entrypoint").length).toBe(2);
    expect(host.textContent).toContain("Background sub-agent · Explore");
    expect(host.textContent).toContain("running");
    expect(host.textContent).toContain("15k tokens");
    expect(host.textContent).not.toContain("Background task");
    expect(host.textContent).not.toContain("Async agent launched");
    await show(
      host,
      conversation([background, agentTask("completed", "Entrypoint is `index.ts`.")], "completed"),
    );
    expect(host.textContent).toContain("completed");
    expect(host.querySelector("code")?.textContent).toBe("index.ts");
  });

  it("shows a task with nothing more to say as a card that does not open", async () => {
    const host = document.createElement("div");
    const bare = item(
      "bare-task",
      {
        taskId: "agent-2",
        taskType: "local_agent",
        workflow: null,
        description: "Explore the pipeline",
        status: "running",
        summary: null,
        error: null,
        phases: [],
        agents: [],
        totalTokens: null,
        toolUses: null,
        durationMs: null,
      },
      { kind: "task", title: null },
    );
    await show(host, conversation([bare]));
    expect(host.textContent).toContain("Explore the pipeline");
    expect(host.querySelector("details")).toBeNull();
  });

  it("shows workflow phases, agent facts, result previews and updates after the turn ended", async () => {
    const host = document.createElement("div");
    const data = {
      taskId: "workflow-1",
      taskType: "local_workflow",
      workflow: "Inspect and check",
      description: "Inspect the entrypoint and run checks",
      status: "running",
      phases: [
        { index: 0, title: "Inspect" },
        { index: 1, title: "Verify" },
      ],
      agents: [
        {
          index: 0,
          label: "Reader",
          phaseIndex: 0,
          state: "done",
          model: "claude-haiku-4-5-20251001",
          tokens: 2500,
          toolCalls: 3,
          durationMs: 4500,
          lastTool: "Read",
          preview: "Entrypoint found",
        },
        {
          index: 1,
          label: "Checker",
          phaseIndex: 1,
          state: "running",
          model: "sonnet",
          tokens: 1200,
          toolCalls: 2,
          durationMs: 2000,
          lastTool: "Bash",
          preview: null,
        },
      ],
      totalTokens: 3700,
      toolUses: 5,
      durationMs: 6500,
    };
    const task = item("task", data, { kind: "task" });
    await show(host, conversation([task], "completed"));
    for (const words of [
      "Background task · Workflow",
      "Inspect and check",
      "Inspect",
      "Verify",
      "Reader",
      "Checker",
      "haiku-4-5",
      "2.5k tokens",
      "3 tools",
      "4.5",
      "Bash",
      "Entrypoint found",
      "3.7k tokens",
      "5 tool calls",
    ])
      expect(host.textContent).toContain(words);
    await show(
      host,
      conversation(
        [
          {
            ...task,
            data: { ...data, status: "completed", summary: "**Observed:** checks completed" },
          },
        ],
        "completed",
      ),
    );
    expect(host.textContent).toContain("completed");
    expect(host.querySelector("strong")?.textContent).toBe("Observed:");
  });

  it("keeps old unlinked steps flat and reads Codex collaboration calls and failed Agent results", async () => {
    const host = document.createElement("div");
    const old = item(
      "old",
      { type: "tool_use", id: "old", name: "Read", input: {} },
      { title: "Read" },
    );
    const codex = item(
      "codex",
      {
        type: "collabAgentToolCall",
        id: "codex",
        tool: "spawnAgent",
        status: "completed",
        prompt: "Inspect the docs",
        model: "gpt-6",
        agentsStates: { "thread-child": { status: "completed", message: "**Read** the docs" } },
      },
      { title: null, status: "completed" },
    );
    const rows = await show(host, conversation([call, old, codex], "completed"));
    expect(rows.find((row) => row.kind === "agent")?.folded.map((entry) => entry.id)).toEqual([
      "old",
    ]);
    expect(host.textContent).toContain("Sub-agent · spawnAgent");
    expect(host.textContent).toContain("thread-child");
    expect(host.querySelector("strong")?.textContent).toBe("Read");
    await show(
      host,
      conversation([
        { ...call, status: "failed", data: { ...callData, result: "Could not read file" } },
      ]),
    );
    expect(host.textContent).toContain("failed");
    expect(host.textContent).toContain("Could not read file");
  });
});
