import { useSyncExternalStore } from "react";

/**
 * The first message of a session this tab started, held until the session's own conversation has
 * it. The composer makes the session and hands the message to its agent's launch, which the
 * server records only once the agent takes it; until then the session page shows it from here, so
 * the person sees what they asked while the workspace gets ready. It lives in this tab's memory
 * alone: a reload shows the session as the server records it.
 */
export interface OpeningMessage {
  readonly text: string;
  readonly sentAt: string;
}

const none: ReadonlyMap<string, OpeningMessage> = new Map();
let held = none;
const listeners = new Set<() => void>();

const changed = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Hold the message a new session was started with. */
export const holdOpeningMessage = (sessionId: string, text: string, sentAt: Date = new Date()) => {
  if (text.trim() === "") return;
  held = new Map([...held, [sessionId, { text, sentAt: sentAt.toISOString() }]]);
  changed();
};

/** The session's conversation has its first message now: stop holding it. */
export const releaseOpeningMessage = (sessionId: string) => {
  if (!held.has(sessionId)) return;
  held = new Map([...held].filter(([id]) => id !== sessionId));
  changed();
};

/** The message held for a session; null when this tab holds none (and on the server). */
export const useOpeningMessage = (sessionId: string): OpeningMessage | null =>
  useSyncExternalStore(
    subscribe,
    () => held.get(sessionId) ?? null,
    () => null,
  );
