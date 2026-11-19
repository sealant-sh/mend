import type RFB from "@novnc/novnc";
import { useCallback, useRef } from "react";

import type { ScreenRtcView } from "#/lib/screen-rtc";
import { ScreenChannel, screenCloseWords, screenSocketUrl } from "#/lib/screen-socket";
import type { ScreenWire } from "#/lib/screen-state";

/**
 * A screen's viewer: `mount` opens it on the element it is given, H.264 over WebRTC, then noVNC
 * when UDP or the encoder is unavailable. Input goes up only while `held` says this connection
 * holds it, so a viewer that never sets it only watches. Nothing reaches the clipboard either way:
 * the viewer never sends noVNC's clipboard and never listens for the screen's (ADR 0020, D13).
 */
export const useScreenViewer = (sessionId: string, onWire: (wire: ScreenWire) => void) => {
  const held = useRef(false);
  const rfb = useRef<RFB | null>(null);
  const rtc = useRef<ScreenRtcView | null>(null);
  // noVNC is an imperative widget bound to its element: it opens with the element, at each
  // Reconnect (a new key), and closes with it. It reads `window` as it loads, so it loads here,
  // in the browser, and only on a page with a live screen.
  const mount = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null) return;
      let disposed = false;
      let view: RFB | null = null;
      let stream: ScreenRtcView | null = null;
      onWire({ _tag: "Connecting" });
      const openVnc = async () => {
        const { default: Rfb } = await import("@novnc/novnc");
        if (disposed) return;
        const socket = new WebSocket(screenSocketUrl(sessionId, window.location.origin));
        const channel = new ScreenChannel(socket, {
          hello: (connection) => {
            if (!disposed) onWire({ _tag: "Watching", connection });
          },
          closed: (close) => {
            if (!disposed) onWire({ _tag: "Closed", words: screenCloseWords(close) });
          },
        });
        view = new Rfb(element, channel, { shared: true });
        view.viewOnly = !held.current;
        view.scaleViewport = true;
        view.background = "transparent";
        rfb.current = view;
      };
      const fallback = () => {
        if (disposed) return;
        stream?.close();
        rtc.current = null;
        element.replaceChildren();
        openVnc().catch(() => {
          if (!disposed) onWire({ _tag: "Closed", words: "the screen viewer didn't load" });
        });
      };
      const open = async () => {
        const { openScreenRtc } = await import("#/lib/screen-rtc");
        if (disposed) return;
        const video = document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.tabIndex = 0;
        video.setAttribute("aria-label", "The workspace's screen");
        video.className = "block h-full w-full object-contain outline-none";
        element.append(video);
        stream = openScreenRtc(video, sessionId, {
          watching: (connection) => {
            if (!disposed) onWire({ _tag: "Watching", connection });
          },
          fallback,
        });
        rtc.current = stream;
        stream.setHeld(held.current);
      };
      void open().catch(fallback);
      return () => {
        disposed = true;
        rfb.current = null;
        view?.disconnect();
        stream?.close();
        rtc.current = null;
      };
    },
    [sessionId, onWire],
  );
  return { mount, held, rfb, rtc };
};
