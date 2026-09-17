// The supervised /api/tty WebSocket. Connection-resilience patterns follow
// t3code (MIT — pingdotgg/t3code, packages/client-runtime connection
// supervisor + docs/internals/connection-runtime.md), adapted to Mend's raw
// PTY wire protocol:
//   - exactly one retry owner (this hook) — consumers never reconnect;
//   - fixed backoff ladder, reset after the link proves stable;
//   - foregrounding after a real absence REPLACES the socket instead of
//     trusting readyState — mobile OSes suspend sockets without delivering
//     a close event;
//   - the server replays the PTY record from 0 on every attach, so each
//     fresh connection bumps `generation` and consumers rebuild their
//     buffer wholesale (a terminal is a screen, not an event log — no
//     sequence-resume here by design);
//   - a settled session ({"t":"end"}) is terminal state, not a failure:
//     no retry.

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

export type TtyPhase = "idle" | "connecting" | "connected" | "reconnecting" | "ended";

const LADDER_MS = [3_000, 4_000, 8_000, 16_000] as const;
const STABLE_AFTER_MS = 30_000;
const BACKGROUND_REPLACE_AFTER_MS = 10_000;

export interface TtyTarget {
  readonly kind: "session" | "process";
  readonly id: string;
}

export interface TtySocket {
  readonly phase: TtyPhase;
  /** True exactly when an input frame would reach the PTY right now. */
  readonly canSend: boolean;
  /** Sends one PTY input frame. Returns false if the socket is not open. */
  readonly send: (data: string) => boolean;
  readonly resize: (cols: number, rows: number) => void;
  /** Skips any pending backoff and reconnects immediately. */
  readonly retryNow: () => void;
}

export function useTtySocket({
  serverUrl,
  token,
  target,
  enabled,
  onBinary,
  onEnd,
}: {
  readonly serverUrl: string | null;
  readonly token: string | null;
  readonly target: TtyTarget | null;
  readonly enabled: boolean;
  /**
   * PTY output bytes. `generation` increments on every fresh connection —
   * when it changes, everything already rendered is being replayed and the
   * consumer must start its buffer over instead of appending.
   */
  readonly onBinary?: (data: ArrayBuffer, generation: number) => void;
  readonly onEnd?: () => void;
}): TtySocket {
  const [phase, setPhase] = useState<TtyPhase>("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const retryNowRef = useRef<() => void>(() => undefined);
  const generationRef = useRef(0);
  const onBinaryRef = useRef(onBinary);
  const onEndRef = useRef(onEnd);
  onBinaryRef.current = onBinary;
  onEndRef.current = onEnd;

  useEffect(() => {
    if (!enabled || serverUrl === null || token === null || target === null) {
      setPhase("idle");
      return;
    }
    let disposed = false;
    let ended = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let connectedAt: number | null = null;
    let backgroundedAt: number | null = null;

    const connect = () => {
      if (disposed || ended) return;
      setPhase(attempt === 0 ? "connecting" : "reconnecting");
      let url: URL;
      try {
        url = new URL(`${serverUrl}/api/tty`);
      } catch {
        setPhase("idle");
        return;
      }
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set(target.kind, target.id);
      url.searchParams.set("from", "0");
      url.searchParams.set("token", token);
      const socket = new WebSocket(url.toString());
      socket.binaryType = "arraybuffer";
      ws = socket;
      wsRef.current = socket;
      let generation = 0;

      socket.addEventListener("open", () => {
        if (disposed || socket !== ws) return;
        connectedAt = Date.now();
        generationRef.current += 1;
        generation = generationRef.current;
        setPhase("connected");
      });
      socket.addEventListener("message", (event) => {
        if (disposed || socket !== ws) return;
        if (typeof event.data === "string") {
          try {
            const frame = JSON.parse(event.data) as { readonly t?: string };
            if (frame.t === "end") {
              ended = true;
              setPhase("ended");
              onEndRef.current?.();
            }
          } catch {
            // Unknown control frame — ignore.
          }
          return;
        }
        onBinaryRef.current?.(event.data as ArrayBuffer, generation);
      });
      socket.addEventListener("close", (event) => {
        if (disposed || socket !== ws) return;
        ws = null;
        wsRef.current = null;
        // 1008: this account's access was revoked (docs/adr/0003). Retrying cannot succeed.
        if (event.code === 1008) {
          ended = true;
          setPhase("ended");
          onEndRef.current?.();
          return;
        }
        if (ended) return;
        if (connectedAt !== null && Date.now() - connectedAt >= STABLE_AFTER_MS) attempt = 0;
        connectedAt = null;
        const delay = LADDER_MS[Math.min(attempt, LADDER_MS.length - 1)];
        attempt += 1;
        setPhase("reconnecting");
        timer = setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => {
        // close always follows; closing here only makes it prompt.
        socket.close();
      });
    };

    const reconnectNow = () => {
      if (disposed || ended) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      attempt = 0;
      const current = ws;
      ws = null; // detach so its close handler cannot double-schedule
      wsRef.current = null;
      current?.close();
      connect();
    };
    retryNowRef.current = reconnectNow;

    const appState = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") {
        backgroundedAt ??= Date.now();
        return;
      }
      if (state !== "active") return;
      const away = backgroundedAt !== null ? Date.now() - backgroundedAt : 0;
      backgroundedAt = null;
      const open = ws !== null && ws.readyState === WebSocket.OPEN;
      if (!open || away >= BACKGROUND_REPLACE_AFTER_MS) reconnectNow();
    });

    connect();
    return () => {
      disposed = true;
      retryNowRef.current = () => undefined;
      appState.remove();
      if (timer !== null) clearTimeout(timer);
      const current = ws;
      ws = null;
      wsRef.current = null;
      current?.close();
    };
  }, [serverUrl, token, target?.kind, target?.id, enabled]);

  const send = useCallback((data: string): boolean => {
    const socket = wsRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ t: "input", data }));
    return true;
  }, []);
  const resize = useCallback((cols: number, rows: number) => {
    const socket = wsRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ t: "resize", cols, rows }));
  }, []);
  const retryNow = useCallback(() => retryNowRef.current(), []);

  return { phase, canSend: phase === "connected", send, resize, retryNow };
}
