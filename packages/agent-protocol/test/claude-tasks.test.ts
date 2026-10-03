import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, AgentTaskData } from "@mend/domain/workbench";
import { Effect, Queue, Stream } from "effect";

import {
  AgentTurnBusyError,
  ClaudeAdapter,
  type AgentProtocolError,
  type AgentTransport,
} from "../src/index.ts";

const SESS = "33333333-3333-4333-8333-333333333333";

const line = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const makeTransport = Effect.fn("test.makeTransport")(function* () {
  const output = yield* Queue.unbounded<Uint8Array, AgentProtocolError>();
  const transport: AgentTransport = {
    send: () => Effect.void,
    output: Stream.fromQueue(output),
    close: () => Queue.shutdown(output),
  };
  return { transport, push: (value: unknown) => Queue.offerUnsafe(output, line(value)) };
});

const agent = (index: number, state: string, extra: Record<string, unknown> = {}) => ({
  type: "workflow_agent",
  index,
  label: index === 1 ? "a" : "b",
  phaseIndex: 1,
  phaseTitle: "Say",
  model: "claude-haiku-4-5-20251001",
  state,
  queuedAt: 1,
  lastProgressAt: 2,
  ...extra,
});

/** The first turn: Claude starts a workflow, says so, and ends the turn while it runs. */
const startingTurn = [
  { type: "system", subtype: "init", uuid: "init-1", session_id: SESS },
  {
    type: "assistant",
    session_id: SESS,
    message: {
      id: "msg_1",
      content: [{ type: "tool_use", id: "toolu_wf", name: "Workflow", input: { script: "…" } }],
    },
  },
  {
    type: "system",
    subtype: "task_started",
    task_id: "wf1",
    tool_use_id: "toolu_wf",
    description: "two tiny agents",
    task_type: "local_workflow",
    workflow_name: "tiny",
    session_id: SESS,
  },
  {
    type: "system",
    subtype: "task_progress",
    task_id: "wf1",
    usage: { total_tokens: 0, tool_uses: 0, duration_ms: 55 },
    workflow_progress: [
      { type: "workflow_phase", index: 1, title: "Say" },
      agent(1, "progress", { startedAt: 3, lastToolName: "Read" }),
      agent(2, "start"),
    ],
    session_id: SESS,
  },
  {
    type: "assistant",
    session_id: SESS,
    message: { id: "msg_2", content: [{ type: "text", text: "Workflow running." }] },
  },
  { type: "result", subtype: "success", session_id: SESS },
];

/** After the turn: the workflow finishes, and Claude opens a turn of its own to report it. */
const afterTheTurn = [
  {
    type: "system",
    subtype: "task_progress",
    task_id: "wf1",
    usage: { total_tokens: 21635, tool_uses: 0, duration_ms: 3114 },
    workflow_progress: [
      { type: "workflow_phase", index: 1, title: "Say" },
      { type: "workflow_log", message: "ignored" },
      agent(2, "done", { startedAt: 3, tokens: 10817, resultPreview: "pelican" }),
      agent(1, "done", { startedAt: 3, tokens: 10818, resultPreview: "pelican" }),
    ],
    session_id: SESS,
  },
  // A progress line without a snapshot keeps the phases and agents already known.
  {
    type: "system",
    subtype: "task_progress",
    task_id: "wf1",
    usage: { total_tokens: 21635, tool_uses: 0, duration_ms: 3114 },
    session_id: SESS,
  },
  {
    type: "system",
    subtype: "task_updated",
    task_id: "wf1",
    patch: { status: "completed", end_time: 4 },
    session_id: SESS,
  },
  {
    type: "system",
    subtype: "task_notification",
    task_id: "wf1",
    status: "completed",
    summary: 'Dynamic workflow "two tiny agents" completed',
    usage: { total_tokens: 21635, tool_uses: 0, duration_ms: 3099 },
    session_id: SESS,
  },
  { type: "system", subtype: "init", uuid: "init-2", session_id: SESS },
  {
    type: "assistant",
    session_id: SESS,
    message: { id: "msg_3", content: [{ type: "text", text: "Results: pelican, pelican" }] },
  },
  {
    type: "result",
    subtype: "success",
    origin: { kind: "task-notification" },
    session_id: SESS,
  },
];

const collect = () => {
  const events: Array<AgentEvent> = [];
  return { events, onEvent: (event: AgentEvent) => Effect.sync(() => void events.push(event)) };
};

const settle = (events: ReadonlyArray<AgentEvent>, completedTurns: number) =>
  Effect.gen(function* () {
    while (events.filter((event) => event._tag === "turn.completed").length < completedTurns) {
      yield* Effect.yieldNow;
    }
  });

const items = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => (event._tag === "item.updated" ? [event.item] : []));

const isTaskData = (data: unknown): data is AgentTaskData =>
  typeof data === "object" && data !== null && "taskId" in data;

describe("ClaudeAdapter background tasks", () => {
  it.effect("records a workflow on the turn that started it, after that turn ended", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeTransport();
        const seen = collect();
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESS,
          permissionMode: "bypass",
          onEvent: seen.onEvent,
        });
        const turnId = yield* session.sendTurn("run the workflow");
        for (const wire of [...startingTurn, ...afterTheTurn]) fake.push(wire);
        yield* settle(seen.events, 2);

        const task = items(seen.events).filter((item) => item.kind === "task");
        expect(task.every((item) => item.providerItemId === "task:wf1")).toBe(true);
        expect(task.every((item) => item.providerTurnId === turnId)).toBe(true);
        // started, two snapshots, completed, notified: the snapshot-less progress line repeats
        // nothing new and is not sent again.
        expect(task.map((item) => item.status)).toEqual([
          "in-progress",
          "in-progress",
          "in-progress",
          "completed",
          "completed",
        ]);
        const first = task[1]?.data;
        if (!isTaskData(first)) throw new Error("expected task data");
        expect(first.agents.map((each) => [each.label, each.state, each.lastTool])).toEqual([
          ["a", "running", "Read"],
          ["b", "queued", null],
        ]);
        const last = task.at(-1);
        if (!isTaskData(last?.data)) throw new Error("expected task data");
        expect(last.title).toBe("Workflow tiny");
        expect(last.data).toMatchObject({
          workflow: "tiny",
          status: "completed",
          summary: 'Dynamic workflow "two tiny agents" completed',
          phases: [{ index: 1, title: "Say" }],
          totalTokens: 21635,
          durationMs: 3099,
        });
        expect(last.data.agents.map((each) => [each.index, each.state, each.preview])).toEqual([
          [1, "done", "pelican"],
          [2, "done", "pelican"],
        ]);
      }),
    ),
  );

  it.effect("opens a turn when Claude starts one on its own, and holds Mend's turn back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeTransport();
        const seen = collect();
        const session = yield* ClaudeAdapter.start(fake.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESS,
          permissionMode: "bypass",
          onEvent: seen.onEvent,
        });
        yield* session.sendTurn("run the workflow");
        for (const wire of startingTurn) fake.push(wire);
        for (const wire of afterTheTurn.slice(0, -2)) fake.push(wire);
        while (!seen.events.some((event) => event._tag === "harness-turn.started")) {
          yield* Effect.yieldNow;
        }
        const opened = seen.events.find((event) => event._tag === "harness-turn.started");
        expect(opened).toEqual({
          _tag: "harness-turn.started",
          providerTurnId: "harness:init-2",
          reason: 'Dynamic workflow "two tiny agents" completed',
        });

        const busy = yield* session.sendTurn("and another thing").pipe(Effect.flip);
        expect(busy).toBeInstanceOf(AgentTurnBusyError);

        for (const wire of afterTheTurn.slice(-2)) fake.push(wire);
        yield* settle(seen.events, 2);
        const reply = items(seen.events).find((item) => item.text === "Results: pelican, pelican");
        expect(reply?.providerTurnId).toBe("harness:init-2");
        const completed = seen.events.filter((event) => event._tag === "turn.completed");
        expect(completed.at(-1)).toMatchObject({
          providerTurnId: "harness:init-2",
          status: "completed",
        });
        // The harness turn ended: Mend's next turn goes out.
        yield* session.sendTurn("and another thing");
      }),
    ),
  );

  it.effect("replays the same turns and items after a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* makeTransport();
        const liveSeen = collect();
        const liveSession = yield* ClaudeAdapter.start(live.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESS,
          permissionMode: "bypass",
          onEvent: liveSeen.onEvent,
        });
        const turnId = yield* liveSession.sendTurn("run the workflow");
        for (const wire of [...startingTurn, ...afterTheTurn]) live.push(wire);
        yield* settle(liveSeen.events, 2);

        const replay = yield* makeTransport();
        const replaySeen = collect();
        yield* ClaudeAdapter.start(replay.transport, {
          cwd: "/workspace/repo",
          providerSessionId: SESS,
          permissionMode: "bypass",
          onEvent: replaySeen.onEvent,
          rehydrate: {
            replayProviderTurnIds: [turnId, "harness:init-2"],
            resolvedProviderRequestIds: new Set(),
          },
        });
        for (const wire of [...startingTurn, ...afterTheTurn]) replay.push(wire);
        yield* settle(replaySeen.events, 2);
        expect(items(replaySeen.events)).toEqual(items(liveSeen.events));
        // The record already holds the harness turn: replay does not open it again.
        expect(replaySeen.events.some((event) => event._tag === "harness-turn.started")).toBe(
          false,
        );
      }),
    ),
  );
});
