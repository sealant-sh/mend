import type { ViewerConnectionId } from "@mend/domain";
import { screenStatusLine } from "@mend/domain/workbench";
import type RFB from "@novnc/novnc";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import {
  handBackScreen,
  type LiveScreenDto,
  type ScreenControlDto,
  type ScreenReadDto,
  takeScreen,
} from "#/lib/api";
import { ScreenChannel, screenCloseWords, screenSocketUrl } from "#/lib/screen-socket";
import { useTRPC } from "#/lib/trpc";

/**
 * This viewer's socket to the screen. `took`: Take over succeeded on this connection, so while the
 * owner holds the input, it is held here and not in another tab.
 */
export type ScreenWire =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Watching"; readonly connection: ViewerConnectionId; readonly took: boolean }
  | { readonly _tag: "Closed"; readonly words: string };

type Pending = "take" | "hand-back" | null;

/** Whether this viewer's own connection holds the input: only then do its keys reach the screen. */
export const heldHere = (
  screen: LiveScreenDto,
  wire: ScreenWire,
  viewerId: string | null,
): boolean =>
  wire._tag === "Watching" &&
  wire.took &&
  screen.holder._tag === "Person" &&
  screen.holder.userId === viewerId;

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

export interface ScreenPaneViewProps {
  readonly screen: LiveScreenDto;
  /** `screenStatusLine`: who holds the screen, as Mend observed it. */
  readonly statusLine: string;
  readonly wire: ScreenWire;
  /** The viewer is the session's owner, the one person who may take over (ADR 0020, D3). */
  readonly owner: boolean;
  readonly ownerName: string;
  readonly held: boolean;
  readonly pending: Pending;
  readonly notice: string | null;
  readonly onTake: () => void;
  readonly onHandBack: () => void;
  readonly onReconnect: () => void;
  /** The element noVNC draws into, while the screen is live. */
  readonly viewer?: ReactNode;
}

/** A session's screen beside its terminal or record (docs/adr/0020, "How people watch and take over"). */
export function ScreenPaneView(props: ScreenPaneViewProps) {
  const { screen, wire, owner, held, pending } = props;
  // Only a live screen is watched: no socket opens on one starting, not started or ended.
  const live = screen.life._tag === "Live";
  const takeShows = owner && live && wire._tag === "Watching" && !held;
  const handBackShows = owner && screen.holder._tag !== "Agent";
  return (
    <>
      <p className="text-xs font-medium text-label">Screen</p>
      <div className="mt-3 overflow-hidden rounded-2xl bg-card shadow-sm">
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-3 border-b border-rule-faint bg-secondary px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {live && wire._tag === "Watching" && (
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--sw-red)]" />
            )}
            <p className="font-mono text-[11.5px] text-muted-foreground">{props.statusLine}</p>
          </div>
          {(takeShows || handBackShows) && (
            <div className="flex items-center gap-2">
              {takeShows && (
                <button
                  type="button"
                  disabled={pending !== null}
                  onClick={props.onTake}
                  className={BUTTON_FILLED}
                >
                  {pending === "take" ? "Taking over…" : "Take over"}
                </button>
              )}
              {handBackShows && (
                <button
                  type="button"
                  disabled={pending !== null}
                  onClick={props.onHandBack}
                  className={held ? BUTTON_FILLED : BUTTON_OUTLINE}
                >
                  {pending === "hand-back" ? "Handing back…" : "Hand back"}
                </button>
              )}
            </div>
          )}
        </div>
        {!owner && (
          <p className="border-b border-rule-faint px-4 py-2 font-sans text-[12.5px] text-ink-2">
            Only {props.ownerName} puts input on this screen.
          </p>
        )}
        {held && (
          <p className="border-b border-rule-faint px-4 py-2 font-sans text-[12.5px] text-ink-2">
            Your keys and clicks reach the screen. The agent waits until you hand back.
          </p>
        )}
        {props.notice !== null && (
          <p className="border-b border-rule-faint px-4 py-2 font-sans text-[12.5px] text-ink-2">
            {props.notice}
          </p>
        )}
        <div className="relative aspect-[1280/800] w-full bg-sunken">
          {live ? (
            props.viewer
          ) : (
            <p className="absolute inset-0 flex items-center justify-center p-6 text-center font-mono text-xs text-faint">
              {screen.life._tag === "Starting"
                ? "starting…"
                : "The agent's next screen look starts it."}
            </p>
          )}
        </div>
        {live && wire._tag === "Connecting" && (
          <p className="border-t border-rule-faint px-4 py-2 font-mono text-[11.5px] text-faint">
            connecting…
          </p>
        )}
        {live && wire._tag === "Closed" && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule-faint px-4 py-2">
            <p className="font-mono text-[11.5px] text-faint">connection closed · {wire.words}</p>
            <button type="button" onClick={props.onReconnect} className={BUTTON_OUTLINE}>
              Reconnect
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The live pane: noVNC on `/api/screen-socket`, read-only until this viewer's own connection holds
 * the input. Whatever noVNC sends, the server passes keys and pointer only from the holder.
 * Nothing reaches the clipboard either way: the pane never sends noVNC's clipboard and never
 * listens for the screen's (ADR 0020, D13).
 */
export function ScreenPane({
  sessionId,
  screen,
  viewerId,
  ownerName,
  nameOf,
}: {
  readonly sessionId: string;
  readonly screen: LiveScreenDto;
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
  const owner = viewerId !== null && viewerId === screen.ownerUserId;
  const held = heldHere(screen, wire, viewerId);

  // noVNC is an imperative widget bound to its element: it opens with the element, at each
  // Reconnect (a new key), and closes with it. It reads `window` as it loads, so it loads here,
  // in the browser, and only on a page with a live screen.
  const mountViewer = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null) return;
      let disposed = false;
      let view: RFB | null = null;
      setWire({ _tag: "Connecting" });
      const open = async () => {
        const { default: Rfb } = await import("@novnc/novnc");
        if (disposed) return;
        const socket = new WebSocket(screenSocketUrl(sessionId, window.location.origin));
        const channel = new ScreenChannel(socket, {
          hello: (connection) => {
            if (!disposed) setWire({ _tag: "Watching", connection, took: false });
          },
          closed: (close) => {
            if (!disposed) setWire({ _tag: "Closed", words: screenCloseWords(close) });
          },
        });
        view = new Rfb(element, channel, { shared: true });
        view.viewOnly = true;
        view.scaleViewport = true;
        view.background = "transparent";
        rfb.current = view;
      };
      open().catch(() => {
        if (!disposed) setWire({ _tag: "Closed", words: "the screen viewer did not load" });
      });
      return () => {
        disposed = true;
        rfb.current = null;
        view?.disconnect();
      };
    },
    [sessionId],
  );

  // The one thing render cannot say to noVNC: whether its keys and pointer go up. It follows the
  // holder as the read reports it, so a lapse or a hand back elsewhere ends it here too.
  useEffect(() => {
    if (rfb.current !== null) rfb.current.viewOnly = !held;
  }, [held]);

  const screenKey = trpc.screens.read.queryKey({ id: sessionId });
  const send = (
    kind: "take" | "hand-back",
    request: Promise<ScreenControlDto>,
    then: (result: ScreenControlDto) => void,
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
        then(result);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Mend did not answer.");
      } finally {
        setPending(null);
        void queryClient.invalidateQueries({ queryKey: screenKey });
      }
    };
    void answer();
  };
  const take = () => {
    if (wire._tag !== "Watching") return;
    const { connection } = wire;
    send("take", takeScreen(sessionId, connection), (result) => {
      // Unchanged: this connection already held it, or was being handed it.
      const took =
        (result._tag === "Changed" && result.holder._tag === "Person") ||
        result._tag === "Unchanged";
      setWire((current) =>
        current._tag === "Watching" && current.connection === connection
          ? { ...current, took }
          : current,
      );
      if (took) rfb.current?.focus();
    });
  };
  const handBack = () =>
    send("hand-back", handBackScreen(sessionId), () =>
      setWire((current) => (current._tag === "Watching" ? { ...current, took: false } : current)),
    );

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
      ownerName={ownerName}
      held={held}
      pending={pending}
      notice={notice}
      onTake={take}
      onHandBack={handBack}
      onReconnect={() => setAttempt((n) => n + 1)}
      viewer={<div key={attempt} ref={mountViewer} className="absolute inset-0" />}
    />
  );
}
