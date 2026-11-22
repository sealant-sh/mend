import { turnSelectionOf, turnSelectionRefusal, type TurnSelection } from "@mend/domain/workbench";
import type {
  AgentApprovalDecision,
  AgentEvent,
  AgentEventItem,
  AgentInputAnswers,
  AgentItemKind,
  AgentItemStatus,
  AgentRequestKind,
  AgentTurnUsage,
} from "@mend/domain/workbench";
import { Data, Deferred, Effect, PubSub, Stream } from "effect";

import { withoutEndpoint } from "./endpoint-words.ts";
import { createNdjsonDecoder } from "./ndjson.ts";
import {
  AgentProtocolError,
  AgentSteerRefusedError,
  AgentTurnDeliveryError,
  type AgentAdapter,
  type AgentQuiescence,
  type AgentSession,
  type AgentStartOptions,
  type AgentSteerInput,
  type AgentTransport,
} from "./types.ts";

/**
 * Antigravity (`agy acp --stdio`) over the Agent Client Protocol: JSON-RPC 2.0, one message per
 * line. Checked against agy 1.5.13 (2026-11-22): `initialize`, `authenticate` with
 * `oauth-personal`, `session/new` or `session/resume`, `session/set_config_option` (`model`,
 * `thought_level`, `mode`), `session/prompt`, whose answer arrives when the turn ends, and the
 * `session/cancel` notification. The agent streams `session/update` notifications that carry no
 * turn id: everything between a prompt and its answer belongs to that prompt's turn.
 */

type JsonObject = Readonly<Record<string, unknown>>;
type JsonRpcId = string | number;

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

const rpcId = (value: unknown): JsonRpcId | null =>
  typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : null;

const requestKey = (id: JsonRpcId): string => `${typeof id === "number" ? "n" : "s"}:${id}`;

/**
 * A prompt's JSON-RPC id names its turn, so the answer finds the turn it ends even when it is read
 * again after a Mend restart, from the output the previous Mend process saw.
 */
const PROMPT_ID_PREFIX = "p:";
const promptIdOf = (turnId: string): string => `${PROMPT_ID_PREFIX}${turnId}`;
const turnOfPromptId = (id: JsonRpcId): string | null =>
  typeof id === "string" && id.startsWith(PROMPT_ID_PREFIX)
    ? id.slice(PROMPT_ID_PREFIX.length)
    : null;

/** Long tool output is kept from its end, where a command reports how it finished. */
const TEXT_LIMIT = 32_000;
const bounded = (text: string): string =>
  text.length <= TEXT_LIMIT ? text : `[earlier output cut]\n${text.slice(-TEXT_LIMIT)}`;

const encodeLine = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const protocolError = (operation: string, message: string, cause: unknown): AgentProtocolError =>
  new AgentProtocolError({ adapter: "antigravity", operation, message, cause });

const turnUndelivered = (
  certainty: AgentTurnDeliveryError["certainty"],
  message: string,
  cause: unknown,
) => new AgentTurnDeliveryError({ adapter: "antigravity", certainty, message, cause });

class AcpRejected extends Data.TaggedError("AcpRejected")<{
  readonly message: string;
  readonly error: JsonObject;
}> {}

class AcpNotSent extends Data.TaggedError("AcpNotSent")<{ readonly error: AgentProtocolError }> {}

class AcpMaybeSent extends Data.TaggedError("AcpMaybeSent")<{
  readonly error: AgentProtocolError;
}> {}

type AcpFailure = AcpRejected | AcpNotSent | AcpMaybeSent;

/** What a resume of a conversation agy cannot read says: nothing was sent. */
export const ANTIGRAVITY_CONVERSATION_NOT_FOUND =
  "Antigravity could not find this conversation. Nothing was sent.";

/** agy 1.5.13's words for `session/resume` of a conversation it has no file for. */
const CONVERSATION_NOT_FOUND = /^Failed to read session \S+/;

/** The ACP tool kinds, as Mend's item kinds. */
const toolItemKind = (kind: string | null): AgentItemKind => {
  switch (kind) {
    case "execute":
      return "command-execution";
    case "edit":
    case "delete":
    case "move":
      return "file-change";
    default:
      return "tool-call";
  }
};

const toolItemStatus = (status: string | null): AgentItemStatus => {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "in-progress";
  }
};

const requestKindOf = (toolKind: string | null): AgentRequestKind => {
  switch (toolItemKind(toolKind)) {
    case "command-execution":
      return "command-approval";
    case "file-change":
      return "file-change-approval";
    default:
      return "tool-permission";
  }
};

/** The command a native shell tool ran: agy names it `CommandLine`. */
const commandOf = (input: unknown): string | null =>
  stringField(input, "CommandLine") ??
  stringField(input, "command_line") ??
  stringField(input, "commandLine") ??
  stringField(input, "command");

const cwdOf = (input: unknown): string | null =>
  stringField(input, "Cwd") ??
  stringField(input, "cwd") ??
  stringField(input, "WorkingDirectory") ??
  stringField(input, "working_dir");

const linesOf = (text: string): ReadonlyArray<string> =>
  text === "" ? [] : text.replace(/\n$/, "").split("\n");

/** A diff of an ACP `diff` content block, in the unified shape the web shows. */
const diffOf = (path: string, oldText: string | null, newText: string): string =>
  [
    `--- ${oldText === null ? "/dev/null" : path}`,
    `+++ ${path}`,
    ...linesOf(oldText ?? "").map((line) => `-${line}`),
    ...linesOf(newText).map((line) => `+${line}`),
  ].join("\n");

/** The data of a tool call item: what the web reads for a command or an edit, and the rest. */
const toolData = (call: JsonObject, kind: AgentItemKind): JsonObject => {
  const input = call["rawInput"] ?? call["args"] ?? null;
  const output = call["rawOutput"] ?? null;
  const base = {
    toolName: stringField(call, "name"),
    toolKind: stringField(call, "kind"),
    input,
  };
  if (kind === "command-execution") {
    const text = stringField(output, "output") ?? stringField(output, "combinedOutput");
    return {
      ...base,
      command: commandOf(input),
      cwd: cwdOf(input),
      aggregatedOutput: text === null ? null : bounded(text),
      exitCode: integerField(output, "exit_code") ?? integerField(output, "exitCode"),
    };
  }
  if (kind === "file-change") {
    const content = Array.isArray(call["content"]) ? call["content"].filter(isObject) : [];
    const changes = content.flatMap((block) => {
      const path = stringField(block, "path");
      const newText = stringField(block, "newText");
      if (stringField(block, "type") !== "diff" || path === null || newText === null) return [];
      return [{ path, diff: bounded(diffOf(path, stringField(block, "oldText"), newText)) }];
    });
    const locations = Array.isArray(call["locations"])
      ? call["locations"].flatMap((location) => {
          const path = stringField(location, "path");
          return path === null ? [] : [{ path, diff: null }];
        })
      : [];
    return { ...base, changes: changes.length > 0 ? changes : locations };
  }
  return {
    ...base,
    output: typeof output === "string" ? bounded(output) : output,
    locations: call["locations"] ?? null,
  };
};

const usageOf = (
  result: unknown,
  context: { readonly used: number; readonly size: number } | null,
): AgentTurnUsage | null => {
  const usage = objectField(result, "usage");
  if (usage === null && context === null) return null;
  return {
    inputTokens: integerField(usage, "inputTokens"),
    outputTokens: integerField(usage, "outputTokens"),
    cachedInputTokens: integerField(usage, "cachedReadTokens"),
    totalTokens: integerField(usage, "totalTokens"),
    contextWindow: context?.size ?? null,
    ...(context === null ? {} : { contextTokens: context.used }),
  };
};

/** How a turn ended, by its `stopReason`. */
const completionOf = (
  stopReason: string | null,
): { readonly status: "completed" | "interrupted" | "failed"; readonly error: string | null } => {
  switch (stopReason) {
    case "cancelled":
      return { status: "interrupted", error: null };
    case "refusal":
      return { status: "failed", error: "Antigravity refused to continue this turn." };
    case "max_tokens":
      return { status: "failed", error: "Antigravity stopped: the reply reached its token limit." };
    case "max_turn_requests":
      return {
        status: "failed",
        error: "Antigravity stopped: the turn reached its request limit.",
      };
    default:
      return { status: "completed", error: null };
  }
};

/**
 * agy asks its own questions through `session/request_permission` too: their tool call ids start
 * `interaction_` and their options are the answers, not approvals.
 */
const isQuestion = (toolCall: JsonObject | null): boolean =>
  stringField(toolCall, "toolCallId")?.startsWith("interaction_") === true;

interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string | null;
}

const optionsOf = (params: JsonObject): ReadonlyArray<PermissionOption> => {
  const options = params["options"];
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    const optionId = stringField(option, "optionId");
    if (optionId === null || optionId.trim() === "") return [];
    return [
      {
        optionId,
        name: stringField(option, "name") ?? optionId,
        kind: stringField(option, "kind"),
      },
    ];
  });
};

const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });
const CANCELLED = { outcome: { outcome: "cancelled" } } as const;

/** The option a decision picks: the exact kind, else its nearest one, else none. */
const optionFor = (
  options: ReadonlyArray<PermissionOption>,
  decision: AgentApprovalDecision,
): PermissionOption | null => {
  const preference: ReadonlyArray<string> =
    decision === "accept"
      ? ["allow_once", "allow_always"]
      : decision === "accept-for-session"
        ? ["allow_always", "allow_once"]
        : decision === "decline"
          ? ["reject_once", "reject_always"]
          : [];
  for (const kind of preference) {
    const option = options.find((entry) => entry.kind === kind);
    if (option !== undefined) return option;
  }
  return null;
};

interface PendingRpc {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, AcpRejected | AgentProtocolError>;
}

interface PendingServerRequest {
  readonly id: JsonRpcId;
  readonly turnId: string;
  readonly kind: "approval" | "input";
  readonly questionId: string | null;
  readonly options: ReadonlyArray<PermissionOption>;
}

/** One stretch of streamed words: the agent's message or its thinking, until something else. */
interface Segment {
  readonly kind: "assistant-message" | "reasoning";
  readonly itemId: string;
}

/** The ACP config option ids agy takes for a turn's choices. */
const MODEL_OPTION = "model";
const EFFORT_OPTION = "thought_level";
const MODE_OPTION = "mode";
/**
 * agy's mode for a turn that is not Plan. Never the mode a resumed conversation reports, which can
 * be a Plan turn's.
 */
const DEFAULT_MODE = "default";

interface ConfigState {
  model: string | null;
  effort: string | null;
  mode: string | null;
}

/** Antigravity's ACP stdio server, as a Mend protocol adapter. */
export const AntigravityAdapter: AgentAdapter = {
  start: (transport: AgentTransport, options: AgentStartOptions) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<AgentEvent>({ replay: 32 });
      const pendingRpc = new Map<string, PendingRpc>();
      const pendingServer = new Map<string, PendingServerRequest>();
      const items = new Map<string, AgentEventItem>();
      /** Each tool call as its updates built it up, by tool call id. */
      const calls = new Map<string, JsonObject>();
      const decoder = createNdjsonDecoder();
      const rehydrate = options.rehydrate;
      // Ids of this Mend process's own requests never match an answer to a previous one's.
      const rpcIdPrefix = `m${crypto.randomUUID().slice(0, 8)}`;
      let nextId = 0;
      let sessionId: string | null = null;
      /**
       * Turns started and not yet answered, oldest first. agy runs one prompt at a time, so the
       * first is the one every `session/update` is about.
       */
      const openTurns: Array<string> = [];
      const permissionOfTurn = new Map<string, "bypass" | "ask">();
      const segments = new Map<string, { open: Segment | null; count: number }>();
      /** What the session runs with now, and what it started with (a null choice restores it). */
      const applied: ConfigState = { model: null, effort: null, mode: null };
      const defaults: Omit<ConfigState, "mode"> = { model: null, effort: null };
      let context: { used: number; size: number } | null = null;
      let transportFailure: AgentProtocolError | null = null;
      const readTransportFailure = (): AgentProtocolError | null => transportFailure;
      let closed = false;

      if (rehydrate !== undefined) {
        openTurns.push(...rehydrate.replayProviderTurnIds);
        for (const turnId of rehydrate.replayProviderTurnIds) {
          const mode = rehydrate.turnSelections?.get(turnId)?.permissionMode;
          if (mode !== undefined) permissionOfTurn.set(turnId, mode);
        }
      }

      const publish = (harnessEvent: AgentEvent): Effect.Effect<void> => {
        const event = withoutEndpoint(harnessEvent, options.endpoint);
        return (options.onEvent === undefined ? Effect.void : options.onEvent(event)).pipe(
          Effect.andThen(PubSub.publish(events, event)),
          Effect.asVoid,
        );
      };

      const send = (value: JsonObject): Effect.Effect<void, AgentProtocolError> =>
        transport.send(encodeLine({ jsonrpc: "2.0", ...value }));

      /** agy answers every request but a prompt at once; a quiet minute means it is stuck. */
      const REQUEST_TIMEOUT = "60 seconds";

      const call = Effect.fn("AntigravityAdapter.call")(function* (
        method: string,
        params: JsonObject,
      ) {
        if (transportFailure !== null) return yield* new AcpNotSent({ error: transportFailure });
        const id = `${rpcIdPrefix}:${nextId++}`;
        const deferred = yield* Deferred.make<unknown, AcpRejected | AgentProtocolError>();
        pendingRpc.set(requestKey(id), { method, deferred });
        const swept = readTransportFailure();
        if (swept !== null) {
          pendingRpc.delete(requestKey(id));
          return yield* new AcpNotSent({ error: swept });
        }
        yield* send({ id, method, params }).pipe(
          Effect.tapError(() => Effect.sync(() => pendingRpc.delete(requestKey(id)))),
          Effect.mapError((error) => new AcpMaybeSent({ error })),
        );
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: REQUEST_TIMEOUT,
            orElse: () =>
              Effect.sync(() => pendingRpc.delete(requestKey(id))).pipe(
                Effect.andThen(
                  Effect.fail(
                    protocolError(
                      method,
                      `Antigravity did not answer ${method} within ${REQUEST_TIMEOUT}.`,
                      null,
                    ),
                  ),
                ),
              ),
          }),
          Effect.mapError((error) =>
            error instanceof AcpRejected ? error : new AcpMaybeSent({ error }),
          ),
        );
      });

      const request = (method: string, params: JsonObject) =>
        call(method, params).pipe(
          Effect.mapError((failure: AcpFailure) =>
            failure._tag === "AcpRejected"
              ? protocolError(method, failure.message, failure.error)
              : failure.error,
          ),
        );

      const readConfig = (result: unknown): void => {
        const configOptions = isObject(result) ? result["configOptions"] : null;
        if (!Array.isArray(configOptions)) return;
        for (const option of configOptions) {
          const value = stringField(option, "currentValue");
          switch (stringField(option, "id")) {
            case MODEL_OPTION:
              applied.model = value;
              break;
            case EFFORT_OPTION:
              applied.effort = value;
              break;
            case MODE_OPTION:
              applied.mode = value;
              break;
          }
        }
      };

      const updateItem = (item: AgentEventItem): Effect.Effect<void> => {
        items.set(item.providerItemId, item);
        return publish({ _tag: "item.updated", item });
      };

      /** The streamed words of a turn end where anything else happens in it. */
      const closeSegment = (turnId: string): Effect.Effect<void> => {
        const state = segments.get(turnId);
        const open = state?.open ?? null;
        if (state === undefined || open === null) return Effect.void;
        state.open = null;
        const item = items.get(open.itemId);
        return item === undefined ? Effect.void : updateItem({ ...item, status: "completed" });
      };

      const streamText = (
        turnId: string,
        kind: Segment["kind"],
        delta: string,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (delta === "") return;
          const state = segments.get(turnId) ?? { open: null, count: 0 };
          segments.set(turnId, state);
          if (state.open !== null && state.open.kind !== kind) yield* closeSegment(turnId);
          if (state.open === null) {
            state.open = {
              kind,
              itemId: `${turnId}:${kind === "assistant-message" ? "message" : "thought"}:${state.count}`,
            };
            state.count += 1;
          }
          const itemId = state.open.itemId;
          const previous = items.get(itemId);
          yield* publish({
            _tag: "content.delta",
            providerItemId: itemId,
            providerTurnId: turnId,
            delta,
          });
          yield* updateItem({
            providerItemId: itemId,
            providerTurnId: turnId,
            kind,
            status: "in-progress",
            title: null,
            text: `${previous?.text ?? ""}${delta}`,
            data: null,
          });
        });

      /** A `tool_call` or `tool_call_update`. */
      const toolCall = (turnId: string, update: JsonObject): Effect.Effect<void> =>
        Effect.gen(function* () {
          const toolCallId = stringField(update, "toolCallId");
          if (toolCallId === null) return;
          yield* closeSegment(turnId);
          // An update carries only what changed: merge it over the call as known so far.
          const merged: JsonObject = {
            ...calls.get(toolCallId),
            ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)),
          };
          calls.set(toolCallId, merged);
          const kind = toolItemKind(stringField(merged, "kind"));
          const data = toolData(merged, kind);
          const command = kind === "command-execution" ? stringField(data, "command") : null;
          yield* updateItem({
            providerItemId: toolCallId,
            providerTurnId: turnId,
            kind,
            status: toolItemStatus(stringField(merged, "status")),
            title: command ?? stringField(merged, "title") ?? stringField(merged, "name"),
            text: stringField(data, "aggregatedOutput"),
            data,
          });
        });

      const plan = (turnId: string, update: JsonObject): Effect.Effect<void> => {
        const entries = Array.isArray(update["entries"]) ? update["entries"].filter(isObject) : [];
        const steps = entries.map((entry) => ({
          step: stringField(entry, "content") ?? "",
          status: stringField(entry, "status") ?? "pending",
        }));
        return closeSegment(turnId).pipe(
          Effect.andThen(
            updateItem({
              // One plan per turn: each update replaces the checklist rather than adding a row.
              providerItemId: `plan:${turnId}`,
              providerTurnId: turnId,
              kind: "plan",
              status: "completed",
              title: "Plan",
              text: steps
                .map(({ step, status }) => `- [${status === "completed" ? "x" : " "}] ${step}`)
                .join("\n"),
              data: { type: "todoList", plan: steps },
            }),
          ),
        );
      };

      const handleUpdate = (params: JsonObject): Effect.Effect<void> => {
        const about = stringField(params, "sessionId");
        if (about !== null && sessionId !== null && about !== sessionId) return Effect.void;
        const update = objectField(params, "update");
        if (update === null) return Effect.void;
        const turnId = openTurns[0] ?? null;
        switch (stringField(update, "sessionUpdate")) {
          case "agent_message_chunk":
          case "agent_thought_chunk": {
            const text = stringField(objectField(update, "content"), "text");
            if (turnId === null || text === null) return Effect.void;
            return streamText(
              turnId,
              stringField(update, "sessionUpdate") === "agent_message_chunk"
                ? "assistant-message"
                : "reasoning",
              text,
            );
          }
          case "tool_call":
          case "tool_call_update":
            return turnId === null ? Effect.void : toolCall(turnId, update);
          case "plan":
            return turnId === null ? Effect.void : plan(turnId, update);
          case "usage_update": {
            const used = integerField(update, "used");
            const size = integerField(update, "size");
            if (used !== null && size !== null) context = { used, size };
            return Effect.void;
          }
          case "config_option_update":
            readConfig(update);
            return Effect.void;
          case "current_mode_update":
            applied.mode = stringField(update, "currentModeId") ?? applied.mode;
            return Effect.void;
          default:
            return Effect.void;
        }
      };

      const completeTurn = (turnId: string, message: JsonObject): Effect.Effect<void> =>
        Effect.gen(function* () {
          const index = openTurns.indexOf(turnId);
          if (index < 0) return;
          openTurns.splice(index, 1);
          yield* closeSegment(turnId);
          segments.delete(turnId);
          permissionOfTurn.delete(turnId);
          // A request the agent never had answered ends with its turn.
          for (const [providerRequestId, pending] of pendingServer) {
            if (pending.turnId !== turnId) continue;
            pendingServer.delete(providerRequestId);
            yield* publish({
              _tag: "request.resolved",
              providerRequestId,
              disposition: "cancelled",
            });
          }
          const error = objectField(message, "error");
          const result = message["result"];
          const ended =
            error === null
              ? completionOf(stringField(result, "stopReason"))
              : {
                  status: "failed" as const,
                  error: stringField(error, "message") ?? "Antigravity failed the turn.",
                };
          yield* publish({
            _tag: "turn.completed",
            providerTurnId: turnId,
            status: ended.status,
            usage: error === null ? usageOf(result, context) : null,
            error: ended.error,
          });
        });

      const permissionOf = (turnId: string): "bypass" | "ask" =>
        permissionOfTurn.get(turnId) ?? options.permissionMode;

      const handlePermission = (id: JsonRpcId, params: JsonObject): Effect.Effect<void> =>
        Effect.gen(function* () {
          const providerRequestId = requestKey(id);
          // Replay of a request answered before the restart: agy has its answer already.
          if (rehydrate?.resolvedProviderRequestIds.has(providerRequestId) === true) return;
          const turnId = openTurns[0] ?? null;
          if (turnId === null) {
            yield* send({ id, result: CANCELLED }).pipe(Effect.ignore);
            return;
          }
          const asked = objectField(params, "toolCall");
          const permissionOptions = optionsOf(params);
          const title = stringField(asked, "title");
          if (isQuestion(asked)) {
            const questionId = stringField(asked, "toolCallId") ?? providerRequestId;
            pendingServer.set(providerRequestId, {
              id,
              turnId,
              kind: "input",
              questionId,
              options: permissionOptions,
            });
            yield* publish({
              _tag: "request.opened",
              request: {
                providerRequestId,
                providerTurnId: turnId,
                providerItemId: null,
                kind: "user-input",
                title,
                detail: params,
                questions: [
                  {
                    id: questionId,
                    header: null,
                    question: title ?? "Choose an option.",
                    options: permissionOptions.map((option) => ({
                      label: option.name,
                      description: null,
                    })),
                    multiSelect: false,
                  },
                ],
              },
            });
            return;
          }
          // A bypass turn asks nobody: Mend answers as the agent's own skip-permissions would. A
          // finished turn's request read again after a restart was answered then.
          if (permissionOf(turnId) === "bypass") {
            if (rehydrate?.completedProviderTurnIds?.has(turnId) === true) return;
            const option = optionFor(permissionOptions, "accept");
            yield* send({
              id,
              result: option === null ? CANCELLED : selected(option.optionId),
            }).pipe(
              Effect.catch((error) => publish({ _tag: "runtime.warning", message: error.message })),
            );
            return;
          }
          pendingServer.set(providerRequestId, {
            id,
            turnId,
            kind: "approval",
            questionId: null,
            options: permissionOptions,
          });
          yield* publish({
            _tag: "request.opened",
            request: {
              providerRequestId,
              providerTurnId: turnId,
              providerItemId: stringField(asked, "toolCallId"),
              kind: requestKindOf(stringField(asked, "kind")),
              title: commandOf(asked?.["rawInput"]) ?? title,
              detail: params,
              questions: null,
            },
          });
        });

      const handleMessage = (value: unknown): Effect.Effect<void> => {
        if (!isObject(value)) {
          return publish({
            _tag: "runtime.warning",
            message: "Antigravity emitted a non-object line.",
          });
        }
        const id = rpcId(value["id"]);
        const method = stringField(value, "method");
        if (id !== null && method === null) {
          const promptTurn = turnOfPromptId(id);
          if (promptTurn !== null) return completeTurn(promptTurn, value);
          const pending = pendingRpc.get(requestKey(id));
          if (pending === undefined) return Effect.void;
          pendingRpc.delete(requestKey(id));
          const error = objectField(value, "error");
          return error === null
            ? Deferred.succeed(pending.deferred, value["result"]).pipe(Effect.asVoid)
            : Deferred.fail(
                pending.deferred,
                new AcpRejected({
                  message:
                    stringField(error, "message") ?? `Antigravity refused ${pending.method}.`,
                  error,
                }),
              ).pipe(Effect.asVoid);
        }
        const params = objectField(value, "params") ?? {};
        if (id !== null && method === "session/request_permission") {
          return handlePermission(id, params);
        }
        if (id !== null && method !== null) {
          // Mend offers agy no file system or terminal of its own (`initialize`).
          return send({ id, error: { code: -32601, message: `Method not found: ${method}` } }).pipe(
            Effect.ignore,
          );
        }
        if (method === "session/update") return handleUpdate(params);
        return Effect.void;
      };

      const handleLine = (line: string): Effect.Effect<void> => {
        try {
          const value: unknown = JSON.parse(line);
          return handleMessage(value);
        } catch {
          return publish({
            _tag: "runtime.warning",
            message: "Antigravity emitted a line that is not JSON.",
          });
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

      const failPendingRpc = (message: string, cause: unknown): Effect.Effect<void> =>
        Effect.gen(function* () {
          const error = protocolError("transport.output", message, cause);
          transportFailure = error;
          for (const pending of pendingRpc.values()) yield* Deferred.fail(pending.deferred, error);
          pendingRpc.clear();
        });

      yield* transport.output.pipe(
        Stream.runForEach(handleBytes),
        Effect.andThen(
          Effect.suspend(() => Effect.forEach(decoder.finish(), handleLine, { discard: true })),
        ),
        Effect.tap(() =>
          failPendingRpc("Antigravity process output ended.", null).pipe(
            Effect.andThen(
              publish({ _tag: "runtime.error", message: "Antigravity process output ended." }),
            ),
          ),
        ),
        Effect.catch((error) =>
          failPendingRpc(`Antigravity transport ended: ${error.message}`, error).pipe(
            Effect.andThen(
              publish({
                _tag: "runtime.error",
                message: `Antigravity transport ended: ${error.message}`,
              }),
            ),
          ),
        ),
        Effect.forkScoped,
      );

      if (rehydrate === undefined) {
        if (options.nativeBootstrap !== undefined) {
          return yield* protocolError(
            "session/new",
            "Antigravity conversations cannot be forked or rolled back in Mend.",
            null,
          );
        }
        const initialized = yield* request("initialize", {
          protocolVersion: 1,
          // Mend offers no client file system or terminal: agy uses its own tools in the workspace.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "mend", version: "0.0.0" },
        });
        const methods = isObject(initialized) ? initialized["authMethods"] : null;
        // A personal Google login is the only one Mend places (`~/.gemini`).
        if (
          Array.isArray(methods) &&
          methods.some((method) => stringField(method, "id") === "oauth-personal")
        ) {
          yield* request("authenticate", { methodId: "oauth-personal" });
        }
        // A resume never forks (docs/adr/0016, decision 6): a conversation agy cannot read fails
        // the start, and nothing starts a new one in its place.
        const setup =
          options.providerSessionId === undefined
            ? yield* request("session/new", { cwd: options.cwd, mcpServers: [] })
            : yield* request("session/resume", {
                sessionId: options.providerSessionId,
                cwd: options.cwd,
                mcpServers: [],
              }).pipe(
                Effect.mapError((error) =>
                  CONVERSATION_NOT_FOUND.test(error.message)
                    ? protocolError("session/resume", ANTIGRAVITY_CONVERSATION_NOT_FOUND, error)
                    : error,
                ),
              );
        sessionId = options.providerSessionId ?? stringField(setup, "sessionId");
        if (sessionId === null) {
          return yield* protocolError(
            "session/new",
            "Antigravity did not return a session id.",
            setup,
          );
        }
        readConfig(setup);
        defaults.model = applied.model;
        defaults.effort = applied.effort;
      } else {
        // agy never saw Mend go: its session is open. Replay rebuilds the turns from its output.
        if (options.providerSessionId === undefined) {
          return yield* protocolError(
            "rehydrate",
            "Antigravity rehydrate needs the durable session id.",
            null,
          );
        }
        sessionId = options.providerSessionId;
      }
      yield* publish({ _tag: "session.ready", providerSessionId: sessionId });

      /** Set one config option when it differs; nothing is sent for a choice already in place. */
      const configure = (configId: string, value: string | null, current: string | null) =>
        value === null || value === current || sessionId === null
          ? Effect.void
          : call("session/set_config_option", { sessionId, configId, value }).pipe(
              Effect.tap((result) => Effect.sync(() => readConfig(result))),
              Effect.mapError((failure) =>
                failure._tag === "AcpRejected"
                  ? protocolError(
                      "selection",
                      `Antigravity refused ${configId} ${value}: ${failure.message}. No prompt was sent.`,
                      failure.error,
                    )
                  : turnUndelivered("not-written", failure.error.message, failure.error),
              ),
            );

      const sendTurn = Effect.fn("AntigravityAdapter.sendTurn")(function* (
        input: string,
        selection?: TurnSelection | null,
      ) {
        if (sessionId === null || closed) {
          return yield* turnUndelivered("not-written", "The Antigravity session is closed.", null);
        }
        if (openTurns.length > 0) {
          return yield* turnUndelivered(
            "not-written",
            "Antigravity already has a turn in progress.",
            openTurns[0],
          );
        }
        const requested =
          selection ??
          (options.model === undefined && options.effort === undefined
            ? null
            : turnSelectionOf("antigravity", options.model, options.effort));
        if (requested !== null) {
          const refusal = turnSelectionRefusal("antigravity", requested);
          if (refusal !== null) return yield* protocolError("selection", refusal, null);
        }
        // A null choice restores what the session started with, so an earlier turn's choice never
        // carries into this one.
        yield* configure(MODEL_OPTION, requested?.model ?? defaults.model, applied.model);
        yield* configure(EFFORT_OPTION, requested?.effort ?? defaults.effort, applied.effort);
        yield* configure(
          MODE_OPTION,
          requested?.interactionMode === "plan" ? "plan" : DEFAULT_MODE,
          applied.mode,
        );
        const turnId = crypto.randomUUID();
        openTurns.push(turnId);
        permissionOfTurn.set(turnId, requested?.permissionMode ?? options.permissionMode);
        yield* send({
          id: promptIdOf(turnId),
          method: "session/prompt",
          params: { sessionId, prompt: [{ type: "text", text: input }] },
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              openTurns.splice(openTurns.indexOf(turnId), 1);
              permissionOfTurn.delete(turnId);
            }),
          ),
          Effect.mapError((error) => turnUndelivered("uncertain", error.message, error)),
        );
        yield* publish({ _tag: "turn.started", providerTurnId: turnId });
        return turnId;
      });

      /** `session/cancel` ends the running prompt; its answer then says `cancelled`. */
      const interrupt = Effect.fn("AntigravityAdapter.interrupt")(function* () {
        const turnId = openTurns[0];
        if (sessionId === null || turnId === undefined) return;
        yield* send({ method: "session/cancel", params: { sessionId } });
        // The protocol asks the client to answer what the cancelled turn still asks as cancelled.
        for (const [providerRequestId, pending] of pendingServer) {
          if (pending.turnId !== turnId) continue;
          pendingServer.delete(providerRequestId);
          yield* send({ id: pending.id, result: CANCELLED }).pipe(Effect.ignore);
          yield* publish({ _tag: "request.resolved", providerRequestId, disposition: "cancelled" });
        }
      });

      /** ACP has no way into a running prompt: a message waits for the next turn. */
      const steer = (input: AgentSteerInput) =>
        Effect.fail(
          new AgentSteerRefusedError({
            adapter: "antigravity",
            reason: "unsupported",
            expectedTurnId: input.expectedTurnId,
            actualTurnId: openTurns[0] ?? null,
            message: "Antigravity takes no messages during a turn.",
          }),
        );

      const respond = Effect.fn("AntigravityAdapter.respond")(function* (
        providerRequestId: string,
        decision: AgentApprovalDecision,
      ) {
        const pending = pendingServer.get(providerRequestId);
        if (pending === undefined || pending.kind !== "approval") {
          return yield* protocolError(
            "respond",
            `Unknown Antigravity approval request ${providerRequestId}.`,
            null,
          );
        }
        const option = optionFor(pending.options, decision);
        yield* send({
          id: pending.id,
          result: option === null ? CANCELLED : selected(option.optionId),
        });
        pendingServer.delete(providerRequestId);
      });

      const respondInput = Effect.fn("AntigravityAdapter.respondInput")(function* (
        providerRequestId: string,
        answers: AgentInputAnswers,
      ) {
        const pending = pendingServer.get(providerRequestId);
        if (pending === undefined || pending.kind !== "input") {
          return yield* protocolError(
            "respondInput",
            `Unknown Antigravity question ${providerRequestId}.`,
            null,
          );
        }
        const answer = answers[pending.questionId ?? ""]?.[0];
        const option =
          pending.options.find((entry) => entry.optionId === answer) ??
          pending.options.find((entry) => entry.name === answer);
        yield* send({
          id: pending.id,
          result: option === undefined ? CANCELLED : selected(option.optionId),
        });
        pendingServer.delete(providerRequestId);
      });

      const quiescence = () =>
        Effect.sync(
          (): AgentQuiescence => ({
            quiescent: openTurns.length === 0,
            openTurn: openTurns.length > 0,
            work: [],
            settleMs: 0,
          }),
        );

      const close = Effect.fn("AntigravityAdapter.close")(function* () {
        if (closed) return;
        closed = true;
        for (const pending of pendingServer.values()) {
          yield* send({ id: pending.id, result: CANCELLED }).pipe(Effect.ignore);
        }
        pendingServer.clear();
        const closing = protocolError("close", "Antigravity adapter closed.", null);
        for (const pending of pendingRpc.values()) yield* Deferred.fail(pending.deferred, closing);
        pendingRpc.clear();
        yield* transport.close();
        yield* PubSub.shutdown(events);
      });

      return {
        sendTurn,
        interrupt,
        activeSteering: { supported: false, interruptsTools: false },
        steer,
        respond,
        respondInput,
        events: Stream.fromPubSub(events),
        quiescence,
        // ACP reports nothing the agent runs outside a prompt (agy's `/schedule`): unknown, so
        // never trusted for a hand-over.
        reportsBackgroundWork: () => Effect.succeed(false),
        endWork: () =>
          Effect.fail(
            protocolError("endWork", "Antigravity reports no background work Mend can end.", null),
          ),
        close,
      } satisfies AgentSession;
    }),
};
