// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useShellOnOwn, wantsShellOnOwn } from "./shell-on-own.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const OWNER_RUNNING = { opensOn: "sess", workspaceRuns: true, liveTerminals: 0 } as const;

describe("whether the Terminal view opens a shell by itself", () => {
  it("opens one for the person who can, in a running workspace with no terminal", () => {
    expect(wantsShellOnOwn(OWNER_RUNNING)).toBe(true);
  });

  it("opens none for a watcher, a stopped workspace, or one with a terminal already", () => {
    expect(wantsShellOnOwn({ ...OWNER_RUNNING, opensOn: null })).toBe(false);
    expect(wantsShellOnOwn({ ...OWNER_RUNNING, workspaceRuns: false })).toBe(false);
    expect(wantsShellOnOwn({ ...OWNER_RUNNING, liveTerminals: 1 })).toBe(false);
  });

  it("waits for the workspace's processes", () => {
    expect(wantsShellOnOwn({ ...OWNER_RUNNING, liveTerminals: null })).toBe(false);
  });
});

let root: Root | null = null;
afterEach(() => act(() => root?.unmount()));

function View(props: {
  readonly sessionId: string;
  readonly wanted: boolean;
  readonly openShell: (sessionId: string) => void;
}) {
  useShellOnOwn(props.sessionId, props.wanted, props.openShell);
  return null;
}

const show = (sessionId: string, wanted: boolean, openShell: (sessionId: string) => void) =>
  act(() =>
    root?.render(
      <StrictMode>
        <View sessionId={sessionId} wanted={wanted} openShell={openShell} />
      </StrictMode>,
    ),
  );

describe("the shell the Terminal view opens by itself", () => {
  it("is opened once, under React's doubled effects, a second visit and a closed shell", () => {
    const openShell = vi.fn();
    root = createRoot(document.createElement("div"));
    show("sess-once", false, openShell);
    expect(openShell).not.toHaveBeenCalled();

    show("sess-once", true, openShell);
    expect(openShell.mock.calls).toEqual([["sess-once"]]);

    // The person closes it, then the view mounts again.
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
    expect(openShell.mock.calls).toEqual([["sess-a"], ["sess-b"]]);
  });
});
