import { describe, expect, it } from "vitest";

import {
  foregroundPresentation,
  notifiedSessionId,
  watchedSessionId,
  watchSession,
} from "./notification-presence";

describe("a push that lands while the app is open", () => {
  it("is silent for the session on screen, and shows for any other", () => {
    const onScreen = foregroundPresentation("session-1", { sessionId: "session-1" });
    expect(onScreen).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
    const elsewhere = foregroundPresentation("session-1", { sessionId: "session-2" });
    expect(elsewhere).toMatchObject({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
    });
    // On the list, in settings, anywhere that is not a session: it shows.
    expect(foregroundPresentation(null, { sessionId: "session-1" }).shouldShowBanner).toBe(true);
    // A push naming no session is never taken for the one on screen.
    expect(foregroundPresentation("session-1", undefined).shouldShowBanner).toBe(true);
    expect(foregroundPresentation("session-1", { sessionId: 42 }).shouldShowBanner).toBe(true);
  });

  it("reads the session a push names, and nothing else", () => {
    expect(notifiedSessionId({ sessionId: "session-1", projectId: "p" })).toBe("session-1");
    expect(notifiedSessionId({ sessionId: "" })).toBeNull();
    expect(notifiedSessionId({})).toBeNull();
  });
});

describe("the session on screen", () => {
  it("follows focus, and a blur never undoes the next screen's claim", () => {
    expect(watchedSessionId()).toBeNull();
    const leaveSession = watchSession("session-1");
    expect(watchedSessionId()).toBe("session-1");
    // The terminal for the same session is pushed on top: it focuses, then the session blurs.
    const leaveTerminal = watchSession("session-1");
    leaveSession();
    expect(watchedSessionId()).toBe("session-1");
    leaveTerminal();
    expect(watchedSessionId()).toBeNull();
    // Another session opened: its claim stands until its own blur.
    const leaveOther = watchSession("session-2");
    leaveTerminal();
    expect(watchedSessionId()).toBe("session-2");
    leaveOther();
    expect(watchedSessionId()).toBeNull();
  });
});
