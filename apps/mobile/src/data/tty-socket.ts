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

import { api, ApiError } from "@/data/live";

export type TtyPhase = "idle" | "connecting" | "connected" | "reconnecting" | "ended";

const LADDER_MS = [3_000, 4_000, 8_000, 16_000] as const;

/**
 * What a 404 from the mint means. A server older than tickets has no such route and its `/health`
 * does not mention them: the bearer rides the URL, as it always did with that server. A server
 * that mints them says so, and then the 404 came from something in between: the bearer stays out
 * of URLs that every hop logs, and the connect fails with the reason.
 */
export const legacyBearerAfterMint404 = async (token: string): Promise<string> => {
  const health = await api<{ readonly upgradeTickets?: boolean }>("GET", "/health").catch(
    () => null,
  );
  if (health?.upgradeTickets === true) {
    throw new ApiError(
      "Upgrade tickets answered 404 on a server that mints them: something between this phone and Mend is refusing them.",
      404,
    );
  }
  console.warn("this server predates upgrade tickets: the device token rides the terminal URL");
  return token;
};

/** What rides the socket's URL: a fresh upgrade ticket (or, on a server older than them, the bearer). */
const socketCredential = async (
  target: { readonly kind: "session" | "process"; readonly id: string },
  token: string,
): Promise<{ readonly name: "ticket" | "token"; readonly value: string }> => {
  try {
    const minted = await api<{ readonly ticket: string }>("POST", "/upgrade-tickets", {
      target: "tty",
      [target.kind]: target.id,
    });
    return { name: "ticket", value: minted.ticket };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { name: "token", value: await legacyBearerAfterMint404(token) };
    }
    throw error;
  }
};
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
    /** Bumped per connect, so a ticket that arrives after a newer connect opens nothing. */
    let connectSeq = 0;
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
      // The credential in the URL is an upgrade ticket: single use, thirty seconds, good for this
      // terminal only (docs/adr/0004, "Upgrade tickets"). The device bearer goes to the server in
      // a header, on the mint, and never in a URL that every proxy on the way would log. Tickets
      // are single use, so every connect and reconnect mints one.
      connectSeq += 1;
      const seq = connectSeq;
      void socketCredential(target, token).then(
        (credential) => {
          if (disposed || ended || seq !== connectSeq) return undefined;
          url.searchParams.set(credential.name, credential.value);
          openSocket(url);
          return undefined;
        },
        () => {
          if (disposed || ended || seq !== connectSeq) return;
          retryLater();
        },
      );
    };

    const retryLater = () => {
      if (connectedAt !== null && Date.now() - connectedAt >= STABLE_AFTER_MS) attempt = 0;
      connectedAt = null;
      const delay = LADDER_MS[Math.min(attempt, LADDER_MS.length - 1)];
      attempt += 1;
      setPhase("reconnecting");
      timer = setTimeout(connect, delay);
    };

    const openSocket = (url: URL) => {
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
        retryLater();
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
