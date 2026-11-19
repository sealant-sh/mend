import { resumesOwnHarness } from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleXIcon, Maximize2Icon, MonitorIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { QueryError } from "#/components/route-screens";
import { useSessionFacts } from "#/components/session/session-facts";
import type { LiveScreenDto, ScreenControlDto, ScreenReadDto } from "#/lib/api";
import { laterPage } from "#/lib/later-pages";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { screenLogActor, screenLogWords } from "#/lib/screen-log";
import {
  displayWords,
  heldHere,
  screenBar,
  screenControlNotice,
  screenDown,
  type ScreenWire,
} from "#/lib/screen-state";
import { sessionDetailQuery } from "#/lib/session-queries";
import { clockSeconds } from "#/lib/session-view";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import type { ViewFacts, ViewPlace, WorkspaceView } from "../views.tsx";
import { useScreenViewer } from "./screen-viewer.ts";

/** Who holds a screen's input has no event of its own, so a screen that runs is read often. */
const SCREEN_READ_MS = 3_000;
/** A person's clicks and keys have no event either: the log is read again while one holds it. */
const SCREEN_LOG_MS = 3_000;
/** Under this height the tile shows the screen alone, without its log. */
const LOG_MIN_HEIGHT = 560;

const useScreenRead = (sessionId: string) => {
  const trpc = useTRPC();
  return useQuery(
    trpc.screens.read.queryOptions(
      { id: sessionId },
      {
        retry: false,
        // Only a screen that runs (or starts) changes hands; an ended one waits for the session
        // events that say it woke.
        refetchInterval: (query) => {
          const read = query.state.data;
          return read?._tag === "Screen" &&
            (read.life._tag === "Live" || read.life._tag === "Starting")
            ? SCREEN_READ_MS
            : false;
        },
      },
    ),
  );
};

/** The Screen tab's and its "+" item's fact: "live" while the workspace's screen runs. */
const useScreenFacts = (place: ViewPlace): ViewFacts => {
  const read = useScreenRead(place.sessionId);
  if (read.isPending || read.isError) return {};
  return read.data._tag === "Screen" && read.data.life._tag === "Live" ? { fact: "live" } : {};
};

/** The height of the element `ref` is given, as it changes; null until first measured. */
const useBoxHeight = () => {
  const [height, setHeight] = useState<number | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.height ?? 0);
      if (next > 0) setHeight((current) => (current === next ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { height, ref };
};

/**
 * The Screen view (Doop "Screen · live" and its states, ADR 0020): the workspace's desktop, live,
 * with a bar that says who has the input, the display and its size, Full screen, and Take over or
 * Hand back for the session's owner; the screen log under it. Anyone who can see the session
 * watches; only its owner puts input on the screen, and the agent waits until they hand back.
 */
function ScreenBody({ place }: { readonly place: ViewPlace }) {
  const read = useScreenRead(place.sessionId);
  const { height, ref } = useBoxHeight();
  const phone = usePhone();
  const withLog = phone || height === null || height >= LOG_MIN_HEIGHT;
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {read.isPending ? (
        <Note busy>Reading the screen…</Note>
      ) : read.isError ? (
        <div className="px-5 py-5 max-lg:px-4">
          <QueryError
            error={read.error}
            retry={() => void read.refetch()}
            retrying={read.isRefetching}
          />
        </div>
      ) : read.data._tag === "Screen" ? (
        <LiveScreen place={place} screen={read.data} />
      ) : (
        <NoScreen place={place} />
      )}
      {withLog ? (
        <ScreenLog
          place={place}
          personHolds={
            read.isSuccess &&
            read.data._tag === "Screen" &&
            read.data.life._tag === "Live" &&
            read.data.holder._tag === "Person"
          }
        />
      ) : null}
    </div>
  );
}

/**
 * A session with no screen: its workspace image has none (a custom image never has one, one of
 * Mend's only when it was built with Screen on), or its agent started without a display.
 */
function NoScreen({ place }: { readonly place: ViewPlace }) {
  const facts = useSessionFacts(place.sessionId);
  const image = facts.session.workspaceImage;
  const settings = (words: string) => (
    <Link
      {...laterPage(`projects/${place.projectId}/settings/workspace`)}
      className="font-medium text-foreground underline underline-offset-2"
    >
      {words}
    </Link>
  );
  return (
    <Stage>
      <Card title="No screen in this workspace.">
        {image !== null && image.mode === "custom" ? (
          <>
            It runs on a custom workspace image, and a custom image has no screen. A screen needs
            one of Mend&apos;s images, chosen in {settings("the project's Workspace settings")}.
          </>
        ) : image !== null && !image.screen ? (
          <>
            Its workspace image was built without one. Turn Screen on in{" "}
            {settings("the project's Workspace settings")}; a workspace built after that has one.
          </>
        ) : facts.agentLive ? (
          "This session's agent started without a display."
        ) : (
          "It starts with the session's agent."
        )}
      </Card>
    </Stage>
  );
}

type Pending = "take" | "hand-back" | "wake" | null;

function LiveScreen({
  place,
  screen,
}: {
  readonly place: ViewPlace;
  readonly screen: LiveScreenDto;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const facts = useSessionFacts(place.sessionId);
  const [attempt, setAttempt] = useState(0);
  const [wire, setWire] = useState<ScreenWire>({ _tag: "Connecting" });
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wakeFrom, setWakeFrom] = useState<LiveScreenDto["processId"] | undefined>(undefined);
  const viewer = useScreenViewer(place.sessionId, setWire);
  const panel = useRef<HTMLDivElement | null>(null);
  const owner = facts.viewerId === screen.ownerUserId;
  const held = heldHere(screen, wire);
  // A wake that answered doesn't make an older read current: wait for Live, or for a different
  // start to end.
  const waking =
    wakeFrom !== undefined &&
    screen.life._tag !== "Live" &&
    !(screen.life._tag === "Ended" && screen.processId !== wakeFrom);
  const live = screen.life._tag === "Live";
  const down = screenDown(screen.life, facts.agentLive, waking);
  const ownerName =
    screen.ownerUserId === null ? "its owner" : (facts.nameOf(screen.ownerUserId) ?? "its owner");
  const bar = screenBar({
    screen,
    wire,
    sessionLive: facts.agentLive,
    waking,
    owner,
    agent: facts.agent,
    nameOf: (userId) => (userId === facts.viewerId ? "You" : (facts.nameOf(userId) ?? "Someone")),
  });

  // The one thing render can't say to the viewer: whether its keys and pointer go up. It follows
  // the holder as the read reports it, so a lapse or a hand back elsewhere ends it here too.
  const { rfb, rtc } = viewer;
  useEffect(() => {
    viewer.held.current = held;
    rtc.current?.setHeld(held);
    if (rfb.current !== null) rfb.current.viewOnly = !held;
    if (held) {
      rfb.current?.focus();
      rtc.current?.focus();
    }
  }, [held, rfb, rtc, viewer.held]);

  const screenKey = trpc.screens.read.queryKey({ id: place.sessionId });
  const settle = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: screenKey }),
      // Taking over and handing back are log entries too.
      queryClient.invalidateQueries(trpc.screens.log.queryFilter({ id: place.sessionId })),
    ]);
  const control = async (kind: "take" | "hand-back") => {
    if (pending !== null) return;
    if (kind === "take" && wire._tag !== "Watching") return;
    setPending(kind);
    setNotice(null);
    try {
      const result: ScreenControlDto =
        kind === "take" && wire._tag === "Watching"
          ? await client.screens.take.mutate({ id: place.sessionId, connection: wire.connection })
          : await client.screens.handBack.mutate({ id: place.sessionId });
      if (result._tag === "Changed")
        queryClient.setQueryData(screenKey, (current: ScreenReadDto | undefined) =>
          current?._tag === "Screen" ? { ...current, holder: result.holder } : current,
        );
      setNotice(screenControlNotice(result));
      if (kind === "take" && (result._tag === "Changed" || result._tag === "Unchanged")) {
        rfb.current?.focus();
        rtc.current?.focus();
      }
    } catch (cause) {
      setNotice(
        failureWords(
          cause,
          kind === "take" ? "Mend couldn't take over. Try again." : "Mend couldn't hand back.",
        ),
      );
    } finally {
      setPending(null);
      void settle();
    }
  };
  const wake = useMutation({
    mutationFn: () => client.screens.wake.mutate({ id: place.sessionId }),
    onMutate: () => setWakeFrom(screen.processId),
    onError: () => setWakeFrom(undefined),
    onSettled: () =>
      Promise.all([settle(), queryClient.invalidateQueries(trpc.sessions.pathFilter())]),
  });
  // A stopped session comes back as the Terminal and Preview views bring it back: a conversation
  // resumes as itself, any other session as a shell. Its screen starts with it.
  const resume = useMutation({
    mutationFn: async () => {
      const { session, currentAgent } = await queryClient.fetchQuery(
        sessionDetailQuery(trpc, place.sessionId),
      );
      const asItself =
        resumesOwnHarness(session.harness) &&
        session.harness !== "shell" &&
        currentAgent?.kind === "agent-protocol";
      await client.sessions.resume.mutate({
        id: place.sessionId,
        request: { harness: asItself ? null : "shell" },
      });
    },
    onSettled: () =>
      Promise.all([settle(), queryClient.invalidateQueries(trpc.sessions.pathFilter())]),
  });

  const fullScreen = async () => {
    setNotice(null);
    try {
      if (panel.current?.requestFullscreen === undefined) {
        setNotice("Full screen isn't available in this browser.");
        return;
      }
      await panel.current.requestFullscreen();
    } catch {
      setNotice("Full screen didn't open. Try again.");
    }
  };

  const ownsSession = facts.session.ownerUserId === facts.viewerId;
  return (
    <div
      ref={panel}
      className="flex min-h-0 flex-1 flex-col bg-background"
      // Escape leaves full screen even while the screen takes the keys.
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || document.fullscreenElement !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        void document
          .exitFullscreen()
          .catch(() => setNotice("Full screen didn't close. Try Esc again."));
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-2.5 max-lg:px-4">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-row" role="status">
          <span className="text-foreground">{bar.title}</span>
          {bar.sub === null ? null : <span className="text-muted-foreground">{bar.sub}</span>}
          {!owner && live ? (
            <span className="text-muted-foreground">Only {ownerName} controls this screen.</span>
          ) : null}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="font-mono text-meta text-muted-foreground">{displayWords(screen)}</span>
          {live ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="max-lg:h-11"
              onClick={() => void fullScreen()}
            >
              <Maximize2Icon aria-hidden /> Full screen
            </Button>
          ) : null}
          {live && bar.control === "take" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-lg:h-11 max-lg:px-4"
              disabled={pending !== null}
              onClick={() => void control("take")}
            >
              {pending === "take" ? "Taking over…" : "Take over"}
            </Button>
          ) : live && bar.control === "hand-back" ? (
            <Button
              type="button"
              size="sm"
              className="max-lg:h-11 max-lg:px-4"
              disabled={pending !== null}
              onClick={() => void control("hand-back")}
            >
              {pending === "hand-back" ? "Handing back…" : "Hand back"}
            </Button>
          ) : null}
        </div>
        {notice === null ? null : (
          <p role="alert" className="w-full text-meta text-destructive">
            {notice}
          </p>
        )}
      </div>
      <Stage>
        <div
          className={cn(
            "relative w-full overflow-hidden rounded-md bg-zinc-800",
            held && "ring-2 ring-primary",
          )}
          style={{ aspectRatio: `${screen.width} / ${screen.height}` }}
        >
          {live && wire._tag !== "Closed" ? (
            <div
              key={attempt}
              ref={viewer.mount}
              data-own-shortcuts
              className="absolute inset-0 [&_canvas]:cursor-default!"
            />
          ) : null}
          {live && wire._tag === "Connecting" ? (
            <Overlay>
              <p className="flex items-center gap-2 text-row text-white/80">
                <Spinner aria-hidden className="size-4" /> Connecting to the screen…
              </p>
            </Overlay>
          ) : null}
          {live && wire._tag === "Closed" ? (
            <Overlay>
              <Card
                title="Mend couldn't reach the screen."
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="max-lg:h-11 max-lg:px-4"
                    onClick={() => {
                      setWire({ _tag: "Connecting" });
                      setAttempt((count) => count + 1);
                    }}
                  >
                    Reconnect
                  </Button>
                }
                failed
              >
                The connection closed: {wire.words}. The screen is probably still running in the
                workspace, so reconnecting usually works.
              </Card>
            </Overlay>
          ) : null}
          {down === null ? null : (
            <Overlay>
              {down._tag === "Starting" ? (
                <p className="flex items-center gap-2 text-row text-white/80">
                  <Spinner aria-hidden className="size-4" /> Starting the screen…
                </p>
              ) : down._tag === "Failed" ? (
                <Card
                  title={down.started ? "The screen stopped." : "The screen didn't start."}
                  failed
                  action={
                    facts.detail.control.steer ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="max-lg:h-11 max-lg:px-4"
                        disabled={wake.isPending || waking}
                        onClick={() => wake.mutate()}
                      >
                        {wake.isPending ? "Starting…" : "Try again"}
                      </Button>
                    ) : null
                  }
                >
                  {down.started
                    ? "It stopped while the session runs."
                    : "Its display didn't come up in the workspace."}
                  {wake.isError ? ` ${failureWords(wake.error, "Mend couldn't start it.")}` : ""}
                </Card>
              ) : (
                <Card
                  title="The screen stopped with the session."
                  action={
                    ownsSession ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="max-lg:h-11 max-lg:px-4"
                        disabled={resume.isPending}
                        onClick={() => resume.mutate()}
                      >
                        {resume.isPending ? "Starting the workspace…" : "Resume session"}
                      </Button>
                    ) : null
                  }
                >
                  It starts again when the session resumes.
                  {ownsSession ? "" : ` Only ${ownerName} can resume it.`}
                  {resume.isError
                    ? ` ${failureWords(resume.error, "Mend couldn't resume the session.")}`
                    : ""}
                </Card>
              )}
            </Overlay>
          )}
        </div>
      </Stage>
    </div>
  );
}

/** The dark area the screen sits in, centred. */
function Stage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-1 items-start justify-center bg-muted/60 px-5 py-5 max-lg:px-3 max-lg:py-3">
      <div className="w-full max-w-[1160px]">{children}</div>
    </div>
  );
}

function Overlay({ children }: { readonly children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
      {children}
    </div>
  );
}

/** A state's card: a title, what to know, and what to do. */
function Card({
  title,
  children,
  action,
  failed = false,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly failed?: boolean;
}) {
  return (
    <div
      role={failed ? "alert" : "status"}
      className="flex max-w-md gap-2.5 rounded-lg border border-border bg-background px-4 py-3 text-left shadow-sm"
    >
      {failed ? (
        <CircleXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : null}
      <div className="grid gap-2">
        <p className="text-row text-muted-foreground">
          <span className="font-medium text-foreground">{title}</span> {children}
        </p>
        {action === undefined || action === null ? null : <div>{action}</div>}
      </div>
    </div>
  );
}

/** The screen log: what the agent and people did on the screen, newest first. */
function ScreenLog({
  place,
  personHolds,
}: {
  readonly place: ViewPlace;
  /** A person holds the input: their clicks and keys have no event, so the log is read often. */
  readonly personHolds: boolean;
}) {
  const trpc = useTRPC();
  const facts = useSessionFacts(place.sessionId);
  const log = useQuery(
    trpc.screens.log.queryOptions(
      { id: place.sessionId },
      { refetchInterval: personHolds ? SCREEN_LOG_MS : false },
    ),
  );
  const nameOf = (userId: string) =>
    userId === facts.viewerId ? "You" : (facts.nameOf(userId) ?? "Someone");
  return (
    <section aria-label="Screen log" className="border-t border-border px-5 pt-3 pb-4 max-lg:px-4">
      <div className="mb-1 flex items-baseline gap-3">
        <h3 className="text-row font-medium text-foreground">Screen log</h3>
        <span className="ml-auto text-meta text-muted-foreground">Frames are kept for 30 days</span>
      </div>
      {log.isPending ? (
        <p role="status" className="text-meta text-muted-foreground">
          Reading the screen log…
        </p>
      ) : log.isError ? (
        <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
          <span role="alert">The screen log didn&apos;t load.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-lg:h-11 max-lg:px-4"
            disabled={log.isFetching}
            onClick={() => void log.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : log.data.length === 0 ? (
        <p className="text-meta text-muted-foreground">
          Nothing on the screen yet. What the agent and people do on it shows here.
        </p>
      ) : (
        <ol>
          {log.data.map((entry) => (
            <li
              key={`${entry.screenId}:${entry.seq}`}
              className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 border-b border-border py-2 text-row last:border-b-0 sm:grid-cols-[84px_150px_minmax(0,1fr)_auto]"
            >
              <time dateTime={entry.at.toISOString()} className="font-mono text-muted-foreground">
                {clockSeconds(entry.at)}
              </time>
              <span className="truncate text-muted-foreground max-sm:hidden">
                {screenLogActor(entry, facts.agent, nameOf)}
              </span>
              <span className="min-w-0 truncate text-foreground">
                <span className="sm:hidden">{screenLogActor(entry, facts.agent, nameOf)} · </span>
                {screenLogWords(entry)}
              </span>
              <span className="font-mono text-meta text-muted-foreground max-sm:hidden">
                {entry.frame === null
                  ? ""
                  : entry.frame.state === "stored"
                    ? `frame ${entry.seq}`
                    : `frame ${entry.frame.state}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Note({
  children,
  busy = false,
}: {
  readonly children: ReactNode;
  readonly busy?: boolean;
}) {
  return (
    <div role="status" className="px-5 py-5 max-lg:px-4">
      <p className="flex items-start gap-2 text-row text-muted-foreground">
        {busy ? <Spinner aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
        <span>{children}</span>
      </p>
    </div>
  );
}

/** The Screen view: the workspace's desktop, live (route PR 19). */
export const SCREEN_VIEW: WorkspaceView = {
  id: "screen",
  name: "Screen",
  icon: <MonitorIcon />,
  useFacts: useScreenFacts,
  Body: ScreenBody,
};
