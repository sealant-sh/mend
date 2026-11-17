import { SCREEN_SOCKET_CLOSE, ScreenSocketHello } from "@mend/api-contracts";
import type { ViewerConnectionId } from "@mend/domain";
import type { RfbChannel } from "@novnc/novnc";
import { Option, Schema } from "effect";

/** The part of a browser WebSocket the channel drives; a test hands it a fake. */
export interface ScreenSocket {
  binaryType: BinaryType;
  readonly readyState: number;
  addEventListener(type: "message" | "close" | "error", listener: (event: Event) => void): void;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

const CONNECTING = 0;
const OPEN = 1;

const helloOf = Schema.decodeUnknownOption(Schema.fromJsonString(ScreenSocketHello));

export interface ScreenChannelEvents {
  /** The server named this viewer's connection: Take over sends it. */
  readonly hello: (connection: ViewerConnectionId) => void;
  readonly closed: (close: { readonly code: number; readonly reason: string }) => void;
}

/**
 * `/api/screen-socket` as noVNC's channel. The server's first frame is text naming the viewer's
 * connection; it is read here and never reaches noVNC, which reads only RFB. noVNC sees the
 * channel open once that frame has arrived, so its handshake starts at the server's first RFB byte.
 */
export class ScreenChannel implements RfbChannel {
  binaryType: BinaryType = "arraybuffer";
  readonly protocol = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: ArrayBuffer }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  #named = false;
  readonly #socket: ScreenSocket;

  constructor(socket: ScreenSocket, events: ScreenChannelEvents) {
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (!(event instanceof MessageEvent)) return;
      if (this.#named) {
        if (event.data instanceof ArrayBuffer) this.onmessage?.({ data: event.data });
        return;
      }
      const hello = helloOf(event.data);
      if (Option.isNone(hello)) {
        socket.close(4000, "the screen socket named no connection");
        return;
      }
      this.#named = true;
      events.hello(hello.value.connection);
      this.onopen?.();
    });
    socket.addEventListener("close", (event) => {
      if (!(event instanceof CloseEvent)) return;
      events.closed({ code: event.code, reason: event.reason });
      this.onclose?.(event);
    });
    socket.addEventListener("error", (event) => this.onerror?.(event));
  }

  /** Connecting until the server names the connection, then the socket's own state. */
  get readyState(): number {
    return this.#socket.readyState === OPEN && !this.#named ? CONNECTING : this.#socket.readyState;
  }

  send(data: Uint8Array<ArrayBuffer>): void {
    this.#socket.send(data);
  }

  close(): void {
    this.#socket.close();
  }
}

/** The screen socket for a session, on this page's own origin; the sign-in cookie rides the upgrade. */
export const screenSocketUrl = (sessionId: string, origin: string): string => {
  const url = new URL("/api/screen-socket", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", sessionId);
  return url.toString();
};

const C = SCREEN_SOCKET_CLOSE;

/** Every `SCREEN_SOCKET_CLOSE` code in plain words (screen-socket.test.ts holds it to the list). */
export const SCREEN_CLOSE_WORDS: ReadonlyMap<number, string> = new Map([
  [C.screenEnded, "the screen stopped"],
  [C.accessEnded, "your access to this session ended"],
  [C.frameTooLarge, "this viewer sent a message over Mend's frame limit"],
  [C.screenReset, "the connection to the screen was reset"],
  [C.recheckUnavailable, "Mend could not check your access in time"],
  [C.viewerRefused, "Mend refused this viewer"],
  [C.noScreen, "the session has no live screen"],
  [C.stoppedAnswering, "this viewer stopped answering Mend's pings"],
  [C.fellBehind, "this viewer fell more than 8 MiB behind the screen"],
  [C.unreachable, "Mend could not reach the screen"],
]);

/** Close codes whose reason names a detail worth reading: a refusal, a cause. */
const WITH_REASON: ReadonlySet<number> = new Set([C.viewerRefused, C.unreachable]);

/** Why the screen socket closed, in plain words, from its close code and reason. */
export const screenCloseWords = (close: {
  readonly code: number;
  readonly reason: string;
}): string => {
  const words = SCREEN_CLOSE_WORDS.get(close.code);
  if (words === undefined) {
    return close.code === 1006
      ? "the connection dropped"
      : `closed with code ${close.code}${close.reason === "" ? "" : ` · ${close.reason}`}`;
  }
  return WITH_REASON.has(close.code) && close.reason !== "" ? `${words} · ${close.reason}` : words;
};
