import {
  latestItemSeq,
  mergeAgentItems,
  readAgentItemsAfter,
  type AgentConversation,
  type AgentConversationEntry,
  type AgentRequestResponse,
} from "@mend/agent-conversation";
import { queryOptions, useMutation } from "@tanstack/react-query";

import {
  interruptAgentTurn,
  listAgentItems,
  listAgentRequests,
  listAgentTurns,
  respondAgentRequest,
  sessionControlEvents,
  submitAgentTurn,
  type AgentItemDto,
  type AgentLaunchModeDto,
  type AgentRequestDto,
  type AgentTurnDto,
  type SessionControlEventDto,
} from "#/lib/api";
import { queryClient } from "#/lib/queries";

/**
 * A protocol-mode session as the desktop reads it: the durable turns, the items the agent said
 * or did, and what it asked a person (`@mend/agent-conversation` orders them; the phone reads
 * the same feed). The workbench stream's `agent-conversation` pointer invalidates the query; a
 * slow poll covers a stream that dropped while the agent works.
 */

export type ConversationDto = AgentConversation<AgentTurnDto, AgentItemDto, AgentRequestDto>;
export type ConversationEntry = AgentConversationEntry<AgentTurnDto, AgentItemDto, AgentRequestDto>;

/** Harnesses Mend runs in protocol mode (`composeProtocolArgv`): a conversation, not a PTY. */
export const CONVERSATION_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex"]);

/** How often a live conversation re-reads without a pointer from the stream. */
const LIVE_POLL_MS = 4_000;

const conversationKey = (sessionId: string) => ["session", sessionId, "conversation"] as const;

/**
 * Read the conversation on from what is held: turns and requests whole (they are few), items
 * from the cursor on, merged by id so a growing item is replaced, never duplicated.
 */
export const readConversation = async (
  sessionId: string,
  previous: ConversationDto | undefined,
): Promise<ConversationDto> => {
  const held = previous?.items ?? [];
  const [turns, updates, requests] = await Promise.all([
    listAgentTurns(sessionId),
    readAgentItemsAfter(
      (after, limit) => listAgentItems(sessionId, after, limit),
      latestItemSeq(held),
    ),
    listAgentRequests(sessionId),
  ]);
  return { turns, items: mergeAgentItems(held, updates), requests };
};

export const conversationQuery = (sessionId: string, live: boolean) =>
  queryOptions({
    queryKey: conversationKey(sessionId),
    queryFn: () =>
      readConversation(sessionId, queryClient.getQueryData(conversationKey(sessionId))),
    refetchInterval: live ? LIVE_POLL_MS : false,
  });

/** Under the conversation's key, so the same pointer re-reads who interrupted. */
export const controlEventsQuery = (sessionId: string) =>
  queryOptions({
    queryKey: [...conversationKey(sessionId), "control-events"] as const,
    queryFn: () => sessionControlEvents(sessionId),
  });

/** Who interrupted each turn, by turn id, as the control record says. */
export const interruptersByTurn = (
  events: ReadonlyArray<SessionControlEventDto>,
): ReadonlyMap<string, string> => {
  const byTurn = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "interrupt" && event.refId !== null)
      byTurn.set(event.refId, event.actorUserId);
  }
  return byTurn;
};

/**
 * Who sent a turn, when that is worth saying: only when someone other than the viewer did, as
 * happens while control is shared. A null author is Mend itself (a Review follow-up).
 */
export const turnAuthorLine = (
  author: string | null,
  viewerId: string | null,
  names: ReadonlyMap<string, string>,
): string | null => {
  if (author === null) return "sent by Mend";
  if (viewerId === null || author === viewerId) return null;
  return `sent by ${names.get(author) ?? "a member"}`;
};

/** A turn's ending in words, when it ended any way but completed. */
export const turnEndWord = (
  turn: AgentTurnDto,
  interrupter: string | null,
  viewerId: string | null,
  names: ReadonlyMap<string, string>,
): string | null => {
  switch (turn.status) {
    case "interrupted": {
      if (interrupter === null) return "interrupted · observed";
      const who = interrupter === viewerId ? "you" : (names.get(interrupter) ?? "a member");
      return `interrupted by ${who} · observed`;
    }
    case "failed":
      return "failed · observed";
    case "cancelled":
      return "cancelled · observed";
    case "queued":
      return "queued";
    default:
      return null;
  }
};

const invalidateSession = (sessionId: string) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: conversationKey(sessionId) }),
    queryClient.invalidateQueries({ queryKey: ["session", sessionId], exact: true }),
  ]);

/** Send, answer and interrupt — each re-reads the conversation when it settles. */
export const useConversationActions = (sessionId: string) => {
  const submit = useMutation({
    mutationFn: (input: string) => submitAgentTurn(sessionId, input),
    onSettled: () => invalidateSession(sessionId),
  });
  const respond = useMutation({
    mutationFn: (input: { readonly requestId: string; readonly response: AgentRequestResponse }) =>
      respondAgentRequest(input.requestId, input.response),
    onSettled: () => invalidateSession(sessionId),
  });
  const interrupt = useMutation({
    mutationFn: (turnId: string) => interruptAgentTurn(turnId),
    onSettled: () => invalidateSession(sessionId),
  });
  return { submit, respond, interrupt };
};

/** Sessions with a pointer read in flight, and whether another pointer arrived meanwhile. */
const refreshing = new Map<string, boolean>();

/**
 * Re-read a session's conversation and detail for the stream's `agent-conversation` pointer.
 * Pointers arrive per streamed delta, faster than a read completes, and a plain invalidation
 * cancels the read in flight: the view would not move until the agent paused. So a read in
 * flight is left to finish, and the pointers that land meanwhile coalesce into one read after it.
 */
export const refreshConversation = (sessionId: string): void => {
  if (refreshing.has(sessionId)) {
    refreshing.set(sessionId, true);
    return;
  }
  refreshing.set(sessionId, false);
  void Promise.all([
    queryClient.invalidateQueries({ queryKey: conversationKey(sessionId) }),
    queryClient.invalidateQueries({ queryKey: ["session", sessionId], exact: true }),
  ]).finally(() => {
    const again = refreshing.get(sessionId) === true;
    refreshing.delete(sessionId);
    if (again) refreshConversation(sessionId);
  });
};

// ─── launch intent ──────────────────────────────────────────────────────────

const launchModes = new Map<string, AgentLaunchModeDto>();

/**
 * What the launcher asked for, until the agent's own row says: a protocol launch has no process
 * row while its workspace provisions, and its pane should open as the conversation it will be.
 */
export const rememberLaunchMode = (sessionId: string, mode: AgentLaunchModeDto): void => {
  launchModes.set(sessionId, mode);
};

export const launchModeOf = (sessionId: string): AgentLaunchModeDto | null =>
  launchModes.get(sessionId) ?? null;
