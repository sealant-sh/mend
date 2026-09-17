import { FitAddon, init as initGhostty, Terminal } from "ghostty-web";
import { useEffect, useRef, useState } from "react";

import { pasteSessionImage } from "../lib/api.ts";

/**
 * The session's real terminal, live in the browser over the same `/api/tty`
 * WebSocket the CLI uses (plan §8.1.F: every device gets the same path).
 * Interactive: keystrokes go up as binary frames, output renders byte-exact
 * with full scrollback replay. Auth is the session cookie riding the
 * same-origin upgrade — nothing else on the wire, nothing per-keystroke.
 *
 * xterm.js is an imperative widget; the effect owns its whole lifecycle
 * (terminal, fit addon, socket, observers) and tears it all down together.
 */

type WireState = "connecting" | "live" | "reconnecting" | "settled";

/** The image on its way to the session — the one moment the terminal is not the whole story. */
type ImageState =
  | { readonly kind: "uploading"; readonly count: number }
  | { readonly kind: "error"; readonly message: string }
  | null;

const imageFilesOf = (list: FileList | null | undefined): ReadonlyArray<File> =>
  list === null || list === undefined
    ? []
    : Array.from(list).filter((file) => file.type.startsWith("image/"));

/** Files over the terminal: claim the drag so the browser does not navigate to the image. */
const onDragOver = (event: DragEvent) => {
  if (event.dataTransfer?.types.includes("Files") !== true) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
};

/** Base64 without the data-URL prefix; FileReader keeps multi-megabyte pastes off the stack. */
const base64Of = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("could not read the image")),
      { once: true },
    );
    reader.addEventListener(
      "load",
      () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        resolve(url.slice(url.indexOf(",") + 1));
      },
      { once: true },
    );
    reader.readAsDataURL(file);
  });

// The reconnect discipline mirrors the mobile tty hook (patterns from
// t3code's connection supervisor, MIT — pingdotgg/t3code): a fixed ladder,
// reset once the link proves stable, immediate retry on window focus. The
// terminal instance survives reconnects — only the socket is replaced, and
// the screen resets because the server replays the record from 0.
const LADDER_MS = [3_000, 4_000, 8_000, 16_000] as const;
const STABLE_AFTER_MS = 30_000;

/** The exchange refused the ticket this page holds: only the app that embedded it can mint another. */
export class EmbedTicketRefused extends Error {
  constructor(status: number) {
    super(`the terminal ticket was refused (${status})`);
    this.name = "EmbedTicketRefused";
  }
}

/** What the page posts to the app that embeds it when its ticket is refused. */
export const EMBED_EXPIRED_MESSAGE = "mend:embed-expired";

/**
 * Tell the embedding app (a React Native WebView, or a parent frame) that this page can no longer
 * reconnect, so it loads the embed again with a fresh ticket. A page with no such host just keeps
 * its reconnect ladder.
 */
const notifyEmbedExpired = () => {
  const host: unknown = Reflect.get(window, "ReactNativeWebView");
  if (typeof host === "object" && host !== null && "postMessage" in host) {
    const { postMessage } = host;
    if (typeof postMessage === "function") postMessage.call(host, EMBED_EXPIRED_MESSAGE);
  }
  if (window.parent !== window) window.parent.postMessage(EMBED_EXPIRED_MESSAGE, "*");
};

/**
 * The embed page's credential chain (docs/adr/0004, "Upgrade tickets"). The first trade spends the
 * ticket from the page's URL and answers a socket ticket and a renewal ticket; later trades show
 * that renewal, which is kept, so a reply lost on the way back strands nobody. The renewal ticket
 * lives here, in memory, and travels only in a request body. It ends twelve hours after the app
 * minted the URL, or with the sign-in or device that minted it.
 */
export const makeEmbedExchange = (
  embedTicket: string,
  address: { readonly session: string } | { readonly process: string },
  send: typeof fetch = fetch,
) => {
  let current = embedTicket;
  return {
    next: async (): Promise<string> => {
      const response = await send("/api/upgrade-tickets/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: current, ...address }),
      });
      if (response.status === 401) throw new EmbedTicketRefused(response.status);
      if (!response.ok) throw new Error(`the terminal ticket trade failed (${response.status})`);
      const traded: unknown = await response.json();
      if (
        typeof traded !== "object" ||
        traded === null ||
        !("ticket" in traded) ||
        !("renew" in traded) ||
        typeof traded.ticket !== "string" ||
        typeof traded.renew !== "string"
      ) {
        throw new Error("the terminal ticket answer was malformed");
      }
      current = traded.renew;
      return traded.ticket;
    },
  };
};

/** Resolve a CSS custom property so xterm's JS theme follows the app theme. */
const cssVar = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
};

export function SessionTerminal({
  sessionId,
  processId,
  embedTicket,
  token,
}: {
  readonly sessionId: string;
  /** A supporting shell process. Omitted for the session's agent PTY. */
  readonly processId?: string;
  /**
   * For a page that cannot ride the cookie (the mobile WebView): the upgrade ticket from its own
   * URL. The page trades it for the socket's ticket and a renewal ticket it keeps in memory
   * (docs/adr/0004, "Upgrade tickets"), so no bearer reaches a URL.
   */
  readonly embedTicket?: string;
  /** A bearer in the URL, from an app build older than tickets. Read only when there is no ticket. */
  readonly token?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<WireState>("connecting");
  const [image, setImage] = useState<ImageState>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;

    // ghostty-web loads its wasm once; everything below waits on it.
    let cancelled = false;
    let teardown: (() => void) | null = null;
    void initGhostty().then(() => {
      if (cancelled) return null;
      teardown = attach();
      return null;
    });

    const attach = () => {
      const term = new Terminal({
        fontFamily: cssVar("--font-mono", "JetBrains Mono, monospace"),
        fontSize: 12.5,
        cursorBlink: true,
        scrollback: 10_000,
        theme: {
          background: cssVar("--sw-panel", "#ffffff"),
          foreground: cssVar("--sw-ink", "#1b1b1d"),
          cursor: cssVar("--sw-accent", "#2052cc"),
          cursorAccent: cssVar("--sw-panel", "#ffffff"),
          selectionBackground: "rgba(32, 82, 204, 0.18)",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      fit.fit();

      let ws: WebSocket | null = null;
      let timer: number | null = null;
      let attempt = 0;
      let connectedAt: number | null = null;
      let settled = false;
      let disposed = false;
      /** Bumped per connect, so a ticket that arrives after a newer connect opens nothing. */
      let connectSeq = 0;
      const exchange =
        embedTicket === undefined || embedTicket === ""
          ? null
          : makeEmbedExchange(
              embedTicket,
              processId === undefined ? { session: sessionId } : { process: processId },
            );

      const sendResize = () => {
        if (ws !== null && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
        }
      };

      const connect = () => {
        if (disposed || settled) return;
        setState(attempt === 0 ? "connecting" : "reconnecting");
        const url = new URL("/api/tty", window.location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set(
          processId === undefined ? "session" : "process",
          processId ?? sessionId,
        );
        url.searchParams.set("from", "0");
        if (exchange === null) {
          if (token !== undefined && token !== "") url.searchParams.set("token", token);
          open(url);
          return;
        }
        // Tickets are single use, so every connect and reconnect trades for a fresh one.
        connectSeq += 1;
        const seq = connectSeq;
        void exchange.next().then(
          (ticket) => {
            if (disposed || settled || seq !== connectSeq) return null;
            url.searchParams.set("ticket", ticket);
            open(url);
            return null;
          },
          (error: unknown) => {
            if (disposed || settled || seq !== connectSeq) return;
            // A refused ticket will be refused again: the app that embedded this page is asked
            // for a fresh one. The ladder carries on for a host that does not answer.
            if (error instanceof EmbedTicketRefused) notifyEmbedExpired();
            retryLater();
          },
        );
      };

      const retryLater = () => {
        if (connectedAt !== null && Date.now() - connectedAt >= STABLE_AFTER_MS) attempt = 0;
        connectedAt = null;
        const delay = LADDER_MS[Math.min(attempt, LADDER_MS.length - 1)];
        attempt += 1;
        setState("reconnecting");
        timer = window.setTimeout(connect, delay);
      };

      const open = (url: URL) => {
        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        ws = socket;

        socket.addEventListener("open", () => {
          if (disposed || socket !== ws) return;
          connectedAt = Date.now();
          // The server replays from 0 — the screen is replaced, not appended.
          term.reset();
          setState("live");
          sendResize();
          term.focus();
        });
        socket.addEventListener("message", (event) => {
          if (disposed || socket !== ws) return;
          if (typeof event.data === "string") {
            try {
              const frame = JSON.parse(event.data) as { readonly t?: string };
              if (frame.t === "end") {
                settled = true;
                setState("settled");
              }
            } catch {
              // Unknown text frame — ignore.
            }
            return;
          }
          term.write(new Uint8Array(event.data as ArrayBuffer));
        });
        socket.addEventListener("close", () => {
          if (disposed || socket !== ws) return;
          ws = null;
          if (settled) {
            setState("settled");
            return;
          }
          retryLater();
        });
      };

      // Coming back to the tab is the moment the user notices a dead link:
      // skip whatever backoff remains and try immediately.
      const onFocus = () => {
        if (disposed || settled) return;
        if (ws !== null && ws.readyState === WebSocket.OPEN) return;
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        attempt = 0;
        connect();
      };
      window.addEventListener("focus", onFocus);

      const encoder = new TextEncoder();
      const onData = term.onData((data) => {
        if (ws !== null && ws.readyState === WebSocket.OPEN) {
          ws.send(new Uint8Array(encoder.encode(data)).buffer);
        }
      });
      const onResize = term.onResize(() => sendResize());
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(element);
      connect();

      // Images: the TUI's own Ctrl+V reads the clipboard of the container it
      // runs in, which has none — so an image paste or drop goes up to Mend,
      // which stores it beside the session and answers with the workspace
      // path; that path is what the terminal pastes (bracketed, when the app
      // asked for it). Codex attaches a pasted image path as an image; claude
      // reads it. Text pastes are untouched — ghostty-web's own listener keeps
      // them — so this runs in the capture phase and claims only image files.
      const sendImages = async (files: ReadonlyArray<File>) => {
        if (files.length === 0) return;
        setImage({ kind: "uploading", count: files.length });
        try {
          const paths: Array<string> = [];
          for (const file of files) {
            const stored = await pasteSessionImage(sessionId, await base64Of(file));
            paths.push(stored.path);
          }
          if (disposed) return;
          term.paste(paths.join(" "));
          setImage(null);
        } catch (error) {
          if (disposed) return;
          setImage({
            kind: "error",
            message: error instanceof Error ? error.message : "the image was not stored",
          });
        }
        term.focus();
      };
      const onPaste = (event: ClipboardEvent) => {
        const files = imageFilesOf(event.clipboardData?.files);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void sendImages(files);
      };
      const onDrop = (event: DragEvent) => {
        const files = imageFilesOf(event.dataTransfer?.files);
        if (files.length === 0) return;
        event.preventDefault();
        void sendImages(files);
      };
      element.addEventListener("paste", onPaste, { capture: true });
      element.addEventListener("dragover", onDragOver);
      element.addEventListener("drop", onDrop);

      return () => {
        disposed = true;
        element.removeEventListener("paste", onPaste, { capture: true });
        element.removeEventListener("dragover", onDragOver);
        element.removeEventListener("drop", onDrop);
        window.removeEventListener("focus", onFocus);
        if (timer !== null) window.clearTimeout(timer);
        observer.disconnect();
        onData.dispose();
        onResize.dispose();
        ws?.close();
        term.dispose();
      };
    };

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [sessionId, processId, embedTicket, token]);

  return (
    <div>
      <div ref={containerRef} className="h-[480px] w-full px-3 py-2" />
      {state !== "live" && (
        <p className="border-t border-rule-faint px-4 py-2 font-mono text-[11.5px] text-faint">
          {state === "connecting" && "connecting…"}
          {state === "settled" && "session settled — the terminal is closed; the record remains"}
          {state === "reconnecting" && "connection lost — reconnecting automatically"}
        </p>
      )}
      {image !== null && (
        <p
          className={`border-t border-rule-faint px-4 py-2 font-mono text-[11.5px] ${image.kind === "error" ? "text-danger" : "text-faint"}`}
        >
          {image.kind === "uploading" &&
            (image.count === 1 ? "image · storing…" : `${image.count} images · storing…`)}
          {image.kind === "error" && `image · not pasted — ${image.message}`}
        </p>
      )}
    </div>
  );
}
