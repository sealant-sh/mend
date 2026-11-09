import {
  type AgentConversation,
  type AgentItemDto,
  type AgentRequestDto,
  type AgentTurnDto,
} from "@mend/agent-conversation";
import type { UnreachableCause } from "@mend/domain/workbench";
import { type InfiniteData, infiniteQueryOptions, type QueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "../server/routers/index.ts";
import { SESSION_STALE_MS } from "./session-queries.ts";
import type { TrpcClient, TrpcProxy } from "./trpc.ts";

type Outputs = inferRouterOutputs<AppRouter>;
type WireTurn = Outputs["sessions"]["historyTurns"]["turns"][number];
type WireItem = Outputs["sessions"]["items"][number];
type WireRequest = Outputs["sessions"]["historyRequests"]["requests"][number];

/** A turn as the conversation reads it: the shared shape plus when it started and ended. */
export interface TurnView extends AgentTurnDto {
  readonly sessionId: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** Why a turn on a login with an endpoint could not connect; null or absent otherwise. */
  readonly unreachable?: UnreachableCause | null;
}

export type ConversationView = AgentConversation<TurnView, AgentItemDto, AgentRequestDto>;

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));

/** The wire's dates as ISO strings, the shared conversation package's shape. */
const turnView = (turn: WireTurn): TurnView => ({
  id: turn.id,
  sessionId: turn.sessionId,
  ordinal: turn.ordinal,
  origin: turn.origin,
  author: turn.author,
  billedUserId: turn.billedUserId,
  billedAccountName: turn.billedAccountName,
  steerSender: turn.steerSender,
  fromSteer: turn.fromSteer,
  clientMessageId: turn.clientMessageId,
  steers: turn.steers.map((steer) => ({
    id: steer.id,
    turnId: steer.turnId,
    ordinal: steer.ordinal,
    author: steer.author,
    input: steer.input,
    createdAt: iso(steer.createdAt),
    delivery: steer.delivery,
    clientMessageId: steer.clientMessageId,
  })),
  input: turn.input,
  status: turn.status,
  error: turn.error,
  createdAt: iso(turn.createdAt),
  startedAt: isoOrNull(turn.startedAt),
  endedAt: isoOrNull(turn.endedAt),
  unreachable: turn.unreachable,
});

const itemView = (item: WireItem): AgentItemDto => ({
  id: item.id,
  seq: item.seq,
  turnId: item.turnId,
  kind: item.kind,
  status: item.status,
  title: item.title,
  text: item.text,
  data: item.data,
  createdAt: iso(item.createdAt),
  updatedAt: iso(item.updatedAt),
});

const requestView = (request: WireRequest): AgentRequestDto => ({
  id: request.id,
  turnId: request.turnId,
  kind: request.kind,
  title: request.title,
  detail: request.detail,
  questions: request.questions,
  status: request.status,
  decision: request.decision,
  answers: request.answers,
  createdAt: iso(request.createdAt),
});

/** Where a session's conversation pages are cached (`conversationQuery`): the tRPC factory's key. */
export const conversationKey = (
  trpc: TrpcProxy,
  sessionId: string,
  limit = CONVERSATION_PAGE_ITEMS,
) => [...trpc.sessions.historyItems.infiniteQueryKey({ id: sessionId, limit })];

/**
 * One window of a session's conversation, newest windows first: its items, the turns they are in
 * and those turns' requests, each read for the window by the same cursor. `next` is where the
 * next older window starts (null: this one reaches the start); `feed` is the session's highest
 * item `seq` when read, where the event stream follows updates from.
 */
export interface ConversationPage extends ConversationView {
  readonly next: string | null;
  readonly feed: number;
}

/** About one screen: the newest window holds this many items. */
export const CONVERSATION_PAGE_ITEMS = 30;

/**
 * A session's conversation in the query cache, as an infinite query of history windows, newest
 * first: the first page is the latest window, and each older one is read only when the reader
 * scrolls up to it. The key is the tRPC factory's, under the `sessions` path; the event stream
 * patches the held pages (`lib/conversation-live.ts`) instead of reading them again.
 */
export const conversationQuery = (
  trpc: TrpcProxy,
  client: TrpcClient,
  sessionId: string,
  /** Hears each page as it lands (the outbox drops what the session now holds). */
  onRead: (page: ConversationView) => void = () => undefined,
  limit: number = CONVERSATION_PAGE_ITEMS,
) =>
  infiniteQueryOptions({
    queryKey: conversationKey(trpc, sessionId, limit),
    initialPageParam: null as string | null,
    getNextPageParam: (page: ConversationPage) => page.next ?? undefined,
    staleTime: SESSION_STALE_MS,
    queryFn: async ({ pageParam }): Promise<ConversationPage> => {
      const page = await readConversationPage(client, sessionId, pageParam, limit);
      onRead(page);
      return page;
    },
  });

/** One history window: the newest `limit` items before `cursor`, with their turns and requests. */
export const readConversationPage = async (
  client: TrpcClient,
  sessionId: string,
  cursor: string | null,
  limit: number = CONVERSATION_PAGE_ITEMS,
): Promise<ConversationPage> => {
  const window = { id: sessionId, cursor, limit };
  // Three reads, one request: the tRPC link batches calls made together.
  const [items, turns, requests] = await Promise.all([
    client.sessions.historyItems.query(window),
    client.sessions.historyTurns.query(window),
    client.sessions.historyRequests.query(window),
  ]);
  return {
    turns: turns.turns.map(turnView),
    items: items.items.map(itemView),
    requests: requests.requests.map(requestView),
    next: items.next,
    feed: items.feed,
  };
};

/** Every page held, as one conversation: the newest copy of anything two windows both hold. */
export const heldConversation = (
  pages: ReadonlyArray<ConversationPage>,
): ConversationView & { readonly feed: number } => {
  const turns = new Map<string, TurnView>();
  const items = new Map<string, AgentItemDto>();
  const requests = new Map<string, AgentRequestDto>();
  // Newest window first: the first copy seen is the newest.
  for (const page of pages) {
    for (const turn of page.turns) if (!turns.has(turn.id)) turns.set(turn.id, turn);
    for (const item of page.items) if (!items.has(item.id)) items.set(item.id, item);
    for (const request of page.requests)
      if (!requests.has(request.id)) requests.set(request.id, request);
  }
  return {
    turns: [...turns.values()].toSorted((a, b) => a.ordinal - b.ordinal),
    items: [...items.values()],
    requests: [...requests.values()],
    feed: pages[0]?.feed ?? 0,
  };
};

/** The conversation a session's cached pages hold; undefined before its first page is read. */
export const cachedConversation = (
  queryClient: QueryClient,
  trpc: TrpcProxy,
  sessionId: string,
): ConversationView | undefined => {
  const data = queryClient.getQueryData<InfiniteData<ConversationPage>>(
    conversationKey(trpc, sessionId),
  );
  return data === undefined ? undefined : heldConversation(data.pages);
};

/** Wire shapes, for the event stream's patches. */
export { itemView, requestView, turnView };
export type { WireItem, WireRequest, WireTurn };
