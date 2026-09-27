// Don't buzz for what you're looking at. The server pushes every notice a
// person's settings let through; the phone decides, at the moment one
// arrives in the foreground, whether it is news: a push about the session
// whose screen is open (its conversation or its terminal) is already on
// screen, so it shows nothing and plays nothing. Anything else shows as it
// would from the lock screen.
//
// This lives on the phone, not the server, on purpose. Presence reported to
// the server goes stale the moment the app is killed, backgrounded or loses
// its network, and then either suppresses pushes nobody sees or needs a TTL
// that buzzes anyway. The foreground handler runs exactly when the push
// lands and reads the screen that is actually open; a backgrounded or locked
// phone never runs it, so the OS shows the push as sent.

/** What the foreground handler answers (expo-notifications' NotificationBehavior). */
export interface ForegroundPresentation {
  readonly shouldShowBanner: boolean;
  readonly shouldShowList: boolean;
  readonly shouldPlaySound: boolean;
  readonly shouldSetBadge: boolean;
}

const SILENT: ForegroundPresentation = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

const SHOWN: ForegroundPresentation = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

/** The session a push names in its data (session-notifier.ts sends `sessionId`). */
export const notifiedSessionId = (data: Record<string, unknown> | undefined): string | null => {
  const sessionId = data?.["sessionId"];
  return typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
};

/** A push about the session on screen is silent; any other shows and sounds. */
export const foregroundPresentation = (
  watchedSessionId: string | null,
  data: Record<string, unknown> | undefined,
): ForegroundPresentation => {
  const sessionId = notifiedSessionId(data);
  return sessionId !== null && sessionId === watchedSessionId ? SILENT : SHOWN;
};

// The session whose screen has focus. A screen claims it on focus and lets go
// on blur; a let-go only clears its own claim, so the next screen's focus
// (the terminal pushed over its session) is never undone by the previous
// screen's blur, whichever runs first.
let watched: { readonly sessionId: string } | null = null;

/** Claim `sessionId` as on screen; the answer lets go of this claim only. */
export const watchSession = (sessionId: string): (() => void) => {
  const claim = { sessionId };
  watched = claim;
  return () => {
    if (watched === claim) watched = null;
  };
};

/** The session on screen right now, or null. */
export const watchedSessionId = (): string | null => watched?.sessionId ?? null;
