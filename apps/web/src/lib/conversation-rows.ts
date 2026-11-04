import {
  type AgentItemDto,
  type AgentRequestDto,
  type AgentTurnSteerDto,
  buildAgentConversation,
  agentTaskOf,
  type AgentTaskView,
  isHarnessTurn,
  isOpenTurn,
} from "@mend/agent-conversation";
import { isHarnessSetupMessage } from "@mend/domain/workbench";

import type { ConversationView, TurnView } from "./conversation.ts";
import { arrivedIn, type OutboxMessage } from "./outbox.ts";
import { parentToolUseId, subAgentOf, toolUseId, type SubAgentView } from "./sub-agents.ts";

/** A run of the agent's output: what it wrote, a table of what it did, or what it asks. */
export type Segment =
  | { readonly kind: "text"; readonly key: string; readonly item: AgentItemDto }
  | { readonly kind: "steps"; readonly key: string; readonly items: ReadonlyArray<AgentItemDto> }
  | { readonly kind: "task"; readonly key: string; readonly task: AgentTaskView }
  | {
      readonly kind: "sub-agent";
      readonly key: string;
      readonly agent: SubAgentView;
      /** The background task a background call started; it carries the agent's progress. */
      readonly task: AgentTaskView | null;
      readonly segments: ReadonlyArray<Segment>;
      readonly stepCount: number;
    }
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

/** How a turn ends without doing what was asked: its row says why, said or not. */
const ENDED_BADLY: ReadonlySet<string> = new Set(["failed", "interrupted", "cancelled"]);

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
  const calls = new Map<string, AgentItemDto>(
    conversation.items.flatMap((item) => {
      const id = toolUseId(item);
      return id === null || subAgentOf(item) === null
        ? []
        : [[`${item.turnId}:${id}`, item] as const];
    }),
  );
  const children = new Map<string, Array<AgentItemDto>>();
  const nested = new Set<string>();
  for (const item of conversation.items) {
    const parent = parentToolUseId(item);
    const key = `${item.turnId}:${parent}`;
    if (parent === null || !calls.has(key) || toolUseId(item) === parent) continue;
    const held = children.get(key) ?? [];
    held.push(item);
    children.set(key, held);
    nested.add(item.id);
  }
  // A background `Agent` call returns as soon as its agent starts; the agent itself is the task
  // that call started. They are one sub-agent: the call says what it was asked, the task how it went.
  const tasks = new Map<string, { readonly itemId: string; readonly task: AgentTaskView }>();
  for (const item of conversation.items) {
    const task = agentTaskOf(item);
    if (task === null || task.taskType !== "local_agent") continue;
    const entry = { itemId: item.id, task };
    if (task.toolUseId !== null) tasks.set(`${item.turnId}:${task.toolUseId}`, entry);
    tasks.set(`${item.turnId}:said:${task.description}`, entry);
  }
  const taskOfCall = new Map<string, AgentTaskView>();
  const absorbed = new Set<string>();
  for (const item of conversation.items) {
    const call = subAgentOf(item);
    if (call === null || !call.background) continue;
    const entry =
      tasks.get(`${item.turnId}:${toolUseId(item)}`) ??
      tasks.get(`${item.turnId}:said:${call.description}`);
    if (entry === undefined || absorbed.has(entry.itemId)) continue;
    taskOfCall.set(item.id, entry.task);
    absorbed.add(entry.itemId);
  }
  const endedTurns = new Set(
    conversation.turns.flatMap((turn) => (isOpenTurn(turn) ? [] : [turn.id])),
  );
  const append = (
    segments: Array<Segment>,
    item: AgentItemDto,
    key: string,
    ancestors: ReadonlySet<string> = new Set(),
  ) => {
    if (SILENT.has(item.kind) || absorbed.has(item.id)) return;
    const subAgent = subAgentOf(item);
    const task = agentTaskOf(item);
    if (subAgent !== null) {
      const inner: Array<Segment> = [];
      const next = new Set([...ancestors, item.id]);
      const steps = (children.get(`${item.turnId}:${toolUseId(item)}`) ?? []).toSorted(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      for (const child of steps) {
        if (!next.has(child.id)) append(inner, child, child.id, next);
      }
      segments.push({
        kind: "sub-agent",
        key,
        agent:
          subAgent.status === "running" && endedTurns.has(item.turnId)
            ? { ...subAgent, status: "stopped" }
            : subAgent,
        task: taskOfCall.get(item.id) ?? null,
        segments: inner,
        stepCount: steps.filter((step) => !isText(step) && !SILENT.has(step.kind)).length,
      });
    } else if (task !== null) {
      segments.push({ kind: "task", key, task });
    } else if (isText(item)) {
      segments.push({ kind: "text", key, item });
    } else {
      const last = segments.at(-1);
      if (last?.kind === "steps")
        segments[segments.length - 1] = { ...last, items: [...last.items, item] };
      else segments.push({ kind: "steps", key, items: [item] });
    }
  };
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
  // Turns that have an agent row: one that ended badly with nothing said still gets one, so its
  // failure shows where its reply would be.
  const replied = new Set<string>();
  const flush = () => {
    if (agent !== null && (agent.segments.length > 0 || agent.folded.length > 0)) {
      rows.push(agent);
      if (agent.turn !== null) replied.add(agent.turn.id);
    }
    agent = null;
  };
  const closeTurn = (ended: TurnView | null) => {
    if (ended === null || replied.has(ended.id) || !ENDED_BADLY.has(ended.status)) return;
    part += 1;
    rows.push({
      kind: "agent",
      key: `agent:${ended.id}:${part}`,
      turn: ended,
      at: ended.endedAt ?? ended.createdAt,
      open: false,
      segments: [],
      folded: [],
    });
    replied.add(ended.id);
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
        closeTurn(turn);
        turn = entry.turn;
        // A turn Codex or Claude opened itself has no message to show, nor one carried over from
        // an earlier terminal session that is exactly Codex's injected AGENTS.md envelope. A turn
        // a message became (it has the message's key) is a person's words, always shown.
        const injected =
          entry.turn.clientMessageId == null &&
          entry.fromSteer === undefined &&
          isHarnessSetupMessage(entry.turn.input);
        if (!isHarnessTurn(entry.turn) && !injected) {
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
        if (SILENT.has(item.kind) || nested.has(item.id) || absorbed.has(item.id)) break;
        const into = current(turn, item.createdAt);
        if (
          !into.open &&
          !isText(item) &&
          subAgentOf(item) === null &&
          agentTaskOf(item) === null
        ) {
          into.folded.push(item);
          break;
        }
        append(into.segments, item, entry.key);
        break;
      }
    }
  }
  flush();
  closeTurn(turn);
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

const EMPTY_HISTORY: ConversationView = { turns: [], items: [], requests: [] };

/**
 * What the conversation shows. The history's read may still be on its way or have failed; the
 * person's own outbox shows regardless, so a message sent meanwhile is never hidden behind it,
 * and the read's state shows beside it. A failed re-read keeps the history already held.
 */
export const conversationBody = (
  history: {
    readonly status: "pending" | "error" | "success";
    readonly data: ConversationView | undefined;
  },
  outbox: ReadonlyArray<OutboxMessage>,
  author: string,
): {
  readonly notice: "reading" | "failed" | null;
  /** The protocol rows, a terminal session's record, or nothing yet. */
  readonly list: "protocol" | "transcript" | null;
  readonly rows: ReadonlyArray<ConversationRow>;
} => {
  const held = history.data ?? EMPTY_HISTORY;
  const protocol = held.turns.length > 0 || outbox.length > 0;
  return {
    notice: history.status === "pending" ? "reading" : history.status === "error" ? "failed" : null,
    list: protocol ? "protocol" : history.data === undefined ? null : "transcript",
    rows: withOutbox(conversationRows(held), held, outbox, author),
  };
};

/**
 * How long a turn ran, in milliseconds; null when that is not known. A turn carried over from a
 * terminal has no measured length (its start and end are the moment it was carried over), so it
 * says how many steps it took, not for how long.
 */
export const turnLasted = (turn: {
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}): number | null => {
  if (turn.startedAt === null || turn.endedAt === null) return null;
  const lasted = new Date(turn.endedAt).getTime() - new Date(turn.startedAt).getTime();
  return lasted > 0 ? lasted : null;
};

/** What a person does after a turn that did not finish: sign the agent in, or send again. */
export type TurnNext = "connect-login" | "send-again";

/** Words that say the agent has no working login (Claude's "Not logged in · Please run /login"). */
const LOGIN_TROUBLE =
  /not logged in|\/login|log ?in again|authenticat|unauthori[sz]ed|invalid api key|api key|credentials?|\b401\b|token (has )?expired/i;

/**
 * Why an agent row's turn did not finish as asked, in the server's and the agent's own words,
 * and what to do next; null for a turn that finished or still runs. A turn whose words say its
 * login is the trouble points at connecting it; any other failure, at sending again.
 */
export const turnEnd = (
  row: Extract<ConversationRow, { readonly kind: "agent" }>,
): { readonly words: string; readonly next: TurnNext | null } | null => {
  const turn = row.turn;
  if (turn === null) return null;
  const said = [
    turn.error ?? "",
    ...row.segments.map((segment) => (segment.kind === "text" ? (segment.item.text ?? "") : "")),
  ].join("\n");
  const next: TurnNext = LOGIN_TROUBLE.test(said) ? "connect-login" : "send-again";
  switch (turn.status) {
    case "failed":
      return { words: `The turn failed${turn.error === null ? "." : `: ${turn.error}`}`, next };
    case "interrupted":
      return { words: "The turn was interrupted.", next: "send-again" };
    case "cancelled":
      return {
        words: `The turn was withdrawn${turn.error === null ? "." : `: ${turn.error}`}`,
        next,
      };
    default:
      return null;
  }
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
