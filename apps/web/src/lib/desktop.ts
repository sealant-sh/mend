import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Optional bridge injected by Mend's Electron desktop shell (`apps/desktop/src/preload/index.ts`)
 * on trusted main frames. In a regular browser `window.mendDesktop` is absent and every hook here
 * is a no-op so the web app stays browser-first.
 */

export type DesktopPlatform = "darwin" | "linux" | "win32";

export type DesktopMenuAction = "new-session" | "open-settings" | "close-tab" | "switch-server";

export interface MendDesktopBridge {
  readonly platform: DesktopPlatform;
  readonly version: string;
  readonly serverUrl: string | null;
  readonly isFullScreen: () => boolean;
  readonly onFullScreenChange: (listener: (fullScreen: boolean) => void) => () => void;
  readonly getZoomFactor: () => number;
  readonly setBadgeCount: (count: number) => Promise<void>;
  readonly switchServer: () => Promise<void>;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly onMenuAction: (listener: (action: DesktopMenuAction) => void) => () => void;
}

declare global {
  interface Window {
    readonly mendDesktop?: MendDesktopBridge;
  }
}

export const DESKTOP_CLOSE_TAB_EVENT = "mend:desktop-close-tab";

const noChange = () => () => {};

/** The Electron desktop bridge, or null in a regular browser or during SSR. */
export const desktopBridge = (): MendDesktopBridge | null =>
  typeof window === "undefined" ? null : (window.mendDesktop ?? null);

/** SSR-safe read of the desktop bridge (null during SSR, resolved on the client). */
export const useDesktopBridge = (): MendDesktopBridge | null =>
  useSyncExternalStore(noChange, desktopBridge, () => null);

const subscribeFullScreen = (onStoreChange: () => void): (() => void) => {
  const bridge = desktopBridge();
  if (bridge === null || bridge.platform !== "darwin") return () => {};
  return bridge.onFullScreenChange(onStoreChange);
};

const readMacTitlebarInset = (): boolean => {
  const bridge = desktopBridge();
  return bridge !== null && bridge.platform === "darwin" && !bridge.isFullScreen();
};

/**
 * True when running inside Electron on macOS with `hiddenInset` traffic lights visible (collapses
 * automatically in macOS full screen, and always false in browsers or on Linux/Windows).
 */
export const useMacDesktopTitlebarInset = (): boolean =>
  useSyncExternalStore(subscribeFullScreen, readMacTitlebarInset, () => false);

/** Syncs the desktop dock/taskbar badge count with the number of sessions waiting on the person. */
export const useDesktopBadgeCount = (count: number): void => {
  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge === null) return;
    void bridge.setBadgeCount(count).catch(() => undefined);
  }, [count]);

  useEffect(() => {
    return () => {
      const bridge = desktopBridge();
      if (bridge !== null) void bridge.setBadgeCount(0).catch(() => undefined);
    };
  }, []);
};

export interface DesktopMenuHandlers {
  readonly onNewSession: () => void;
  readonly onOpenSettings: () => void;
  readonly onCloseTab: () => void;
}

/** Subscribes to native Electron menu actions (`Cmd/Ctrl+N`, `Cmd/Ctrl+,`, `Cmd/Ctrl+W`). */
export const useDesktopMenuActions = (handlers: DesktopMenuHandlers): void => {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge === null) return;
    return bridge.onMenuAction((action) => {
      if (action === "new-session") latest.current.onNewSession();
      else if (action === "open-settings") latest.current.onOpenSettings();
      else if (action === "close-tab") latest.current.onCloseTab();
    });
  }, []);
};

/** Dispatches the local close-tab event handled by an open session workspace. */
export const dispatchDesktopCloseTab = (): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DESKTOP_CLOSE_TAB_EVENT));
  }
};

/** Subscribes a session workspace to desktop `Cmd/Ctrl+W` close-tab commands. */
export const useDesktopCloseTab = (onCloseTab: () => void): void => {
  const latest = useRef(onCloseTab);
  latest.current = onCloseTab;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const listener = () => latest.current();
    window.addEventListener(DESKTOP_CLOSE_TAB_EVENT, listener);
    return () => window.removeEventListener(DESKTOP_CLOSE_TAB_EVENT, listener);
  }, []);
};
