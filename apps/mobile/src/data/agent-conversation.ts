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

import { ApiError, api } from "@/data/live";

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

export const useAgentConversation = (sessionId: string, enabled: boolean, live: boolean) => {
  const queryClient = useQueryClient();
  const queryKey = ["session", sessionId, "conversation"] as const;
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
  const submit = useMutation({
    mutationFn: (input: string) => api<unknown>("POST", `/sessions/${sessionId}/turns`, { input }),
    onSettled: invalidate,
  });
  const respond = useMutation({
    mutationFn: (input: { readonly requestId: string; readonly response: AgentRequestResponse }) =>
      api<unknown>("POST", `/requests/${input.requestId}/respond`, input.response),
    onSettled: invalidate,
  });
  // Steering: a queued turn is cancelled outright; a running one reaches the
  // harness's own interrupt. The process stays live for the next message.
  const interrupt = useMutation({
    mutationFn: (turnId: string) => api<unknown>("POST", `/turns/${turnId}/interrupt`, {}),
    onSettled: invalidate,
  });
  return { submit, respond, interrupt };
};
