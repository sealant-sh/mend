import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  IPC,
  type ApiRequest,
  type ConnectionInfo,
  type EventsState,
  type MendBridge,
  type TtyTarget,
  type WorkbenchEvent,
} from "../shared/bridge";

/**
 * The bridge, exposed as `window.mend`. Every method is a thin IPC call; the
 * shapes live in src/shared/bridge.ts so main, preload and renderer agree by
 * construction.
 */

const subscribe =
  <T>(channel: string) =>
  (listener: (payload: T) => void) => {
    const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };

const platform: MendBridge["platform"] =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";

const bridge: MendBridge = {
  platform,
  connection: {
    get: () => ipcRenderer.invoke(IPC.connectionGet),
    authorize: (url: string) => ipcRenderer.invoke(IPC.connectionAuthorize, url),
    awaitAuthorize: () => ipcRenderer.invoke(IPC.connectionAwaitAuthorize),
    cancelAuthorize: () => ipcRenderer.invoke(IPC.connectionCancelAuthorize),
    setToken: (input) => ipcRenderer.invoke(IPC.connectionSetToken, input),
    signOut: () => ipcRenderer.invoke(IPC.connectionSignOut),
    onChange: subscribe<ConnectionInfo>(IPC.connectionChanged),
  },
  api: {
    request: (input: ApiRequest) => ipcRenderer.invoke(IPC.apiRequest, input),
  },
  tty: {
    url: (target: TtyTarget, from: string) => ipcRenderer.invoke(IPC.ttyUrl, target, from),
  },
  events: {
    onEvent: subscribe<WorkbenchEvent>(IPC.event),
    onState: subscribe<EventsState>(IPC.eventsState),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
  },
};

contextBridge.exposeInMainWorld("mend", bridge);
