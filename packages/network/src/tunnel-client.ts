import * as net from "node:net";

/**
 * WHATWG WebSockets have no drain event, so a paused connection checks again every
 * `HELD_RETRY_MS`.
 */
const SEND_HIGH_WATER_BYTES = 1024 * 1024;
const HELD_RETRY_MS = 10;

export interface TunnelClientOptions {
  /** Hears the server's close when it is not the workspace's clean end (`4404`, `not-found`). */
  readonly onClosed?: (code: number, reason: string) => void;
}

/**
 * Pump one accepted local connection over a tunnel socket: local bytes are held until the socket
 * opens, binary frames both ways, a `{t:"eof"}` text frame for a half-close. The local connection
 * is paused while the socket holds more than `SEND_HIGH_WATER_BYTES` unsent, so a server that is
 * not reading holds the local client back instead of growing this process. The server's close 1000
 * is the workspace's FIN, after every byte; any other close (a reset, a refused dial) resets the
 * local connection, so a cut-short answer never reads as a whole one. No URL (the ticket was
 * refused), or a socket that never opens, ends the local connection the way a refused one would.
 * The listener must be half-open (`tunnelListener`), or the answer after the client's FIN is lost.
 */
export const pumpConnection = (
  socket: net.Socket,
  url: Promise<URL>,
  options: TunnelClientOptions = {},
): void => {
  // Hold local bytes until the tunnel is open; loopback buffers are tiny.
  socket.pause();
  // A peer that resets is an ordinary close: the 'close' that follows shuts its tunnel. Without
  // a listener the reset is an uncaught exception, and it can land while the ticket is minted.
  socket.on("error", () => {});
  void url.then(
    (target) => {
      if (socket.destroyed) return null;
      const ws = new WebSocket(target);
      ws.binaryType = "arraybuffer";
      let opened = false;
      let held: NodeJS.Timeout | null = null;
      const resumeOnceSent = (): void => {
        if (socket.destroyed) {
          held = null;
          return;
        }
        if (ws.bufferedAmount > SEND_HIGH_WATER_BYTES) {
          held = setTimeout(resumeOnceSent, HELD_RETRY_MS);
          return;
        }
        held = null;
        socket.resume();
      };
      ws.addEventListener(
        "open",
        () => {
          opened = true;
          socket.resume();
        },
        { once: true },
      );
      ws.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (event.data instanceof ArrayBuffer) socket.write(Buffer.from(event.data));
      });
      ws.addEventListener(
        "close",
        (event) => {
          if (held !== null) clearTimeout(held);
          if (event.code === 1000) {
            socket.end();
            return;
          }
          if (opened) options.onClosed?.(event.code, event.reason);
          if (!socket.destroyed) socket.resetAndDestroy();
        },
        { once: true },
      );
      // Before it opened (the ticket or the handshake refused), the local connection just ends.
      ws.addEventListener(
        "error",
        () => {
          if (socket.destroyed) return;
          if (opened) socket.resetAndDestroy();
          else socket.destroy();
        },
        { once: true },
      );
      socket.on("data", (chunk: Buffer) => {
        // Copy per chunk: the WS client wants an ArrayBuffer-backed view, and Buffer pools share
        // their backing store.
        ws.send(new Uint8Array(chunk));
        if (held === null && ws.bufferedAmount > SEND_HIGH_WATER_BYTES) {
          socket.pause();
          held = setTimeout(resumeOnceSent, HELD_RETRY_MS);
        }
      });
      socket.on("end", () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "eof" }));
      });
      socket.on("close", () => ws.close());
      return null;
    },
    () => socket.destroy(),
  );
};

/**
 * The local listener of one tunnel: each accepted connection is pumped over its own tunnel socket,
 * at a URL minted for it. Half-open, so a client's FIN goes through as one and the answer after it
 * still arrives.
 */
export const tunnelListener = (
  tunnelUrl: () => Promise<URL>,
  options: TunnelClientOptions & { readonly onConnection?: (socket: net.Socket) => void } = {},
): net.Server =>
  net.createServer({ allowHalfOpen: true }, (socket) => {
    options.onConnection?.(socket);
    pumpConnection(socket, tunnelUrl(), options);
  });
