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
  type AgentSteerDeliveryDto,
  type AgentTurnDto,
  type AgentTurnSteerDto,
} from "@mend/agent-conversation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { LocalImage } from "@/data/conversation-rows";
import { ApiError, type Machine } from "@/data/machine";
import { usePairing } from "@/data/pairing-scope";
import { uuidV4 } from "@/data/random";
import {
  draftAfter,
  EMPTY_DRAFT,
  sessionMessage,
  setSessionMessage,
  useDraftsUnreadable,
  useSessionMessageState,
  type MessageDraft,
  type MessageOutcome,
  type MessageReceipt,
  type SendMessageBody,
} from "@/data/session-message";
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

const parseDelivery = (value: unknown): AgentSteerDeliveryDto => {
  const row = record(value, "steer delivery");
  const tag = string(row, "_tag", "steer delivery");
  switch (tag) {
    case "Sending":
      return { _tag: tag };
    case "Accepted":
      return {
        _tag: tag,
        evidence:
          row.evidence === "provider-acknowledged" ? "provider-acknowledged" : "transport-written",
      };
    case "Queued":
      return {
        _tag: tag,
        turnId: string(row, "turnId", "steer delivery"),
        reason: string(row, "reason", "steer delivery"),
      };
    case "NotSent":
      return { _tag: tag, reason: string(row, "reason", "steer delivery") };
    default:
      // A delivery this build does not know is one it cannot confirm.
      return { _tag: "Unknown", reason: typeof row.reason === "string" ? row.reason : tag };
  }
};

const parseSteer = (value: unknown): AgentTurnSteerDto => {
  const row = record(value, "steer");
  return {
    id: string(row, "id", "steer"),
    turnId: string(row, "turnId", "steer"),
    ordinal: integer(row, "ordinal", "steer"),
    author: string(row, "author", "steer"),
    input: string(row, "input", "steer"),
    createdAt: string(row, "createdAt", "steer"),
    delivery: parseDelivery(row.delivery),
  };
};

const parseTurn = (value: unknown): AgentTurnDto => {
  const row = record(value, "agent turn");
  // Older servers send no origin: every turn they recorded was sent by Mend.
  const origin = row["origin"];
  return {
    id: string(row, "id", "agent turn"),
    ordinal: integer(row, "ordinal", "agent turn"),
    ...(typeof origin === "string" ? { origin } : {}),
    // Who sent it and whose login paid (docs/adr/0013); older servers send neither.
    ...("author" in row ? { author: nullableString(row, "author", "agent turn") } : {}),
    ...("billedUserId" in row
      ? { billedUserId: nullableString(row, "billedUserId", "agent turn") }
      : {}),
    ...("billedAccountName" in row
      ? { billedAccountName: nullableString(row, "billedAccountName", "agent turn") }
      : {}),
    // Servers from before steering send neither.
    ...("steers" in row ? { steers: parseArray(row.steers, "agent turn", parseSteer) } : {}),
    ...("fromSteer" in row ? { fromSteer: nullableString(row, "fromSteer", "agent turn") } : {}),
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
    // Read where it is used (`agentTaskOf`): only some kinds carry a record worth reading.
    data: row["data"],
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

const loadAgentItems = (machine: Machine, sessionId: string, initialAfter: number) =>
  readAgentItemsAfter(
    async (after, limit) =>
      parseArray(
        await machine.read<unknown>(`/sessions/${sessionId}/items?after=${after}&limit=${limit}`),
        "agent items",
        parseItem,
      ),
    initialAfter,
  ).catch((error: unknown) => {
    throw error instanceof AgentItemCursorStalled ? malformed("agent item cursor") : error;
  });

const conversationKey = (sessionId: string) => ["session", sessionId, "conversation"] as const;

export const useAgentConversation = (sessionId: string, enabled: boolean, live: boolean) => {
  const { machine } = usePairing();
  const queryClient = useQueryClient();
  const queryKey = conversationKey(sessionId);
  return useQuery({
    queryKey,
    enabled,
    queryFn: async (): Promise<AgentConversationDto> => {
      const previous = queryClient.getQueryData<AgentConversationDto>(queryKey);
      const after = latestItemSeq(previous?.items ?? []);
      const [turns, updates, requests] = await Promise.all([
        machine.read<unknown>(`/sessions/${sessionId}/turns`),
        loadAgentItems(machine, sessionId, after),
        machine.read<unknown>(`/sessions/${sessionId}/requests`),
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
  const { machine } = usePairing();
  const queryClient = useQueryClient();
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
      queryClient.invalidateQueries({ queryKey: ["session", sessionId, "conversation"] }),
    ]);
  const respond = useMutation({
    mutationFn: (input: { readonly requestId: string; readonly response: AgentRequestResponse }) =>
      machine.write<unknown>("POST", `/requests/${input.requestId}/respond`, input.response),
    onSettled: invalidate,
  });
  // Steering: a queued turn is cancelled outright; a running one reaches the
  // harness's own interrupt. The process stays live for the next message.
  const interrupt = useMutation({
    mutationFn: (turnId: string) =>
      machine.writeNoContent("POST", `/turns/${turnId}/interrupt`, {}),
    onSettled: invalidate,
  });
  return { respond, interrupt };
};

type Recorded =
  | { readonly _tag: "Turn"; readonly turn: AgentTurnDto }
  | { readonly _tag: "Steer"; readonly steer: AgentTurnSteerDto };

const parseReceipt = (
  value: unknown,
): { readonly receipt: MessageReceipt; readonly recorded: Recorded } => {
  const row = record(value, "message receipt");
  const explanation = string(row, "explanation", "message receipt");
  if (row._tag === "Turn") {
    const turn = record(row.turn, "message receipt");
    return {
      receipt: {
        _tag: "Turn",
        explanation,
        status: string(turn, "status", "message receipt"),
        startedAt: nullableString(turn, "startedAt", "message receipt"),
      },
      recorded: { _tag: "Turn", turn: parseTurn(turn) },
    };
  }
  if (row._tag === "Steer") {
    const steer = parseSteer(row.steer);
    return {
      receipt: { _tag: "Steer", explanation, delivery: steer.delivery._tag },
      recorded: { _tag: "Steer", steer },
    };
  }
  throw malformed("message receipt");
};

/** The conversation with what a receipt recorded in it, so it shows before the next read. */
const withRecorded = (
  conversation: AgentConversationDto,
  recorded: Recorded,
): AgentConversationDto => {
  if (recorded._tag === "Turn") {
    const { turn } = recorded;
    return conversation.turns.some((existing) => existing.id === turn.id)
      ? conversation
      : { ...conversation, turns: [...conversation.turns, turn] };
  }
  const { steer } = recorded;
  return {
    ...conversation,
    turns: conversation.turns.map((turn) =>
      turn.id !== steer.turnId || (turn.steers ?? []).some((existing) => existing.id === steer.id)
        ? turn
        : { ...turn, steers: [...(turn.steers ?? []), steer] },
    ),
  };
};

const SENDING: MessageOutcome = { _tag: "Sending" };
/** How long Send waits for Mend's answer before calling the outcome not confirmed. */
const MESSAGE_ANSWER_MS = 30_000;
const NOT_STORED = "not sent · the phone could not store the message first · try again";
const SERVER_TOO_OLD =
  "not sent · this Mend server is older than the app and takes no messages from it · update the server";

/** This phone's images by the turn or steer they went with, so the conversation shows its copies. */
const sentImages = new Map<string, ReadonlyArray<LocalImage>>();
export const ownImages: ReadonlyMap<string, ReadonlyArray<LocalImage>> = sentImages;

export interface MessageSender {
  /** False until the phone has read its stored drafts: nothing may be typed or sent before. */
  readonly ready: boolean;
  /** The stored drafts could not be read yet; the phone keeps trying. */
  readonly unreadable: boolean;
  readonly draft: MessageDraft;
  readonly outcome: MessageOutcome;
  readonly setText: (text: string) => void;
  /** An image stored beside the session, from now on carried by the draft. */
  readonly addImage: (image: LocalImage) => void;
  readonly removeImage: (path: string) => void;
  /** Sends the draft. True once Mend took it and the draft is cleared. */
  readonly send: () => Promise<boolean>;
}

/**
 * The person's message in a live conversation (session-message.ts), sent through Mend's send
 * rule. One send at a time: Send waits for Mend's answer, never for the agent. The turn or steer
 * the receipt names is written into the cached conversation straight away, so the words, Stop and
 * the working line need not wait for the next poll.
 */
export const useMessageSender = (sessionId: string): MessageSender => {
  const { machine } = usePairing();
  const queryClient = useQueryClient();
  // Captured for the send's whole life: an answer for a pairing that has ended changes nothing.
  const pairing = machine.key;
  const state = useSessionMessageState(pairing, sessionId);
  const unreadable = useDraftsUnreadable();
  const edit = (change: (draft: MessageDraft, outcome: MessageOutcome) => MessageDraft) => {
    const current = sessionMessage(pairing, sessionId);
    if (current !== null) {
      void setSessionMessage(pairing, sessionId, {
        draft: change(current.draft, current.outcome),
      });
    }
  };

  const send = async (): Promise<boolean> => {
    const current = sessionMessage(pairing, sessionId);
    if (current === null || current.outcome._tag === "Sending") return false;
    const key = current.draft.clientMessageId ?? uuidV4();
    const attempt: MessageDraft = { ...current.draft, clientMessageId: key };
    const body: SendMessageBody = {
      input: composeTurnInput(attempt.text, attempt.images),
      clientMessageId: key,
    };
    // The key reaches the phone's storage before the server: a send that went out under a key the
    // phone then lost would go again, after a restart, under another.
    if (!(await setSessionMessage(pairing, sessionId, { draft: attempt, outcome: SENDING }))) {
      void setSessionMessage(pairing, sessionId, {
        outcome: { _tag: "Refused", words: NOT_STORED },
      });
      return false;
    }
    const cached = conversationKey(sessionId);
    // A poll already in flight would land without the new turn and overwrite what is written below.
    await queryClient.cancelQueries({ queryKey: cached });
    try {
      const { receipt, recorded } = parseReceipt(
        await machine.write<unknown>(
          "POST",
          `/sessions/${sessionId}/messages`,
          body,
          MESSAGE_ANSWER_MS,
        ),
      );
      if (attempt.images.length > 0) {
        sentImages.set(
          recorded._tag === "Turn" ? recorded.turn.id : recorded.steer.id,
          attempt.images,
        );
      }
      queryClient.setQueryData<AgentConversationDto>(cached, (conversation) =>
        conversation === undefined ? conversation : withRecorded(conversation, recorded),
      );
      const next = draftAfter(receipt, attempt);
      void setSessionMessage(pairing, sessionId, {
        draft: next,
        outcome: { _tag: "Answered", explanation: receipt.explanation },
      });
      return next === EMPTY_DRAFT;
    } catch (error) {
      if (error instanceof ApiError && error.tag === "MessageKeyConflict") {
        void setSessionMessage(pairing, sessionId, {
          outcome: { _tag: "KeyUsed", words: error.message },
        });
      } else if (error instanceof ApiError && error.tag !== null) {
        void setSessionMessage(pairing, sessionId, {
          outcome: { _tag: "Refused", words: error.message },
        });
      } else if (error instanceof ApiError && error.status === 404) {
        // A server from before this route answers with no tag: nothing was recorded.
        void setSessionMessage(pairing, sessionId, {
          outcome: { _tag: "Refused", words: SERVER_TOO_OLD },
        });
      } else {
        // No answer, or one Mend did not write (an edge's page, an untagged 5xx): the message may
        // have been recorded, so the draft keeps its key.
        void setSessionMessage(pairing, sessionId, { outcome: { _tag: "Unconfirmed" } });
      }
      return false;
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    }
  };

  return {
    ready: state !== null,
    unreadable,
    draft: state?.draft ?? EMPTY_DRAFT,
    outcome: state?.outcome ?? { _tag: "Idle" },
    // After a key conflict, sending the same words again is the same message: only new words
    // are a new one, under a new key.
    setText: (text) =>
      edit((draft, outcome) =>
        outcome._tag === "KeyUsed" && text !== draft.text
          ? { ...draft, text, clientMessageId: null }
          : { ...draft, text },
      ),
    addImage: (image) => edit((draft) => ({ ...draft, images: [...draft.images, image] })),
    removeImage: (path) =>
      edit((draft) => ({ ...draft, images: draft.images.filter((image) => image.path !== path) })),
    send,
  };
};
