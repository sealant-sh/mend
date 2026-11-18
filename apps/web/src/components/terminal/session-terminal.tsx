import { type AgentStartingFacts, agentStartingLine } from "@mend/domain/workbench";
import { cn } from "@mend/ui/lib/utils";
import { FitAddon, init as initGhostty, type ITheme, LinkDetector, Terminal } from "ghostty-web";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";

import { EmbedTicketRefused, makeEmbedExchange, notifyEmbedExpired } from "#/lib/embed-exchange";
import { OWN_SHORTCUTS } from "#/lib/search-keys";
import { linksOnRow } from "#/lib/terminal-links";

/**
 * A live terminal in the browser over the same `/api/tty` WebSocket the CLI uses: a session's own
 * terminal, or one of its workspace's shells. Keys go up as binary frames; output renders
 * byte-exact, and every connect replays the record from its first byte, so a reconnect redraws
 * the whole scrollback. The page's sign-in cookie rides the upgrade; a page that has none (the
 * phone's WebView) trades an upgrade ticket instead.
 *
 * The renderer is ghostty-web: xterm.js's API over Ghostty's own parser, compiled to wasm, the
 * same parser the phone's native terminal runs. The effect owns its whole life (the terminal, its
 * fit, the socket, the observers) and tears it all down together.
 */

type WireState = "connecting" | "live" | "reconnecting" | "settled";

/** An image on its way to the session: the one moment the terminal is not the whole story. */
type ImageState =
  | { readonly kind: "uploading"; readonly count: number }
  | { readonly kind: "error"; readonly message: string }
  | null;

/** What the view around a terminal can ask of it. */
export interface TerminalControls {
  /** The selected text, or everything the terminal holds when nothing is selected. */
  readonly text: () => string;
  /** Empties the screen and its scrollback here; the shell itself is untouched. */
  readonly clear: () => void;
  readonly focus: () => void;
}

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

// The reconnect ladder mirrors the phone's tty hook (from t3code's connection supervisor, MIT,
// pingdotgg/t3code): fixed steps, reset once the link proves stable, an immediate retry on window
// focus. The terminal survives reconnects; only the socket is replaced.
const LADDER_MS = [3_000, 4_000, 8_000, 16_000] as const;
const STABLE_AFTER_MS = 30_000;

/**
 * How long an open terminal may show nothing before it says the agent is starting: a replay of an
 * agent that already drew arrives well inside it, so a reattach never flashes the line.
 */
const STARTING_GRACE_MS = 400;

/** A token's value as the element sees it (light or dark), or null when the page has none. */
const tokenOf = (element: Element, name: string): string | null => {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value === "" ? null : value;
};

/**
 * The terminal's colours from the kit's tokens: the muted panel, the page's ink, and the status
 * colours for the ANSI ones a prompt and a test run use most. Read once as the terminal opens;
 * ghostty-web can't change its theme after that, so a theme switch opens a new terminal. A colour
 * the page doesn't define is left to ghostty-web.
 */
const themeOf = (element: Element): ITheme => {
  const pairs: ReadonlyArray<readonly [keyof ITheme, string]> = [
    ["background", "--muted"],
    ["foreground", "--foreground"],
    ["cursor", "--foreground"],
    ["cursorAccent", "--muted"],
    ["selectionBackground", "--selection"],
    ["selectionForeground", "--foreground"],
    ["black", "--muted-foreground"],
    ["brightBlack", "--muted-foreground"],
    ["red", "--destructive"],
    ["brightRed", "--destructive"],
    ["green", "--success"],
    ["brightGreen", "--success"],
    ["yellow", "--warning"],
    ["brightYellow", "--warning"],
    ["blue", "--info"],
    ["brightBlue", "--info"],
    ["magenta", "--pr-merged"],
    ["brightMagenta", "--pr-merged"],
    ["cyan", "--info"],
    ["brightCyan", "--info"],
    ["white", "--foreground-2"],
    ["brightWhite", "--foreground"],
  ];
  const theme: ITheme = {};
  for (const [key, token] of pairs) {
    const value = tokenOf(element, token);
    if (value !== null) Reflect.set(theme, key, value);
  }
  return theme;
};

/**
 * The terminal's font: the kit's mono face (Geist Mono) at the control size, waited for, so the
 * canvas measures the face it draws with. "This device"'s terminal font setting (route PR 37) will
 * be read here.
 */
const fontOf = async (element: Element) => {
  const family = tokenOf(element, "--font-mono") ?? "monospace";
  const size = Number.parseFloat(tokenOf(element, "--text-control") ?? "") || 13;
  await document.fonts.load(`${size}px ${family}`).catch(() => undefined);
  return { family, size };
};

/** A line under the terminal: connecting, the agent starting, an image on its way. */
const LINE = "border-t px-3 py-1.5 font-mono text-2xs text-muted-foreground";

/** Everything the terminal holds, top of the scrollback first, trailing blanks dropped. */
const allText = (term: Terminal): string => {
  const buffer = term.buffer.active;
  const lines: Array<string> = [];
  for (let y = 0; y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
};

export function SessionTerminal({
  sessionId,
  processId,
  embedTicket,
  token,
  startingLabel = "the agent",
  starting,
  readOnly = false,
  pasteImage,
  controls,
  autoFocus = false,
  className,
}: {
  readonly sessionId: string;
  /** A shell of the workspace. Omitted for the session's own terminal. */
  readonly processId?: string;
  /**
   * For a page that cannot ride the cookie (the phone's WebView): the upgrade ticket from its own
   * URL. The page trades it for the socket's ticket and a renewal ticket it keeps in memory
   * (docs/adr/0004, "Upgrade tickets"), so no bearer reaches a URL.
   */
  readonly embedTicket?: string;
  /** A bearer in the URL, from a phone build older than tickets. Read only when there is no ticket. */
  readonly token?: string;
  /**
   * Who the line under the terminal says is starting while the agent has drawn nothing yet
   * (`agentStartingLine`): on a fresh machine its first screen can take most of a minute, and a
   * blank terminal reads as broken.
   */
  readonly startingLabel?: string;
  /** When the agent started and on what machine; the line counts from the socket's open without it. */
  readonly starting?: AgentStartingFacts;
  /**
   * Output only: no keys, resizes or images go up. Someone other than the session's owner watches
   * its terminals this way, and the server drops their input anyway (docs/adr/0013).
   */
  readonly readOnly?: boolean;
  /**
   * Stores a pasted or dropped image beside the session and answers its path in the workspace,
   * which the terminal pastes. Without it, images are left to the browser.
   */
  readonly pasteImage?: (contentsBase64: string) => Promise<string>;
  readonly controls?: Ref<TerminalControls>;
  /** Takes the keyboard once connected: the phone's page, where the terminal is all there is. */
  readonly autoFocus?: boolean;
  readonly className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [state, setState] = useState<WireState>("connecting");
  // The agent's terminal while it has drawn nothing: since when, and the clock the line reads.
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [image, setImage] = useState<ImageState>(null);
  // The effect reads the latest paste without opening a new terminal when it changes.
  const pasteRef = useRef(pasteImage);
  pasteRef.current = pasteImage;

  useImperativeHandle(
    controls,
    () => ({
      text: () => {
        const term = termRef.current;
        if (term === null) return "";
        return term.hasSelection() ? term.getSelection() : allText(term);
      },
      clear: () => termRef.current?.clear(),
      focus: () => termRef.current?.focus(),
    }),
    [],
  );

  // The terminal is an imperative widget: an effect opens it and its socket, and closes both.
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;

    // ghostty-web loads its wasm once; everything below waits on it and on the font.
    let cancelled = false;
    let teardown: (() => void) | null = null;
    void Promise.all([initGhostty(), fontOf(element)]).then(([, font]) => {
      if (cancelled) return null;
      teardown = attach(font);
      return null;
    });

    const attach = (font: { readonly family: string; readonly size: number }) => {
      const term = new Terminal({
        fontFamily: font.family,
        fontSize: font.size,
        cursorBlink: !readOnly,
        disableStdin: readOnly,
        scrollback: 10_000,
        theme: themeOf(element),
      });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      /** Fits the grid to the box, unless the box is out of the page (a hidden or moving tab). */
      const refit = () => {
        if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
      };
      refit();
      const links = new LinkDetector(term);
      links.registerProvider({
        provideLinks: (y, callback) => {
          const found = linksOnRow(y, (row) => term.buffer.active.getLine(row));
          callback(
            found.length === 0
              ? undefined
              : found.map(({ url, range }) => ({
                  text: url,
                  range,
                  activate: (event) => {
                    if (event.ctrlKey || event.metaKey) {
                      window.open(url, "_blank", "noopener,noreferrer");
                    }
                  },
                })),
          );
        },
      });
      // ghostty-web 0.4.0 reads no OSC 8 URI and has no way to remove its one-row URL provider,
      // whose cut-off link wins on a wrapped URL; a detector holding only ours replaces its own.
      Reflect.set(term, "linkDetector", links);

      let ws: WebSocket | null = null;
      let timer: number | null = null;
      let drawn = false;
      // Only a session's own terminal says its agent is starting; a shell draws its prompt at once.
      const ticker =
        processId === undefined
          ? window.setInterval(() => {
              if (!drawn) setNow(Date.now());
            }, 500)
          : null;
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
        if (readOnly) return;
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
          // The server replays from 0: the screen is replaced, not appended.
          term.reset();
          drawn = false;
          if (processId === undefined) {
            setWaitingSince(Date.now());
            setNow(Date.now());
          }
          setState("live");
          refit();
          sendResize();
          if (autoFocus && !readOnly) term.focus();
        });
        socket.addEventListener("message", (event) => {
          if (disposed || socket !== ws) return;
          if (typeof event.data === "string") {
            try {
              const frame: unknown = JSON.parse(event.data);
              if (
                typeof frame === "object" &&
                frame !== null &&
                "t" in frame &&
                frame.t === "end"
              ) {
                settled = true;
                setState("settled");
              }
            } catch {
              // An unknown text frame: nothing to do.
            }
            return;
          }
          if (!(event.data instanceof ArrayBuffer)) return;
          const bytes = new Uint8Array(event.data);
          if (bytes.length > 0 && !drawn) {
            drawn = true;
            setWaitingSince(null);
          }
          term.write(bytes);
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

      // Coming back to the window is when a person notices a dead link: skip what is left of the
      // ladder and try at once.
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
        if (readOnly) return;
        if (ws !== null && ws.readyState === WebSocket.OPEN) {
          ws.send(new Uint8Array(encoder.encode(data)).buffer);
        }
      });
      const onResize = term.onResize(() => sendResize());
      // A tile resized, a tab moved to another tile, the window resized: the grid follows the box.
      const observer = new ResizeObserver(refit);
      observer.observe(element);
      connect();

      // Images: the agent's own Ctrl+V reads the clipboard of the machine it runs on, which has
      // none, so an image paste or drop goes up to Mend, which stores it beside the session and
      // answers its path in the workspace; the terminal pastes that path (bracketed, when the
      // program asked for it). Text pastes are left to ghostty-web's own listener: this runs in the
      // capture phase and claims only image files.
      const sendImages = async (files: ReadonlyArray<File>) => {
        const store = pasteRef.current;
        if (files.length === 0 || store === undefined) return;
        setImage({ kind: "uploading", count: files.length });
        try {
          const paths: Array<string> = [];
          for (const file of files) paths.push(await store(await base64Of(file)));
          if (disposed) return;
          term.paste(paths.join(" "));
          setImage(null);
        } catch (error) {
          if (disposed) return;
          setImage({
            kind: "error",
            message: error instanceof Error ? error.message : "Mend didn't store it.",
          });
        }
        term.focus();
      };
      const onPaste = (event: ClipboardEvent) => {
        const files = imageFilesOf(event.clipboardData?.files);
        if (files.length === 0 || pasteRef.current === undefined) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void sendImages(files);
      };
      const onDrop = (event: DragEvent) => {
        const files = imageFilesOf(event.dataTransfer?.files);
        if (files.length === 0 || pasteRef.current === undefined) return;
        event.preventDefault();
        void sendImages(files);
      };
      if (!readOnly) {
        element.addEventListener("paste", onPaste, { capture: true });
        element.addEventListener("dragover", onDragOver);
        element.addEventListener("drop", onDrop);
      }

      return () => {
        disposed = true;
        element.removeEventListener("paste", onPaste, { capture: true });
        element.removeEventListener("dragover", onDragOver);
        element.removeEventListener("drop", onDrop);
        window.removeEventListener("focus", onFocus);
        if (timer !== null) window.clearTimeout(timer);
        if (ticker !== null) window.clearInterval(ticker);
        observer.disconnect();
        onData.dispose();
        onResize.dispose();
        ws?.close();
        termRef.current = null;
        term.dispose();
      };
    };

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [sessionId, processId, embedTicket, token, readOnly, autoFocus]);

  const facts: AgentStartingFacts = starting ?? { startedAt: null, freshMachine: false };
  const startingLine =
    state === "live" && waitingSince !== null && now - waitingSince >= STARTING_GRACE_MS
      ? agentStartingLine(startingLabel, facts, now - (facts.startedAt ?? waitingSince))
      : null;
  const wireLine =
    state === "connecting"
      ? "Connecting…"
      : state === "reconnecting"
        ? "Lost the connection. Reconnecting…"
        : state === "settled"
          ? "This terminal has ended. What it printed stays here."
          : null;
  const imageLine =
    image === null
      ? null
      : image.kind === "uploading"
        ? image.count === 1
          ? "Storing the image…"
          : `Storing ${image.count} images…`
        : `Couldn't paste the image. ${image.message}`;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-muted", className)}>
      {/* The terminal keeps ⌘K and Ctrl K for the program in it (search's shortcut steps aside). */}
      <div
        ref={containerRef}
        {...{ [OWN_SHORTCUTS]: "" }}
        className="min-h-0 w-full flex-1 overflow-hidden"
      />
      <div role="status" className="empty:hidden">
        {startingLine === null ? null : <p className={LINE}>{startingLine}</p>}
        {wireLine === null ? null : <p className={LINE}>{wireLine}</p>}
        {imageLine === null ? null : (
          <p className={cn(LINE, image?.kind === "error" && "text-destructive")}>{imageLine}</p>
        )}
      </div>
    </div>
  );
}
