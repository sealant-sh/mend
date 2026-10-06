import type {
  AgentApprovalDecision,
  AgentEvent,
  AgentEventItem,
  AgentInputAnswers,
  AgentInputQuestion,
  AgentItemKind,
  AgentItemStatus,
  AgentRequestKind,
  AgentTurnUsage,
} from "@mend/domain/workbench";
import { Effect, Deferred, PubSub, Stream } from "effect";

import { createNdjsonDecoder } from "./ndjson.ts";
import {
  AgentProtocolError,
  type AgentAdapter,
  type AgentSession,
  type AgentStartOptions,
  type AgentTransport,
} from "./types.ts";

type JsonObject = Readonly<Record<string, unknown>>;
type JsonRpcId = string | number;

interface PendingRpcRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, AgentProtocolError>;
}

interface PendingServerRequest {
  readonly id: JsonRpcId;
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

const rpcId = (value: unknown): JsonRpcId | null =>
  typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : null;

const requestKey = (id: JsonRpcId): string => `${typeof id === "number" ? "n" : "s"}:${id}`;

const protocolError = (operation: string, message: string, cause: unknown): AgentProtocolError =>
  new AgentProtocolError({ adapter: "codex", operation, message, cause });

/** What a resume that cannot find its thread says: the turn fails, and nothing was sent. */
export const CODEX_THREAD_NOT_FOUND =
  "Codex could not find this conversation's thread. Nothing was sent.";

const encodeLine = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const itemKind = (value: string | null): AgentItemKind => {
  switch (value) {
    case "userMessage":
      return "user-message";
    case "agentMessage":
      return "assistant-message";
    case "reasoning":
      return "reasoning";
    case "plan":
    case "todoList":
      return "plan";
    case "commandExecution":
      return "command-execution";
    case "fileChange":
      return "file-change";
    case "webSearch":
      return "web-search";
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
      return "tool-call";
    case "error":
      return "error";
    default:
      return "other";
  }
};

const itemTitle = (item: JsonObject, kind: AgentItemKind): string | null => {
  const direct = stringField(item, "title") ?? stringField(item, "name");
  if (direct !== null) return direct;
  if (kind === "command-execution") {
    const command = item["command"];
    if (typeof command === "string") return command;
    if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
      return command.join(" ");
    }
  }
  if (kind === "file-change") return stringField(item, "path");
  return null;
};

const itemText = (item: JsonObject): string | null =>
  stringField(item, "text") ?? stringField(item, "message") ?? stringField(item, "output");

const turnIdFrom = (params: JsonObject, currentTurnId: string | null): string | null =>
  stringField(params, "turnId") ?? stringField(objectField(params, "turn"), "id") ?? currentTurnId;

const usageFrom = (value: unknown): AgentTurnUsage | null => {
  if (!isObject(value)) return null;
  const total = objectField(value, "total") ?? value;
  const inputTokens = integerField(total, "inputTokens") ?? integerField(total, "input_tokens");
  const outputTokens = integerField(total, "outputTokens") ?? integerField(total, "output_tokens");
  const cachedInputTokens =
    integerField(total, "cachedInputTokens") ?? integerField(total, "cached_input_tokens");
  const totalTokens = integerField(total, "totalTokens") ?? integerField(total, "total_tokens");
  const contextWindow =
    integerField(value, "modelContextWindow") ?? integerField(value, "model_context_window");
  if (
    inputTokens === null &&
    outputTokens === null &&
    cachedInputTokens === null &&
    totalTokens === null &&
    contextWindow === null
  ) {
    return null;
  }
  return { inputTokens, outputTokens, cachedInputTokens, totalTokens, contextWindow };
};

const approvalDecision = (decision: AgentApprovalDecision): string =>
  decision === "accept-for-session" ? "acceptForSession" : decision;

const completedTurnStatus = (
  status: string | null,
): "completed" | "interrupted" | "failed" | "cancelled" => {
  switch (status) {
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "completed";
  }
};

const codexInputAnswers = (
  answers: AgentInputAnswers,
): Readonly<Record<string, { readonly answers: ReadonlyArray<string> }>> =>
  Object.fromEntries(
    Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
  );

const requestKind = (method: string): AgentRequestKind => {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command-approval";
    case "item/fileChange/requestApproval":
      return "file-change-approval";
    case "item/tool/requestUserInput":
      return "user-input";
    default:
      return "unknown";
  }
};

const questionsFrom = (params: JsonObject): ReadonlyArray<AgentInputQuestion> | null => {
  const questions = params["questions"];
  if (!Array.isArray(questions)) return null;
  return questions.flatMap((question): ReadonlyArray<AgentInputQuestion> => {
    if (!isObject(question)) return [];
    const id = stringField(question, "id");
    const text = stringField(question, "question");
    if (id === null || text === null) return [];
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
        id,
        header: stringField(question, "header"),
        question: text,
        options,
        multiSelect: question["multiSelect"] === true,
      },
    ];
  });
};

const requestTitle = (params: JsonObject): string | null => {
  const command = params["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return command.join(" ");
  }
  return stringField(params, "reason") ?? stringField(params, "toolName");
};

/** Codex app-server JSON-RPC adapter over NDJSON stdio. */
export const CodexAdapter: AgentAdapter = {
  start: (transport: AgentTransport, options: AgentStartOptions) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<AgentEvent>({ replay: 32 });
      const pendingRpc = new Map<string, PendingRpcRequest>();
      const pendingServer = new Map<string, PendingServerRequest>();
      const items = new Map<string, AgentEventItem>();
      const decoder = createNdjsonDecoder();
      const rehydrate = options.rehydrate;
      // Replay includes responses to the PREVIOUS Mend process's requests, and
      // its ids also started at 0 — epoch-prefixed string ids keep a stale
      // response from ever resolving a new call (requestKey namespaces by type).
      const rpcIdPrefix = rehydrate === undefined ? null : `m${crypto.randomUUID().slice(0, 8)}`;
      let nextId = 0;
      const mintRpcId = (): JsonRpcId =>
        rpcIdPrefix === null ? nextId++ : `${rpcIdPrefix}:${nextId++}`;
      let threadId: string | null = null;
      let currentTurnId: string | null = null;
      let latestUsage: AgentTurnUsage | null = null;
      let transportFailure: AgentProtocolError | null = null;
      const readTransportFailure = (): AgentProtocolError | null => transportFailure;
      let closed = false;

      const publish = (event: AgentEvent): Effect.Effect<void> =>
        (options.onEvent === undefined ? Effect.void : options.onEvent(event)).pipe(
          Effect.andThen(PubSub.publish(events, event)),
          Effect.asVoid,
        );

      const send = (value: unknown): Effect.Effect<void, AgentProtocolError> =>
        transport.send(encodeLine(value));

      /**
       * Codex answers accepted requests immediately (a turn/start response is the turn object,
       * not the finished turn), so a quiet minute means the process is wedged, not thinking.
       * The timeout keeps launchInternal and the dispatch permit from hanging forever on a
       * binary that starts but never speaks.
       */
      const REQUEST_TIMEOUT = "60 seconds";

      const request = Effect.fn("CodexAdapter.request")(function* (
        method: string,
        params: JsonObject,
      ) {
        if (transportFailure !== null) return yield* transportFailure;
        const id = mintRpcId();
        const deferred = yield* Deferred.make<unknown, AgentProtocolError>();
        pendingRpc.set(requestKey(id), { method, deferred });
        // Re-check after registering: a transport failure that swept pendingRpc between the
        // first check and the set would otherwise leave this deferred waiting forever. Read
        // through a call so control-flow narrowing does not reduce the check to `never`.
        const sweptFailure = readTransportFailure();
        if (sweptFailure !== null) {
          pendingRpc.delete(requestKey(id));
          return yield* sweptFailure;
        }
        yield* send({ method, id, params }).pipe(
          Effect.tapError(() => Effect.sync(() => pendingRpc.delete(requestKey(id)))),
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
                      `Codex did not answer ${method} within ${REQUEST_TIMEOUT}.`,
                      null,
                    ),
                  ),
                ),
              ),
          }),
        );
      });

      const sendResponse = (
        id: JsonRpcId,
        result: unknown,
      ): Effect.Effect<void, AgentProtocolError> => send({ id, result });

      const updateItem = (item: AgentEventItem): Effect.Effect<void> => {
        items.set(item.providerItemId, item);
        return publish({ _tag: "item.updated", item });
      };

      const lifecycleItem = (params: JsonObject, status: AgentItemStatus): Effect.Effect<void> => {
        const raw = objectField(params, "item");
        const providerItemId = stringField(raw, "id") ?? stringField(params, "itemId");
        const providerTurnId = turnIdFrom(params, currentTurnId);
        if (raw === null || providerItemId === null || providerTurnId === null) return Effect.void;
        const kind = itemKind(stringField(raw, "type"));
        return updateItem({
          providerItemId,
          providerTurnId,
          kind,
          status,
          title: itemTitle(raw, kind),
          text: itemText(raw),
          data: raw,
        });
      };

      const contentDelta = (params: JsonObject): Effect.Effect<void> => {
        const providerItemId = stringField(params, "itemId");
        const providerTurnId = turnIdFrom(params, currentTurnId);
        const delta = stringField(params, "delta");
        if (providerItemId === null || providerTurnId === null || delta === null || delta === "") {
          return Effect.void;
        }
        const previous = items.get(providerItemId);
        const next: AgentEventItem =
          previous === undefined
            ? {
                providerItemId,
                providerTurnId,
                kind: "other",
                status: "in-progress",
                title: null,
                text: delta,
                data: null,
              }
            : { ...previous, text: `${previous.text ?? ""}${delta}` };
        return publish({
          _tag: "content.delta",
          providerItemId,
          providerTurnId,
          delta,
        }).pipe(Effect.andThen(updateItem(next)));
      };

      const handleServerRequest = (message: JsonObject, method: string, id: JsonRpcId) => {
        const params = objectField(message, "params") ?? {};
        const kind = requestKind(method);
        if (kind === "unknown") {
          return send({
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          }).pipe(Effect.catch(() => Effect.void));
        }
        const providerRequestId = requestKey(id);
        // Replay of a request answered before the restart: the harness got its
        // response long ago — re-opening (or re-answering it at close) is wrong.
        if (
          rehydrate !== undefined &&
          rehydrate.resolvedProviderRequestIds.has(providerRequestId)
        ) {
          return Effect.void;
        }
        pendingServer.set(providerRequestId, {
          id,
          kind: kind === "user-input" ? "input" : "approval",
        });
        const providerTurnId = turnIdFrom(params, currentTurnId);
        if (providerTurnId === null) {
          pendingServer.delete(providerRequestId);
          return sendResponse(
            id,
            kind === "user-input" ? { answers: {} } : { decision: "cancel" },
          ).pipe(Effect.catch(() => Effect.void));
        }
        return publish({
          _tag: "request.opened",
          request: {
            providerRequestId,
            providerTurnId,
            providerItemId: stringField(params, "itemId"),
            kind,
            title: requestTitle(params),
            detail: params,
            questions: kind === "user-input" ? questionsFrom(params) : null,
          },
        });
      };

      const handleNotification = (method: string, params: JsonObject): Effect.Effect<void> => {
        switch (method) {
          case "turn/started": {
            const providerTurnId = turnIdFrom(params, currentTurnId);
            if (providerTurnId === null) return Effect.void;
            currentTurnId = providerTurnId;
            return publish({ _tag: "turn.started", providerTurnId });
          }
          case "turn/completed": {
            const turn = objectField(params, "turn");
            const providerTurnId = stringField(turn, "id") ?? currentTurnId;
            if (providerTurnId === null) return Effect.void;
            const status = completedTurnStatus(stringField(turn, "status"));
            const error = stringField(objectField(turn, "error"), "message");
            currentTurnId = null;
            return publish({
              _tag: "turn.completed",
              providerTurnId,
              status,
              usage: latestUsage,
              error,
            });
          }
          case "item/started":
            return lifecycleItem(params, "in-progress");
          case "item/completed":
            return lifecycleItem(params, "completed");
          case "item/agentMessage/delta":
          case "item/reasoning/textDelta":
          case "item/commandExecution/outputDelta":
            return contentDelta(params);
          case "thread/tokenUsage/updated":
            latestUsage = usageFrom(params["tokenUsage"]);
            return Effect.void;
          case "error":
            return publish({
              _tag: "runtime.error",
              message: stringField(params, "message") ?? "Codex app-server reported an error.",
            });
          default:
            return Effect.void;
        }
      };

      const handleMessage = (value: unknown): Effect.Effect<void> => {
        if (!isObject(value)) {
          return publish({ _tag: "runtime.warning", message: "Codex emitted a non-object line." });
        }
        const id = rpcId(value["id"]);
        const method = stringField(value, "method");
        if (id !== null && method === null) {
          const pending = pendingRpc.get(requestKey(id));
          if (pending === undefined) return Effect.void;
          pendingRpc.delete(requestKey(id));
          const error = objectField(value, "error");
          if (error !== null) {
            return Deferred.fail(
              pending.deferred,
              protocolError(
                "response",
                stringField(error, "message") ?? "Codex request failed.",
                error,
              ),
            ).pipe(Effect.asVoid);
          }
          const result = value["result"];
          const readyThreadId =
            pending.method === "thread/start" || pending.method === "thread/resume"
              ? stringField(objectField(result, "thread"), "id")
              : null;
          return Effect.gen(function* () {
            if (readyThreadId !== null) {
              threadId = readyThreadId;
              yield* publish({ _tag: "session.ready", providerSessionId: readyThreadId });
            }
            yield* Deferred.succeed(pending.deferred, result);
          });
        }
        if (id !== null && method !== null) return handleServerRequest(value, method, id);
        if (method !== null) return handleNotification(method, objectField(value, "params") ?? {});
        return Effect.void;
      };

      const handleLine = (line: string): Effect.Effect<void> => {
        try {
          const value: unknown = JSON.parse(line);
          return handleMessage(value);
        } catch (cause) {
          const error = protocolError("decode", "Codex emitted malformed NDJSON.", cause);
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

      const failPendingRpc = (message: string, cause: unknown): Effect.Effect<void> =>
        Effect.gen(function* () {
          const error = protocolError("transport.output", message, cause);
          transportFailure = error;
          for (const pending of pendingRpc.values()) {
            yield* Deferred.fail(pending.deferred, error);
          }
          pendingRpc.clear();
        });

      yield* transport.output.pipe(
        Stream.runForEach(handleBytes),
        Effect.andThen(Effect.forEach(decoder.finish(), handleLine, { discard: true })),
        Effect.tap(() =>
          failPendingRpc("Codex process output ended.", null).pipe(
            Effect.andThen(
              publish({ _tag: "runtime.error", message: "Codex process output ended." }),
            ),
          ),
        ),
        Effect.catch((error) =>
          failPendingRpc(`Codex transport ended: ${error.message}`, error).pipe(
            Effect.andThen(
              publish({
                _tag: "runtime.error",
                message: `Codex transport ended: ${error.message}`,
              }),
            ),
          ),
        ),
        Effect.forkScoped,
      );

      if (rehydrate === undefined) {
        yield* request("initialize", { clientInfo: { name: "mend", version: "0.0.0" } });
        yield* send({ method: "initialized" });

        const threadParams = {
          cwd: options.cwd,
          approvalPolicy: options.permissionMode === "ask" ? "on-request" : "never",
          sandbox: options.permissionMode === "ask" ? "workspace-write" : "danger-full-access",
        };
        // A resume never forks (docs/adr/0016, decision 6): a thread Codex cannot find fails the
        // start, and nothing starts a new thread in its place. Starting a new conversation is
        // the person's explicit choice, never a silent one: a fresh thread under the same session
        // would carry its next turn into an empty conversation, and later turns would continue
        // that one.
        const threadResult =
          options.providerSessionId === undefined
            ? yield* request("thread/start", threadParams)
            : yield* request("thread/resume", {
                ...threadParams,
                threadId: options.providerSessionId,
              }).pipe(
                Effect.mapError((error) =>
                  /unknown|not found|no such|does not exist/i.test(error.message)
                    ? protocolError("thread/resume", CODEX_THREAD_NOT_FOUND, error)
                    : error,
                ),
              );
        threadId = stringField(objectField(threadResult, "thread"), "id");
        if (threadId === null) {
          return yield* protocolError(
            "thread/start",
            "Codex did not return a thread id.",
            threadResult,
          );
        }
        yield* publish({ _tag: "session.ready", providerSessionId: threadId });
      } else {
        // The app-server never observed a disconnect — it is initialized and its
        // thread is open. Re-handshaking would double-initialize; seed instead.
        if (options.providerSessionId === undefined) {
          return yield* protocolError(
            "rehydrate",
            "Codex rehydrate needs the durable thread id.",
            null,
          );
        }
        threadId = options.providerSessionId;
        yield* publish({ _tag: "session.ready", providerSessionId: threadId });
      }

      const sendTurn = Effect.fn("CodexAdapter.sendTurn")(function* (input: string) {
        if (threadId === null) {
          return yield* protocolError("turn/start", "Codex thread is not ready.", null);
        }
        const result = yield* request("turn/start", {
          threadId,
          input: [{ type: "text", text: input }],
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.effort === undefined ? {} : { effort: options.effort }),
        });
        const providerTurnId = stringField(objectField(result, "turn"), "id");
        if (providerTurnId === null) {
          return yield* protocolError("turn/start", "Codex did not return a turn id.", result);
        }
        currentTurnId = providerTurnId;
        return providerTurnId;
      });

      const interrupt = Effect.fn("CodexAdapter.interrupt")(function* () {
        if (threadId === null || currentTurnId === null) return;
        yield* request("turn/interrupt", { threadId, turnId: currentTurnId });
      });

      const respond = Effect.fn("CodexAdapter.respond")(function* (
        providerRequestId: string,
        decision: AgentApprovalDecision,
      ) {
        // Only requests this adapter instance is holding open can be answered. Reconstructing a
        // JSON-RPC id from the opaque string would risk answering an id twice after close().
        const pending = pendingServer.get(providerRequestId);
        if (pending === undefined || pending.kind !== "approval") {
          return yield* protocolError(
            "respond",
            `Unknown Codex approval request ${providerRequestId}.`,
            null,
          );
        }
        yield* sendResponse(pending.id, { decision: approvalDecision(decision) });
        pendingServer.delete(providerRequestId);
      });

      const respondInput = Effect.fn("CodexAdapter.respondInput")(function* (
        providerRequestId: string,
        answers: AgentInputAnswers,
      ) {
        const pending = pendingServer.get(providerRequestId);
        if (pending === undefined || pending.kind !== "input") {
          return yield* protocolError(
            "respondInput",
            `Unknown Codex user-input request ${providerRequestId}.`,
            null,
          );
        }
        yield* sendResponse(pending.id, { answers: codexInputAnswers(answers) });
        pendingServer.delete(providerRequestId);
      });

      const close = Effect.fn("CodexAdapter.close")(function* () {
        if (closed) return;
        closed = true;
        for (const pending of pendingServer.values()) {
          yield* sendResponse(
            pending.id,
            pending.kind === "input" ? { answers: {} } : { decision: "cancel" },
          ).pipe(Effect.ignore);
        }
        pendingServer.clear();
        const closingError = protocolError("close", "Codex adapter closed.", null);
        for (const pending of pendingRpc.values()) {
          yield* Deferred.fail(pending.deferred, closingError);
        }
        pendingRpc.clear();
        yield* transport.close();
        yield* PubSub.shutdown(events);
      });

      return {
        sendTurn,
        interrupt,
        respond,
        respondInput,
        events: Stream.fromPubSub(events),
        close,
      } satisfies AgentSession;
    }),
};
