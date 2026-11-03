import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { Eyebrow, focusRing } from "#/components/kit/button";
import { ScreenPane } from "#/components/screen-pane";
import { screenLogActor, screenLogWords } from "#/lib/screen-log";
import { clockSeconds } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";

import type { SessionFacts } from "./facts";
import { ResumeButtons } from "./resume-buttons";

/**
 * The Screen tab (screens P4, P4b, C4, X3, X7): the agent's screen, live, and its log. Anyone who
 * can see the session watches; only its owner takes over and hands back, and the agent pauses
 * until they do (docs/adr/0020-guis-in-sessions.md).
 */
export function ScreenTab({
  facts,
  wide,
}: {
  readonly facts: SessionFacts;
  /** Without a side panel the screen is held to a readable width, centred. */
  readonly wide: boolean;
}) {
  const { screen, screenRead } = facts;
  return (
    <div className="grid content-start gap-3 pb-2">
      {screen === null ? (
        <>
          <p
            role={screenRead.isPending ? "status" : undefined}
            className="font-mono text-[12px] text-muted-foreground"
          >
            {screenRead.isPending
              ? "Reading the screen…"
              : screenRead.isError
                ? "The screen could not be read."
                : facts.imageWithoutScreen !== null
                  ? null
                  : noScreenWords(facts)}
            {screenRead.isSuccess && facts.imageWithoutScreen !== null ? (
              <ScreensOff facts={facts} />
            ) : null}
          </p>
          {screenRead.isSuccess && !facts.agentLive ? (
            <div className="grid min-h-[240px] place-items-center rounded-[14px] bg-secondary p-6 text-center">
              <ResumeButtons facts={facts} />
            </div>
          ) : null}
        </>
      ) : (
        <div className={cn("w-full", wide ? "mx-auto max-w-[800px]" : "")}>
          <ScreenPane
            sessionId={facts.session.id}
            screen={screen}
            steer={facts.control.steer}
            sessionLive={facts.agentLive}
            viewerId={facts.viewer?.userId ?? null}
            ownerName={facts.ownerName ?? "its owner"}
            nameOf={facts.nameOf}
            stopped={<ResumeButtons facts={facts} />}
          />
        </div>
      )}
      <ScreenLog facts={facts} />
    </div>
  );
}

/**
 * A session with no screen in an image that has one (ADR 0020, D7): the screen starts with the
 * session's agent, so one that runs without it was given no display.
 */
export const noScreenWords = (facts: Pick<SessionFacts, "agentLive">): string =>
  facts.agentLive
    ? "No screen: this session's agent started without a display."
    : "No screen yet. It starts with the session's agent.";

/** How often the log is read again while a person holds the input. */
const SCREEN_LOG_MS = 3_000;

/** `.slog`: the screen log, newest first; its frames are kept 30 days. */
function ScreenLog({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  // The agent's looks and acts arrive with its conversation's events. A person's clicks and keys
  // have no event, so the log is read again while a person holds the input.
  const personHolds = facts.screen?.life._tag === "Live" && facts.screen.holder._tag === "Person";
  const log = useQuery(
    trpc.screens.log.queryOptions(
      { id: facts.session.id },
      { refetchInterval: personHolds ? SCREEN_LOG_MS : false },
    ),
  );
  if (log.data !== undefined && log.data.length === 0) return null;
  return (
    <section aria-label="Screen log">
      <div className="mb-1 flex items-baseline">
        <Eyebrow>Screen log</Eyebrow>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-faint">frames kept 30 days</span>
      </div>
      {log.isPending ? (
        <p role="status" className="font-mono text-[11.5px] text-muted-foreground">
          Reading the screen log…
        </p>
      ) : log.isError ? (
        <p role="alert" className="font-mono text-[11.5px] text-danger">
          The screen log did not load.
        </p>
      ) : (
        <ol className="font-mono text-[11.5px] leading-normal">
          {log.data.map((entry) => (
            <li
              key={`${entry.screenId}:${entry.seq}`}
              className="grid grid-cols-[62px_72px_minmax(0,1fr)_auto] gap-2.5 border-t border-rule-faint py-1.5 text-ink-2"
            >
              <time dateTime={entry.at.toISOString()}>{clockSeconds(entry.at)}</time>
              <span className="truncate text-muted-foreground">
                {screenLogActor(entry, facts.agent, facts.nameOf)}
              </span>
              <span className="truncate">{screenLogWords(entry)}</span>
              <span className="text-faint">
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

/**
 * A session whose own workspace image has no screen, and what gives one: one of Mend's images
 * built with Screen on (project settings → Workspace → Screen and Docker), or, for a custom
 * image, switching to one of Mend's. It describes this session's image, never the project's
 * setting now.
 */
export function ScreensOff({ facts }: { readonly facts: SessionFacts }) {
  const link = (words: string) => (
    <Link
      to="/projects/$projectId/settings/$section"
      params={{ projectId: facts.session.projectId, section: "workspace" }}
      className={cn("text-info underline-offset-2 hover:underline", focusRing)}
    >
      {words}
    </Link>
  );
  return facts.imageWithoutScreen === "custom" ? (
    <>
      No screen: this session runs on a custom workspace image, and a custom image has no screen. A
      screen needs one of Mend&apos;s images, chosen in {link("Settings → Workspace")}.
    </>
  ) : (
    <>
      No screen: this session&apos;s workspace image was built without one. Turn Screen on in{" "}
      {link("Settings → Workspace → Screen and Docker")}; a workspace built after that has one.
    </>
  );
}
