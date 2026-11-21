import { TurnSelection } from "@mend/domain/workbench";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

import type { SessionMessageReceiptDto } from "./api.ts";
import { cachedConversation, type ConversationView } from "./conversation.ts";
import {
  draftKeys,
  dropAllDrafts,
  readDraft,
  subscribeDrafts,
  writeDraft,
  writeDrafts,
} from "./drafts.ts";
import { failureWords, refusalTagOf } from "./refusal.ts";
import { sendInTurn } from "./serial-writes.ts";
import { loginRefusalOf, type LoginRefusal } from "./shared-control.ts";
import { orLogin, useTRPC, useTRPCClient } from "./trpc.ts";
import { uuidV4 } from "./uuid.ts";

/**
 * Where a message the person sent stands, as their own tab knows it. Its words show as a bubble
 * the moment Send is pressed; the server's turn or steer replaces the bubble once it arrives with
 * the same key.
 *
 * A message sent while the session starts goes to Mend at once, like any other: Mend keeps it for
 * the agent's first process (SLNT-1237). Only words written on a start's page before Mend has
 * made the session wait here, for a moment, as `Sending` (`holdForStart`).
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
  /** The model, thinking, speed and permission picked for the turn it starts, when changed. */
  readonly selection?: TurnSelection;
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
  readonly selection?: TurnSelection;
}

export type SendMessage = (request: MessageRequest) => Promise<SessionMessageReceiptDto>;

export const UNCONFIRMED =
  "Mend didn't confirm this message arrived. Check the conversation before you send it again.";

const NOT_SENT = "Couldn't send. Your message is still here.";

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

const isSelection = Schema.is(TurnSelection);

const isMessage = (value: unknown): value is OutboxMessage =>
  isRecord(value) &&
  typeof value["clientMessageId"] === "string" &&
  typeof value["text"] === "string" &&
  typeof value["sentAt"] === "string" &&
  (value["resuming"] === undefined || typeof value["resuming"] === "boolean") &&
  (value["selection"] === undefined || isSelection(value["selection"])) &&
  isState(value["state"]);

let parsed: { readonly raw: string; readonly messages: ReadonlyArray<OutboxMessage> } = {
  raw: "",
  messages: [],
};

/**
 * A message an earlier version of this page kept in the tab while its session started (`Waiting`,
 * before SLNT-1237): nothing sent it, so it reads as unconfirmed, with Try again and Edit.
 */
const fromEarlier = (value: unknown): unknown =>
  isRecord(value) && isRecord(value["state"]) && value["state"]["_tag"] === "Waiting"
    ? { ...value, state: { _tag: "Unconfirmed" } }
    : value;

/** The stored outbox as read from its raw text; the same array while the text is the same. */
export const parseOutbox = (raw: string): ReadonlyArray<OutboxMessage> => {
  if (raw === parsed.raw) return parsed.messages;
  let messages: ReadonlyArray<OutboxMessage> = [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) messages = value.map(fromEarlier).filter(isMessage);
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

/**
 * At sign-out: every draft and every message on its way goes, so the next person in this tab
 * finds none of them.
 */
export const forgetMessages = () => {
  dropAllDrafts();
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
 * The turn a message became or went into, as the server's conversation holds it: the turn with
 * its key or the one Mend's answer named, or the turn its steer went into (or was queued as).
 * Null while the conversation does not hold it.
 */
export const turnOfMessage = (
  conversation: ConversationView,
  message: OutboxMessage,
): ConversationView["turns"][number] | null => {
  const key = message.clientMessageId;
  const named = message.state._tag === "Sent" ? message.state : null;
  const own = conversation.turns.find(
    (turn) => turn.clientMessageId === key || (named !== null && turn.id === named.turnId),
  );
  if (own !== undefined) return own;
  for (const turn of conversation.turns) {
    const steer = (turn.steers ?? []).find(
      (candidate) =>
        candidate.clientMessageId === key || (named !== null && candidate.id === named.steerId),
    );
    if (steer === undefined) continue;
    const queued = steer.delivery._tag === "Queued" ? steer.delivery.turnId : null;
    return conversation.turns.find((candidate) => candidate.id === queued) ?? turn;
  }
  return null;
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
        ...(message.selection === undefined ? {} : { selection: message.selection }),
      }),
    (receipt) => settle(stateAfterReceipt(receipt)),
  );
  const answered = async () => {
    let failure: unknown = null;
    try {
      await sent;
    } catch (cause) {
      failure = cause;
      const login = loginRefusalOf(cause);
      if (login === null) settle(stateAfterFailure(cause, message.clientMessageId));
      else holdForLogin(scope, message, login);
    }
    setInFlight(message.clientMessageId, false);
    courier.answered(failure);
  };
  return answered();
};

interface SendOptions {
  readonly now?: Date;
  readonly resuming?: boolean;
  readonly selection?: TurnSelection | undefined;
}

/**
 * Send new words under `clientMessageId`: their bubble shows at once, at the end. `resuming` says
 * the session is stopped now, so the bubble reads "resuming…" until Mend answers. `selection` goes
 * with the words when the person picked another model, thinking, speed or permission.
 */
export const sendMessage = (
  courier: Courier,
  scope: MessageScope,
  text: string,
  clientMessageId: string,
  { now = new Date(), resuming = false, selection }: SendOptions = {},
) =>
  deliver(courier, scope, {
    clientMessageId,
    text,
    sentAt: now.toISOString(),
    state: { _tag: "Sending" },
    ...(resuming ? { resuming } : {}),
    ...(selection === undefined ? {} : { selection }),
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
  return sendMessage(courier, scope, message.text, key, {
    now,
    resuming,
    selection: message.selection,
  });
};

/**
 * Words written on a start's page before Mend has made the session (`lib/pending-starts`): their
 * bubble shows at once, at the end, as on its way, and they go the moment the session exists
 * (`sendHeld`). This tab alone holds them for that moment; a reload then shows them unconfirmed.
 */
export const holdForStart = (
  scope: MessageScope,
  text: string,
  clientMessageId: string,
  { now = new Date(), selection }: Omit<SendOptions, "resuming"> = {},
) => {
  writeOutbox(scope, [
    ...readOutbox(scope),
    {
      clientMessageId,
      text,
      sentAt: now.toISOString(),
      state: { _tag: "Sending" },
      ...(selection === undefined ? {} : { selection }),
    },
  ]);
  setInFlight(clientMessageId, true);
};

/** Send messages held for a start, oldest first, each under its own key, one at a time. */
export const sendHeld = (
  courier: Courier,
  scope: MessageScope,
  messages: ReadonlyArray<OutboxMessage>,
) => Promise.all(messages.map((message) => deliver(courier, scope, message)));

/**
 * Move what one person wrote to a session that wasn't made yet (a start still on its way, under
 * the address it was opened at) onto the session Mend made: the outbox and the draft.
 */
export const moveMessages = (from: MessageScope, to: MessageScope) => {
  const messages = readOutbox(from);
  if (messages.length > 0) {
    writeOutbox(to, [...readOutbox(to), ...messages]);
    writeOutbox(from, []);
  }
  const before = draftItems(from);
  const after = draftItems(to);
  const words = readDraft(before.text);
  const there = readDraft(after.text);
  // Beside words already there, they join as part of a new message (as `editMessage` does).
  writeDrafts([
    ...(words === ""
      ? []
      : there.trim() === ""
        ? ([
            [after.text, words],
            [after.key, readDraft(before.key)],
          ] as const)
        : ([
            [after.text, `${there}\n\n${words}`],
            [after.key, ""],
          ] as const)),
    [before.text, ""],
    [before.key, ""],
  ]);
};

/**
 * Take back everything one person wrote to a session that won't be made (a refused start): the
 * messages in its outbox, then the words left in its composer, oldest first. Both are emptied.
 */
export const takeWritten = (scope: MessageScope): ReadonlyArray<string> => {
  const items = draftItems(scope);
  const written = [...readOutbox(scope).map((message) => message.text), readDraft(items.text)];
  writeOutbox(scope, []);
  writeDrafts([
    [items.text, ""],
    [items.key, ""],
  ]);
  return written.filter((words) => words.trim() !== "");
};

/** The composer's draft: its words and the key their next send carries (`lib/drafts`). */
export const draftItems = (scope: MessageScope) => ({
  text: `${scope.userId}.${scope.sessionId}.text`,
  key: `${scope.userId}.${scope.sessionId}.key`,
  /** A message refused for the sender's own login, kept until it works (`lib/shared-control`). */
  login: `${scope.userId}.${scope.sessionId}.login`,
});

/**
 * A message the server refused for the sender's own agent login (missing, expired or not picked;
 * Doop "Shared control · Ada's login expired"): it never reached the session, so its bubble goes
 * and its words go back into the box, under the key they were sent with, and the refusal is kept
 * beside them. The session's band says what to do; once the login works, the composer sends them.
 */
export const holdForLogin = (
  scope: MessageScope,
  message: OutboxMessage,
  login: LoginRefusal,
  now: number = Date.now(),
) => {
  const items = draftItems(scope);
  const words = readDraft(items.text);
  changeMessage(scope, message.clientMessageId, () => null);
  const entries: Array<readonly [string, string]> =
    words.trim() === ""
      ? [
          [items.text, message.text],
          [items.key, message.clientMessageId],
        ]
      : [
          [items.text, `${message.text}\n\n${words}`],
          [items.key, ""],
        ];
  writeDrafts([...entries, [items.login, JSON.stringify({ ...login, at: now })]]);
};

/** Forget the login a message was refused for: it was sent again, or the box was emptied. */
export const releaseLoginHold = (scope: MessageScope) => {
  const items = draftItems(scope);
  if (readDraft(items.login) !== "") writeDrafts([[items.login, ""]]);
};

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
/** The courier that sends one session's messages, and re-reads what each answer moved. */
export const makeCourier = (
  queryClient: QueryClient,
  client: ReturnType<typeof useTRPCClient>,
  trpc: ReturnType<typeof useTRPC>,
  sessionId: string,
): Courier => ({
  queryClient,
  send: (request) => orLogin(client.sessions.sendMessage.mutate(request)),
  conversation: () => cachedConversation(queryClient, trpc, sessionId),
  answered: (cause) => {
    if (refusalTagOf(cause) === "MessageAuthorChanged")
      void queryClient.invalidateQueries(trpc.organization.current.queryFilter());
    void queryClient.invalidateQueries(trpc.sessions.pathFilter());
  },
});

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
  const courier = makeCourier(queryClient, client, trpc, sessionId);
  return {
    scope,
    messages: scope === null ? [] : shownOutbox(readOutbox(scope)),
    inMemoryOnly: scope !== null && outboxInMemoryOnly(scope),
    announcement: scope === null ? null : announcementOf(scope),
    courier,
  };
};
