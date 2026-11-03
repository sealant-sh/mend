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

/**
 * A screen that is not live, as its pane says it (ADR 0020, D7). It runs while its session does,
 * so while the session runs it is starting, or it failed and offers a retry; otherwise it stopped
 * with the session and starts again when the session resumes.
 */
export type ScreenDown =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Failed"; readonly started: boolean }
  | { readonly _tag: "Stopped" };

export const screenDown = (
  life: LiveScreenDto["life"],
  sessionLive: boolean,
  waking: boolean,
): ScreenDown | null => {
  if (life._tag === "Live") return null;
  if (waking || life._tag === "Starting") return { _tag: "Starting" };
  if (!sessionLive) return { _tag: "Stopped" };
  return life._tag === "NotStarted"
    ? { _tag: "Starting" }
    : { _tag: "Failed", started: life.reason !== "start-failed" };
};

const BUTTON_FILLED =
  "rounded-xl bg-primary px-3 py-1.5 font-sans text-[13px] font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:opacity-50 motion-reduce:transition-none motion-reduce:hover:translate-y-0";
const PILL_BUTTON =
  "shrink-0 rounded-[10px] border border-rule bg-panel px-2.5 py-1.5 font-sans text-[12.5px] leading-none font-medium text-foreground shadow-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sw-accent)] disabled:opacity-50";
const BUTTON_OUTLINE =
  "rounded-xl border border-border bg-card px-3 py-1.5 font-sans text-[13px] font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50 motion-reduce:transition-none motion-reduce:hover:translate-y-0";

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
  /** The session's agent runs, so its screen should too. */
  readonly sessionLive: boolean;
  readonly ownerName: string;
  readonly held: boolean;
  readonly pending: Pending;
  readonly notice: string | null;
  readonly onWake: () => void;
  readonly onTake: () => void;
  readonly onHandBack: () => void;
  readonly onReconnect: () => void;
  /** What a stopped screen offers in its middle: the session's Resume. */
  readonly stopped?: ReactNode;
  /** The live video or noVNC viewer. */
  readonly viewer?: ReactNode;
}

/** A screen's controls and fitted viewport, including the same header in fullscreen. */
export function ScreenPaneView(props: ScreenPaneViewProps) {
  const { screen, wire, owner, held, pending } = props;
  const panel = useRef<HTMLDivElement>(null);
  const [fullscreenNotice, setFullscreenNotice] = useState<string | null>(null);
  const live = screen.life._tag === "Live";
  const down = screenDown(screen.life, props.sessionLive, pending === "wake");
  const takeShows = owner && live && wire._tag === "Watching" && !held;
  const handBackShows = owner && live && wire._tag === "Watching" && held;
  // Keep the domain's reasons, leaving frame/viewer metadata and sandbox notes out of the label.
  const words =
    props.statusLine
      .replace(/^screen · /, "")
      .split(" · degraded")[0]
      ?.split(" · browser sandbox off")[0] ?? "";
  const stoppedWords =
    screen.life._tag !== "Ended"
      ? "Stopped"
      : screen.life.reason === "idle"
        ? "Stopped · idle"
        : words.replace(/^ended(?: · | )?/, "Stopped · ");
  const status: { tone: "red" | "hollow" | "amber" | "accent" | "green"; word: string } =
    down?._tag === "Starting"
      ? { tone: "hollow", word: "Starting…" }
      : down?._tag === "Failed"
        ? { tone: "red", word: down.started ? stoppedWords : "Did not start" }
        : down?._tag === "Stopped"
          ? { tone: "hollow", word: stoppedWords }
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
  const control = takeShows ? (
    <button
      type="button"
      disabled={pending !== null}
      onClick={props.onTake}
      className={PILL_BUTTON}
    >
      {pending === "take" ? "Taking over…" : "Take over"}
    </button>
  ) : handBackShows ? (
    <button
      type="button"
      disabled={pending !== null}
      onClick={props.onHandBack}
      className={PILL_BUTTON}
    >
      {pending === "hand-back" ? "Handing back…" : "Hand back"}
    </button>
  ) : null;
  const watching = live && wire._tag === "Watching" && !held && screen.holder._tag !== "Paused";
  return (
    <div className="grid gap-2">
      <div
        ref={panel}
        className="screen-panel relative aspect-[8/5] w-full overflow-hidden rounded-[14px] border border-rule bg-[#3a3d42] shadow-sm"
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape" || document.fullscreenElement !== event.currentTarget) return;
          event.preventDefault();
          event.stopPropagation();
          void document.exitFullscreen().catch(() => {
            setFullscreenNotice("Fullscreen did not close. Try Esc again.");
          });
        }}
      >
        <div className="absolute inset-x-0 top-0 z-10 flex h-[22px] items-center gap-2.5 bg-[#26282c] px-2.5 font-mono text-[10.5px] text-[#b9bbc0]">
          <span>screen :{screen.display}</span>
          {live ? null : (
            <span className="[&_*]:text-[#d4d6da]">
              <StatusDot tone={status.tone} word={status.word} />
            </span>
          )}
          <span className="flex-1" />
          {live && screen.life._tag === "Live" && screen.life.browserSandboxOff ? (
            <span title="Browser sandbox off: the workspace could not start Chromium's sandbox.">
              <Info className="inline size-3" aria-hidden="true" /> sandbox off
            </span>
          ) : null}
          {live && screen.life._tag === "Live" && screen.life.degraded !== null ? (
            <span title={props.statusLine}>an app or stream did not start</span>
          ) : null}
          <span>
            {screen.width} × {screen.height}
          </span>
          {live ? (
            <button
              type="button"
              onClick={() => void fullscreen()}
              className="inline-flex items-center gap-1 rounded px-1 text-[#b9bbc0] outline-none hover:text-white focus-visible:outline-2 focus-visible:outline-[#9db8ff]"
            >
              <Maximize className="size-3" aria-hidden="true" />
              Fullscreen
            </button>
          ) : null}
        </div>
        <div className="screen-stage absolute inset-x-0 top-[22px] bottom-0">
          <div className="screen-viewport absolute inset-0" data-screen-input>
            {live ? (
              props.viewer
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-[12.5px] text-[#d4d6da]">
                <p>
                  {down?._tag === "Failed"
                    ? down.started
                      ? "The screen stopped while the session runs."
                      : "The screen did not start."
                    : down?._tag === "Stopped"
                      ? "The screen stopped with the session. It starts again when the session resumes."
                      : "Starting…"}
                </p>
                {down?._tag === "Stopped" ? props.stopped : null}
                {props.steer && down?._tag === "Failed" && screen.life._tag === "Ended" ? (
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={props.onWake}
                    className={BUTTON_FILLED}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
        {live ? (
          <div
            className={`absolute bottom-2.5 left-2.5 z-10 flex max-w-[calc(100%-20px)] items-center gap-[7px] rounded-[10px] py-1 pr-1 pl-2.5 font-sans text-[11.5px] font-medium shadow-sm ${held ? "bg-primary text-primary-foreground" : "bg-white/90 text-[#1b1b1d]"}`}
          >
            {held ? (
              <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-white" />
            ) : null}
            <span className="min-w-0 truncate">
              {held ? (
                status.word
              ) : (
                <StatusDot
                  tone={status.tone}
                  word={watching ? `${status.word} · you are watching` : status.word}
                />
              )}
            </span>
            {control}
          </div>
        ) : null}
      </div>
      {(!owner && live) || notice !== null || (live && wire._tag === "Closed") ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {!owner && live ? <span>Only {props.ownerName} controls this screen</span> : null}
          {notice === null ? null : <span role="status">{notice}</span>}
          {live && wire._tag === "Closed" ? (
            <button type="button" onClick={props.onReconnect} className={BUTTON_OUTLINE}>
              Reconnect
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A screen's viewer, the same for the Screen tab and the side panel's thumbnail: `mount` opens it
 * on the element it is given, H.264 over WebRTC, then noVNC when UDP or the encoder is
 * unavailable. Input goes up only while `held` says this connection holds it, so a viewer that
 * never sets it only watches.
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
          if (!disposed) onWire({ _tag: "Closed", words: "the screen viewer did not load" });
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
  sessionLive,
  viewerId,
  ownerName,
  nameOf,
  stopped,
}: {
  readonly sessionId: string;
  readonly active?: boolean;
  readonly screen: LiveScreenDto;
  readonly steer: boolean;
  readonly sessionLive: boolean;
  readonly viewerId: string | null;
  readonly ownerName: string;
  readonly nameOf: (userId: string) => string;
  readonly stopped?: ReactNode;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [wire, setWire] = useState<ScreenWire>({ _tag: "Connecting" });
  const [pending, setPending] = useState<Pending>(null);
  const [wakeFrom, setWakeFrom] = useState<{
    readonly sessionId: string;
    readonly processId: LiveScreenDto["processId"];
  } | null>(null);
  const wakeInFlight = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const viewer = useScreenViewer(sessionId, setWire);
  const { rfb, rtc } = viewer;
  const owner = viewerId !== null && viewerId === screen.ownerUserId;
  const held = heldHere(screen, wire);
  // A successful POST does not make an older poll current. Wait for Live or a different start
  // ending, including a start that ended between polls without this pane ever reading Starting.
  const waking =
    wakeFrom?.sessionId === sessionId &&
    screen.life._tag !== "Live" &&
    !(screen.life._tag === "Ended" && screen.processId !== wakeFrom.processId);

  // The one thing render cannot say to noVNC: whether its keys and pointer go up. It follows the
  // holder as the read reports it, so a lapse or a hand back elsewhere ends it here too.
  useEffect(() => {
    viewer.held.current = held;
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
        // Taking over and handing back are log entries too.
        void queryClient.invalidateQueries(trpc.screens.log.queryFilter({ id: sessionId }));
      }
    };
    void answer();
  };
  const wake = async () => {
    if (wakeInFlight.current || waking || pending !== null || screen.life._tag !== "Ended") return;
    wakeInFlight.current = true;
    setPending("wake");
    setWakeFrom({ sessionId, processId: screen.processId });
    setNotice(null);
    try {
      await wakeScreen(sessionId);
      await queryClient.invalidateQueries({ queryKey: screenKey });
    } catch (error) {
      setWakeFrom(null);
      setNotice(error instanceof Error ? error.message : "The screen did not start. Try again.");
    } finally {
      wakeInFlight.current = false;
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
      sessionLive={sessionLive}
      ownerName={ownerName}
      held={held}
      pending={screen.life._tag === "Live" && pending === "wake" ? null : waking ? "wake" : pending}
      notice={notice}
      onWake={() => void wake()}
      onTake={take}
      onHandBack={handBack}
      onReconnect={() => setAttempt((n) => n + 1)}
      stopped={stopped}
      viewer={<div key={attempt} ref={viewer.mount} className="absolute inset-0" />}
    />
  );
}
