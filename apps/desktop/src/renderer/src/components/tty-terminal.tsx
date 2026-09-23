import { useEffect, useRef, useState } from "react";

import { pasteSessionImage } from "#/lib/api";
import { useTerminalFont, type TerminalFontSetting } from "#/lib/terminal-font";
import { afterUnopenedClose, type PtyLiveness } from "#/lib/tty-attach";
import type { GhosttyTheme } from "#/terminal/ghostty/core";
import {
  GhosttyTerminalSurface,
  type GhosttyTerminalSurfaceOptions,
} from "#/terminal/ghostty/surface";

import type { TtyTarget } from "../../../shared/bridge";

/**
 * A PTY in a tab: the session's (or a shell process's) platform terminal over
 * the same `/api/tty` WebSocket the CLI uses — byte-exact output with full
 * replay from `from`, keystrokes up as binary frames. Main mints the URL (it
 * holds the bearer); this component owns the socket.
 *
 * The terminal itself is the vendored t3code adapter around the official
 * libghostty-vt wasm (see #/terminal/ghostty): it loads its fonts before
 * measuring the cell, paints the theme before the wasm lands, blinks the
 * cursor only while focused, and owns input/IME/selection/links/scrollback.
 * One effect owns the surface + socket lifecycle and tears both down
 * together. Reconnects ride the CLI's ladder; the surface survives a
 * reconnect — the server replays the record from `from`, so the screen is
 * reset and rebuilt, not appended.
 *
 * An upgrade the server refused looks like a network drop from here (close
 * 1006 either way), so before climbing the ladder the terminal asks `probe`
 * whether the PTY's process still runs (#/lib/tty-attach). An ended process
 * stops the ladder: there is no PTY to come back to.
 */

export type WireState = "connecting" | "live" | "reconnecting" | "settled" | "refused";

const LADDER_MS = [3_000, 4_000, 8_000, 16_000] as const;
const STABLE_AFTER_MS = 30_000;

// The terminal motif — dark in both themes (styles.css): the record is the
// same bytes day or night. Cobalt cursor; ANSI palette is ghostty's default.
export const TERMINAL_THEME: GhosttyTheme = {
  background: { r: 0x1e, g: 0x1e, b: 0x21 },
  foreground: { r: 0xcb, g: 0xc8, b: 0xc1 },
  cursor: { r: 0x57, g: 0x81, b: 0xea },
  selectionBackground: "rgba(87, 129, 234, 0.28)",
};

/** The image on its way to the session — the one moment the terminal is not the whole story. */
type ImageState =
  | { readonly kind: "uploading"; readonly count: number }
  | { readonly kind: "error"; readonly message: string }
  | null;

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

export function TtyTerminal({
  target,
  sessionId,
  from = "0",
  focus = false,
  focusRequest = 0,
  probe,
  onState,
}: {
  readonly target: TtyTarget;
  /**
   * The session this PTY belongs to (a shell's too): a pasted image is stored
   * beside it and its workspace path pasted. Omitted, images are not accepted.
   */
  readonly sessionId?: string;
  /** Record sequence to replay from; changing it reconnects. */
  readonly from?: string;
  readonly focus?: boolean;
  /** Increment to return keyboard focus without remounting or resetting the terminal. */
  readonly focusRequest?: number;
  /**
   * Whether the PTY's process still runs, asked after an upgrade that never opened. Omitted,
   * every such close reconnects.
   */
  readonly probe?: () => Promise<PtyLiveness>;
  readonly onState?: (state: WireState) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<GhosttyTerminalSurface | null>(null);
  const font = useTerminalFont();
  const [state, setState] = useState<WireState>("connecting");
  const [image, setImage] = useState<ImageState>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const probeRef = useRef(probe);
  probeRef.current = probe;
  const fontRef = useRef<TerminalFontSetting>(font);
  fontRef.current = font;

  // Font changes apply live: the surface re-measures the cell, refits the
  // grid, and onResize carries the new cols/rows to the PTY.
  useEffect(() => {
    void surfaceRef.current?.setFont(font);
  }, [font]);

  useEffect(() => {
    if (focusRequest > 0) surfaceRef.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const report = (next: WireState) => {
      setState(next);
      onStateRef.current?.(next);
    };

    let surface: GhosttyTerminalSurface | null = null;
    let ws: WebSocket | null = null;
    let timer: number | null = null;
    let attempt = 0;
    let connectedAt: number | null = null;
    let settled = false;
    let disposed = false;

    const sendResize = (cols: number, rows: number) => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "resize", cols, rows }));
      }
    };

    const reconnectLater = () => {
      if (connectedAt !== null && Date.now() - connectedAt >= STABLE_AFTER_MS) attempt = 0;
      connectedAt = null;
      const delay = LADDER_MS[Math.min(attempt, LADDER_MS.length - 1)];
      attempt += 1;
      report("reconnecting");
      timer = window.setTimeout(() => void connect(), delay);
    };

    // The attach failed before a byte flowed: ask the server what the PTY's process is doing.
    const afterFailedAttach = async () => {
      const ask = probeRef.current;
      const liveness: PtyLiveness =
        ask === undefined ? "unknown" : await ask().catch(() => "unknown" as const);
      if (disposed || settled) return;
      const verdict = afterUnopenedClose(liveness);
      if (verdict === "ended") {
        settled = true;
        report("settled");
        return;
      }
      if (verdict === "refused") {
        report("refused");
        return;
      }
      reconnectLater();
    };

    const connect = async () => {
      if (disposed || settled || surface === null) return;
      report(attempt === 0 ? "connecting" : "reconnecting");
      let url: string;
      try {
        url = await window.mend.tty.url(target, from);
      } catch {
        // The ticket mint failed: the same question as a refused upgrade.
        if (!disposed) void afterFailedAttach();
        return;
      }
      if (disposed) return;
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      ws = socket;
      let opened = false;

      socket.addEventListener("open", () => {
        if (disposed || socket !== ws || surface === null) return;
        opened = true;
        connectedAt = Date.now();
        // The server replays from `from` — the screen is replaced, not appended.
        surface.resetAndWrite("");
        report("live");
        sendResize(surface.cols, surface.rows);
      });
      socket.addEventListener("message", (event) => {
        if (disposed || socket !== ws || surface === null) return;
        if (typeof event.data === "string") {
          try {
            const frame: unknown = JSON.parse(event.data);
            if (
              typeof frame === "object" &&
              frame !== null &&
              (frame as { readonly t?: unknown }).t === "end"
            ) {
              settled = true;
              report("settled");
            }
          } catch {
            // Unknown text frame — ignore.
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) surface.write(new Uint8Array(event.data));
      });
      socket.addEventListener("close", () => {
        if (disposed || socket !== ws) return;
        ws = null;
        if (settled) {
          report("settled");
          return;
        }
        if (!opened) {
          void afterFailedAttach();
          return;
        }
        reconnectLater();
      });
    };

    // Coming back to the window is the moment the user notices a dead
    // link: skip whatever backoff remains and try immediately.
    const onFocus = () => {
      if (disposed || settled) return;
      if (ws !== null && ws.readyState === WebSocket.OPEN) return;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      attempt = 0;
      void connect();
    };
    window.addEventListener("focus", onFocus);

    const encoder = new TextEncoder();
    const options: GhosttyTerminalSurfaceOptions = {
      theme: TERMINAL_THEME,
      font: fontRef.current,
      onData: (data) => {
        if (ws !== null && ws.readyState === WebSocket.OPEN) {
          ws.send(encoder.encode(data).buffer as ArrayBuffer);
        }
      },
      onResize: (cols, rows) => sendResize(cols, rows),
      onSelectionChange: () => {},
      // The app's window-level capture bindings (lib/keys.ts) preventDefault
      // before the surface sees the key; everything else goes to the PTY.
      beforeKey: (event) => !event.defaultPrevented,
      onLinkActivate: (text) => {
        void window.mend.shell.openExternal(text);
      },
      // Images: the TUI's Ctrl+V reads the clipboard of the container it runs
      // in, which has none. Mend stores the bytes beside the session and
      // answers with the workspace path; that path is pasted like any text
      // (bracketed, when the app asked for it). Codex attaches a pasted image
      // path as an image; claude reads it.
      ...(sessionId === undefined
        ? {}
        : {
            onImageFiles: (files: ReadonlyArray<File>) => {
              void (async () => {
                setImage({ kind: "uploading", count: files.length });
                try {
                  const paths: Array<string> = [];
                  for (const file of files) {
                    const stored = await pasteSessionImage(sessionId, await base64Of(file));
                    paths.push(stored.path);
                  }
                  if (disposed) return;
                  const joined = paths.join(" ");
                  await surface?.pasteFromClipboard(() => Promise.resolve(joined));
                  setImage(null);
                } catch (error) {
                  if (disposed) return;
                  setImage({
                    kind: "error",
                    message: error instanceof Error ? error.message : "the image was not stored",
                  });
                }
                surface?.focus();
              })();
            },
          }),
    };

    void GhosttyTerminalSurface.create(host, options).then(
      (created) => {
        if (disposed) {
          created.dispose();
          return null;
        }
        surface = created;
        surfaceRef.current = created;
        // The font may have changed while the wasm was loading.
        void created.setFont(fontRef.current);
        if (focus) created.focus();
        void connect();
        return null;
      },
      () => {
        report("refused");
        return null;
      },
    );

    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      if (timer !== null) window.clearTimeout(timer);
      ws?.close();
      surface?.dispose();
      if (surfaceRef.current === surface) surfaceRef.current = null;
      // The surface removes its own children on dispose; sweep anyway so a
      // failed create can never strand a half-mounted canvas.
      host.replaceChildren();
    };
    // `focus` only matters at mount; re-running for it would reset the screen.
  }, [target.kind, target.id, sessionId, from]);

  return (
    <div className="relative h-full w-full bg-term">
      <div ref={hostRef} className="tty-host" />
      {state !== "live" && (
        <p className="pointer-events-none absolute right-3 bottom-2 font-mono text-[11.5px] text-term-faint">
          {state === "connecting" && "connecting…"}
          {state === "reconnecting" && "reconnecting…"}
          {state === "settled" && "exited · observed"}
          {state === "refused" && "no terminal — the server refused the attach"}
        </p>
      )}
      {image !== null && (
        <p
          className={`pointer-events-none absolute bottom-2 left-3 font-mono text-[11.5px] ${image.kind === "error" ? "text-term-red" : "text-term-faint"}`}
        >
          {image.kind === "uploading" &&
            (image.count === 1 ? "image · storing…" : `${image.count} images · storing…`)}
          {image.kind === "error" && `image · not pasted — ${image.message}`}
        </p>
      )}
    </div>
  );
}
