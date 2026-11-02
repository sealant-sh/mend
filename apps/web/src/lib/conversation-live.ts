import { type AgentItemDto, readAgentItemsAfter } from "@mend/agent-conversation";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type { WorkbenchEventDto } from "./api.ts";
import {
  CONVERSATION_PAGE_ITEMS,
  type ConversationPage,
  conversationQuery,
  itemView,
  requestView,
  turnView,
} from "./conversation.ts";
import type { trpcClient, TrpcProxy } from "./trpc.ts";

type Pages = InfiniteData<ConversationPage, string | null>;

/** What one event's reads found: items changed since the feed, and the newest window's turns and requests. */
export interface ConversationChanges {
  readonly items: ReadonlyArray<AgentItemDto>;
  readonly turns: ConversationPage["turns"];
  readonly requests: ConversationPage["requests"];
}

/** Put `value` in place of the one with its id in the page that holds it, or in `fallback`. */
const placeIn = <A extends { readonly id: string }>(
  pages: Array<Array<A>>,
  value: A,
  fallback: number | null,
) => {
  for (const held of pages) {
    const at = held.findIndex((each) => each.id === value.id);
    if (at >= 0) {
      held[at] = value;
      return;
    }
  }
  if (fallback !== null) pages[fallback]?.push(value);
};

/**
 * The held pages with one event's changes in them. A turn replaces its copy, or joins the newest
 * page; an item or request replaces its copy, or joins the page that holds its turn. Anything of a
 * turn no page holds yet is that turn's, read with it when the reader scrolls back to it.
 */
export const withChanges = (data: Pages, changes: ConversationChanges): Pages => {
  const turns = data.pages.map((page) => [...page.turns]);
  const items = data.pages.map((page) => [...page.items]);
  const requests = data.pages.map((page) => [...page.requests]);
  for (const turn of changes.turns) placeIn(turns, turn, 0);
  const pageOfTurn = new Map<string, number>();
  turns.forEach((held, index) => {
    for (const turn of held) if (!pageOfTurn.has(turn.id)) pageOfTurn.set(turn.id, index);
  });
  for (const item of changes.items) placeIn(items, item, pageOfTurn.get(item.turnId) ?? null);
  for (const request of changes.requests)
    placeIn(requests, request, pageOfTurn.get(request.turnId) ?? null);
  const feed = changes.items.reduce((latest, item) => Math.max(latest, item.seq), 0);
  return {
    ...data,
    pages: data.pages.map((page, index) => ({
      ...page,
      turns: turns[index] ?? page.turns,
      items: items[index] ?? page.items,
      requests: requests[index] ?? page.requests,
      feed: index === 0 ? Math.max(page.feed, feed) : page.feed,
    })),
  };
};

/**
 * Keep every held conversation current from the event stream, the ones on screen and the ones a
 * preload read alike: an event about a session reads what changed since its newest page's `feed`
 * (never the history again) and the newest window's turns and requests, and patches them into the
 * pages. Reads for one session never overlap: an event that lands during one asks for one more.
 */
export const makeConversationPatcher = (
  queryClient: QueryClient,
  trpc: TrpcProxy,
  client: typeof trpcClient,
) => {
  const reading = new Map<string, { again: boolean }>();

  const read = async (sessionId: string): Promise<void> => {
    const running = reading.get(sessionId);
    if (running !== undefined) {
      running.again = true;
      return;
    }
    const state = { again: false };
    reading.set(sessionId, state);
    const { queryKey } = conversationQuery(trpc, client, sessionId);
    try {
      do {
        state.again = false;
        const feed = queryClient.getQueryData<Pages>(queryKey)?.pages[0]?.feed;
        if (feed === undefined) return;
        const window = { id: sessionId, cursor: null, limit: CONVERSATION_PAGE_ITEMS };
        const changes = await Promise.all([
          readAgentItemsAfter(
            async (after, limit) =>
              (await client.sessions.items.query({ id: sessionId, after, limit })).map(itemView),
            feed,
          ),
          client.sessions.historyTurns.query(window),
          client.sessions.historyRequests.query(window),
        ]).then(
          ([items, turns, requests]): ConversationChanges => ({
            items,
            turns: turns.turns.map(turnView),
            requests: requests.requests.map(requestView),
          }),
          // A failed read leaves the pages as they were; the next event or reconnect reads again.
          () => null,
        );
        if (changes !== null)
          queryClient.setQueryData<Pages>(queryKey, (data) =>
            data === undefined ? data : withChanges(data, changes),
          );
      } while (state.again);
    } finally {
      reading.delete(sessionId);
    }
  };

  return {
    /** One event: the session it names, when its pages are held. */
    apply: (event: WorkbenchEventDto): void => {
      if (event.sessionId === undefined) return;
      if (event.type !== "agent-conversation" && event.type !== "session") return;
      const { queryKey } = conversationQuery(trpc, client, event.sessionId);
      if (queryClient.getQueryData(queryKey) === undefined) return;
      void read(event.sessionId);
    },
    /** After a reconnect, whose missed events nobody replays: every held conversation. */
    all: (): void => {
      for (const query of queryClient
        .getQueryCache()
        .findAll({ predicate: (each) => isConversationKey(each.queryKey) })) {
        const id = sessionOfKey(query.queryKey);
        if (id !== null) void read(id);
      }
    },
  };
};

const sessionOfKey = (queryKey: ReadonlyArray<unknown>): string | null => {
  const [, meta] = queryKey;
  if (typeof meta !== "object" || meta === null || !("input" in meta)) return null;
  const { input } = meta;
  return typeof input === "object" &&
    input !== null &&
    "id" in input &&
    typeof input.id === "string"
    ? input.id
    : null;
};

/** Whether a query is a conversation's pages, which the event stream patches instead of reading. */
export const isConversationKey = (queryKey: ReadonlyArray<unknown>): boolean => {
  const [path] = queryKey;
  return Array.isArray(path) && path[0] === "sessions" && path[1] === "historyItems";
};
