import {
  type AgentConversation,
  type AgentItemDto,
  type AgentRequestDto,
  type AgentTurnDto,
  latestItemSeq,
  mergeAgentItems,
  readAgentItemsAfter,
} from "@mend/agent-conversation";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "../server/routers/index.ts";
import { SESSION_STALE_MS } from "./session-queries.ts";
import type { trpcClient } from "./trpc.ts";

type Outputs = inferRouterOutputs<AppRouter>;
type WireTurn = Outputs["sessions"]["turns"][number];
type WireItem = Outputs["sessions"]["items"][number];
type WireRequest = Outputs["sessions"]["requests"][number];

/** A turn as the conversation reads it: the shared shape plus when it started and ended. */
export interface TurnView extends AgentTurnDto {
  readonly sessionId: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
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

/** Where a session's conversation is cached (`conversationQuery`). */
export const conversationKey = (sessionId: string) => [
  ["sessions", "conversation"],
  { input: { id: sessionId }, type: "query" },
];

/**
 * A session's conversation in the query cache, under the `sessions` path so every event that
 * re-reads the session re-reads it too. Each read takes only the items that changed since the
 * highest `seq` already held (an item that grows takes a new one) and merges them in, so a long
 * conversation is read once and then by its updates.
 */
export const conversationQuery = (
  client: typeof trpcClient,
  queryClient: QueryClient,
  sessionId: string,
  /** Hears each read as it lands (the outbox drops what it now holds). */
  onRead: (conversation: ConversationView) => void = () => undefined,
) => {
  const queryKey = conversationKey(sessionId);
  return queryOptions({
    queryKey,
    staleTime: SESSION_STALE_MS,
    queryFn: async (): Promise<ConversationView> => {
      const previous = queryClient.getQueryData<ConversationView>(queryKey);
      const [turns, updates, requests] = await Promise.all([
        client.sessions.turns.query({ id: sessionId }),
        readAgentItemsAfter(
          async (after, limit) =>
            (await client.sessions.items.query({ id: sessionId, after, limit })).map(itemView),
          latestItemSeq(previous?.items ?? []),
        ),
        client.sessions.requests.query({ id: sessionId }),
      ]);
      const view: ConversationView = {
        turns: turns.map(turnView),
        items: mergeAgentItems(previous?.items ?? [], updates),
        requests: requests.map(requestView),
      };
      onRead(view);
      return view;
    },
  });
};
