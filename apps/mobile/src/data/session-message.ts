/**
 * The message a person is writing in a live conversation, and what Mend said about the last send
 * (`POST /sessions/:id/messages`). Send goes into their own running turn or starts their next one,
 * as their "Send steers the running turn" setting says; the server decides and answers with a
 * sentence (`explanation`), shown as it is.
 *
 * A draft carries the key its send goes under (`clientMessageId`). The key is made at the first
 * send and kept, through edits, until Mend answers with a receipt, so sending again after a lost
 * answer is the same message to the server, never a second one. Changed words under a used key
 * are refused with `MessageKeyConflict`, never delivered: an earlier attempt under the key was
 * recorded, and the key stays until the person changes the words again.
 *
 * Drafts live in this module, not in the composer, so they outlive it when it unmounts (the agent
 * stopped, control was taken back), and on the device, so they outlive the app. They belong to the
 * pairing they were written under (`settleDraftScope`): another pairing never reads them, and the
 * phone forgets them when it pairs again or unpairs. What the last send came to lives in memory
 * only: a send in flight when the app was killed has no answer to show.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

import type { LocalImage } from "@/data/conversation-rows";
import type { PairingKey } from "@/data/pairing-key";

export interface MessageDraft {
  readonly text: string;
  /** The images stored beside the session that this message carries. */
  readonly images: ReadonlyArray<LocalImage>;
  readonly clientMessageId: string | null;
}

export type MessageOutcome =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Sending" }
  | { readonly _tag: "Answered"; readonly explanation: string }
  | { readonly _tag: "Refused"; readonly words: string }
  /** The key went with other words: the server's `words`, and an earlier attempt was recorded. */
  | { readonly _tag: "KeyUsed"; readonly words: string }
  | { readonly _tag: "Unconfirmed" };

/** A receipt, as far as the draft cares. */
export type MessageReceipt =
  | {
      readonly _tag: "Turn";
      readonly explanation: string;
      readonly status: string;
      readonly startedAt: string | null;
    }
  | { readonly _tag: "Steer"; readonly explanation: string; readonly delivery: string };

/** What the phone posts. Never `queue`: Send follows the person's own setting. */
export interface SendMessageBody {
  readonly input: string;
  readonly clientMessageId: string;
}

export const EMPTY_DRAFT: MessageDraft = { text: "", images: [], clientMessageId: null };

export const UNCONFIRMED = "Message outcome not confirmed · check the session before sending again";
export const NOT_LOADED = "your saved message could not be loaded yet · trying again";
export const KEY_USED =
  "an earlier attempt of this message was recorded · change the words to send them as a new message";

const ENDED_BEFORE_START: ReadonlySet<string> = new Set(["cancelled", "failed", "interrupted"]);

/**
 * What stays after a receipt. Words Mend recorded and never delivered (the server's `not sent ·
 * …`) stay under a new key, since the spent one would replay this receipt. Words whose delivery is
 * not confirmed stay under their key, so sending them again replays the receipt.
 */
export const draftAfter = (receipt: MessageReceipt, attempt: MessageDraft): MessageDraft => {
  const unsent = { ...attempt, clientMessageId: null };
  if (receipt._tag === "Turn") {
    return receipt.startedAt === null && ENDED_BEFORE_START.has(receipt.status)
      ? unsent
      : EMPTY_DRAFT;
  }
  switch (receipt.delivery) {
    case "Accepted":
    case "Queued":
      return EMPTY_DRAFT;
    case "NotSent":
      return unsent;
    default:
      return attempt;
  }
};

// ─── the store ──────────────────────────────────────────────────────────────

export interface SessionMessage {
  readonly draft: MessageDraft;
  readonly outcome: MessageOutcome;
}

const IDLE: SessionMessage = { draft: EMPTY_DRAFT, outcome: { _tag: "Idle" } };
/** One stored item per pairing and session, so writing one draft never touches another. */
const STORAGE_PREFIX = "mend-message-draft:";

/** By `<pairing>:<session>`. */
const messages = new Map<string, SessionMessage>();
const listeners = new Set<() => void>();
/** The pairing drafts belong to now: null when unpaired, undefined until the pairing is read. */
let scope: PairingKey | null | undefined;
/** Nothing is shown or written for a scope until its stored drafts have been read. */
let stored: "Unread" | "Unreadable" | "Read" = "Unread";
let failedReads = 0;
let reading: Promise<void> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

const entryKey = (pairing: PairingKey, sessionId: string): string => `${pairing}:${sessionId}`;
const belongs = (key: string): boolean => typeof scope === "string" && key.startsWith(`${scope}:`);
const forgetOtherPairings = () => {
  for (const key of messages.keys()) if (!belongs(key)) messages.delete(key);
};
let writing: Promise<unknown> = Promise.resolve();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const storedImage = (value: unknown): LocalImage | null =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.path === "string" &&
  typeof value.uri === "string"
    ? { name: value.name, path: value.path, uri: value.uri }
    : null;

const storedDraft = (value: unknown): MessageDraft | null => {
  if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.images)) {
    return null;
  }
  const key = value.clientMessageId;
  if (key !== null && typeof key !== "string") return null;
  const images = value.images.map(storedImage);
  return images.every((image) => image !== null)
    ? { text: value.text, images: images.filter((image) => image !== null), clientMessageId: key }
    : null;
};

const isEmpty = (draft: MessageDraft): boolean =>
  draft.text === "" && draft.images.length === 0 && draft.clientMessageId === null;

/** Storage steps run one after another, so a later draft is never overwritten by an earlier one. */
const inTurn = (step: () => Promise<void>): Promise<boolean> => {
  const done = writing.then(step).then(
    () => true,
    () => false,
  );
  writing = done;
  return done;
};

const notify = () => {
  for (const listener of listeners) listener();
};

const parsedOrNull = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readStored = async () => {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(STORAGE_PREFIX));
    for (const [key, raw] of Object.entries(await AsyncStorage.getMany(keys))) {
      const draft = storedDraft(parsedOrNull(raw));
      if (draft !== null) {
        messages.set(key.slice(STORAGE_PREFIX.length), { draft, outcome: { _tag: "Idle" } });
      }
    }
    stored = "Read";
    if (scope !== undefined) forgetOtherPairings();
  } catch {
    stored = "Unreadable";
    failedReads += 1;
    retryWhileWatched();
  }
  notify();
};

const readNow = (): Promise<void> => {
  if (stored === "Read") return Promise.resolve();
  reading ??= readStored().finally(() => {
    reading = null;
  });
  return reading;
};

// Only while a composer is open, so the web build's static render in Node, which has no storage,
// is not kept alive by retries.
const retryWhileWatched = () => {
  if (stored !== "Unreadable" || listeners.size === 0 || retry !== null) return;
  retry = setTimeout(
    () => {
      retry = null;
      void readNow();
    },
    Math.min(1_000 * 2 ** (failedReads - 1), 30_000),
  );
};

void readNow();
AppState.addEventListener("change", (state) => {
  if (state === "active" && stored === "Unreadable") void readNow();
});

/**
 * The pairing drafts belong to from now on (null: none). Every other pairing's drafts are
 * forgotten, on the device as well, and a send still answering for one of them changes nothing.
 */
export const settleDraftScope = async (pairing: PairingKey | null): Promise<void> => {
  scope = pairing;
  forgetOtherPairings();
  notify();
  await inTurn(async () => {
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.removeMany(
      keys.filter(
        (key) => key.startsWith(STORAGE_PREFIX) && !belongs(key.slice(STORAGE_PREFIX.length)),
      ),
    );
  });
};

/**
 * Null until the stored drafts are read (nothing may be written over them before that), and for a
 * pairing that is not the phone's now.
 */
export const sessionMessage = (pairing: PairingKey, sessionId: string): SessionMessage | null =>
  stored === "Read" && pairing === scope
    ? (messages.get(entryKey(pairing, sessionId)) ?? IDLE)
    : null;

/**
 * Changes the session's message and stores its draft. Resolves true once the draft is stored, and
 * false when it is not: `sessionMessage` is null (nothing changes), or the write failed.
 */
export const setSessionMessage = (
  pairing: PairingKey,
  sessionId: string,
  next: { readonly draft?: MessageDraft; readonly outcome?: MessageOutcome },
): Promise<boolean> => {
  const current = sessionMessage(pairing, sessionId);
  if (current === null) return Promise.resolve(false);
  const entry = entryKey(pairing, sessionId);
  const draft = next.draft ?? current.draft;
  messages.set(entry, { draft, outcome: next.outcome ?? current.outcome });
  notify();
  if (draft === current.draft) return Promise.resolve(true);
  const key = STORAGE_PREFIX + entry;
  return inTurn(() =>
    isEmpty(draft)
      ? AsyncStorage.removeItem(key)
      : AsyncStorage.setItem(key, JSON.stringify(draft)),
  );
};

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  retryWhileWatched();
  return () => listeners.delete(onChange);
};

export const useSessionMessageState = (
  pairing: PairingKey,
  sessionId: string,
): SessionMessage | null =>
  useSyncExternalStore(
    subscribe,
    () => sessionMessage(pairing, sessionId),
    () => null,
  );

/** True while the stored drafts could not be read: the composer stays read-only meanwhile. */
export const useDraftsUnreadable = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => stored === "Unreadable",
    () => false,
  );
