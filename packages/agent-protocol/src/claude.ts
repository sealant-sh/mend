import type {
  AgentApprovalDecision,
  AgentEvent,
  AgentEventItem,
  AgentInputAnswers,
  AgentInputQuestion,
  AgentItemKind,
  AgentTaskData,
  AgentTurnUsage,
} from "@mend/domain/workbench";
import { PubSub, Effect, Stream } from "effect";

import { contentBlockKind } from "./claude-items.ts";
import { foldTaskLine, isTaskSubtype, taskItem } from "./claude-tasks.ts";
import type {
  ClaudeControlRequest,
  ClaudeControlResponse,
  ClaudeUserMessage,
} from "./claude-wire.ts";
import { createNdjsonDecoder } from "./ndjson.ts";
import {
  AgentProtocolError,
  AgentTurnBusyError,
  type AgentAdapter,
  type AgentBackgroundWork,
  type AgentQuiescence,
  type AgentSession,
  type AgentStartOptions,
  type AgentTransport,
} from "./types.ts";

type JsonObject = Readonly<Record<string, unknown>>;

interface PendingControl {
  readonly toolName: string;
  readonly input: JsonObject;
  readonly suggestions: ReadonlyArray<unknown>;
  readonly kind: "approval" | "input";
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const objectField = (value: unknown, key: string): JsonObject | null => {
  if (!isObject(value)) return null;
  const field = value[key];
  return isObject(field) ? field : null;
};

const stringField = (value: unknown, key: string): string | null => {
  if (!isObject(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
};

const integerField = (value: unknown, key: string): number | null => {
  if (!isObject(value)) return null;
  const field = value[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : null;
};

const protocolError = (operation: string, message: string, cause: unknown): AgentProtocolError =>
  new AgentProtocolError({ adapter: "claude", operation, message, cause });

/**
 * Prefix of a turn the harness opened itself. The rest is the `uuid` of the `system init` line
 * that opened it, so a replay of the same output names the same turn.
 */
export const CLAUDE_HARNESS_TURN_PREFIX = "harness:";

/** What a turn Claude opened on its own is answering, when no task notification said. */
const HARNESS_TURN_REASON = "Claude started a turn on its own";

/** A monitor ends on its own within this (Claude caps `timeout_ms` at 30 minutes). */
const MONITOR_MAX_MS = 30 * 60_000;
/** A wakeup fires within this (`delaySeconds` is clamped to [60, 3600]). */
const WAKEUP_MAX_MS = 60 * 60_000;
/** A session cron auto-expires after this (CronCreate's `recurring`: "auto-expired after 7 days"). */
const CRON_MAX_MS = 7 * 24 * 60 * 60_000;
/**
 * Without session-state events (a Claude older than `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`), a
 * turn's result counts as settled after this; with them, `idle` is waited for at most this long.
 */
const CLAUDE_SETTLE_MS = 1_000;
const CLAUDE_IDLE_WAIT_MS = 5_000;

const encodeLine = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const questionsFrom = (input: JsonObject): ReadonlyArray<AgentInputQuestion> | null => {
  const questions = input["questions"];
  if (!Array.isArray(questions)) return null;
  return questions.flatMap((question, index): ReadonlyArray<AgentInputQuestion> => {
    if (!isObject(question)) return [];
    const text = stringField(question, "question");
    if (text === null) return [];
    const rawOptions = question["options"];
    const options = Array.isArray(rawOptions)
      ? rawOptions.flatMap(
          (option): ReadonlyArray<{ label: string; description: string | null }> => {
            if (!isObject(option)) return [];
            const label = stringField(option, "label");
            return label === null
              ? []
              : [{ label, description: stringField(option, "description") }];
          },
        )
      : [];
    return [
      {
        id: stringField(question, "id") ?? String(index),
        header: stringField(question, "header"),
        question: text,
        options,
        multiSelect: question["multiSelect"] === true,
      },
    ];
  });
};

const usageFrom = (value: unknown): AgentTurnUsage | null => {
  if (!isObject(value)) return null;
  const inputTokens = integerField(value, "input_tokens");
  const outputTokens = integerField(value, "output_tokens");
  const cachedInputTokens =
    (integerField(value, "cache_read_input_tokens") ?? 0) +
    (integerField(value, "cache_creation_input_tokens") ?? 0);
  if (inputTokens === null && outputTokens === null && cachedInputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens:
      inputTokens === null && outputTokens === null
        ? null
        : (inputTokens ?? 0) + (outputTokens ?? 0),
    contextWindow: null,
  };
};

const sessionPermissionUpdates = (
  toolName: string,
  suggestions: ReadonlyArray<unknown>,
): ReadonlyArray<JsonObject> => {
  const scoped = suggestions.flatMap(
    (suggestion): ReadonlyArray<JsonObject> =>
      isObject(suggestion) ? [{ ...suggestion, destination: "session" }] : [],
  );
  return scoped.length > 0
    ? scoped
    : [
        {
          type: "addRules",
          rules: [{ toolName }],
          behavior: "allow",
          destination: "session",
        },
      ];
};

const controlResponse = (requestId: string, response: JsonObject): ClaudeControlResponse => ({
  type: "control_response",
  response: { subtype: "success", request_id: requestId, response },
});

/** Claude Code private stream-json adapter pinned by CLAUDE_CODE_PROTOCOL_VERSION. */
export const ClaudeAdapter: AgentAdapter = {
  start: (transport: AgentTransport, options: AgentStartOptions) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<AgentEvent>({ replay: 32 });
      const decoder = createNdjsonDecoder();
      const pending = new Map<string, PendingControl>();
      const items = new Map<string, AgentEventItem>();
      const sessionId = options.providerSessionId ?? crypto.randomUUID();
      const rehydrate = options.rehydrate;
      // Rehydrate correlation: claude turn ids are client-minted, so replayed
      // output is attributed to the dispatched turns in order — each replayed
      // `result` advances the queue exactly where sendTurn would have minted.
      const replayQueue = rehydrate === undefined ? [] : [...rehydrate.replayProviderTurnIds];
      let currentTurnId: string | null = replayQueue.shift() ?? null;
      // Anthropic streaming resets content-block indexes to 0 on every message_start, and one
      // turn holds many assistant messages (each tool round trip starts a new one). Item
      // identity therefore needs the message ordinal, and deltas need the id minted at
      // content_block_start (tool_use blocks carry a real id; text blocks get the fallback).
      let messageOrdinal = 0;
      const blockIds = new Map<number, string>();
      // The CLI echoes each completed block as its own `assistant` event whose content
      // array holds just that one block, so the array position is NOT the stream's
      // content-block index. Recover it by counting the blocks consumed per provider
      // message id; `streamingMessageId` scopes the `blockIds` lookup to the message the
      // deltas actually belong to (sub-agent echoes carry their own message ids).
      let streamingMessageId: string | null = null;
      const assistantBlockCursors = new Map<string, number>();
      let announcedSessionId: string | null = null;
      let closed = false;
      // Background tasks by task id, each held to the turn that started it: their lines keep
      // coming after that turn ended. `published` is the last item sent, to skip repeats.
      const tasks = new Map<
        string,
        { readonly providerTurnId: string; data: AgentTaskData; published: string }
      >();
      // The latest task notification, until a turn Claude opens on its own answers it.
      let notificationReason: string | null = null;
      // What a new sender's turn waits for (docs/adr/0016, decision 6). Claude says its state
      // (`session_state_changed`, with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`) and its live
      // background tasks as a level (`background_tasks_changed`); wakeups, monitors and session
      // crons are read from its tool calls and their results.
      let sessionState: string | null = null;
      /** Claude reported `idle` with no `system/init` or turn after it. */
      let idleSinceTurn = false;
      let lastResultAt: number | null = null;
      /** The last turn any line ran in: where a task first reported outside a turn sits. */
      let lastTurnId: string | null = currentTurnId;
      const background = new Map<
        string,
        { readonly type: string | null; readonly description: string; readonly ambient: boolean }
      >();
      const pausedTasks = new Map<string, string>();
      const toolNames = new Map<string, string>();
      const monitors = new Map<string, { readonly description: string; readonly until: number }>();
      const wakeups = new Map<string, number>();
      const crons = new Map<string, number>();

      const publish = (event: AgentEvent): Effect.Effect<void> =>
        (options.onEvent === undefined ? Effect.void : options.onEvent(event)).pipe(
          Effect.andThen(PubSub.publish(events, event)),
          Effect.asVoid,
        );
      const send = (value: unknown): Effect.Effect<void, AgentProtocolError> =>
        transport.send(encodeLine(value));
      const updateItem = (item: AgentEventItem): Effect.Effect<void> => {
        items.set(item.providerItemId, item);
        return publish({ _tag: "item.updated", item });
      };

      const completeContentBlocks = (envelope: JsonObject): Effect.Effect<void> => {
        if (currentTurnId === null) return Effect.void;
        const message = objectField(envelope, "message");
        const content = message?.["content"];
        if (!Array.isArray(content)) return Effect.void;
        const messageId = stringField(message, "id");
        return Effect.forEach(
          content,
          (block, position) => {
            if (!isObject(block)) return Effect.void;
            const type = stringField(block, "type");
            const streamIndex = (() => {
              if (messageId === null) return position;
              const next = assistantBlockCursors.get(messageId) ?? 0;
              assistantBlockCursors.set(messageId, next + 1);
              return next;
            })();
            const id =
              stringField(block, "id") ??
              (messageId === null || messageId === streamingMessageId
                ? blockIds.get(streamIndex)
                : undefined) ??
              (messageId === null
                ? `${currentTurnId}:m${messageOrdinal}:block:${streamIndex}`
                : `${messageId}:block:${streamIndex}`);
            const kind: AgentItemKind = contentBlockKind(type, stringField(block, "name"));
            return updateItem({
              providerItemId: id,
              providerTurnId: currentTurnId ?? "",
              kind,
              status: "completed",
              title: type === "tool_use" ? stringField(block, "name") : null,
              text: stringField(block, "text") ?? stringField(block, "thinking") ?? null,
              data: block,
            });
          },
          { discard: true },
        );
      };

      const handleStreamEvent = (message: JsonObject): Effect.Effect<void> => {
        if (currentTurnId === null) return Effect.void;
        const event = objectField(message, "event");
        if (event === null) return Effect.void;
        const eventType = stringField(event, "type");
        if (eventType === "message_start") {
          messageOrdinal += 1;
          blockIds.clear();
          streamingMessageId = stringField(objectField(event, "message"), "id");
          return Effect.void;
        }
        const index = integerField(event, "index") ?? 0;
        const fallbackId = `${currentTurnId}:m${messageOrdinal}:block:${index}`;
        if (eventType === "content_block_start") {
          const block = objectField(event, "content_block");
          if (block === null) return Effect.void;
          const type = stringField(block, "type");
          const providerItemId = stringField(block, "id") ?? fallbackId;
          blockIds.set(index, providerItemId);
          const kind: AgentItemKind = contentBlockKind(type, stringField(block, "name"));
          return updateItem({
            providerItemId,
            providerTurnId: currentTurnId,
            kind,
            status: "in-progress",
            title: type === "tool_use" ? stringField(block, "name") : null,
            text: stringField(block, "text") ?? stringField(block, "thinking"),
            data: block,
          });
        }
        if (eventType === "content_block_delta") {
          const deltaObject = objectField(event, "delta");
          const delta =
            stringField(deltaObject, "text") ?? stringField(deltaObject, "thinking") ?? "";
          if (delta === "") return Effect.void;
          const blockId = blockIds.get(index) ?? fallbackId;
          const previous = items.get(blockId);
          const item: AgentEventItem = previous ?? {
            providerItemId: blockId,
            providerTurnId: currentTurnId,
            kind:
              stringField(deltaObject, "type") === "thinking_delta"
                ? "reasoning"
                : "assistant-message",
            status: "in-progress",
            title: null,
            text: null,
            data: null,
          };
          const next = { ...item, text: `${item.text ?? ""}${delta}` };
          return publish({
            _tag: "content.delta",
            providerItemId: item.providerItemId,
            providerTurnId: currentTurnId,
            delta,
          }).pipe(Effect.andThen(updateItem(next)));
        }
        if (eventType === "content_block_stop") {
          const previous = items.get(blockIds.get(index) ?? fallbackId);
          return previous === undefined
            ? Effect.void
            : updateItem({ ...previous, status: "completed" });
        }
        return Effect.void;
      };

      const handleControlRequest = (message: JsonObject): Effect.Effect<void> => {
        const requestId = stringField(message, "request_id");
        const request = objectField(message, "request");
        if (requestId === null || request === null) return Effect.void;
        // Replay of a request answered before the restart: the harness got its
        // response long ago — re-opening (or re-answering it at close) is wrong.
        if (rehydrate !== undefined && rehydrate.resolvedProviderRequestIds.has(requestId)) {
          return Effect.void;
        }
        const subtype = stringField(request, "subtype");
        if (subtype !== "can_use_tool") {
          return send(
            controlResponse(requestId, { behavior: "deny", message: "Unsupported request" }),
          ).pipe(Effect.catch(() => Effect.void));
        }
        const toolName = stringField(request, "tool_name") ?? "tool";
        const input = objectField(request, "input") ?? {};
        const rawSuggestions = request["permission_suggestions"];
        const suggestions = Array.isArray(rawSuggestions) ? rawSuggestions : [];
        const kind = toolName === "AskUserQuestion" ? "input" : "approval";
        pending.set(requestId, { toolName, input, suggestions, kind });
        if (currentTurnId === null) {
          pending.delete(requestId);
          return send(
            controlResponse(requestId, { behavior: "deny", message: "No active turn" }),
          ).pipe(Effect.catch(() => Effect.void));
        }
        return publish({
          _tag: "request.opened",
          request: {
            providerRequestId: requestId,
            providerTurnId: currentTurnId,
            providerItemId: stringField(input, "tool_use_id"),
            kind: kind === "input" ? "user-input" : "tool-permission",
            title: toolName,
            detail: { toolName, input, suggestions },
            questions: kind === "input" ? questionsFrom(input) : null,
          },
        });
      };

      /**
       * Claude announces every turn with a `system init` line. One that arrives while no turn is
       * open is a turn Claude started on its own — after a background task or workflow ended, it
       * reads the notification and answers it. Its id comes from the line, so a replay of the
       * same output opens the same turn.
       */
      const handleInit = (message: JsonObject): Effect.Effect<void> => {
        idleSinceTurn = false;
        if (currentTurnId !== null) return Effect.void;
        // A turn Claude starts on its own after a wakeup was due is that wakeup firing.
        const now = Date.now();
        for (const [id, due] of wakeups) if (due <= now + 60_000) wakeups.delete(id);
        const uuid = stringField(message, "uuid");
        if (uuid === null) return Effect.void;
        const providerTurnId = `${CLAUDE_HARNESS_TURN_PREFIX}${uuid}`;
        currentTurnId = providerTurnId;
        lastTurnId = providerTurnId;
        messageOrdinal = 0;
        blockIds.clear();
        const reason = notificationReason ?? HARNESS_TURN_REASON;
        notificationReason = null;
        return publish({ _tag: "harness-turn.started", providerTurnId, reason });
      };

      const handleTaskLine = (subtype: string, message: JsonObject): Effect.Effect<void> => {
        const taskId = stringField(message, "task_id");
        if (taskId === null) return Effect.void;
        if (subtype === "task_notification") {
          notificationReason = stringField(message, "summary") ?? notificationReason;
          pausedTasks.delete(taskId);
          monitors.delete(taskId);
        }
        if (subtype === "task_updated") {
          const status = stringField(objectField(message, "patch"), "status");
          if (status === "paused") {
            pausedTasks.set(
              taskId,
              stringField(objectField(message, "patch"), "description") ??
                tasks.get(taskId)?.data.description ??
                "",
            );
          } else if (status !== null) {
            pausedTasks.delete(taskId);
            if (status !== "running" && status !== "pending") monitors.delete(taskId);
          }
        }
        const tracked = tasks.get(taskId);
        // A task Claude reports outside any turn (one a resumed conversation left running, or one
        // that outlived the turn that started it before Mend attached) sits on the last turn the
        // conversation ran; with none at all it is only counted as background work.
        const providerTurnId = tracked?.providerTurnId ?? currentTurnId ?? lastTurnId;
        if (providerTurnId === null) return Effect.void;
        const data = foldTaskLine(tracked?.data, subtype, message);
        if (data === null) return Effect.void;
        const item = taskItem(data, providerTurnId);
        const published = JSON.stringify(item);
        if (tracked !== undefined && tracked.published === published) return Effect.void;
        tasks.set(taskId, { providerTurnId, data, published });
        return updateItem(item);
      };

      const handleResult = (message: JsonObject): Effect.Effect<void> => {
        if (currentTurnId === null) return Effect.void;
        const providerTurnId = currentTurnId;
        const subtype = stringField(message, "subtype");
        const terminalReason = stringField(message, "terminal_reason");
        const errors = message["errors"];
        const error = Array.isArray(errors)
          ? (errors.find((candidate): candidate is string => typeof candidate === "string") ?? null)
          : null;
        const status =
          terminalReason === "aborted_tools" || terminalReason === "aborted_streaming"
            ? "interrupted"
            : subtype === "success"
              ? "completed"
              : "failed";
        lastResultAt = Date.now();
        // Replay: advance to the next dispatched turn, replicating the resets
        // sendTurn performed live so fallback item ids replay byte-identical.
        currentTurnId = replayQueue.shift() ?? null;
        if (currentTurnId !== null) {
          messageOrdinal = 0;
          blockIds.clear();
        }
        return publish({
          _tag: "turn.completed",
          providerTurnId,
          status,
          usage: usageFrom(message["usage"]),
          error,
        });
      };

      /** The tools whose results say what wakes the conversation later: by tool use id. */
      const noteToolUses = (envelope: JsonObject): void => {
        const content = objectField(envelope, "message")?.["content"];
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (stringField(block, "type") !== "tool_use") continue;
          const id = stringField(block, "id");
          const name = stringField(block, "name");
          if (id === null || name === null) continue;
          if (
            name === "Monitor" ||
            name === "ScheduleWakeup" ||
            name === "CronCreate" ||
            name === "CronDelete"
          ) {
            toolNames.set(id, name);
          }
        }
      };

      /**
       * A tool's result (`tool_use_result`, Claude's structured output): a monitor's task and
       * deadline, a wakeup's time, a session cron made or deleted. A durable cron lives in the
       * worktree, not in the session, and is not waited for here.
       */
      const noteToolResults = (envelope: JsonObject): void => {
        const content = objectField(envelope, "message")?.["content"];
        if (!Array.isArray(content)) return;
        const result = objectField(envelope, "tool_use_result");
        const now = Date.now();
        for (const block of content) {
          if (stringField(block, "type") !== "tool_result") continue;
          const id = stringField(block, "tool_use_id");
          if (id === null) continue;
          const name = toolNames.get(id);
          if (name === undefined) continue;
          toolNames.delete(id);
          if (result === null) continue;
          if (name === "Monitor") {
            const taskId = stringField(result, "taskId");
            if (taskId === null) continue;
            const timeout = integerField(result, "timeoutMs") ?? MONITOR_MAX_MS;
            monitors.set(taskId, {
              description: background.get(taskId)?.description ?? "a monitor",
              until:
                result["persistent"] === true
                  ? Number.POSITIVE_INFINITY
                  : now + Math.min(timeout === 0 ? MONITOR_MAX_MS : timeout, MONITOR_MAX_MS),
            });
          } else if (name === "ScheduleWakeup") {
            if (result["stopped"] === true) {
              wakeups.clear();
              continue;
            }
            const at = integerField(result, "scheduledFor");
            wakeups.set(id, Math.min(at ?? now + WAKEUP_MAX_MS, now + WAKEUP_MAX_MS));
          } else if (name === "CronCreate") {
            const cronId = stringField(result, "id");
            if (cronId !== null && result["durable"] !== true) crons.set(cronId, now);
          } else if (name === "CronDelete") {
            const cronId = stringField(result, "id");
            if (cronId !== null) crons.delete(cronId);
          }
        }
      };

      const handleMessage = (value: unknown): Effect.Effect<void> => {
        if (!isObject(value)) {
          return publish({ _tag: "runtime.warning", message: "Claude emitted a non-object line." });
        }
        const type = stringField(value, "type");
        const providerSessionId = stringField(value, "session_id");
        const ready =
          providerSessionId === null || providerSessionId === announcedSessionId
            ? Effect.void
            : Effect.suspend(() => {
                announcedSessionId = providerSessionId;
                return publish({ _tag: "session.ready", providerSessionId });
              });
        switch (type) {
          case "system": {
            const subtype = stringField(value, "subtype");
            if (subtype === "init") return ready.pipe(Effect.andThen(handleInit(value)));
            if (isTaskSubtype(subtype)) {
              return ready.pipe(Effect.andThen(handleTaskLine(subtype ?? "", value)));
            }
            if (subtype === "session_state_changed") {
              sessionState = stringField(value, "state");
              idleSinceTurn = sessionState === "idle";
              return ready;
            }
            if (subtype === "background_tasks_changed") {
              const listed = value["tasks"];
              background.clear();
              if (Array.isArray(listed)) {
                for (const entry of listed) {
                  const taskId = stringField(entry, "task_id");
                  if (taskId === null) continue;
                  background.set(taskId, {
                    type: stringField(entry, "task_type"),
                    description: stringField(entry, "description") ?? "",
                    ambient: isObject(entry) && entry["ambient"] === true,
                  });
                }
              }
              return ready;
            }
            return ready.pipe(
              Effect.andThen(
                publish({
                  _tag: "runtime.warning",
                  message: `Claude system message: ${subtype ?? "unknown"}`,
                }),
              ),
            );
          }
          case "stream_event":
            return ready.pipe(Effect.andThen(handleStreamEvent(value)));
          case "assistant":
            noteToolUses(value);
            return ready.pipe(Effect.andThen(completeContentBlocks(value)));
          case "user":
            noteToolResults(value);
            return ready;
          case "control_request":
            return ready.pipe(Effect.andThen(handleControlRequest(value)));
          case "result":
            return ready.pipe(Effect.andThen(handleResult(value)));
          default:
            return ready;
        }
      };

      const handleLine = (line: string): Effect.Effect<void> => {
        try {
          const value: unknown = JSON.parse(line);
          return handleMessage(value);
        } catch (cause) {
          const error = protocolError("decode", "Claude emitted malformed NDJSON.", cause);
          return publish({ _tag: "runtime.warning", message: error.message });
        }
      };

      const handleBytes = (bytes: Uint8Array): Effect.Effect<void, AgentProtocolError> =>
        Effect.forEach(decoder.push(bytes), handleLine, { discard: true }).pipe(
          Effect.andThen(
            decoder.atLineBoundary() && transport.acknowledgeOutput !== undefined
              ? transport.acknowledgeOutput()
              : Effect.void,
          ),
        );

      yield* transport.output.pipe(
        Stream.runForEach(handleBytes),
        Effect.andThen(Effect.forEach(decoder.finish(), handleLine, { discard: true })),
        Effect.tap(() =>
          currentTurnId === null
            ? Effect.void
            : publish({
                _tag: "turn.completed",
                providerTurnId: currentTurnId,
                status: "failed",
                usage: null,
                error: "Claude process ended during the turn.",
              }),
        ),
        Effect.tap(() =>
          publish({ _tag: "runtime.error", message: "Claude process output ended." }),
        ),
        Effect.catch((error) =>
          publish({ _tag: "runtime.error", message: `Claude transport ended: ${error.message}` }),
        ),
        Effect.forkScoped,
      );

      announcedSessionId = sessionId;
      yield* publish({ _tag: "session.ready", providerSessionId: sessionId });

      const sendTurn = Effect.fn("ClaudeAdapter.sendTurn")(function* (input: string) {
        if (currentTurnId?.startsWith(CLAUDE_HARNESS_TURN_PREFIX) === true) {
          return yield* new AgentTurnBusyError({ providerTurnId: currentTurnId });
        }
        if (currentTurnId !== null) {
          return yield* protocolError(
            "sendTurn",
            "Claude already has a turn in progress.",
            currentTurnId,
          );
        }
        const providerTurnId = crypto.randomUUID();
        currentTurnId = providerTurnId;
        lastTurnId = providerTurnId;
        idleSinceTurn = false;
        messageOrdinal = 0;
        blockIds.clear();
        const message: ClaudeUserMessage = {
          type: "user",
          session_id: sessionId,
          parent_tool_use_id: null,
          origin: { kind: "human" },
          message: { role: "user", content: [{ type: "text", text: input }] },
        };
        yield* send(message).pipe(Effect.tapError(() => Effect.sync(() => (currentTurnId = null))));
        yield* publish({ _tag: "turn.started", providerTurnId });
        return providerTurnId;
      });

      const interrupt = Effect.fn("ClaudeAdapter.interrupt")(function* () {
        if (currentTurnId === null) return;
        const request: ClaudeControlRequest = {
          type: "control_request",
          request_id: crypto.randomUUID(),
          request: { subtype: "interrupt" },
        };
        yield* send(request);
      });

      const respond = Effect.fn("ClaudeAdapter.respond")(function* (
        providerRequestId: string,
        decision: AgentApprovalDecision,
      ) {
        const request = pending.get(providerRequestId);
        if (request === undefined || request.kind !== "approval") {
          return yield* protocolError(
            "respond",
            `Unknown Claude approval request ${providerRequestId}.`,
            null,
          );
        }
        const response: JsonObject =
          decision === "accept" || decision === "accept-for-session"
            ? {
                behavior: "allow",
                updatedInput: request.input,
                ...(decision === "accept-for-session"
                  ? {
                      updatedPermissions: sessionPermissionUpdates(
                        request.toolName,
                        request.suggestions,
                      ),
                    }
                  : {}),
              }
            : {
                behavior: "deny",
                message: decision === "cancel" ? "Cancelled by user" : "Declined by user",
                interrupt: decision === "cancel",
              };
        yield* send(controlResponse(providerRequestId, response));
        pending.delete(providerRequestId);
      });

      const respondInput = Effect.fn("ClaudeAdapter.respondInput")(function* (
        providerRequestId: string,
        answers: AgentInputAnswers,
      ) {
        const request = pending.get(providerRequestId);
        if (request === undefined || request.kind !== "input") {
          return yield* protocolError(
            "respondInput",
            `Unknown Claude user-input request ${providerRequestId}.`,
            null,
          );
        }
        yield* send(
          controlResponse(providerRequestId, {
            behavior: "allow",
            updatedInput: { ...request.input, answers },
          }),
        );
        pending.delete(providerRequestId);
      });

      /**
       * Claude is quiescent (docs/adr/0016, decision 6) with no open turn, `idle` reported with no
       * turn after it, no live background task (an ambient one aside, unless a monitor started
       * it), no task it paused, no pending wakeup, no live monitor and no session cron.
       */
      const quiescence = (): Effect.Effect<AgentQuiescence> =>
        Effect.sync(() => {
          const now = Date.now();
          for (const [id, due] of wakeups) if (due <= now) wakeups.delete(id);
          for (const [id, monitor] of monitors) if (monitor.until <= now) monitors.delete(id);
          for (const [id, made] of crons) if (made + CRON_MAX_MS <= now) crons.delete(id);
          const work: Array<AgentBackgroundWork> = [];
          for (const [id, task] of background) {
            if (monitors.has(id) || pausedTasks.has(id) || task.ambient) continue;
            work.push({
              kind: task.type === "local_agent" ? "sub-agent" : "task",
              id,
              description: task.description,
              endable: true,
            });
          }
          for (const [id, description] of pausedTasks) {
            work.push({ kind: "paused-task", id, description, endable: true });
          }
          for (const [id, monitor] of monitors) {
            // A monitor is a task: `stop_task` ends it, a persistent one included (review of
            // mend#572, P3-2).
            work.push({ kind: "monitor", id, description: monitor.description, endable: true });
          }
          for (const id of wakeups.keys()) {
            work.push({ kind: "wakeup", id, description: null, endable: false });
          }
          for (const id of crons.keys()) {
            work.push({ kind: "cron", id, description: null, endable: false });
          }
          const openTurn =
            currentTurnId !== null ||
            sessionState === "running" ||
            sessionState === "requires_action";
          const sinceResult = lastResultAt === null ? Number.POSITIVE_INFINITY : now - lastResultAt;
          const settleMs =
            sessionState === null
              ? Math.max(0, CLAUDE_SETTLE_MS - sinceResult)
              : idleSinceTurn
                ? 0
                : Math.max(0, CLAUDE_IDLE_WAIT_MS - sinceResult);
          return {
            quiescent: !openTurn && work.length === 0 && settleMs === 0,
            openTurn,
            work,
            settleMs,
          } satisfies AgentQuiescence;
        });

      /** A background task stopped from the waiting line: Claude's `stop_task`. */
      const endWork = Effect.fn("ClaudeAdapter.endWork")(function* (
        work: Pick<AgentBackgroundWork, "kind" | "id">,
      ) {
        if (
          work.kind !== "task" &&
          work.kind !== "paused-task" &&
          work.kind !== "sub-agent" &&
          work.kind !== "monitor"
        ) {
          return yield* protocolError(
            "endWork",
            `Claude ends a ${work.kind} on its own; Mend cannot stop it.`,
            null,
          );
        }
        const request: ClaudeControlRequest = {
          type: "control_request",
          request_id: crypto.randomUUID(),
          request: { subtype: "stop_task", task_id: work.id },
        };
        yield* send(request);
      });

      const close = Effect.fn("ClaudeAdapter.close")(function* () {
        if (closed) return;
        closed = true;
        for (const providerRequestId of pending.keys()) {
          yield* send(
            controlResponse(providerRequestId, {
              behavior: "deny",
              message: "Mend closed the protocol session.",
              interrupt: true,
            }),
          ).pipe(Effect.ignore);
        }
        pending.clear();
        yield* transport.close();
        yield* PubSub.shutdown(events);
      });

      // A Mend that restarted re-asks Claude for its background tasks (decision 6): a repeated
      // `initialize` is answered with the current set, which the replay of the recorded output
      // has already rebuilt for a CLI that does not send it.
      if (rehydrate !== undefined && options.steering === true) {
        const reinitialize: ClaudeControlRequest = {
          type: "control_request",
          request_id: crypto.randomUUID(),
          request: { subtype: "initialize" },
        };
        yield* send(reinitialize).pipe(Effect.ignore);
      }

      return {
        sendTurn,
        interrupt,
        respond,
        respondInput,
        events: Stream.fromPubSub(events),
        quiescence,
        endWork,
        close,
      } satisfies AgentSession;
    }),
};
