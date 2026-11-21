import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from "electron";

import {
  IPC,
  type DesktopBootstrap,
  type DesktopMenuAction,
  type MendDesktopBridge,
  type MendShellBridge,
  type ShellState,
} from "../shared/bridge.ts";

/**
 * Sandboxed preload script.
 *
 * Asks the main process synchronously whether this frame is trusted (`shell`, `server`, or
 * `untrusted`). Subframes (such as live preview iframes) and untrusted origins receive no bridge
 * globals at all.
 */

const isShellState = (value: unknown): value is ShellState =>
  typeof value === "object" &&
  value !== null &&
  "mode" in value &&
  (value.mode === "connect" || value.mode === "offline") &&
  "recentServers" in value &&
  Array.isArray(value.recentServers);

const isBootstrap = (value: unknown): value is DesktopBootstrap =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value.kind === "shell" || value.kind === "server" || value.kind === "untrusted");

const rawBootstrap: unknown = ipcRenderer.sendSync(IPC.bootstrap);
const bootstrap: DesktopBootstrap = isBootstrap(rawBootstrap)
  ? rawBootstrap
  : {
      kind: "untrusted",
      platform: "linux",
      version: "0.0.0",
      serverUrl: null,
      fullScreen: false,
    };

const syncMacInset = (): void => {
  const zoom = webFrame.getZoomFactor();
  document.documentElement.style.setProperty(
    "--desktop-window-controls-inset",
    `${Math.round(90 / zoom)}px`,
  );
};

if (bootstrap.kind !== "untrusted") {
  // On macOS, native traffic lights stay 14pt regardless of Chromium zoom; expose their reserved
  // width in CSS pixels so Sheet's sidebar stays clear of them at any zoom level.
  if (bootstrap.platform === "darwin") {
    window.addEventListener("DOMContentLoaded", syncMacInset, { once: true });
    window.addEventListener("resize", syncMacInset);
  }

  const desktopBridge: MendDesktopBridge = {
    platform: bootstrap.platform,
    version: bootstrap.version,
    serverUrl: bootstrap.serverUrl,
    isFullScreen: (): boolean => ipcRenderer.sendSync(IPC.getFullScreen) === true,
    onFullScreenChange: (listener) => {
      const handler = (_event: IpcRendererEvent, fullScreen: unknown) => {
        if (typeof fullScreen === "boolean") listener(fullScreen);
      };
      ipcRenderer.on(IPC.fullScreenChanged, handler);
      return () => {
        ipcRenderer.removeListener(IPC.fullScreenChanged, handler);
      };
    },
    getZoomFactor: () => webFrame.getZoomFactor(),
    setBadgeCount: (count: number) => ipcRenderer.invoke(IPC.setBadgeCount, count),
    switchServer: () => ipcRenderer.invoke(IPC.switchServer),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
    onMenuAction: (listener) => {
      const handler = (_event: IpcRendererEvent, action: unknown) => {
        if (
          action === "new-session" ||
          action === "open-settings" ||
          action === "close-tab" ||
          action === "switch-server"
        ) {
          listener(action satisfies DesktopMenuAction);
        }
      };
      ipcRenderer.on(IPC.menuAction, handler);
      return () => {
        ipcRenderer.removeListener(IPC.menuAction, handler);
      };
    },
  };

  contextBridge.exposeInMainWorld("mendDesktop", desktopBridge);

  if (bootstrap.kind === "shell") {
    const shellBridge: MendShellBridge = {
      getState: () => ipcRenderer.invoke(IPC.shellGetState),
      onStateChange: (listener) => {
        const handler = (_event: IpcRendererEvent, state: unknown) => {
          if (isShellState(state)) {
            listener(state);
          }
        };
        ipcRenderer.on(IPC.shellStateChanged, handler);
        return () => {
          ipcRenderer.removeListener(IPC.shellStateChanged, handler);
        };
      },
      connect: (rawUrl: string) => ipcRenderer.invoke(IPC.shellConnect, rawUrl),
      retry: () => ipcRenderer.invoke(IPC.shellRetry),
      removeRecent: (url: string) => ipcRenderer.invoke(IPC.shellRemoveRecent, url),
      cancelSwitch: () => ipcRenderer.invoke(IPC.shellCancelSwitch),
    };

    contextBridge.exposeInMainWorld("mendShell", shellBridge);
  }
}
