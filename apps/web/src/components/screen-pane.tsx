import type { ViewerConnectionId } from "@mend/domain";
import { screenStatusLine } from "@mend/domain/workbench";
import type RFB from "@novnc/novnc";
import { useQueryClient } from "@tanstack/react-query";
import { Info, Maximize } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { StatusDot } from "#/components/status";
import {
  handBackScreen,
  type LiveScreenDto,
  type ScreenControlDto,
  type ScreenReadDto,
  takeScreen,
  wakeScreen,
} from "#/lib/api";
import type { ScreenRtcView } from "#/lib/screen-rtc";
import { ScreenChannel, screenCloseWords, screenSocketUrl } from "#/lib/screen-socket";
import { useTRPC } from "#/lib/trpc";

/** This viewer's socket to the screen; `connection` is the id the server named it. */
export type ScreenWire =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Watching"; readonly connection: ViewerConnectionId }
  | { readonly _tag: "Closed"; readonly words: string };

type Pending = "take" | "hand-back" | "wake" | null;

/**
 * Whether this viewer's own connection holds the input, as the server last reported: only then do
 * its keys reach the screen. A takeover from another tab names that tab's connection.
 */
export const heldHere = (screen: LiveScreenDto, wire: ScreenWire): boolean =>
  wire._tag === "Watching" &&
  screen.holder._tag === "Person" &&
  screen.holder.connection === wire.connection;

/** What Take over or Hand back answered, when it did not simply happen. */
export const screenControlNotice = (result: ScreenControlDto): string | null => {
  switch (result._tag) {
    case "Changed":
    case "Unchanged":
      return null;
    case "Refused":
      return result.why === "owner-only"
        ? "Only the session's owner puts input on this screen."
        : result.why === "held"
          ? "Someone else holds the input."
          : "The agent looks at the screen before it acts again.";
    case "NoScreen":
      return "The session has no live screen.";
    case "NoHand":
      return "Mend has no input connection to this screen right now, so nothing was taken.";
    case "NotWatching":
      return "This viewer is not open on the screen yet. Reconnect and try again.";
  }
};

const BUTTON_FILLED =
  "rounded-xl bg-primary px-3 py-1.5 font-sans text-[13px] font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:opacity-50";
const BUTTON_OUTLINE =
  "rounded-xl border border-border bg-card px-3 py-1.5 font-sans text-[13px] font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50";

/** Screen facts and controls, independent of the video or noVNC transport. */
export interface ScreenPaneViewProps {
  readonly screen: LiveScreenDto;
  /** `screenStatusLine`: who holds the screen, as Mend observed it. */
  readonly statusLine: string;
  readonly wire: ScreenWire;
  /** The viewer is the session's owner, the one person who may take over (ADR 0020, D3). */
  readonly owner: boolean;
  /** The same admission as sending a message, including shared control. */
  readonly steer: boolean;
  readonly ownerName: string;
  readonly held: boolean;
  readonly pending: Pending;
  readonly notice: string | null;
  readonly onWake: () => void;
  readonly onTake: () => void;
  readonly onHandBack: () => void;
  readonly onReconnect: () => void;
  /** The live video or noVNC viewer. */
  readonly viewer?: ReactNode;
}

/** A screen's controls and fitted viewport, including the same header in fullscreen. */
export function ScreenPaneView(props: ScreenPaneViewProps) {
  const { screen, wire, owner, held, pending } = props;
  const panel = useRef<HTMLDivElement>(null);
  const [fullscreenNotice, setFullscreenNotice] = useState<string | null>(null);
  const live = screen.life._tag === "Live";
  const takeShows = owner && live && wire._tag === "Watching" && !held;
  const handBackShows = owner && live && wire._tag === "Watching" && held;
  // Keep the domain's reasons, leaving frame/viewer metadata and sandbox notes out of the label.
  const words =
    props.statusLine
      .replace(/^screen · /, "")
      .split(" · degraded")[0]
      ?.split(" · browser sandbox off")[0] ?? "";
  const status: { tone: "red" | "hollow" | "amber" | "accent" | "green"; word: string } =
    pending === "wake" || screen.life._tag === "Starting"
      ? { tone: "hollow", word: "Starting…" }
      : screen.life._tag === "Ended"
        ? {
            tone: "hollow",
            word:
              screen.life.reason === "idle"
                ? "Stopped · idle"
                : words.replace(/^ended(?: · | )?/, "Stopped · "),
          }
        : !live || wire._tag === "Connecting"
          ? { tone: "hollow", word: "Connecting" }
          : wire._tag === "Closed"
            ? { tone: "red", word: `Closed · ${wire.words}` }
            : screen.holder._tag === "Paused"
              ? { tone: "amber", word: words.replace(/^input paused · /, "Paused · ") }
              : screen.holder._tag === "Person"
                ? { tone: "accent", word: held ? "You have input" : words }
                : { tone: "green", word: words.charAt(0).toUpperCase() + words.slice(1) };
  const fullscreen = async () => {
    setFullscreenNotice(null);
    try {
      if (panel.current?.requestFullscreen === undefined) {
        setFullscreenNotice("Fullscreen is unavailable in this browser.");
        return;
      }
      await panel.current.requestFullscreen();
      if (held) panel.current.querySelector<HTMLElement>("video, canvas")?.focus();
    } catch {
      setFullscreenNotice("Fullscreen did not open. Try again from this screen.");
    }
  };
  const notice = props.notice ?? fullscreenNotice;
  return (
    <div
      ref={panel}
      className="screen-panel overflow-hidden rounded-2xl bg-card shadow-sm"
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || document.fullscreenElement !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        void document.exitFullscreen().catch(() => {
          setFullscreenNotice("Fullscreen did not close. Try Esc again.");
        });
      }}
    >
      <div className="flex min-h-13 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <StatusDot tone={status.tone} word={status.word} />
          {!owner && live && (
            <span className="text-xs text-muted-foreground">
              Only {props.ownerName} controls this screen
            </span>
          )}
          {live && screen.life._tag === "Live" && screen.life.browserSandboxOff && (
            <button
              type="button"
              aria-label="Browser sandbox off"
              title="Browser sandbox off: the workspace could not start Chromium's sandbox."
              className="text-muted-foreground"
            >
              <Info className="size-3.5" aria-hidden="true" />
            </button>
          )}
          {live && screen.life._tag === "Live" && screen.life.degraded !== null && (
            <span className="text-xs text-muted-foreground" title={props.statusLine}>
              An app or stream did not start
            </span>
          )}
          {notice !== null && (
            <span role="status" className="text-xs text-muted-foreground">
              {notice}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {props.steer && screen.life._tag === "Ended" && (
            <button
              type="button"
              disabled={pending !== null}
              onClick={props.onWake}
              className={BUTTON_FILLED}
            >
              {pending === "wake" ? "Starting…" : "Wake the screen"}
            </button>
          )}
          {takeShows && (
            <button
              type="button"
              disabled={pending !== null}
              onClick={props.onTake}
              className={BUTTON_OUTLINE}
            >
              {pending === "take" ? "Taking over…" : "Take over"}
            </button>
          )}
          {handBackShows && (
            <button
              type="button"
              disabled={pending !== null}
              onClick={props.onHandBack}
              className={BUTTON_FILLED}
            >
              {pending === "hand-back" ? "Handing back…" : "Hand back"}
            </button>
          )}
          {live && (
            <button
              type="button"
              onClick={() => void fullscreen()}
              className="inline-flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-[13px] text-muted-foreground hover:text-foreground"
            >
              <Maximize className="size-3.5" aria-hidden="true" />
              Fullscreen
            </button>
          )}
          {live && wire._tag === "Closed" && (
            <button type="button" onClick={props.onReconnect} className={BUTTON_OUTLINE}>
              Reconnect
            </button>
          )}
        </div>
      </div>
      <div className="screen-stage relative aspect-[8/5] w-full bg-sunken">
        <div className="screen-viewport absolute inset-0">
          {live ? (
            props.viewer
          ) : (
            <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-muted-foreground">
              {pending === "wake" || screen.life._tag === "Starting"
                ? "Starting…"
                : screen.life._tag === "Ended"
                  ? "The screen is stopped."
                  : "The agent's next screen look starts it."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The live pane tries H.264 over WebRTC, then noVNC when UDP or the encoder is unavailable.
 * Both paths put input through the hand only while this connection holds it.
 * Nothing reaches the clipboard either way: the pane never sends noVNC's clipboard and never
 * listens for the screen's (ADR 0020, D13).
 */
export function ScreenPane({
  sessionId,
  active = true,
  screen,
  steer,
  viewerId,
  ownerName,
  nameOf,
}: {
  readonly sessionId: string;
  readonly active?: boolean;
  readonly screen: LiveScreenDto;
  readonly steer: boolean;
  readonly viewerId: string | null;
  readonly ownerName: string;
  readonly nameOf: (userId: string) => string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [wire, setWire] = useState<ScreenWire>({ _tag: "Connecting" });
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rfb = useRef<RFB | null>(null);
  const rtc = useRef<ScreenRtcView | null>(null);
  const heldRef = useRef(false);
  const owner = viewerId !== null && viewerId === screen.ownerUserId;
  const held = heldHere(screen, wire);

  // noVNC is an imperative widget bound to its element: it opens with the element, at each
  // Reconnect (a new key), and closes with it. It reads `window` as it loads, so it loads here,
  // in the browser, and only on a page with a live screen.
  const mountViewer = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null) return;
      let disposed = false;
      let view: RFB | null = null;
      let stream: ScreenRtcView | null = null;
      setWire({ _tag: "Connecting" });
      const openVnc = async () => {
        const { default: Rfb } = await import("@novnc/novnc");
        if (disposed) return;
        const socket = new WebSocket(screenSocketUrl(sessionId, window.location.origin));
        const channel = new ScreenChannel(socket, {
          hello: (connection) => {
            if (!disposed) setWire({ _tag: "Watching", connection });
          },
          closed: (close) => {
            if (!disposed) setWire({ _tag: "Closed", words: screenCloseWords(close) });
          },
        });
        view = new Rfb(element, channel, { shared: true });
        view.viewOnly = !heldRef.current;
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
          if (!disposed) setWire({ _tag: "Closed", words: "the screen viewer did not load" });
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
        video.setAttribute("aria-label", "Session screen");
        video.className = "block h-full w-full object-contain outline-none";
        element.append(video);
        stream = openScreenRtc(video, sessionId, {
          watching: (connection) => {
            if (!disposed) setWire({ _tag: "Watching", connection });
          },
          fallback,
        });
        rtc.current = stream;
        stream.setHeld(heldRef.current);
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
    [sessionId],
  );

  // The one thing render cannot say to noVNC: whether its keys and pointer go up. It follows the
  // holder as the read reports it, so a lapse or a hand back elsewhere ends it here too.
  useEffect(() => {
    heldRef.current = held;
    rtc.current?.setHeld(held);
    if (rfb.current !== null) rfb.current.viewOnly = !held;
    if (held && active) {
      rfb.current?.focus();
      rtc.current?.focus();
    }
  }, [held, active]);

  const screenKey = trpc.screens.read.queryKey({ id: sessionId });
  const send = (
    kind: "take" | "hand-back",
    request: Promise<ScreenControlDto>,
    then?: (result: ScreenControlDto) => void,
  ) => {
    setPending(kind);
    setNotice(null);
    const answer = async () => {
      try {
        const result = await request;
        if (result._tag === "Changed") {
          queryClient.setQueryData(screenKey, (read: ScreenReadDto | undefined) =>
            read?._tag === "Screen" ? { ...read, holder: result.holder } : read,
          );
        }
        setNotice(screenControlNotice(result));
        then?.(result);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Mend did not answer.");
      } finally {
        setPending(null);
        void queryClient.invalidateQueries({ queryKey: screenKey });
      }
    };
    void answer();
  };
  const wake = async () => {
    setPending("wake");
    setNotice(null);
    try {
      await wakeScreen(sessionId);
      await queryClient.invalidateQueries({ queryKey: screenKey });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The screen did not start. Try again.");
    } finally {
      setPending(null);
      void queryClient.invalidateQueries(trpc.sessions.pathFilter());
    }
  };
  const take = () => {
    if (wire._tag !== "Watching") return;
    const { connection } = wire;
    send("take", takeScreen(sessionId, connection), (result) => {
      if (result._tag === "Changed" || result._tag === "Unchanged") {
        rfb.current?.focus();
        rtc.current?.focus();
      }
    });
  };
  const handBack = () => send("hand-back", handBackScreen(sessionId));

  return (
    <ScreenPaneView
      screen={screen}
      statusLine={screenStatusLine({
        life: screen.life,
        holder: screen.holder,
        viewers: 0,
        now: new Date(),
        nameOf,
      })}
      wire={wire}
      owner={owner}
      steer={steer}
      ownerName={ownerName}
      held={held}
      pending={pending}
      notice={notice}
      onWake={() => void wake()}
      onTake={take}
      onHandBack={handBack}
      onReconnect={() => setAttempt((n) => n + 1)}
      viewer={<div key={attempt} ref={mountViewer} className="absolute inset-0" />}
    />
  );
}
