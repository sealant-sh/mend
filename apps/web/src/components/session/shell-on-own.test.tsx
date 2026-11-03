// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useShellOnOwn, wantsShellOnOwn } from "./shell-on-own.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const OWNER_LIVE = {
  shown: true,
  terminalInput: true,
  agentLive: true,
  conversationLive: true,
  shells: 0,
} as const;

describe("whether the Terminal tab opens a shell by itself", () => {
  it("opens one for the person who types there, on a live conversation with no shell", () => {
    expect(wantsShellOnOwn(OWNER_LIVE)).toBe(true);
  });

  it("opens none for a reader, a stopped session, a terminal session, or one with a shell", () => {
    expect(wantsShellOnOwn({ ...OWNER_LIVE, terminalInput: false })).toBe(false);
    expect(wantsShellOnOwn({ ...OWNER_LIVE, agentLive: false, conversationLive: false })).toBe(
      false,
    );
    expect(wantsShellOnOwn({ ...OWNER_LIVE, conversationLive: false })).toBe(false);
    expect(wantsShellOnOwn({ ...OWNER_LIVE, shells: 1 })).toBe(false);
  });

  it("waits for the workspace's processes and for the tab to show", () => {
    expect(wantsShellOnOwn({ ...OWNER_LIVE, shells: null })).toBe(false);
    expect(wantsShellOnOwn({ ...OWNER_LIVE, shown: false })).toBe(false);
  });
});

let root: Root | null = null;
afterEach(() => act(() => root?.unmount()));

function Tab(props: {
  readonly sessionId: string;
  readonly wanted: boolean;
  readonly openShell: (input: { readonly id: string }) => void;
}) {
  useShellOnOwn(props.sessionId, props.wanted, props.openShell);
  return null;
}

const show = (sessionId: string, wanted: boolean, openShell: () => void) =>
  act(() =>
    root?.render(
      <StrictMode>
        <Tab sessionId={sessionId} wanted={wanted} openShell={openShell} />
      </StrictMode>,
    ),
  );

describe("the shell the Terminal tab opens by itself", () => {
  it("is opened once, under React's doubled effects, a second visit and a closed shell", () => {
    const openShell = vi.fn();
    root = createRoot(document.createElement("div"));
    show("sess-once", false, openShell);
    expect(openShell).not.toHaveBeenCalled();

    show("sess-once", true, openShell);
    expect(openShell).toHaveBeenCalledTimes(1);
    expect(openShell).toHaveBeenCalledWith({ id: "sess-once" });

    // The person closes it, then comes back to the tab (a new mount of the tab).
    show("sess-once", false, openShell);
    act(() => root?.unmount());
    root = createRoot(document.createElement("div"));
    show("sess-once", true, openShell);
    expect(openShell).toHaveBeenCalledTimes(1);
  });

  it("is opened once for each session", () => {
    const openShell = vi.fn();
    root = createRoot(document.createElement("div"));
    show("sess-a", true, openShell);
    show("sess-b", true, openShell);
    expect(openShell.mock.calls).toEqual([[{ id: "sess-a" }], [{ id: "sess-b" }]]);
  });
});
