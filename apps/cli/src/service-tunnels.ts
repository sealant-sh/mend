import * as net from "node:net";

import { createSseParser } from "./workbench-events.ts";

/**
 * Attach tunnels (docs/SESSION-SERVICES.md): while this CLI is attached to a session on a
 * server that is not this machine, every live TCP Service of that session a browser opens is
 * bound on this machine's loopback and pumped over the authenticated `service-tunnel` socket —
 * the same data plane `mend service connect` uses, opened without being asked. The tunnels
 * follow the session's Services: a Service that stops closes its tunnel, and detaching closes
 * them all. The Service itself is never stopped from here.
 *
 * Transport-free core: the caller hands in how to list Services, how to mint a tunnel URL, and
 * where server events come from, so tests drive it with fakes.
 */

/** The facts a tunnel needs about one Service — a subset of the CLI's ServiceDto. */
export interface TunnelService {
  readonly id: string;
  readonly sessionId: string;
  readonly label: string;
  readonly protocol: "tcp" | "udp";
  readonly browserScheme: "http" | "https" | null;
  readonly workspacePort: number;
}

export interface OpenTunnel {
  readonly service: TunnelService;
  /** The loopback port on this machine. */
  readonly port: number;
  /** `web → http://localhost:5173` */
  readonly line: string;
}

/** Which of a session's live Services an attach tunnels: TCP ones meant for a browser. */
export const attachTunnelTargets = (
  services: ReadonlyArray<TunnelService>,
  sessionId: string,
): ReadonlyArray<TunnelService> =>
  services.filter(
    (service) =>
      service.sessionId === sessionId &&
      service.protocol === "tcp" &&
      service.browserScheme !== null,
  );

export const tunnelLine = (service: TunnelService, port: number): string =>
  `${service.label} → ${service.browserScheme ?? "tcp"}://localhost:${port}`;

/** An event payload that can change one session's Services (or end the session). */
export const touchesSessionServices = (payload: string, sessionId: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const type = "type" in parsed ? parsed.type : undefined;
  const session = "sessionId" in parsed ? parsed.sessionId : undefined;
  return (type === "session-process" || type === "session") && session === sessionId;
};

/**
 * Pump one accepted local connection over a tunnel socket: local bytes are held until the socket
 * opens, binary frames both ways, a `{t:"eof"}` text frame for a half-close. No URL (the ticket
 * was refused) ends the local connection the way a refused one would.
 */
export const pumpConnection = (socket: net.Socket, url: Promise<URL>): void => {
  // Hold local bytes until the tunnel is open; loopback buffers are tiny.
  socket.pause();
  void url.then(
    (target) => {
      if (socket.destroyed) return null;
      const ws = new WebSocket(target);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("open", () => socket.resume(), { once: true });
      ws.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (event.data instanceof ArrayBuffer) socket.write(Buffer.from(event.data));
      });
      ws.addEventListener("close", () => socket.end(), { once: true });
      ws.addEventListener("error", () => socket.destroy(), { once: true });
      // Copy per chunk: the WS client wants an ArrayBuffer-backed view, and
      // Buffer pools share their backing store.
      socket.on("data", (chunk: Buffer) => ws.send(new Uint8Array(chunk)));
      socket.on("end", () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "eof" }));
      });
      socket.on("close", () => ws.close());
      socket.on("error", () => ws.close());
      return null;
    },
    () => socket.destroy(),
  );
};

/**
 * Bind `127.0.0.1:<port>`. With `fallback`, a port this machine cannot give (taken, privileged)
 * becomes an ephemeral one instead of a failure. Resolves with the bound port.
 */
export const listenLocal = (server: net.Server, port: number, fallback: boolean): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const attempt = (candidate: number, lastTry: boolean): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        if (!lastTry) {
          attempt(0, true);
          return;
        }
        reject(error);
      };
      server.once("error", onError);
      server.listen(candidate, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : candidate);
      });
    };
    attempt(port, !fallback || port === 0);
  });

/** Where server events come from: one payload at a time, and a mark after every reconnect. */
export type ServerEvents = (
  handlers: { readonly onPayload: (payload: string) => void; readonly onReconnect: () => void },
  signal: AbortSignal,
) => Promise<void>;

/** `/api/events` (the SSE stream the web and the dashboard read), reconnecting until aborted. */
export const serverEvents =
  (config: { readonly url: string; readonly token: string | null }): ServerEvents =>
  async (handlers, signal) => {
    let connected = false;
    while (!signal.aborted) {
      try {
        const headers: Record<string, string> = {};
        if (config.token !== null) headers["authorization"] = `Bearer ${config.token}`;
        const response = await fetch(`${config.url}/api/events`, { headers, signal });
        if (!response.ok || response.body === null) throw new Error(String(response.status));
        // A dropped stream may have swallowed events: say so once it is back.
        if (connected) handlers.onReconnect();
        connected = true;
        const reader = response.body.getReader();
        const parser = createSseParser();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
            handlers.onPayload(payload);
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      connected = true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };

export type CloseReason = "stopped" | "unfocused" | "closed";

export interface ServiceTunnelsOptions {
  /** Every live Service the caller can see; the tunnels filter to the focused session. */
  readonly listServices: () => Promise<ReadonlyArray<TunnelService>>;
  /** A fresh single-use tunnel URL for one connection to one Service. */
  readonly tunnelUrl: (serviceId: string) => Promise<URL>;
  readonly events: ServerEvents;
  readonly onOpen?: (tunnel: OpenTunnel) => void;
  /**
   * `stopped`: the Service is no longer live. `unfocused`: the caller moved to another session.
   * `closed`: the caller closed every tunnel (a detach).
   */
  readonly onClose?: (tunnel: OpenTunnel, reason: CloseReason) => void;
  readonly onError?: (service: TunnelService, message: string) => void;
  /** The safety-net re-read beside the event stream. Default 20 s. */
  readonly pollMs?: number;
  /** How long a burst of events is gathered into one re-read. Default 250 ms. */
  readonly settleMs?: number;
}

export interface ServiceTunnels {
  /** Tunnel this session's browser Services (null: none). Resolves after the first pass. */
  readonly focus: (sessionId: string | null) => Promise<void>;
  /** Re-read the Services now (also what events and the poll do). */
  readonly refresh: () => Promise<void>;
  /** A stable snapshot: the same array until a tunnel opens or closes. */
  readonly current: () => ReadonlyArray<OpenTunnel>;
  readonly subscribe: (listener: () => void) => () => void;
  /** Close every tunnel and stop listening. Idempotent. */
  readonly close: () => void;
}

interface Entry {
  readonly tunnel: OpenTunnel;
  readonly server: net.Server;
  readonly sockets: Set<net.Socket>;
}

export const createServiceTunnels = (options: ServiceTunnelsOptions): ServiceTunnels => {
  const open = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const controller = new AbortController();
  let focused: string | null = null;
  let snapshot: ReadonlyArray<OpenTunnel> = [];
  let closed = false;
  let running: Promise<void> | null = null;
  let again = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let watching = false;

  const changed = (): void => {
    snapshot = [...open.values()].map((entry) => entry.tunnel);
    for (const listener of listeners) listener();
  };

  const shut = (id: string, reason: CloseReason): void => {
    const entry = open.get(id);
    if (entry === undefined) return;
    open.delete(id);
    entry.server.close();
    for (const socket of entry.sockets) socket.destroy();
    options.onClose?.(entry.tunnel, reason);
  };

  const openFor = async (service: TunnelService): Promise<void> => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      pumpConnection(socket, options.tunnelUrl(service.id));
    });
    let port: number;
    try {
      port = await listenLocal(server, service.workspacePort, true);
    } catch (error) {
      options.onError?.(service, error instanceof Error ? error.message : String(error));
      return;
    }
    if (closed || focused !== service.sessionId) {
      server.close();
      return;
    }
    const tunnel = { service, port, line: tunnelLine(service, port) };
    open.set(service.id, { tunnel, server, sockets });
    options.onOpen?.(tunnel);
  };

  const pass = async (): Promise<void> => {
    const session = focused;
    let wanted: ReadonlyArray<TunnelService> = [];
    if (session !== null) {
      try {
        wanted = attachTunnelTargets(await options.listServices(), session);
      } catch {
        // An unreadable list changes nothing: the tunnels already open stay open.
        return;
      }
    }
    if (closed || session !== focused) return;
    const wantedIds = new Set(wanted.map((service) => service.id));
    let moved = false;
    for (const [id, entry] of open) {
      if (!wantedIds.has(id)) {
        shut(id, entry.tunnel.service.sessionId === session ? "stopped" : "unfocused");
        moved = true;
      }
    }
    for (const service of wanted) {
      if (open.has(service.id)) continue;
      await openFor(service);
      moved = true;
    }
    if (moved) changed();
  };

  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      for (;;) {
        again = false;
        await pass();
        // An event that landed during the pass asked for one more.
        if (!again || closed) return;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const scheduleRefresh = (): void => {
    if (closed || settleTimer !== null) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void refresh();
    }, options.settleMs ?? 250);
  };

  const watch = (): void => {
    if (watching) return;
    watching = true;
    void options.events(
      {
        onPayload: (payload) => {
          if (focused !== null && touchesSessionServices(payload, focused)) scheduleRefresh();
        },
        onReconnect: scheduleRefresh,
      },
      controller.signal,
    );
    pollTimer = setInterval(() => void refresh(), options.pollMs ?? 20_000);
    // The poll must never be what keeps a finished CLI alive.
    pollTimer.unref?.();
  };

  return {
    focus: (sessionId) => {
      if (closed) return Promise.resolve();
      focused = sessionId;
      if (sessionId !== null) watch();
      return refresh();
    },
    refresh,
    current: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      controller.abort();
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
      // Deleting the current entry while iterating a Map is defined: iteration continues.
      for (const id of open.keys()) shut(id, "closed");
      changed();
      listeners.clear();
    },
  };
};
