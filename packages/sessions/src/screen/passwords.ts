import { randomBytes } from "node:crypto";

import type { SessionId } from "@mend/domain";
import { Redacted } from "effect";

/** The hand signs in with `full`; each watcher's relay with `viewOnly`, so Xvnc drops its input. */
export interface ScreenPasswords {
  readonly full: Redacted.Redacted<string>;
  readonly viewOnly: Redacted.Redacted<string>;
}

/** VncAuth reads eight characters: six random bytes in base64url are exactly that. */
const password = () => Redacted.make(randomBytes(6).toString("base64url"));

/**
 * A live screen's passwords, in the memory of the process that started it and nowhere else. Made
 * at each start; the start's script fetches them once, as the person the screen runs as.
 */
export const makeScreenPasswords = () => {
  const held = new Map<
    SessionId,
    { readonly passwords: ScreenPasswords; readonly runsAs: string | null; fetched: boolean }
  >();
  return {
    issue: (sessionId: SessionId, runsAs: string | null): ScreenPasswords => {
      const passwords = { full: password(), viewOnly: password() };
      held.set(sessionId, { passwords, runsAs, fetched: false });
      return passwords;
    },
    /** The script's fetch: `caller` is whom the channel's grant speaks for (null: root). */
    fetch: (sessionId: SessionId, caller: string | null): ScreenPasswords | null => {
      const entry = held.get(sessionId);
      if (entry === undefined || entry.fetched || entry.runsAs !== caller) return null;
      entry.fetched = true;
      return entry.passwords;
    },
    of: (sessionId: SessionId): ScreenPasswords | null => held.get(sessionId)?.passwords ?? null,
    forget: (sessionId: SessionId): void => void held.delete(sessionId),
  };
};

export type ScreenPasswordsHeld = ReturnType<typeof makeScreenPasswords>;
