import {
  AgentItemCursorStalled,
  latestItemSeq,
  mergeAgentItems,
  readAgentItemsAfter,
  type AgentConversationDto,
  type AgentInputOptionDto,
  type AgentInputQuestionDto,
  type AgentItemDto,
  type AgentRequestDto,
  type AgentRequestResponse,
  type AgentTurnDto,
} from "@mend/agent-conversation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useReducer, useRef } from "react";

import { ApiError, api, apiNoContent } from "@/data/live";
import { pendingTurnsReducer, type LocalImage, type PendingTurn } from "@/data/pending-turns";
import { composeTurnInput } from "@/data/turn-input";

const malformed = (subject: string): ApiError =>
  new ApiError(`The server returned malformed ${subject} data.`, 0);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, subject: string): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) {
    throw malformed(subject);
  }
  return value;
};

const string = (row: Readonly<Record<string, unknown>>, key: string, subject: string): string => {
  const value = row[key];
  if (typeof value !== "string") {
    throw malformed(subject);
  }
  return value;
};

const nullableString = (
  row: Readonly<Record<string, unknown>>,
  key: string,
  subject: string,
): string | null => {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw malformed(subject);
  }
  return value;
};

const integer = (row: Readonly<Record<string, unknown>>, key: string, subject: string): number => {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw malformed(subject);
  }
  return value;
};

const parseTurn = (value: unknown): AgentTurnDto => {
  const row = record(value, "agent turn");
  return {
    id: string(row, "id", "agent turn"),
    ordinal: integer(row, "ordinal", "agent turn"),
    input: string(row, "input", "agent turn"),
    status: string(row, "status", "agent turn"),
    error: nullableString(row, "error", "agent turn"),
    createdAt: string(row, "createdAt", "agent turn"),
  };
};

const parseItem = (value: unknown): AgentItemDto => {
  const row = record(value, "agent item");
  return {
    id: string(row, "id", "agent item"),
    seq: integer(row, "seq", "agent item"),
    turnId: string(row, "turnId", "agent item"),
    kind: string(row, "kind", "agent item"),
    status: string(row, "status", "agent item"),
    title: nullableString(row, "title", "agent item"),
    text: nullableString(row, "text", "agent item"),
    createdAt: string(row, "createdAt", "agent item"),
    updatedAt: string(row, "updatedAt", "agent item"),
  };
};

const parseOption = (value: unknown): AgentInputOptionDto => {
  const row = record(value, "agent input option");
  return {
    label: string(row, "label", "agent input option"),
    description: nullableString(row, "description", "agent input option"),
  };
};

const parseQuestion = (value: unknown): AgentInputQuestionDto => {
  const row = record(value, "agent input question");
  const options = row["options"];
  if (!Array.isArray(options) || typeof row.multiSelect !== "boolean") {
    throw malformed("agent input question");
  }
  return {
    id: string(row, "id", "agent input question"),
    header: nullableString(row, "header", "agent input question"),
    question: string(row, "question", "agent input question"),
    options: options.map(parseOption),
    multiSelect: row.multiSelect,
  };
};

const parseAnswers = (value: unknown): Readonly<Record<string, ReadonlyArray<string>>> | null => {
  if (value === null) {
    return null;
  }
  const row = record(value, "agent input answers");
  const answers: Record<string, ReadonlyArray<string>> = {};
  for (const [questionId, response] of Object.entries(row)) {
    if (!Array.isArray(response) || !response.every((answer) => typeof answer === "string")) {
      throw malformed("agent input answers");
    }
    answers[questionId] = response;
  }
  return answers;
};

const parseRequest = (value: unknown): AgentRequestDto => {
  const row = record(value, "agent request");
  const questions = row.questions;
  if (questions !== null && !Array.isArray(questions)) {
    throw malformed("agent request");
  }
  return {
    id: string(row, "id", "agent request"),
    turnId: string(row, "turnId", "agent request"),
    kind: string(row, "kind", "agent request"),
    title: nullableString(row, "title", "agent request"),
    detail: row.detail,
    questions: questions === null ? null : questions.map(parseQuestion),
    status: string(row, "status", "agent request"),
    decision: nullableString(row, "decision", "agent request"),
    answers: parseAnswers(row.answers),
    createdAt: string(row, "createdAt", "agent request"),
  };
};

const parseArray = <T>(
  value: unknown,
  subject: string,
  parse: (item: unknown) => T,
): ReadonlyArray<T> => {
  if (!Array.isArray(value)) {
    throw malformed(subject);
  }
  return value.map(parse);
};

const loadAgentItems = (sessionId: string, initialAfter: number) =>
  readAgentItemsAfter(
    async (after, limit) =>
      parseArray(
        await api<unknown>("GET", `/sessions/${sessionId}/items?after=${after}&limit=${limit}`),
        "agent items",
        parseItem,
      ),
    initialAfter,
  ).catch((error: unknown) => {
    throw error instanceof AgentItemCursorStalled ? malformed("agent item cursor") : error;
  });

const conversationKey = (sessionId: string) => ["session", sessionId, "conversation"] as const;

export const useAgentConversation = (sessionId: string, enabled: boolean, live: boolean) => {
  const queryClient = useQueryClient();
  const queryKey = conversationKey(sessionId);
  return useQuery({
    queryKey,
    enabled,
    queryFn: async (): Promise<AgentConversationDto> => {
      const previous = queryClient.getQueryData<AgentConversationDto>(queryKey);
      const after = latestItemSeq(previous?.items ?? []);
      const [turns, updates, requests] = await Promise.all([
        api<unknown>("GET", `/sessions/${sessionId}/turns`),
        loadAgentItems(sessionId, after),
        api<unknown>("GET", `/sessions/${sessionId}/requests`),
      ]);
      return {
        turns: parseArray(turns, "agent turns", parseTurn),
        items: mergeAgentItems(previous?.items ?? [], updates),
        requests: parseArray(requests, "agent requests", parseRequest),
      };
    },
    refetchInterval: live ? 800 : false,
  });
};

export const useAgentConversationActions = (sessionId: string) => {
  const queryClient = useQueryClient();
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
      queryClient.invalidateQueries({ queryKey: ["session", sessionId, "conversation"] }),
    ]);
  const respond = useMutation({
    mutationFn: (input: { readonly requestId: string; readonly response: AgentRequestResponse }) =>
      api<unknown>("POST", `/requests/${input.requestId}/respond`, input.response),
    onSettled: invalidate,
  });
  // Steering: a queued turn is cancelled outright; a running one reaches the
  // harness's own interrupt. The process stays live for the next message.
  const interrupt = useMutation({
    mutationFn: (turnId: string) => apiNoContent("POST", `/turns/${turnId}/interrupt`, {}),
    onSettled: invalidate,
  });
  return { respond, interrupt };
};

const errorText = (error: unknown): string => {
  // The turn route's 409 (`ProtocolSessionNotLive`) carries no words of its own; `api` falls back
  // to the status line, which says nothing to a person.
  if (error instanceof ApiError && error.status === 409 && error.message.startsWith("POST ")) {
    return "the agent is not running · resume the session, then retry";
  }
  return error instanceof Error && error.message !== ""
    ? error.message
    : "the message was not sent";
};

export interface TurnSender {
  /** This phone's sends the conversation may not show yet (pending-turns.ts). */
  readonly pending: ReadonlyArray<PendingTurn>;
  /** Shows the message at once and sends it after any earlier send. Returns its client id. */
  readonly send: (text: string, images: ReadonlyArray<LocalImage>) => string;
  readonly retry: (clientId: string) => void;
  readonly discard: (clientId: string) => void;
  /** The recorded turn a send became, once the server answers; null when it refused. */
  readonly turnIdOf: (clientId: string) => Promise<string | null>;
}

/**
 * Sends turns optimistically. Sends go one after another, so the server records them in the
 * order they were made. The server's answer is written into the cached conversation straight
 * away — the Stop button and the "working" line need not wait for the next poll — and the
 * pending turn is matched to it by the turn id, never by its text.
 */
export const useTurnSender = (sessionId: string): TurnSender => {
  const queryClient = useQueryClient();
  const [pending, dispatch] = useReducer(pendingTurnsReducer, []);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const outcomes = useRef(new Map<string, Promise<string | null>>());
  const inputs = useRef(new Map<string, string>());
  // A send on its way, so a second tap on Retry cannot send the same message twice.
  const inFlight = useRef(new Set<string>());
  const seq = useRef(0);

  const deliver = (clientId: string, input: string) => {
    inFlight.current.add(clientId);
    const outcome = queue.current.then(async (): Promise<string | null> => {
      const key = conversationKey(sessionId);
      // A poll already in flight would land without this turn and overwrite what is written
      // below; the pending row covers the gap either way, but there is no need to race it.
      await queryClient.cancelQueries({ queryKey: key });
      try {
        const turn = parseTurn(
          await api<unknown>("POST", `/sessions/${sessionId}/turns`, { input }),
        );
        queryClient.setQueryData<AgentConversationDto>(key, (current) =>
          current === undefined || current.turns.some((existing) => existing.id === turn.id)
            ? current
            : { ...current, turns: [...current.turns, turn] },
        );
        dispatch({ type: "delivered", clientId, turnId: turn.id });
        return turn.id;
      } catch (error) {
        dispatch({ type: "failed", clientId, error: errorText(error) });
        return null;
      } finally {
        inFlight.current.delete(clientId);
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      }
    });
    queue.current = outcome;
    outcomes.current.set(clientId, outcome);
  };

  return {
    pending,
    send: (text, images) => {
      seq.current += 1;
      const clientId = `${Date.now().toString(36)}-${seq.current}`;
      const message = text.trim();
      const input = composeTurnInput(message, images);
      inputs.current.set(clientId, input);
      dispatch({ type: "queued", clientId, text: message, input, images });
      deliver(clientId, input);
      return clientId;
    },
    retry: (clientId) => {
      const input = inputs.current.get(clientId);
      if (input === undefined || inFlight.current.has(clientId)) return;
      dispatch({ type: "retried", clientId });
      deliver(clientId, input);
    },
    discard: (clientId) => {
      inputs.current.delete(clientId);
      outcomes.current.delete(clientId);
      dispatch({ type: "discarded", clientId });
    },
    turnIdOf: (clientId) => outcomes.current.get(clientId) ?? Promise.resolve(null),
  };
};
