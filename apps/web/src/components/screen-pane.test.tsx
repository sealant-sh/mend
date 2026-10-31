// @vitest-environment jsdom
import { SessionProcessId, ViewerConnectionId } from "@mend/domain";
import { DisplayNumber } from "@mend/domain/workbench";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { serialize } from "superjson";
import { describe, expect, it, vi } from "vitest";

import type { LiveScreenDto } from "#/lib/api";
import { makeTrpcProxy, TRPCProvider, trpcClient } from "#/lib/trpc";

import {
  heldHere,
  ScreenPane,
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
  processId: SessionProcessId.make("screen-before-wake"),
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
      steer
      ownerName="Yiannis"
      held={false}
      pending={null}
      notice={null}
      onWake={() => undefined}
      onTake={() => undefined}
      onHandBack={() => undefined}
      onReconnect={() => undefined}
      viewer={<div data-testid="novnc" />}
      {...overrides}
    />,
  );

const reply = (value: unknown) =>
  new Response(JSON.stringify([{ result: { data: serialize(value) } }]), {
    headers: { "content-type": "application/json" },
  });
const settleWake = async () => {
  await act(() => vi.advanceTimersByTimeAsync(10));
};

const withWakePane = async (
  work: (pane: {
    readonly host: HTMLDivElement;
    readonly wakes: string[];
    readonly answer: () => void;
    readonly read: (next: LiveScreenDto) => Promise<void>;
    readonly settle: () => Promise<void>;
  }) => Promise<void>,
) => {
  vi.useFakeTimers();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const stopped = screen({ life: { _tag: "Ended", reason: "idle" } });
  let answer: () => void = () => {
    throw new Error(`Wake response for display ${stopped.display} is not ready`);
  };
  const response = new Promise<Response>((resolve) => {
    answer = () => resolve(reply(undefined));
  });
  const wakes: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const path = input.toString();
    if (path.includes("screens.wake")) {
      wakes.push(...(path.split("/").at(-1)?.split("?")[0]?.split(",") ?? []));
      return response;
    }
    if (path.includes("screens.read")) return reply(stopped);
    throw new Error(`Unexpected request: ${path}`);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const trpc = makeTrpcProxy(queryClient);
  const screenKey = trpc.screens.read.queryKey({ id: "session-wake" });
  function Probe() {
    const { data } = useQuery({
      ...trpc.screens.read.queryOptions({ id: "session-wake" }),
      initialData: stopped,
      staleTime: Infinity,
    });
    return data._tag === "Screen" ? (
      <ScreenPane
        sessionId="session-wake"
        screen={data}
        steer
        viewerId={OWNER}
        ownerName="Yiannis"
        nameOf={() => "Yiannis"}
      />
    ) : null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
            <Probe />
          </TRPCProvider>
        </QueryClientProvider>,
      );
    });
    await work({
      host,
      wakes,
      answer,
      read: async (next) => {
        await act(async () => queryClient.setQueryData(screenKey, next));
        await settleWake();
      },
      settle: settleWake,
    });
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
};

describe("ScreenPane wake", () => {
  it("keeps Starting after the POST resolves and a poll still reads Ended, until Live", () =>
    withWakePane(async ({ host, wakes, answer, read, settle }) => {
      const button = host.querySelector("button");
      if (button === null) throw new Error("Missing wake button");
      await act(async () => button.click());
      await settle();
      expect(wakes).toHaveLength(1);
      answer();
      await settle();
      expect(host.textContent).toContain("Starting…");
      expect(host.textContent).not.toContain("Wake the screen");
      expect(host.querySelector("button")).toBeNull();
      await read(screen());
      expect(host.textContent).not.toContain("Starting…");
      expect(host.textContent).toContain("Fullscreen");
      expect(wakes).toHaveLength(1);
    }));

  it("offers a retry when a new screen ends between polls, even with the old end reason", () =>
    withWakePane(async ({ host, answer, read, settle }) => {
      const button = host.querySelector("button");
      if (button === null) throw new Error("Missing wake button");
      await act(async () => button.click());
      await settle();
      answer();
      await settle();
      expect(host.textContent).toContain("Starting…");
      await read(
        screen({
          processId: SessionProcessId.make("screen-after-wake"),
          life: { _tag: "Ended", reason: "idle" },
        }),
      );
      expect(host.textContent).toContain("Wake the screen");
      expect(host.textContent).not.toContain("Starting…");
    }));

  it("sends one wake even when pressed twice before React commits the pending state", () =>
    withWakePane(async ({ host, wakes, answer, read, settle }) => {
      const button = host.querySelector("button");
      if (button === null) throw new Error("Missing wake button");
      await act(async () => {
        button.click();
        button.click();
      });
      await settle();
      expect(wakes).toHaveLength(1);
      answer();
      await settle();
      await read(
        screen({
          processId: SessionProcessId.make("screen-after-wake"),
          life: { _tag: "Starting" },
        }),
      );
      expect(host.textContent).toContain("Starting…");
      expect(host.querySelector("button")).toBeNull();
      expect(wakes).toHaveLength(1);
      await read(
        screen({
          processId: SessionProcessId.make("screen-after-wake"),
          life: { _tag: "Ended", reason: "process-exited" },
        }),
      );
      expect(host.textContent).toContain("Wake the screen");
      expect(host.textContent).not.toContain("Starting…");
    }));
});

describe("ScreenPaneView", () => {
  it("shows the live screen and its status line while the agent holds it", () => {
    const html = render();
    expect(html).toContain("Agent has input");
    expect(html).toContain('data-testid="novnc"');
    expect(html).toContain("Take over");
    expect(html).not.toContain("Hand back");
  });

  it("offers Take over only to the session's owner; everyone else reads who may", () => {
    const html = render({ owner: false });
    expect(html).not.toContain("Take over");
    expect(html).not.toContain("Hand back");
    expect(html).toContain("Only Yiannis controls this screen");
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
    expect(html).toContain("You have input");
  });

  it("offers Take over again once the owner's other tab took the input", () => {
    const elsewhere = heldBy(otherTab);
    const html = render({
      screen: elsewhere,
      statusLine: "screen · Yiannis has input",
      held: heldHere(elsewhere, watching),
    });
    expect(html).toContain("Take over");
    expect(html).toContain("Yiannis has input");
    expect(html).not.toContain("Hand back");
  });

  it("reads the status line when the input is paused, and lets the owner take over", () => {
    const paused = screen({ holder: { _tag: "Paused", reason: "disconnected" } });
    const owner = render({ screen: paused, statusLine: "screen · input paused · connection lost" });
    expect(owner).toContain("Paused · connection lost");
    expect(owner).toContain("Take over");
    expect(owner).not.toContain("Hand back");
    const watcher = render({
      screen: paused,
      owner: false,
      statusLine: "screen · input paused · connection lost",
    });
    expect(watcher).toContain("Paused · connection lost");
    expect(watcher).not.toContain("Take over");
  });

  it("says connecting until the server names the connection, and offers no Take over yet", () => {
    const html = render({ wire: { _tag: "Connecting" } });
    expect(html).toContain("Connecting");
    expect(html).toContain("border-[1.5px]");
    expect(html).not.toContain("Take over");
  });

  it("says why the connection closed and offers Reconnect", () => {
    const html = render({ wire: { _tag: "Closed", words: "the screen stopped" } });
    expect(html).toContain("Closed · the screen stopped");
    expect(html).toContain("Reconnect");
    expect(html).not.toContain("Take over");
  });

  it("opens no viewer on a screen that is starting, not started or ended", () => {
    const starting = render({
      screen: screen({ life: { _tag: "Starting" } }),
      statusLine: "screen · starting",
    });
    expect(starting).toContain("Starting…");
    expect(starting).not.toContain('data-testid="novnc"');
    const ended = render({
      screen: screen({ life: { _tag: "Ended", reason: "idle" } }),
      statusLine: "screen · ended after 15 min idle",
    });
    expect(ended).toContain("The screen is stopped.");
    expect(ended).not.toContain('data-testid="novnc"');
    expect(ended).not.toContain("Take over");
  });
  it.each([
    { owner: true, steer: true },
    { owner: false, steer: true },
    { owner: false, steer: false },
  ])("offers a wake only to a steerer: %j", ({ owner, steer }) => {
    const html = render({
      screen: screen({ life: { _tag: "Ended", reason: "idle" } }),
      statusLine: "screen · ended after 15 min idle",
      wire: { _tag: "Closed", words: "the screen stopped" },
      owner,
      steer,
    });
    expect(html).toContain("Stopped · idle");
    expect(html).toContain("border-[1.5px]");
    expect(html.includes("Wake the screen")).toBe(steer);
    if (!steer) expect(html).not.toContain("<button");
    expect(html).not.toContain("Reconnect");
    expect(html).not.toContain("Take over");
    expect(html).not.toContain("Only Yiannis controls this screen");
  });

  it("shows Starting without another action while waking, and keeps failures beside a retry", () => {
    const stopped = screen({ life: { _tag: "Ended", reason: "idle" } });
    const starting = render({ screen: stopped, pending: "wake" });
    expect(starting).toContain("Starting…");
    expect(starting).not.toContain("<button");
    expect(starting).not.toContain("Wake the screen");
    const failed = render({ screen: stopped, notice: "The screen did not start. Try again." });
    expect(failed).toContain("The screen did not start. Try again.");
    expect(failed).toContain("Wake the screen");
  });

  it("uses earned dot colors without the run record pulse", () => {
    expect(render()).toContain("bg-success-dot");
    expect(render()).not.toContain("animate-pulse");
    expect(render({ screen: heldBy(connection), held: true })).toContain("bg-[var(--sw-accent)]");
    expect(render({ wire: { _tag: "Closed", words: "lost" } })).toContain("bg-danger-dot");
  });

  it("keeps the sandbox note in a tooltip and notices in the header", () => {
    const html = render({
      screen: screen({ life: { _tag: "Live", degraded: null, browserSandboxOff: true } }),
      notice: "Someone else holds the input.",
    });
    expect(html).toContain('title="Browser sandbox off:');
    expect(html).toContain('role="status"');
    expect(html).not.toContain("border-b border-rule-faint");
  });

  it("requests fullscreen on the whole panel, including its controls", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <ScreenPaneView
          screen={screen()}
          statusLine="screen · agent has input"
          wire={watching}
          owner
          steer
          ownerName="Yiannis"
          held={false}
          pending={null}
          notice={null}
          onWake={() => undefined}
          onTake={() => undefined}
          onHandBack={() => undefined}
          onReconnect={() => undefined}
        />,
      ),
    );
    const panel = host.querySelector(".screen-panel");
    if (!(panel instanceof HTMLDivElement)) throw new Error("Missing screen panel");
    const requests: HTMLElement[] = [];
    const exits: string[] = [];
    const previousFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    const previousExit = document.exitFullscreen;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => panel });
    document.exitFullscreen = async () => {
      exits.push("exit");
    };
    panel.requestFullscreen = async () => {
      requests.push(panel);
    };
    const button = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Fullscreen",
    );
    if (button === undefined) throw new Error("Missing Fullscreen button");
    try {
      await act(async () => button.click());
      expect(requests).toEqual([panel]);
      expect(panel.textContent).toContain("Take over");
      const keys: string[] = [];
      const viewer = document.createElement("video");
      panel.append(viewer);
      viewer.addEventListener("keydown", (event) => keys.push(event.key));
      await act(async () => {
        viewer.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      expect(exits).toEqual(["exit"]);
      expect(keys).toEqual([]);
      panel.requestFullscreen = async () => {
        throw new Error("refused");
      };
      await act(async () => button.click());
      expect(host.textContent).toContain("Fullscreen did not open.");
    } finally {
      if (previousFullscreen === undefined) Reflect.deleteProperty(document, "fullscreenElement");
      else Object.defineProperty(document, "fullscreenElement", previousFullscreen);
      document.exitFullscreen = previousExit;
      await act(async () => root.unmount());
      host.remove();
    }
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
