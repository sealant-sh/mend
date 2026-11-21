// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  desktopBridge,
  dispatchDesktopCloseTab,
  type DesktopMenuAction,
  type MendDesktopBridge,
  useDesktopBadgeCount,
  useDesktopCloseTab,
  useDesktopMenuActions,
  useMacDesktopTitlebarInset,
} from "./desktop.ts";

// React 19 requires IS_REACT_ACT_ENVIRONMENT on globalThis for `act()` in jsdom.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const setBridge = (bridge: MendDesktopBridge | undefined): void => {
  if (bridge === undefined) {
    Reflect.deleteProperty(window, "mendDesktop");
  } else {
    Object.defineProperty(window, "mendDesktop", {
      value: bridge,
      configurable: true,
      writable: true,
    });
  }
};

const makeBridge = (options?: {
  readonly platform?: "darwin" | "linux" | "win32";
  readonly initialFullScreen?: boolean;
}) => {
  let fullScreen = options?.initialFullScreen ?? false;
  const fullScreenListeners = new Set<(value: boolean) => void>();
  const menuListeners = new Set<(action: DesktopMenuAction) => void>();
  const setBadgeCount = vi.fn(async (_count: number) => undefined);
  const switchServer = vi.fn(async () => undefined);

  const bridge: MendDesktopBridge = {
    platform: options?.platform ?? "darwin",
    version: "0.0.0",
    serverUrl: "http://localhost:3115",
    isFullScreen: () => fullScreen,
    onFullScreenChange: (listener) => {
      fullScreenListeners.add(listener);
      return () => {
        fullScreenListeners.delete(listener);
      };
    },
    getZoomFactor: () => 1,
    setBadgeCount,
    switchServer,
    openExternal: async () => true,
    onMenuAction: (listener) => {
      menuListeners.add(listener);
      return () => {
        menuListeners.delete(listener);
      };
    },
  };

  return {
    bridge,
    setBadgeCount,
    emitFullScreen: (next: boolean) => {
      fullScreen = next;
      for (const listener of fullScreenListeners) listener(next);
    },
    emitMenuAction: (action: DesktopMenuAction) => {
      for (const listener of menuListeners) listener(action);
    },
  };
};

const containers: Array<HTMLElement> = [];
const mount = (node: ReturnType<typeof createElement>) => {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    rerender: (next: ReturnType<typeof createElement>) => {
      act(() => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
};

afterEach(() => {
  setBridge(undefined);
  while (containers.length > 0) containers.pop()?.remove();
});

function BadgeProbe({ count }: { readonly count: number }) {
  useDesktopBadgeCount(count);
  return null;
}

describe("desktop bridge hooks", () => {
  it("stays inert in a regular browser without window.mendDesktop", () => {
    expect(desktopBridge()).toBeNull();
    let inset: boolean | null = null;
    function Probe() {
      inset = useMacDesktopTitlebarInset();
      return null;
    }
    const mounted = mount(createElement(Probe));
    expect(inset).toBe(false);
    mounted.unmount();
  });

  it("reserves macOS traffic-light inset only outside full screen, and never on Linux", () => {
    const mac = makeBridge({ platform: "darwin", initialFullScreen: false });
    setBridge(mac.bridge);

    let inset = false;
    function Probe() {
      inset = useMacDesktopTitlebarInset();
      return null;
    }
    const mounted = mount(createElement(Probe));
    expect(inset).toBe(true);

    act(() => mac.emitFullScreen(true));
    expect(inset).toBe(false);

    act(() => mac.emitFullScreen(false));
    expect(inset).toBe(true);
    mounted.unmount();

    const linux = makeBridge({ platform: "linux" });
    setBridge(linux.bridge);
    const linuxMounted = mount(createElement(Probe));
    expect(inset).toBe(false);
    linuxMounted.unmount();
  });

  it("syncs badge count on change and clears to 0 on unmount", () => {
    const { bridge, setBadgeCount } = makeBridge({ platform: "linux" });
    setBridge(bridge);

    const mounted = mount(createElement(BadgeProbe, { count: 2 }));
    expect(setBadgeCount).toHaveBeenCalledWith(2);

    mounted.rerender(createElement(BadgeProbe, { count: 0 }));
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);

    mounted.unmount();
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it("routes desktop menu actions and close-tab events to their handlers", () => {
    const { bridge, emitMenuAction } = makeBridge({ platform: "darwin" });
    setBridge(bridge);

    const onNewSession = vi.fn();
    const onOpenSettings = vi.fn();
    const onCloseTab = vi.fn();

    function MenuProbe() {
      useDesktopMenuActions({
        onNewSession,
        onOpenSettings,
        onCloseTab: dispatchDesktopCloseTab,
      });
      useDesktopCloseTab(onCloseTab);
      return null;
    }

    const mounted = mount(createElement(MenuProbe));
    act(() => {
      emitMenuAction("new-session");
      emitMenuAction("open-settings");
      emitMenuAction("close-tab");
    });

    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onCloseTab).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });
});
