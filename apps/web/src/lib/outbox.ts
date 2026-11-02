import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import type { SessionMessageReceiptDto } from "./api.ts";
import { cachedConversation, type ConversationView } from "./conversation.ts";
import { draftKeys, readDraft, subscribeDrafts, writeDraft, writeDrafts } from "./drafts.ts";
import { failureWords, refusalTagOf } from "./refusal.ts";
import { sendInTurn } from "./serial-writes.ts";
import { orLogin, useTRPC, useTRPCClient } from "./trpc.ts";
import { uuidV4 } from "./uuid.ts";

/**
 * Where a message the person sent stands, as their own tab knows it. Its words show as a bubble
 * the moment Send is pressed; the server's turn or steer replaces the bubble once it arrives with
 * the same key.
 *
 * - `Sending`: on its way. Read back after a reload, when nothing in this tab still sends it, it
 *   is `Unconfirmed`.
 * - `Sent`: Mend answered that it took the words; the bubble waits for the turn or steer the
 *   answer names (`turnId` or `steerId`) to arrive.
 * - `Unconfirmed`: the answer was lost (a dropped connection, a 5xx, an edge's page). Retry sends
 *   it again under the same key, which the server replays rather than delivers twice.
 * - `NotSent`: Mend refused it, or recorded it and could not deliver it. `nextKey` is the key a
 *   retry carries: the same one when the server never recorded the words, null (a new one) when it
 *   did and the spent key would replay this answer.
 */
export type OutboxState =
  | { readonly _tag: "Sending" }
  | {
      readonly _tag: "Sent";
      readonly turnId: string | null;
      readonly steerId: string | null;
      readonly explanation: string;
    }
  | { readonly _tag: "Unconfirmed" }
  | { readonly _tag: "NotSent"; readonly words: string; readonly nextKey: string | null };

export interface OutboxMessage {
  readonly clientMessageId: string;
  readonly text: string;
  /** When Send was pressed, ISO. */
  readonly sentAt: string;
  readonly state: OutboxState;
  /** Sent while the session was stopped: Mend resumes it to take the words ("resuming…"). */
  readonly resuming?: boolean;
}

/** One person's messages to one session. */
export interface MessageScope {
  readonly userId: string;
  readonly sessionId: string;
}

/** What the composer sends: the web tier's `sessions.sendMessage` input. */
export interface MessageRequest {
  readonly id: string;
  readonly input: string;
  readonly clientMessageId: string;
  /** Always asked: a session that stopped comes back to take the words; a live one ignores it. */
  readonly resume: true;
  readonly expectedUserId: string;
}

export type SendMessage = (request: MessageRequest) => Promise<SessionMessageReceiptDto>;

export const UNCONFIRMED = "Message outcome not confirmed · check the session before sending again";

const NOT_SENT = "Not sent. Your message is still here; send it again.";

const ENDED: ReadonlySet<string> = new Set(["cancelled", "failed", "interrupted"]);

// ─── The store ──────────────────────────────────────────────────────────────

/**
 * The outbox lives in the draft store (`lib/drafts`), beside the composer's words: per account
 * and session in sessionStorage, so a message that did not arrive outlives a tab switch, an
 * unmount and a reload, and goes at sign-out with every draft. Never in the query cache, which
 * holds only what the server said.
 */
const outboxKey = (scope: MessageScope) => `${scope.userId}.${scope.sessionId}.outbox`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isState = (value: unknown): value is OutboxState => {
  if (!isRecord(value)) return false;
  switch (value["_tag"]) {
    case "Sending":
    case "Unconfirmed":
      return true;
    case "Sent":
      return (
        (typeof value["turnId"] === "string" || value["turnId"] === null) &&
        (typeof value["steerId"] === "string" || value["steerId"] === null) &&
        typeof value["explanation"] === "string"
      );
    case "NotSent":
      return (
        typeof value["words"] === "string" &&
        (typeof value["nextKey"] === "string" || value["nextKey"] === null)
      );
    default:
      return false;
  }
};

const isMessage = (value: unknown): value is OutboxMessage =>
  isRecord(value) &&
  typeof value["clientMessageId"] === "string" &&
  typeof value["text"] === "string" &&
  typeof value["sentAt"] === "string" &&
  (value["resuming"] === undefined || typeof value["resuming"] === "boolean") &&
  isState(value["state"]);

let parsed: { readonly raw: string; readonly messages: ReadonlyArray<OutboxMessage> } = {
  raw: "",
  messages: [],
};

/** The stored outbox as read from its raw text; the same array while the text is the same. */
export const parseOutbox = (raw: string): ReadonlyArray<OutboxMessage> => {
  if (raw === parsed.raw) return parsed.messages;
  let messages: ReadonlyArray<OutboxMessage> = [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) messages = value.filter(isMessage);
  } catch {
    // Not what this tab wrote: nothing to show.
  }
  parsed = { raw, messages };
  return messages;
};

/** The raw stored outbox of one scope, for `useSyncExternalStore` (`subscribeDrafts`). */
export const readOutboxText = (scope: MessageScope): string => readDraft(outboxKey(scope));

/**
 * Outboxes the browser would not store (a full sessionStorage quota, private browsing): kept in
 * this tab's memory instead, until a write to storage goes through again, so a message is never in
 * neither place. A reload loses them, which the composer says.
 */
const inMemory = new Map<string, ReadonlyArray<OutboxMessage>>();

const readStoredOutbox = (key: string): ReadonlyArray<OutboxMessage> =>
  inMemory.get(key) ?? parseOutbox(readDraft(key));

export const readOutbox = (scope: MessageScope): ReadonlyArray<OutboxMessage> =>
  readStoredOutbox(outboxKey(scope));

/** At sign-out, here or in another tab: what this tab held beside storage goes with the drafts. */
export const forgetTabOutboxes = () => {
  inMemory.clear();
  announced.clear();
  changed();
};

/** Whether this scope's outbox is in this tab's memory only, the browser having refused it. */
export const outboxInMemoryOnly = (scope: MessageScope): boolean => inMemory.has(outboxKey(scope));

const writeStoredOutbox = (key: string, messages: ReadonlyArray<OutboxMessage>) => {
  if (writeDraft(key, messages.length === 0 ? "" : JSON.stringify(messages))) inMemory.delete(key);
  else inMemory.set(key, messages);
  changed();
};

const writeOutbox = (scope: MessageScope, messages: ReadonlyArray<OutboxMessage>) =>
  writeStoredOutbox(outboxKey(scope), messages);

const changeMessage = (
  scope: MessageScope,
  clientMessageId: string,
  change: (message: OutboxMessage) => OutboxMessage | null,
) =>
  writeOutbox(
    scope,
    readOutbox(scope).flatMap((message) => {
      if (message.clientMessageId !== clientMessageId) return [message];
      const next = change(message);
      return next === null ? [] : [next];
    }),
  );

// Keys this tab is sending right now: a stored `Sending` outside it is a send a reload cut off.
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

/** Tell every reader that what this tab holds apart from storage changed. */
const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};

const setInFlight = (clientMessageId: string, sending: boolean) => {
  if (sending) inFlight.add(clientMessageId);
  else inFlight.delete(clientMessageId);
  changed();
};

/** Hear sends start and end here, memory-only outboxes change, and announcements. */
export const subscribeInFlight = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Changes whenever any of those does, for `useSyncExternalStore`. */
export const inFlightSnapshot = () => version;

/**
 * The newest outcome said aloud for each scope: every send's own, as it settles, whichever
 * message is newest, so an earlier refusal is heard while a later message is on its way. `id`
 * tells a repeat of the same words apart.
 */
const announced = new Map<
  string,
  { readonly id: number; readonly words: string; readonly urgent: boolean }
>();
let announcements = 0;

const announce = (scope: MessageScope, state: OutboxState) => {
  const said =
    state._tag === "Sent"
      ? { words: state.explanation, urgent: false }
      : state._tag === "NotSent"
        ? { words: state.words, urgent: true }
        : state._tag === "Unconfirmed"
          ? { words: UNCONFIRMED, urgent: true }
          : null;
  if (said === null) return;
  announcements += 1;
  announced.set(outboxKey(scope), { id: announcements, ...said });
  changed();
};

/** The newest outcome to say aloud for a scope, if any. */
export const announcementOf = (scope: MessageScope) => announced.get(outboxKey(scope)) ?? null;

/** The outbox as its bubbles show it: a `Sending` no send of this tab carries is `Unconfirmed`. */
export const shownOutbox = (messages: ReadonlyArray<OutboxMessage>): ReadonlyArray<OutboxMessage> =>
  messages.map((message) =>
    message.state._tag === "Sending" && !inFlight.has(message.clientMessageId)
      ? { ...message, state: { _tag: "Unconfirmed" } }
      : message,
  );

// ─── Arrival ────────────────────────────────────────────────────────────────

/**
 * Whether the server's conversation holds the turn or steer this message became: one carrying its
 * key, or the one Mend's answer named (for a server that does not return keys).
 */
export const arrivedIn = (conversation: ConversationView, message: OutboxMessage): boolean => {
  const key = message.clientMessageId;
  const named = message.state._tag === "Sent" ? message.state : null;
  return conversation.turns.some(
    (turn) =>
      turn.clientMessageId === key ||
      (named !== null && turn.id === named.turnId) ||
      (turn.steers ?? []).some(
        (steer) => steer.clientMessageId === key || (named !== null && steer.id === named.steerId),
      ),
  );
};

/**
 * The outbox without the messages that are now the conversation's own: arrived and not refused.
 * A refused message that arrived (recorded, never delivered) stays, so its Retry and Edit stay.
 * The newest stays too, its words dropped, as the receipt the composer's footer reads.
 */
const withoutArrived = (
  messages: ReadonlyArray<OutboxMessage>,
  conversation: ConversationView | undefined,
): ReadonlyArray<OutboxMessage> => {
  if (conversation === undefined) return messages;
  const last = messages.length - 1;
  return messages.flatMap((message, index) => {
    if (message.state._tag === "NotSent" || !arrivedIn(conversation, message)) return [message];
    return index === last ? [{ ...message, text: "" }] : [];
  });
};

/**
 * Drop what the conversation now holds from every outbox of the session in this tab, whoever's
 * it is: run on each read of the conversation, so confirmed messages leave storage as they
 * arrive, not only on that account's next send.
 */
export const pruneArrived = (sessionId: string, conversation: ConversationView) => {
  const suffix = `.${sessionId}.outbox`;
  const keys = new Set([
    ...draftKeys().filter((key) => key.endsWith(suffix)),
    ...[...inMemory.keys()].filter((key) => key.endsWith(suffix)),
  ]);
  for (const key of keys) {
    const held = readStoredOutbox(key);
    const kept = withoutArrived(held, conversation);
    const same =
      kept.length === held.length &&
      kept.every((message, index) => message.text === held[index]?.text);
    if (!same) writeStoredOutbox(key, kept);
  }
};

// ─── Sending ────────────────────────────────────────────────────────────────

/** A new message key, or null where this browser cannot make one. */
export const mintMessageKey = (): string | null => {
  try {
    return uuidV4();
  } catch {
    return null;
  }
};

/** Where a message stands after Mend's answer. */
export const stateAfterReceipt = (receipt: SessionMessageReceiptDto): OutboxState => {
  if (receipt._tag === "Turn")
    return receipt.turn.startedAt === null && ENDED.has(receipt.turn.status)
      ? { _tag: "NotSent", words: receipt.explanation, nextKey: null }
      : { _tag: "Sent", turnId: receipt.turn.id, steerId: null, explanation: receipt.explanation };
  return receipt.steer.delivery._tag === "NotSent"
    ? { _tag: "NotSent", words: receipt.explanation, nextKey: null }
    : {
        _tag: "Sent",
        turnId: null,
        steerId: receipt.steer.id,
        explanation: receipt.explanation,
      };
};

/** Where a message stands after its send failed: refused in words, or with no answer at all. */
export const stateAfterFailure = (cause: unknown, clientMessageId: string): OutboxState => {
  const tag = refusalTagOf(cause);
  if (tag === null) return { _tag: "Unconfirmed" };
  return {
    _tag: "NotSent",
    words: failureWords(cause, NOT_SENT),
    nextKey: tag === "MessageKeyConflict" ? null : clientMessageId,
  };
};

export interface Courier {
  readonly queryClient: QueryClient;
  readonly send: SendMessage;
  /** The session's conversation as the cache holds it now, to drop messages that arrived. */
  readonly conversation: () => ConversationView | undefined;
  /** Runs after every answer, received or refused: re-read what it moved. */
  readonly answered: (cause: unknown) => void;
}

/**
 * Lay a message into the outbox (a new one at the end, or a retry in its place) and send it. The
 * bubble shows before anything leaves. One person's messages to one session leave one at a time,
 * in the order sent, so the agent reads them in that order; each message's answer settles only
 * its own bubble.
 */
const deliver = (courier: Courier, scope: MessageScope, message: OutboxMessage) => {
  const sending: OutboxMessage = { ...message, state: { _tag: "Sending" } };
  const current = readOutbox(scope);
  writeOutbox(
    scope,
    withoutArrived(
      current.some((entry) => entry.clientMessageId === message.clientMessageId)
        ? current.map((entry) =>
            entry.clientMessageId === message.clientMessageId ? sending : entry,
          )
        : [...current, sending],
      courier.conversation(),
    ),
  );
  setInFlight(message.clientMessageId, true);
  const settle = (state: OutboxState) => {
    changeMessage(scope, message.clientMessageId, (entry) => ({ ...entry, state }));
    announce(scope, state);
  };
  const sent = sendInTurn(
    courier.queryClient,
    `message.${scope.userId}.${scope.sessionId}`,
    () =>
      courier.send({
        id: scope.sessionId,
        input: message.text,
        clientMessageId: message.clientMessageId,
        resume: true,
        expectedUserId: scope.userId,
      }),
    (receipt) => settle(stateAfterReceipt(receipt)),
  );
  const answered = async () => {
    let failure: unknown = null;
    try {
      await sent;
    } catch (cause) {
      failure = cause;
      settle(stateAfterFailure(cause, message.clientMessageId));
    }
    setInFlight(message.clientMessageId, false);
    courier.answered(failure);
  };
  return answered();
};

/**
 * Send new words under `clientMessageId`: their bubble shows at once, at the end. `resuming` says
 * the session is stopped now, so the bubble reads "resuming…" until Mend answers.
 */
export const sendMessage = (
  courier: Courier,
  scope: MessageScope,
  text: string,
  clientMessageId: string,
  { now = new Date(), resuming = false }: { readonly now?: Date; readonly resuming?: boolean } = {},
) =>
  deliver(courier, scope, {
    clientMessageId,
    text,
    sentAt: now.toISOString(),
    state: { _tag: "Sending" },
    ...(resuming ? { resuming } : {}),
  });

/**
 * Send a message that did not arrive again. An unconfirmed one goes under its own key, so the
 * server replays it if it had arrived after all; a refused one under the key its refusal left.
 * A new key makes it a new message, at the end.
 */
export const retryMessage = (
  courier: Courier,
  scope: MessageScope,
  message: OutboxMessage,
  { now = new Date(), resuming = false }: { readonly now?: Date; readonly resuming?: boolean } = {},
) => {
  const key =
    message.state._tag === "NotSent"
      ? (message.state.nextKey ?? mintMessageKey())
      : message.clientMessageId;
  if (key === null) return Promise.resolve();
  if (key === message.clientMessageId) return deliver(courier, scope, { ...message, resuming });
  changeMessage(scope, message.clientMessageId, () => null);
  return sendMessage(courier, scope, message.text, key, { now, resuming });
};

/** The composer's draft: its words and the key their next send carries (`lib/drafts`). */
export const draftItems = (scope: MessageScope) => ({
  text: `${scope.userId}.${scope.sessionId}.text`,
  key: `${scope.userId}.${scope.sessionId}.key`,
});

/**
 * Take a message that did not arrive back into the composer to change it; its bubble goes. Into
 * an empty composer it goes with the key a retry would carry, so sending it unchanged is still the
 * same message to the server; beside words already there it goes as part of a new message.
 */
export const editMessage = (scope: MessageScope, message: OutboxMessage) => {
  const items = draftItems(scope);
  const words = readDraft(items.text);
  const key = message.state._tag === "NotSent" ? message.state.nextKey : message.clientMessageId;
  changeMessage(scope, message.clientMessageId, () => null);
  writeDrafts(
    words.trim() === ""
      ? [
          [items.text, message.text],
          [items.key, key ?? ""],
        ]
      : [
          [items.text, `${message.text}\n\n${words}`],
          [items.key, ""],
        ],
  );
};

// ─── React ──────────────────────────────────────────────────────────────────

/**
 * The account a draft and an outbox are kept under: the answer to who is signed in, only while it
 * is not being read again and did not fail. Read from the query cache as it changes, not from the
 * rendered query, which hears of a re-read started on focus only a task later.
 */
export const useMessageOwner = (): string | null => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const identityKey = trpc.organization.current.queryKey();
  return useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () => {
      const state = queryClient.getQueryState(identityKey);
      return state?.status === "success" && state.fetchStatus === "idle"
        ? (state.data?.userId ?? null)
        : null;
    },
    () => null,
  );
};

/**
 * The signed-in person's outbox for one session, as its bubbles show it, and the courier that
 * sends from it. Empty until who is signed in is known.
 */
export const useOutbox = (sessionId: string) => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const userId = useMessageOwner();
  // Renders again whenever the stored outbox, or what this tab holds beside it, changes.
  useSyncExternalStore(
    subscribeDrafts,
    () => (userId === null ? "" : readOutboxText({ userId, sessionId })),
    () => "",
  );
  useSyncExternalStore(subscribeInFlight, inFlightSnapshot, inFlightSnapshot);
  const scope = userId === null ? null : { userId, sessionId };
  const courier: Courier = {
    queryClient,
    send: (request) => orLogin(client.sessions.sendMessage.mutate(request)),
    conversation: () => cachedConversation(queryClient, trpc, sessionId),
    answered: (cause) => {
      if (refusalTagOf(cause) === "MessageAuthorChanged")
        void queryClient.invalidateQueries(trpc.organization.current.queryFilter());
      void queryClient.invalidateQueries(trpc.sessions.pathFilter());
    },
  };
  return {
    scope,
    messages: scope === null ? [] : shownOutbox(readOutbox(scope)),
    inMemoryOnly: scope !== null && outboxInMemoryOnly(scope),
    announcement: scope === null ? null : announcementOf(scope),
    courier,
  };
};
