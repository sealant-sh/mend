import {
  type AgentItemDto,
  type AgentRequestDto,
  type AgentTurnSteerDto,
  buildAgentConversation,
  isHarnessTurn,
  isOpenTurn,
} from "@mend/agent-conversation";

import type { ConversationView, TurnView } from "./conversation.ts";
import { arrivedIn, type OutboxMessage } from "./outbox.ts";

/** A run of the agent's output: what it wrote, a table of what it did, or what it asks. */
export type Segment =
  | { readonly kind: "text"; readonly key: string; readonly item: AgentItemDto }
  | { readonly kind: "steps"; readonly key: string; readonly items: ReadonlyArray<AgentItemDto> }
  | { readonly kind: "request"; readonly key: string; readonly request: AgentRequestDto };

/** One message of the conversation as the list shows it. */
export type ConversationRow =
  | {
      readonly kind: "you";
      readonly key: string;
      readonly text: string;
      /** Who sent it: a Mend user id, null for a message Mend sent itself. */
      readonly author: string | null;
      readonly at: string;
      /** A message into a running turn, with how far it got. */
      readonly steer: AgentTurnSteerDto | null;
      /** The key it was sent under, when it was sent with one. */
      readonly clientMessageId: string | null;
      /**
       * The sender's own message as this tab holds it, while it is on its way or after it did not
       * arrive: its bubble says so and offers Retry and Edit. Null once the server's own turn or
       * steer shows it.
       */
      readonly outbox: OutboxMessage | null;
    }
  | {
      readonly kind: "agent";
      readonly key: string;
      readonly turn: TurnView | null;
      readonly at: string;
      /** Still working: its steps show as they happen, and the live line follows it. */
      readonly open: boolean;
      readonly segments: ReadonlyArray<Segment>;
      /** A finished turn's steps, folded under "Worked for …". */
      readonly folded: ReadonlyArray<AgentItemDto>;
    };

/** Kinds that are the agent thinking aloud: never shown as steps. */
const SILENT: ReadonlySet<string> = new Set(["reasoning", "user-message"]);

const isText = (item: AgentItemDto) => item.kind === "assistant-message";

/**
 * The conversation as rows: each turn's message, then the agent's reply. A finished turn shows
 * what the agent wrote and folds its steps; an open one shows its steps where they happened. A
 * message sent into a running turn breaks the reply where it arrived.
 */
export const conversationRows = (
  conversation: ConversationView,
): ReadonlyArray<ConversationRow> => {
  const rows: Array<ConversationRow> = [];
  let agent: {
    kind: "agent";
    key: string;
    turn: TurnView | null;
    at: string;
    open: boolean;
    segments: Array<Segment>;
    folded: Array<AgentItemDto>;
  } | null = null;
  let part = 0;
  const flush = () => {
    if (agent !== null && (agent.segments.length > 0 || agent.folded.length > 0)) rows.push(agent);
    agent = null;
  };
  const current = (turn: TurnView | null, at: string) => {
    if (agent === null) {
      part += 1;
      agent = {
        kind: "agent",
        key: `agent:${turn?.id ?? "loose"}:${part}`,
        turn,
        at,
        open: turn !== null && isOpenTurn(turn),
        segments: [],
        folded: [],
      };
    }
    return agent;
  };
  let turn: TurnView | null = null;
  for (const entry of buildAgentConversation(conversation)) {
    switch (entry.kind) {
      case "turn": {
        flush();
        turn = entry.turn;
        if (!isHarnessTurn(entry.turn)) {
          const clientMessageId =
            entry.turn.clientMessageId ?? entry.fromSteer?.clientMessageId ?? null;
          rows.push({
            kind: "you",
            key: messageKey(clientMessageId, entry.key),
            text: entry.fromSteer?.input ?? entry.turn.input,
            author: entry.turn.author ?? null,
            at: entry.turn.createdAt,
            steer: null,
            clientMessageId,
            outbox: null,
          });
        }
        break;
      }
      case "steer": {
        flush();
        const clientMessageId = entry.steer.clientMessageId ?? null;
        rows.push({
          kind: "you",
          key: messageKey(clientMessageId, entry.key),
          text: entry.steer.input,
          author: entry.steer.author,
          at: entry.steer.createdAt,
          steer: entry.steer,
          clientMessageId,
          outbox: null,
        });
        break;
      }
      case "request": {
        const into = current(turn, entry.request.createdAt);
        into.segments.push({ kind: "request", key: entry.key, request: entry.request });
        break;
      }
      case "item": {
        const { item } = entry;
        if (SILENT.has(item.kind)) break;
        const into = current(turn, item.createdAt);
        if (isText(item)) {
          into.segments.push({ kind: "text", key: entry.key, item });
          break;
        }
        if (!into.open) {
          into.folded.push(item);
          break;
        }
        const last = into.segments.at(-1);
        if (last?.kind === "steps") {
          into.segments[into.segments.length - 1] = {
            ...last,
            items: [...last.items, item],
          };
        } else into.segments.push({ kind: "steps", key: entry.key, items: [item] });
        break;
      }
    }
  }
  flush();
  return rows;
};

/**
 * A sent message's row key: its key when it has one, so the bubble shown at Send and the server's
 * row that replaces it are one row to React and to the scroller.
 */
const messageKey = (clientMessageId: string | null, fallback: string): string =>
  clientMessageId === null ? fallback : `message:${clientMessageId}`;

/**
 * The conversation with the sender's own outbox laid over it (`lib/outbox`): every message not
 * yet in the server's conversation is a bubble at the end, in the order sent; one the server
 * recorded and refused stays the server's row and carries its Retry and Edit. A message that
 * arrived shows once, as the server's row.
 */
export const withOutbox = (
  rows: ReadonlyArray<ConversationRow>,
  conversation: ConversationView,
  outbox: ReadonlyArray<OutboxMessage>,
  author: string,
): ReadonlyArray<ConversationRow> => {
  if (outbox.length === 0) return rows;
  const refused = new Map(
    outbox.flatMap((message) =>
      message.state._tag === "NotSent" ? [[message.clientMessageId, message] as const] : [],
    ),
  );
  const shown = rows.map((row) => {
    if (row.kind !== "you" || row.clientMessageId === null) return row;
    const message = refused.get(row.clientMessageId);
    return message === undefined ? row : { ...row, outbox: message };
  });
  const waiting = outbox.filter((message) => !arrivedIn(conversation, message));
  return [
    ...shown,
    ...waiting.map(
      (message): ConversationRow => ({
        kind: "you",
        key: messageKey(message.clientMessageId, message.clientMessageId),
        text: message.text,
        author,
        at: message.sentAt,
        steer: null,
        clientMessageId: message.clientMessageId,
        outbox: message,
      }),
    ),
  ];
};

/** The agent's latest words, for the strip above the composer on every other tab. */
export const latestAgentText = (conversation: ConversationView): AgentItemDto | null => {
  let latest: AgentItemDto | null = null;
  for (const item of conversation.items) {
    if (isText(item) && item.text !== null && item.text.trim() !== "") {
      if (latest === null || item.createdAt >= latest.createdAt) latest = item;
    }
  }
  return latest;
};

/** What the running turn is doing now: its newest step still in progress. */
export const workingOn = (conversation: ConversationView): AgentItemDto | null => {
  let latest: AgentItemDto | null = null;
  for (const item of conversation.items) {
    if (item.status !== "in-progress" || SILENT.has(item.kind)) continue;
    if (latest === null || item.updatedAt >= latest.updatedAt) latest = item;
  }
  return latest;
};
