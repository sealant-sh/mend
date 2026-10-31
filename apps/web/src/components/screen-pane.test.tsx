import { ViewerConnectionId } from "@mend/domain";
import { DisplayNumber } from "@mend/domain/workbench";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LiveScreenDto } from "#/lib/api";

import {
  heldHere,
  ScreenPaneView,
  type ScreenPaneViewProps,
  screenControlNotice,
  type ScreenWire,
} from "./screen-pane.tsx";

const OWNER = "u-owner";
const connection = ViewerConnectionId.make("vc_one");
const otherTab = ViewerConnectionId.make("vc_two");
const watching: ScreenWire = { _tag: "Watching", connection };
const heldBy = (holder: ViewerConnectionId) =>
  screen({ holder: { _tag: "Person", userId: OWNER, connection: holder, taking: false } });

const screen = (overrides: Partial<LiveScreenDto> = {}): LiveScreenDto => ({
  _tag: "Screen",
  display: DisplayNumber.make(10),
  width: 1280,
  height: 800,
  life: { _tag: "Live", degraded: null, browserSandboxOff: false },
  holder: { _tag: "Agent", awaiting: false },
  since: null,
  ownerUserId: OWNER,
  ...overrides,
});

const render = (overrides: Partial<ScreenPaneViewProps> = {}) =>
  renderToStaticMarkup(
    <ScreenPaneView
      screen={screen()}
      statusLine="screen · agent has input"
      wire={watching}
      owner
      ownerName="Yiannis"
      held={false}
      pending={null}
      notice={null}
      onTake={() => undefined}
      onHandBack={() => undefined}
      onReconnect={() => undefined}
      viewer={<div data-testid="novnc" />}
      {...overrides}
    />,
  );

describe("ScreenPaneView", () => {
  it("shows the live screen and its status line while the agent holds it", () => {
    const html = render();
    expect(html).toContain("screen · agent has input");
    expect(html).toContain('data-testid="novnc"');
    expect(html).toContain("Take over");
    expect(html).not.toContain("Hand back");
  });

  it("offers Take over only to the session's owner; everyone else reads who may", () => {
    const html = render({ owner: false });
    expect(html).not.toContain("Take over");
    expect(html).not.toContain("Hand back");
    expect(html).toContain("Only Yiannis puts input on this screen.");
    expect(html).toContain('data-testid="novnc"');
  });

  it("offers Hand back, and no Take over, while this viewer holds the input", () => {
    const html = render({
      screen: heldBy(connection),
      statusLine: "screen · Yiannis has input",
      held: true,
    });
    expect(html).toContain("Hand back");
    expect(html).not.toContain("Take over");
    expect(html).toContain("Your keys and clicks reach the screen.");
  });

  it("offers Take over again once the owner's other tab took the input", () => {
    const elsewhere = heldBy(otherTab);
    const html = render({
      screen: elsewhere,
      statusLine: "screen · Yiannis has input",
      held: heldHere(elsewhere, watching),
    });
    expect(html).toContain("Take over");
    expect(html).not.toContain("Your keys and clicks reach the screen.");
  });

  it("reads the status line when the input is paused, and lets the owner take over or hand back", () => {
    const paused = screen({ holder: { _tag: "Paused", reason: "disconnected" } });
    const owner = render({ screen: paused, statusLine: "screen · input paused · connection lost" });
    expect(owner).toContain("screen · input paused · connection lost");
    expect(owner).toContain("Take over");
    expect(owner).toContain("Hand back");
    const watcher = render({
      screen: paused,
      owner: false,
      statusLine: "screen · input paused · connection lost",
    });
    expect(watcher).toContain("screen · input paused · connection lost");
    expect(watcher).not.toContain("Take over");
  });

  it("says connecting until the server names the connection, and offers no Take over yet", () => {
    const html = render({ wire: { _tag: "Connecting" } });
    expect(html).toContain("connecting…");
    expect(html).not.toContain("Take over");
  });

  it("says why the connection closed and offers Reconnect", () => {
    const html = render({ wire: { _tag: "Closed", words: "the screen stopped" } });
    expect(html).toContain("connection closed · the screen stopped");
    expect(html).toContain("Reconnect");
    expect(html).not.toContain("Take over");
  });

  it("opens no viewer on a screen that is starting, not started or ended", () => {
    const starting = render({
      screen: screen({ life: { _tag: "Starting" } }),
      statusLine: "screen · starting",
    });
    expect(starting).toContain("screen · starting");
    expect(starting).toContain("starting…");
    expect(starting).not.toContain('data-testid="novnc"');
    const ended = render({
      screen: screen({ life: { _tag: "Ended", reason: "idle" } }),
      statusLine: "screen · ended after 15 min idle",
    });
    expect(ended).toContain("The agent&#x27;s next screen look starts it.");
    expect(ended).not.toContain('data-testid="novnc"');
    expect(ended).not.toContain("Take over");
  });
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
