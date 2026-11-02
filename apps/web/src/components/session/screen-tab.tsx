import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";

import { Eyebrow } from "#/components/kit/button";
import { ScreenPane } from "#/components/screen-pane";
import { screenLogActor, screenLogWords } from "#/lib/screen-log";
import { clockSeconds } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";

import type { SessionFacts } from "./facts";

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
        <p
          role={screenRead.isPending ? "status" : undefined}
          className="font-mono text-[12px] text-muted-foreground"
        >
          {screenRead.isPending
            ? "Reading the screen…"
            : screenRead.isError
              ? "The screen could not be read."
              : facts.agentHarness
                ? `No screen. ${facts.agent} starts one when it needs a browser, and you watch it here.`
                : "No screen. A screen starts when an agent in this session needs a browser."}
        </p>
      ) : (
        <div className={cn("w-full", wide ? "mx-auto max-w-[800px]" : "")}>
          <ScreenPane
            sessionId={facts.session.id}
            screen={screen}
            steer={facts.control.steer}
            viewerId={facts.viewer?.userId ?? null}
            ownerName={facts.ownerName ?? "its owner"}
            nameOf={facts.nameOf}
          />
        </div>
      )}
      <ScreenLog facts={facts} />
    </div>
  );
}

/** `.slog`: the screen log, newest first; its frames are kept 30 days. */
function ScreenLog({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const log = useQuery(trpc.screens.log.queryOptions({ id: facts.session.id }));
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
