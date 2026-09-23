import path from "node:path";

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  session,
  shell,
  type MenuItemConstructorOptions,
} from "electron";

import {
  IPC,
  type ApiRequest,
  type ConnectionInfo,
  type EventsState,
  type SignInInput,
  type TtyTarget,
  type WorkbenchEvent,
} from "../shared/bridge";
import { configPath, loadConfig, watchConfig } from "./config";
import { request, setToken, signIn, signOut, subscribeEvents, ttyUrl } from "./server";
import { isMendSocket, SOCKET_URL_PATTERNS, withoutBrowserCredentials } from "./socket-headers";

/**
 * The cockpit window. One window, one credential, one event stream: main
 * owns all three and hands the renderer a narrow bridge (src/preload).
 *
 * Chrome: the titlebar is ours (Figma "Desktop / Cockpit" — traffic lights,
 * "Mend · cockpit", the shortcut hints). macOS keeps its native traffic lights
 * inset into that bar; Linux and Windows go frameless and the renderer draws
 * working ones through `window.*` on the bridge.
 */

const RENDERER_URL = process.env["ELECTRON_RENDERER_URL"];

// Linux/Wayland scaling. Electron's native-Wayland fractional scaling is
// unreliable on wlroots compositors (niri, sway, …): on a 1× output sitting
// next to a 2× one Chromium rounds every window up to scale 2, so the whole UI
// renders at 2× — huge, with a tiny native cursor. `WaylandFractionalScaleV1`
// is supposed to fix that but doesn't hold here, so we pin the device scale
// factor instead. The app is drawn at its Figma logical size, so 1 is the right
// default; MEND_DEVICE_SCALE overrides it (a number to pin a different scale —
// e.g. 2 on a HiDPI-only setup — or "auto" to drop the pin and let Chromium /
// the compositor negotiate). Must be set before app-ready; no-ops elsewhere.
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

// A second, isolated instance for testing/diagnostics: MEND_USER_DATA moves
// the profile (and with it the single-instance lock), so a probe instance can
// run beside the daily one. Must be set before the lock is requested.
const userData = process.env["MEND_USER_DATA"];
if (userData !== undefined && userData !== "") {
  app.setPath("userData", userData);
}

let mainWindow: BrowserWindow | null = null;

const connectionInfo = (): ConnectionInfo => {
  const config = loadConfig();
  return { url: config.url, signedIn: config.token !== null, configPath: configPath() };
};

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1512,
    height: 982,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e21" : "#faf9f7",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 16 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // External links open in the system browser; the window never navigates
  // away from the renderer.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (RENDERER_URL !== undefined) {
    void window.loadURL(RENDERER_URL);
  } else {
    void window.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }
  return window;
};

const send = (channel: string, payload: unknown) => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

// ─── the event stream follows the credential ────────────────────────────────

let stopEvents: (() => void) | null = null;
let eventsState: EventsState = "off";

const restartEvents = () => {
  stopEvents?.();
  stopEvents = subscribeEvents({
    onEvent: (event: WorkbenchEvent) => send(IPC.event, event),
    onState: (state) => {
      eventsState = state;
      send(IPC.eventsState, state);
    },
  });
};

const connectionChanged = () => {
  send(IPC.connectionChanged, connectionInfo());
  restartEvents();
};

// ─── IPC ────────────────────────────────────────────────────────────────────

const registerIpc = () => {
  ipcMain.handle(IPC.connectionGet, () => connectionInfo());
  ipcMain.handle(IPC.connectionSignIn, async (_event, input: SignInInput) => {
    const result = await signIn(input);
    if (result.ok) connectionChanged();
    return result;
  });
  ipcMain.handle(
    IPC.connectionSetToken,
    (_event, input: { readonly url: string; readonly token: string }) => {
      setToken(input);
      connectionChanged();
    },
  );
  ipcMain.handle(IPC.connectionSignOut, () => {
    signOut();
    connectionChanged();
  });
  ipcMain.handle(IPC.apiRequest, (_event, input: ApiRequest) => request(input));
  ipcMain.handle(IPC.ttyUrl, (_event, target: TtyTarget, from: string) => ttyUrl(target, from));
  ipcMain.handle(IPC.openExternal, (_event, url: string) => {
    // Only web URLs leave the app; anything else stays where it is.
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  });
  ipcMain.on(IPC.windowMinimize, () => mainWindow?.minimize());
  ipcMain.on(IPC.windowToggleMaximize, () => {
    if (mainWindow === null) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on(IPC.windowClose, () => mainWindow?.close());
};

// ─── menu: the few native items a desktop app owes the OS ───────────────────

const buildMenu = () => {
  const isMac = process.platform === "darwin";
  const template: Array<MenuItemConstructorOptions> = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

// ─── CSP ────────────────────────────────────────────────────────────────────

/**
 * Packaged builds lock the page down: scripts and styles from the bundle
 * only (plus wasm for the terminal), sockets to wherever the operator's
 * server is (its host is configuration, so ws:/wss: stay open), nothing else.
 * Dev skips it — Vite's HMR client and React's refresh preamble are inline.
 */
const installContentSecurityPolicy = () => {
  if (RENDERER_URL !== undefined) return;
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    "connect-src 'self' data: ws: wss:",
    "worker-src 'self' blob:",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] },
    });
  });
};

// ─── the terminal socket leaves as a token client ───────────────────────────

/**
 * The renderer opens `/api/tty` itself, and Chromium stamps the upgrade with the page's Origin,
 * which the server refuses (src/main/socket-headers.ts). The server URL is read per request, so a
 * `mend login --url` elsewhere or a changed MEND_URL applies to the next socket without a restart.
 */
const installSocketHeaders = () => {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [...SOCKET_URL_PATTERNS] },
    (details, callback) => {
      if (!isMendSocket(details.url, loadConfig().url)) {
        callback({});
        return;
      }
      callback({ requestHeaders: withoutBrowserCredentials(details.requestHeaders) });
    },
  );
};

// ─── lifecycle ──────────────────────────────────────────────────────────────

const summon = () => {
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

  const start = async () => {
    await app.whenReady();
    app.setAppUserModelId("sh.sealant.mend");
    installContentSecurityPolicy();
    installSocketHeaders();
    registerIpc();
    buildMenu();
    mainWindow = createWindow();
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    // Once the page is up, tell it where the stream stands — it may have
    // missed the first transitions while loading.
    mainWindow.webContents.on("did-finish-load", () => send(IPC.eventsState, eventsState));
    restartEvents();

    // ⌥Space summons the cockpit from any app (Figma titlebar hint). A taken
    // shortcut (another app owns it) is simply unavailable — not an error.
    globalShortcut.register("Alt+Space", summon);

    const unwatch = watchConfig(connectionChanged);
    app.on("will-quit", () => {
      unwatch();
      stopEvents?.();
      globalShortcut.unregisterAll();
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  };
  void start();

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
