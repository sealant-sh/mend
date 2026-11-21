/**
 * Contract shared by main, preload, and the local Connect/Offline shell.
 *
 * Remote Mend web pages receive only `window.mendDesktop` (and only on the main frame of the
 * configured server origin). The local Connect/Offline shell additionally receives
 * `window.mendShell` so it can probe and switch servers.
 */

export type DesktopPlatform = "darwin" | "linux" | "win32";

export type DesktopMenuAction = "new-session" | "open-settings" | "close-tab" | "switch-server";

export type ShellMode = "connect" | "offline";

export interface ShellState {
  readonly mode: ShellMode;
  readonly platform: DesktopPlatform;
  /** The server currently configured, or the one that failed to load when in offline mode. */
  readonly serverUrl: string | null;
  /** Pre-filled suggestion on first launch (e.g. from the CLI's config, read-only). */
  readonly suggestedUrl: string | null;
  readonly recentServers: ReadonlyArray<string>;
  /** True when the user opened the server switcher from an already-connected server. */
  readonly canCancelSwitch: boolean;
  /** Plain-English reason why the server could not be reached, when in offline mode. */
  readonly offlineReason: string | null;
  /** True while main is polling `/api/health` in the background. */
  readonly reconnecting: boolean;
}

export type ConnectResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

export interface DesktopBootstrap {
  readonly kind: "shell" | "server" | "untrusted";
  readonly platform: DesktopPlatform;
  readonly version: string;
  readonly serverUrl: string | null;
  readonly fullScreen: boolean;
}

/**
 * Capability surface exposed as `window.mendDesktop` on trusted main frames (the active Mend
 * server and the local shell). `apps/web` detects Electron by checking `window.mendDesktop`.
 */
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

/**
 * Local-only capability surface exposed as `window.mendShell` on the built-in Connect and Offline
 * screens. Never exposed to remote origins.
 */
export interface MendShellBridge {
  readonly getState: () => Promise<ShellState>;
  readonly onStateChange: (listener: (state: ShellState) => void) => () => void;
  readonly connect: (rawUrl: string) => Promise<ConnectResult>;
  readonly retry: () => Promise<ConnectResult>;
  readonly removeRecent: (url: string) => Promise<ShellState>;
  readonly cancelSwitch: () => Promise<void>;
}

export const IPC = {
  bootstrap: "mend:desktop:bootstrap",
  getFullScreen: "mend:desktop:get-full-screen",
  fullScreenChanged: "mend:desktop:full-screen-changed",
  setBadgeCount: "mend:desktop:set-badge-count",
  switchServer: "mend:desktop:switch-server",
  openExternal: "mend:desktop:open-external",
  menuAction: "mend:desktop:menu-action",

  shellGetState: "mend:shell:get-state",
  shellStateChanged: "mend:shell:state-changed",
  shellConnect: "mend:shell:connect",
  shellRetry: "mend:shell:retry",
  shellRemoveRecent: "mend:shell:remove-recent",
  shellCancelSwitch: "mend:shell:cancel-switch",
} as const;
