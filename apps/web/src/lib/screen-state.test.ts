import { SessionProcessId, ViewerConnectionId } from "@mend/domain";
import { DisplayNumber } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import type { LiveScreenDto } from "./api.ts";
import {
  displayWords,
  heldHere,
  screenBar,
  screenControlNotice,
  screenDown,
  type ScreenWire,
} from "./screen-state.ts";

const OWNER = "u-owner";
const connection = ViewerConnectionId.make("vc_one");
const otherTab = ViewerConnectionId.make("vc_two");
const watching: ScreenWire = { _tag: "Watching", connection };

const screen = (overrides: Partial<LiveScreenDto> = {}): LiveScreenDto => ({
  _tag: "Screen",
  display: DisplayNumber.make(10),
  processId: SessionProcessId.make("screen-1"),
  width: 1280,
  height: 800,
  life: { _tag: "Live", degraded: null, browserSandboxOff: false },
  holder: { _tag: "Agent", awaiting: false },
  since: null,
  ownerUserId: OWNER,
  ...overrides,
});
const heldBy = (holder: ViewerConnectionId) =>
  screen({ holder: { _tag: "Person", userId: OWNER, connection: holder, taking: false } });

const bar = (
  overrides: Partial<Parameters<typeof screenBar>[0]> = {},
): ReturnType<typeof screenBar> =>
  screenBar({
    screen: screen(),
    wire: watching,
    sessionLive: true,
    waking: false,
    owner: true,
    agent: "Codex",
    nameOf: (userId) => (userId === OWNER ? "Ada Lovelace" : userId),
    ...overrides,
  });

describe("heldHere", () => {
  it("is true only while the server names this viewer's own connection as the holder", () => {
    expect(heldHere(heldBy(connection), watching)).toBe(true);
    // The same owner took over in another tab: the person holds it, this connection does not.
    expect(heldHere(heldBy(otherTab), watching)).toBe(false);
    expect(heldHere(screen(), watching)).toBe(false);
    expect(heldHere(heldBy(connection), { _tag: "Closed", words: "the screen stopped" })).toBe(
      false,
    );
  });
});

describe("screenControlNotice", () => {
  it("says nothing when the input moved, and why when it did not", () => {
    expect(
      screenControlNotice({ _tag: "Changed", holder: { _tag: "Agent", awaiting: true } }),
    ).toBe(null);
    expect(screenControlNotice({ _tag: "NoHand" })).toBe(
      "Mend has no input connection to this screen right now, so nothing was taken.",
    );
    expect(screenControlNotice({ _tag: "Refused", why: "owner-only" })).toBe(
      "Only the session's owner puts input on this screen.",
    );
  });
});

describe("screenDown", () => {
  it("reads a screen not started yet beside a running agent as starting", () => {
    expect(screenDown({ _tag: "NotStarted" }, true, false)).toEqual({ _tag: "Starting" });
    expect(screenDown({ _tag: "Starting" }, true, false)).toEqual({ _tag: "Starting" });
  });

  it("tells a screen that didn't start from one that stopped while the session runs", () => {
    expect(screenDown({ _tag: "Ended", reason: "start-failed" }, true, false)).toEqual({
      _tag: "Failed",
      started: false,
    });
    expect(screenDown({ _tag: "Ended", reason: "process-exited" }, true, false)).toEqual({
      _tag: "Failed",
      started: true,
    });
    expect(screenDown({ _tag: "Ended", reason: "process-exited" }, true, true)).toEqual({
      _tag: "Starting",
    });
  });

  it("says a stopped session's screen stopped with it, and a live one is up", () => {
    expect(screenDown({ _tag: "Ended", reason: "idle" }, false, false)).toEqual({
      _tag: "Stopped",
    });
    expect(screenDown(screen().life, true, false)).toBeNull();
  });
});

describe("the Screen view's bar", () => {
  it("names who has the input, and offers the owner Take over while they watch", () => {
    expect(bar()).toEqual({ title: "Codex has input", sub: "You're watching", control: "take" });
    expect(bar({ owner: false })).toEqual({
      title: "Codex has input",
      sub: "You're watching",
      control: null,
    });
  });

  it("offers Hand back while this viewer has the input, and Take over to the owner's other tab", () => {
    expect(bar({ screen: heldBy(connection) })).toEqual({
      title: "You have input",
      sub: "Codex waits until you hand back",
      control: "hand-back",
    });
    expect(bar({ screen: heldBy(otherTab) })).toEqual({
      title: "Ada Lovelace has input",
      sub: "You're watching",
      control: "take",
    });
  });

  it("says when the input is paused and why", () => {
    expect(bar({ screen: screen({ holder: { _tag: "Paused", reason: "lease-lapsed" } }) })).toEqual(
      {
        title: "Input paused",
        sub: "lease lapsed",
        control: "take",
      },
    );
  });

  it("offers nothing until the server names the connection, or once it closed", () => {
    expect(bar({ wire: { _tag: "Connecting" } })).toEqual({
      title: "Connecting…",
      sub: null,
      control: null,
    });
    expect(bar({ wire: { _tag: "Closed", words: "the connection closed" } }).title).toBe(
      "Not connected",
    );
  });

  it("says where a screen that isn't live stands", () => {
    expect(bar({ screen: screen({ life: { _tag: "Starting" } }) }).title).toBe(
      "Starting the screen…",
    );
    expect(bar({ screen: screen({ life: { _tag: "Ended", reason: "start-failed" } }) }).title).toBe(
      "Didn't start",
    );
    expect(
      bar({ screen: screen({ life: { _tag: "Ended", reason: "idle" } }), sessionLive: false })
        .title,
    ).toBe("Stopped with the session");
  });

  it("writes the display and its size", () => {
    expect(displayWords(screen())).toBe("Display :10 · 1280 × 800");
  });
});
