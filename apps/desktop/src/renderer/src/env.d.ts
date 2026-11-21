import type { MendDesktopBridge, MendShellBridge } from "../../shared/bridge.ts";

declare global {
  interface Window {
    readonly mendDesktop?: MendDesktopBridge;
    readonly mendShell?: MendShellBridge;
  }
}
