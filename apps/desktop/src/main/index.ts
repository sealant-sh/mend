import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  session,
  shell,
  webContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";

import {
  IPC,
  type ConnectResult,
  type DesktopBootstrap,
  type DesktopMenuAction,
  type DesktopPlatform,
  type ShellMode,
  type ShellState,
} from "../shared/bridge.ts";
import { MIN_WINDOW_SIZE, resolveInitialBounds } from "./bounds.ts";
import {
  buildApplicationMenuTemplate,
  type MainContentsCommand,
  type MainZoomCommand,
} from "./menu.ts";
import { probeServer } from "./probe.ts";
import {
  createDesktopStore,
  readCliDefaultUrl,
  recordRecentServer,
  removeRecentServer,
  type DesktopStoreState,
} from "./store.ts";
import { isAllowedExternalUrl, isLocalShellUrl, isSameOrigin, normalizeServerUrl } from "./urls.ts";

/**
 * Thin Electron shell around Mend's live web app (`apps/web`).
 *
 * When a server URL is configured, the main window loads it directly as a top-level document so
 * Better Auth cookies, `/trpc`, `/api/events` SSE, `/api/tty` WebSockets, and live preview iframes
 * work identically to a browser with zero duplicated UI. When no server is chosen yet, the user
 * clicks Switch Server, or the server fails to load, the window shows the local Sheet-styled
 * Connect / Offline shell.
 */

const RENDERER_URL = process.env["ELECTRON_RENDERER_URL"];
const PROD_RENDERER_HTML = path.join(import.meta.dirname, "../renderer/index.html");
const PROD_RENDERER_DIR_URL = pathToFileURL(path.join(import.meta.dirname, "../renderer/")).href;
const PLATFORM: DesktopPlatform =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";

// Sheet's `--canvas` in light and dark (`packages/ui/src/styles/globals.css`).
const CANVAS_LIGHT = "#eceef1";
const CANVAS_DARK = "#0e1013";

// Match Sheet's top desk strip (`h-header` = 52px); native macOS traffic lights stay 14pt at any zoom.
const MACOS_TOPBAR_HEIGHT = 52;
const MACOS_TRAFFIC_LIGHT_RADIUS = 7;

const RECONNECT_LADDER_MS = [3_000, 4_000, 8_000] as const;
const BOUNDS_SAVE_DEBOUNCE_MS = 400;
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 3;

// Linux/Wayland scaling: wlroots compositors (niri, sway, …) can round a 1× monitor up to 2× when
// paired with a HiDPI display. Pin scale to 1 by default; `MEND_DEVICE_SCALE=auto` or a positive
// number overrides it. Must run before `app.whenReady()`.
if (process.platform === "linux") {
  if (process.env["ELECTRON_OZONE_PLATFORM_HINT"] === undefined) {
    app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  }
  app.commandLine.appendSwitch("enable-features", "WaylandFractionalScaleV1");

  const requested = process.env["MEND_DEVICE_SCALE"];
  const scale =
    requested === "auto"
      ? null
      : requested !== undefined && Number.isFinite(Number(requested)) && Number(requested) > 0
        ? requested
        : "1";
  if (scale !== null) app.commandLine.appendSwitch("force-device-scale-factor", scale);
}

// `MEND_USER_DATA` isolates profile + single-instance lock for verify drives and smoke tests.
const customUserData = process.env["MEND_USER_DATA"];
app.setPath(
  "userData",
  customUserData !== undefined && customUserData !== "" ? customUserData : app.getPath("userData"),
);
app.setName("Mend");

const envServerOverride = (() => {
  const raw = process.env["MEND_DESKTOP_SERVER_URL"];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = normalizeServerUrl(raw);
  return parsed.ok ? parsed.url : null;
})();

const startAtConnect = process.env["MEND_DESKTOP_START_AT"] === "connect";

const store = createDesktopStore(app.getPath("userData"));
let persisted: DesktopStoreState = store.load();
let activeServerUrl: string | null = envServerOverride ?? persisted.serverUrl;
let shellMode: ShellMode = "connect";
let offlineReason: string | null = null;
let reconnecting = false;
let canCancelSwitch = false;
let viewingLocalShell = false;
let mainWindow: BrowserWindow | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;

const backgroundColorForTheme = (): string =>
  nativeTheme.shouldUseDarkColors ? CANVAS_DARK : CANVAS_LIGHT;

const syncMacTrafficLights = (win: BrowserWindow): void => {
  if (PLATFORM !== "darwin" || win.isDestroyed() || win.isFullScreen()) return;
  const zoom = win.webContents.getZoomFactor();
  win.setWindowButtonPosition({
    x: 16,
    y: Math.max(8, Math.round((MACOS_TOPBAR_HEIGHT * zoom) / 2 - MACOS_TRAFFIC_LIGHT_RADIUS)),
  });
};

const currentShellState = (): ShellState => ({
  mode: shellMode,
  platform: PLATFORM,
  serverUrl: activeServerUrl,
  suggestedUrl: activeServerUrl ?? readCliDefaultUrl(),
  recentServers: persisted.recentServers,
  canCancelSwitch: canCancelSwitch && activeServerUrl !== null,
  offlineReason,
  reconnecting,
});

const broadcastShellState = (): void => {
  if (mainWindow === null || mainWindow.isDestroyed() || !viewingLocalShell) return;
  mainWindow.webContents.send(IPC.shellStateChanged, currentShellState());
};

const stopReconnectLoop = (): void => {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  reconnecting = false;
};

const isSenderLocalShell = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
  if (mainWindow === null || mainWindow.isDestroyed()) return false;
  if (event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  return isLocalShellUrl(event.senderFrame.url, {
    devRendererUrl: RENDERER_URL,
    prodRendererDirUrl: PROD_RENDERER_DIR_URL,
  });
};

const isSenderActiveServer = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
  if (mainWindow === null || mainWindow.isDestroyed()) return false;
  if (event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  if (activeServerUrl === null) return false;
  return isSameOrigin(event.senderFrame.url, activeServerUrl);
};

const senderTrustKind = (event: IpcMainEvent | IpcMainInvokeEvent): DesktopBootstrap["kind"] => {
  if (isSenderLocalShell(event)) return "shell";
  if (isSenderActiveServer(event)) return "server";
  return "untrusted";
};

const loadLocalShell = (win: BrowserWindow): void => {
  viewingLocalShell = true;
  if (RENDERER_URL !== undefined) {
    void win.loadURL(RENDERER_URL);
  } else {
    void win.loadFile(PROD_RENDERER_HTML);
  }
};

const navigateToServer = (win: BrowserWindow, serverUrl: string): void => {
  stopReconnectLoop();
  viewingLocalShell = false;
  canCancelSwitch = false;
  offlineReason = null;
  void win.loadURL(serverUrl);
};

const scheduleReconnect = (): void => {
  if (reconnectTimer !== null || shellMode !== "offline" || activeServerUrl === null) return;
  const delay =
    RECONNECT_LADDER_MS[Math.min(reconnectAttempt, RECONNECT_LADDER_MS.length - 1)] ?? 3_000;
  reconnectAttempt += 1;
  reconnecting = true;
  broadcastShellState();

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const target = activeServerUrl;
    if (
      shellMode !== "offline" ||
      target === null ||
      mainWindow === null ||
      mainWindow.isDestroyed()
    ) {
      reconnecting = false;
      return;
    }
    const attemptReconnect = async (): Promise<void> => {
      const result = await probeServer(target);
      if (shellMode !== "offline" || activeServerUrl !== target) return;
      if (result.ok && mainWindow !== null && !mainWindow.isDestroyed()) {
        navigateToServer(mainWindow, target);
      } else {
        scheduleReconnect();
      }
    };
    void attemptReconnect();
  }, delay);
};

const enterOfflineScreen = (win: BrowserWindow, reason: string): void => {
  shellMode = "offline";
  offlineReason = reason;
  canCancelSwitch = false;
  if (viewingLocalShell) {
    broadcastShellState();
  } else {
    loadLocalShell(win);
  }
  scheduleReconnect();
};

const enterConnectScreen = (
  win: BrowserWindow,
  options: { readonly allowCancel: boolean },
): void => {
  stopReconnectLoop();
  shellMode = "connect";
  offlineReason = null;
  canCancelSwitch = options.allowCancel && activeServerUrl !== null;
  if (viewingLocalShell) {
    broadcastShellState();
  } else {
    loadLocalShell(win);
  }
};

const describeLoadFailure = (errorCode: number, errorDescription: string): string => {
  if (errorCode === -102 || errorDescription === "ERR_CONNECTION_REFUSED") {
    return "Connection refused. Check that Mend is running at this address.";
  }
  if (errorCode === -105 || errorDescription === "ERR_NAME_NOT_RESOLVED") {
    return "Couldn't resolve that hostname. Check the address and your network.";
  }
  if (errorCode === -106 || errorDescription === "ERR_INTERNET_DISCONNECTED") {
    return "This computer appears to be offline.";
  }
  if (errorCode === -118 || errorDescription === "ERR_CONNECTION_TIMED_OUT") {
    return "The connection timed out.";
  }
  if (errorCode <= -200 && errorCode >= -219) {
    return "The server's TLS certificate wasn't trusted.";
  }
  return `Couldn't load the server (${errorDescription || `error ${errorCode}`}).`;
};

const createWindow = (): BrowserWindow => {
  const displays = screen.getAllDisplays().map((display) => display.bounds);
  const initialBounds = resolveInitialBounds(persisted.bounds, displays);

  const win = new BrowserWindow({
    ...initialBounds,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: backgroundColorForTheme(),
    ...(PLATFORM === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: {
            x: 16,
            y: Math.round(MACOS_TOPBAR_HEIGHT / 2 - MACOS_TRAFFIC_LIGHT_RADIUS),
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (PLATFORM !== "darwin") {
    win.setMenuBarVisibility(false);
  }

  if (persisted.maximized) {
    win.maximize();
  }

  win.once("ready-to-show", () => {
    win.show();
  });

  // Persist window bounds debounced so resize/move never hammers disk.
  let boundsTimer: NodeJS.Timeout | null = null;
  const saveWindowBounds = (): void => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    persisted = { ...persisted, bounds, maximized };
    store.save(persisted);
  };
  const scheduleBoundsSave = (): void => {
    if (boundsTimer !== null) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      saveWindowBounds();
    }, BOUNDS_SAVE_DEBOUNCE_MS);
  };
  win.on("resize", scheduleBoundsSave);
  win.on("move", scheduleBoundsSave);
  win.on("maximize", scheduleBoundsSave);
  win.on("unmaximize", scheduleBoundsSave);
  win.on("close", () => {
    if (boundsTimer !== null) {
      clearTimeout(boundsTimer);
      boundsTimer = null;
    }
    saveWindowBounds();
  });

  if (PLATFORM === "darwin") {
    win.on("enter-full-screen", () => {
      if (!win.isDestroyed()) win.webContents.send(IPC.fullScreenChanged, true);
    });
    win.on("leave-full-screen", () => {
      if (win.isDestroyed()) return;
      syncMacTrafficLights(win);
      win.webContents.send(IPC.fullScreenChanged, false);
    });
    win.on("swipe", (_event, direction) => {
      if (win.isDestroyed() || viewingLocalShell) return;
      const history = win.webContents.navigationHistory;
      if (direction === "left" && history.canGoBack()) history.goBack();
      else if (direction === "right" && history.canGoForward()) history.goForward();
    });
  }

  // External links (`target="_blank"`, `window.open`, `vscode://`) open in the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url).catch(() => undefined);
    }
    return { action: "deny" };
  });

  // Top-level navigations outside the configured server origin open in the OS browser instead of
  // taking over the desktop window.
  win.webContents.on("will-navigate", (event, url) => {
    const isShell = isLocalShellUrl(url, {
      devRendererUrl: RENDERER_URL,
      prodRendererDirUrl: PROD_RENDERER_DIR_URL,
    });
    if (isShell) return;
    if (activeServerUrl !== null && isSameOrigin(url, activeServerUrl)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url).catch(() => undefined);
    }
  });

  win.webContents.on("did-finish-load", () => {
    // Electron disables trackpad pinch zoom by default and resets it on every navigation.
    void win.webContents.setVisualZoomLevelLimits(1, 3);
    syncMacTrafficLights(win);
    if (viewingLocalShell) {
      broadcastShellState();
    }
  });

  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      // -3 is ERR_ABORTED (ordinary redirect or superseded load).
      if (!isMainFrame || errorCode === -3) return;
      if (
        isLocalShellUrl(validatedUrl, {
          devRendererUrl: RENDERER_URL,
          prodRendererDirUrl: PROD_RENDERER_DIR_URL,
        })
      ) {
        return;
      }
      enterOfflineScreen(win, describeLoadFailure(errorCode, errorDescription));
    },
  );

  // Initial target: load the configured server directly unless Connect was explicitly requested.
  if (activeServerUrl !== null && !startAtConnect) {
    navigateToServer(win, activeServerUrl);
  } else {
    enterConnectScreen(win, { allowCancel: false });
  }

  return win;
};

const installLocalShellCsp = (): void => {
  if (RENDERER_URL !== undefined) return;
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith(PROD_RENDERER_DIR_URL)) {
      callback({
        responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] },
      });
      return;
    }
    callback({});
  });
};

const dispatchMenuAction = (action: DesktopMenuAction): void => {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  if (action === "switch-server") {
    enterConnectScreen(mainWindow, { allowCancel: !viewingLocalShell });
    return;
  }
  if (!viewingLocalShell) {
    mainWindow.webContents.send(IPC.menuAction, action);
  }
};

const runMainContentsCommand = (command: MainContentsCommand): void => {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  if (command === "reload") mainWindow.webContents.reload();
  else if (command === "force-reload") mainWindow.webContents.reloadIgnoringCache();
  else mainWindow.webContents.toggleDevTools();
};

const runMainZoom = (command: MainZoomCommand): void => {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const current = mainWindow.webContents.getZoomLevel();
  const next =
    command === "reset"
      ? 0
      : command === "in"
        ? Math.min(ZOOM_MAX, current + ZOOM_STEP)
        : Math.max(ZOOM_MIN, current - ZOOM_STEP);
  mainWindow.webContents.setZoomLevel(next);
  syncMacTrafficLights(mainWindow);
};

const registerIpc = (): void => {
  ipcMain.on(IPC.bootstrap, (event) => {
    const kind = senderTrustKind(event);
    const payload: DesktopBootstrap = {
      kind,
      platform: PLATFORM,
      version: app.getVersion(),
      serverUrl: kind === "untrusted" ? null : activeServerUrl,
      fullScreen: mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFullScreen(),
    };
    event.returnValue = payload;
  });

  ipcMain.on(IPC.getFullScreen, (event) => {
    if (senderTrustKind(event) === "untrusted") {
      event.returnValue = false;
      return;
    }
    event.returnValue =
      mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFullScreen();
  });

  ipcMain.handle(IPC.setBadgeCount, (event, count: unknown) => {
    if (senderTrustKind(event) === "untrusted") return;
    const normalized =
      typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    app.setBadgeCount(normalized);
  });

  ipcMain.handle(IPC.switchServer, (event) => {
    if (senderTrustKind(event) === "untrusted") return;
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      enterConnectScreen(mainWindow, { allowCancel: !viewingLocalShell });
    }
  });

  ipcMain.handle(IPC.openExternal, async (event, url: unknown): Promise<boolean> => {
    if (senderTrustKind(event) === "untrusted") return false;
    if (typeof url !== "string" || !isAllowedExternalUrl(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });

  // ─── Local shell IPC (refused for any remote origin) ──────────────────────

  ipcMain.handle(IPC.shellGetState, (event): ShellState => {
    if (!isSenderLocalShell(event)) {
      throw new Error("Shell state is only available on the local desktop shell.");
    }
    return currentShellState();
  });

  ipcMain.handle(IPC.shellConnect, async (event, rawUrl: unknown): Promise<ConnectResult> => {
    if (!isSenderLocalShell(event)) {
      return { ok: false, reason: "Not allowed from this frame." };
    }
    if (typeof rawUrl !== "string") {
      return { ok: false, reason: "Enter a Mend server address." };
    }
    const normalized = normalizeServerUrl(rawUrl);
    if (!normalized.ok) return normalized;

    const probed = await probeServer(normalized.url);
    if (!probed.ok) return probed;

    activeServerUrl = normalized.url;
    persisted = {
      ...persisted,
      serverUrl: normalized.url,
      recentServers: recordRecentServer(persisted.recentServers, normalized.url),
    };
    store.save(persisted);

    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      navigateToServer(mainWindow, normalized.url);
    }
    return { ok: true, url: normalized.url };
  });

  ipcMain.handle(IPC.shellRetry, async (event): Promise<ConnectResult> => {
    if (!isSenderLocalShell(event)) {
      return { ok: false, reason: "Not allowed from this frame." };
    }
    if (activeServerUrl === null) {
      return { ok: false, reason: "No server address is selected." };
    }
    const target = activeServerUrl;
    const probed = await probeServer(target);
    if (!probed.ok) {
      offlineReason = probed.reason;
      broadcastShellState();
      return probed;
    }
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      navigateToServer(mainWindow, target);
    }
    return { ok: true, url: target };
  });

  ipcMain.handle(IPC.shellRemoveRecent, (event, url: unknown): ShellState => {
    if (!isSenderLocalShell(event)) {
      throw new Error("Not allowed from this frame.");
    }
    if (typeof url === "string") {
      persisted = {
        ...persisted,
        recentServers: removeRecentServer(persisted.recentServers, url),
      };
      store.save(persisted);
    }
    const state = currentShellState();
    broadcastShellState();
    return state;
  });

  ipcMain.handle(IPC.shellCancelSwitch, (event): void => {
    if (!isSenderLocalShell(event)) return;
    if (activeServerUrl !== null && mainWindow !== null && !mainWindow.isDestroyed()) {
      navigateToServer(mainWindow, activeServerUrl);
    }
  });
};

const summon = (): void => {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", summon);

  const start = async (): Promise<void> => {
    await app.whenReady();
    app.setAppUserModelId("run.mend.desktop");
    installLocalShellCsp();
    registerIpc();

    const menuTemplate = buildApplicationMenuTemplate({
      platform: PLATFORM,
      appName: app.name,
      onMenuAction: dispatchMenuAction,
      onCloseWindow: () => mainWindow?.close(),
      onCloseTabOrDevTools: () => {
        const focusedDevTools = webContents
          .getAllWebContents()
          .find((contents) => !contents.isDestroyed() && contents.isDevToolsFocused());
        if (focusedDevTools !== undefined) {
          focusedDevTools.closeDevTools();
          return;
        }
        dispatchMenuAction("close-tab");
      },
      onMainContentsCommand: runMainContentsCommand,
      onZoom: runMainZoom,
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

    nativeTheme.on("updated", () => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(backgroundColorForTheme());
      }
    });

    mainWindow = createWindow();
    mainWindow.on("closed", () => {
      stopReconnectLoop();
      mainWindow = null;
    });

    // Alt+Space summons Mend from anywhere when no other app holds it.
    globalShortcut.register("Alt+Space", summon);

    app.on("will-quit", () => {
      stopReconnectLoop();
      globalShortcut.unregisterAll();
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  };
  void start();

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
