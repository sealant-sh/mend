/**
 * A protocol-mode session read as a conversation: the durable authored turns, the items the agent
 * said or did during each, and what it asked a person to decide. The shapes here are the least
 * any client needs; the phone parses its own DTOs into them and the desktop passes the contract's
 * wire types, which carry more. Nothing here may use newer Array prototype methods: the phone's
 * runtime does not have all of them.
 */

export interface AgentTurnDto {
  readonly id: string;
  readonly ordinal: number;
  readonly input: string;
  readonly status: string;
  readonly error: string | null;
  readonly createdAt: string;
}

export interface AgentItemDto {
  readonly id: string;
  /** Session-wide update cursor. It changes when an in-progress item grows. */
  readonly seq: number;
  readonly turnId: string;
  readonly kind: string;
  readonly status: string;
  readonly title: string | null;
  readonly text: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentInputOptionDto {
  readonly label: string;
  readonly description: string | null;
}

export interface AgentInputQuestionDto {
  readonly id: string;
  readonly header: string | null;
  readonly question: string;
  readonly options: ReadonlyArray<AgentInputOptionDto>;
  readonly multiSelect: boolean;
}

export interface AgentRequestDto {
  readonly id: string;
  readonly turnId: string;
  readonly kind: string;
  readonly title: string | null;
  readonly detail: unknown;
  readonly questions: ReadonlyArray<AgentInputQuestionDto> | null;
  readonly status: string;
  readonly decision: string | null;
  readonly answers: Readonly<Record<string, ReadonlyArray<string>>> | null;
  readonly createdAt: string;
}

export interface AgentConversation<
  T extends AgentTurnDto = AgentTurnDto,
  I extends AgentItemDto = AgentItemDto,
  R extends AgentRequestDto = AgentRequestDto,
> {
  readonly turns: ReadonlyArray<T>;
  readonly items: ReadonlyArray<I>;
  readonly requests: ReadonlyArray<R>;
}

export type AgentConversationDto = AgentConversation;

export type AgentConversationEntry<
  T extends AgentTurnDto = AgentTurnDto,
  I extends AgentItemDto = AgentItemDto,
  R extends AgentRequestDto = AgentRequestDto,
> =
  | { readonly kind: "turn"; readonly key: string; readonly turn: T }
  | { readonly kind: "item"; readonly key: string; readonly item: I }
  | { readonly kind: "request"; readonly key: string; readonly request: R };

export const EMPTY_CONVERSATION: AgentConversation<never, never, never> = {
  turns: [],
  items: [],
  requests: [],
};

const sortedCopy = <T>(
  values: ReadonlyArray<T>,
  compare: (left: T, right: T) => number,
): ReadonlyArray<T> =>
  values.reduce<ReadonlyArray<T>>((ordered, value) => {
    const insertion = ordered.findIndex((existing) => compare(value, existing) < 0);
    return insertion === -1
      ? [...ordered, value]
      : [...ordered.slice(0, insertion), value, ...ordered.slice(insertion)];
  }, []);

const lastMatching = <T>(
  values: ReadonlyArray<T>,
  predicate: (value: T) => boolean,
): T | undefined => {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return value;
  }
  return undefined;
};

/** Apply cursor-delivered item updates without duplicating provider items. */
export const mergeAgentItems = <I extends AgentItemDto>(
  current: ReadonlyArray<I>,
  updates: ReadonlyArray<I>,
): ReadonlyArray<I> => {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of updates) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
};

/** The item cursor to read on from: the highest `seq` already held, 0 for none. */
export const latestItemSeq = (items: ReadonlyArray<AgentItemDto>): number =>
  items.reduce((latest, item) => Math.max(latest, item.seq), 0);

/** Render authored turns first, then each turn's ordered items and human requests. */
export const buildAgentConversation = <
  T extends AgentTurnDto,
  I extends AgentItemDto,
  R extends AgentRequestDto,
>(
  conversation: AgentConversation<T, I, R>,
): ReadonlyArray<AgentConversationEntry<T, I, R>> => {
  const entries: Array<AgentConversationEntry<T, I, R>> = [];
  const turns = sortedCopy(conversation.turns, (a, b) => a.ordinal - b.ordinal);
  const seenItems = new Set<string>();
  const seenRequests = new Set<string>();

  for (const turn of turns) {
    entries.push({ kind: "turn", key: `turn:${turn.id}`, turn });
    const children = [
      ...conversation.items
        .filter((item) => item.turnId === turn.id && item.kind !== "user-message")
        .map((item) => ({ kind: "item" as const, at: item.createdAt, id: item.id, item })),
      ...conversation.requests
        .filter((request) => request.turnId === turn.id)
        .map((request) => ({
          kind: "request" as const,
          at: request.createdAt,
          id: request.id,
          request,
        })),
    ];
    const orderedChildren = sortedCopy(
      children,
      (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
    );

    for (const child of orderedChildren) {
      if (child.kind === "item") {
        seenItems.add(child.item.id);
        entries.push({ kind: "item", key: `item:${child.item.id}`, item: child.item });
      } else {
        seenRequests.add(child.request.id);
        entries.push({
          kind: "request",
          key: `request:${child.request.id}`,
          request: child.request,
        });
      }
    }
  }

  for (const item of conversation.items) {
    if (seenItems.has(item.id) || item.kind === "user-message") {
      continue;
    }
    entries.push({ kind: "item", key: `item:${item.id}`, item });
  }
  for (const request of conversation.requests) {
    if (seenRequests.has(request.id)) {
      continue;
    }
    entries.push({ kind: "request", key: `request:${request.id}`, request });
  }
  return entries;
};

/** Turn statuses that still occupy, or will occupy, the agent. */
export const isOpenTurn = (turn: AgentTurnDto): boolean =>
  turn.status === "queued" || turn.status === "running";

/** The newest turn still queued or running: what Stop interrupts. */
export const openTurnOf = <T extends AgentTurnDto>(turns: ReadonlyArray<T>): T | undefined =>
  lastMatching(turns, isOpenTurn);

/** The first request still waiting on a person. */
export const pendingRequestOf = <R extends AgentRequestDto>(
  requests: ReadonlyArray<R>,
): R | undefined => requests.find((request) => request.status === "pending");

/**
 * What a live conversation is doing: waiting on a person's answer, or working on a turn. Null
 * when neither is observed. Each client words it for who is looking.
 */
export const conversationActivity = (
  conversation: AgentConversation,
): "waiting" | "working" | null => {
  if (pendingRequestOf(conversation.requests) !== undefined) return "waiting";
  if (openTurnOf(conversation.turns) !== undefined) return "working";
  return null;
};
