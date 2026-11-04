import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Button } from "#/components/kit/button";
import { Dot } from "#/components/kit/status";
import {
  editPendingLaunch,
  retryPendingLaunch,
  usePendingLaunches,
  type PendingLaunch,
} from "#/lib/pending-launches";
import { harnessName, SESSION_TABS } from "#/lib/session-view";

import { ConversationPane } from "./conversation-pane";
import { BackToSessions } from "./header";
import { YouMessage } from "./you-message";

/**
 * The one line a starting session shows under the person's message, in the look of the agent's
 * own live line, so the start reads as one sequence until the agent's first words replace it.
 */
export function StartLine({ words }: { readonly words: string }) {
  return (
    <p role="status" className="flex items-center gap-2 font-mono text-[12px] text-ink-2">
      <Dot tone="run" />
      {words}
      <span
        aria-hidden="true"
        className="inline-block h-3.5 w-[7px] rounded-[2px] bg-primary motion-safe:animate-pulse"
      />
    </p>
  );
}

/** What the composer says while the agent cannot take a message yet; the session page says the same. */
export function StartingComposer({ agent }: { readonly agent: string }) {
  return (
    <p
      role="status"
      className="composer-glass rounded-[18px] border border-dashed border-input px-[18px] py-3.5 text-[13.5px] text-muted-foreground"
    >
      {agent} is starting. Write to it here once it runs.
    </p>
  );
}

/**
 * A session before Mend can show the session itself: laid out as the session page is (header,
 * tab line, conversation, composer), so nothing moves when the real page takes its place.
 */
function StartingFrame({
  launch,
  children,
}: {
  readonly launch: PendingLaunch;
  readonly children: ReactNode;
}) {
  const failed = launch.state._tag === "Failed";
  return (
    <main aria-busy={!failed} className="flex h-dvh min-w-0 flex-1 flex-col">
      <header className="px-6 pt-3.5 max-md:px-3 max-md:pt-1.5">
        <div className="flex min-h-9 min-w-0 items-center gap-2.5 max-md:gap-2">
          <BackToSessions />
          <h1 className="flex min-w-0 items-center gap-2.5">
            <Dot tone={failed ? "bad" : "run"} />
            <span className="sr-only">{failed ? "Did not start" : "Starting"}: </span>
            <span className="truncate font-display text-[18px] leading-tight font-semibold tracking-[-0.02em]">
              New session
            </span>
            <span className="shrink-0 font-mono text-[11.5px] font-normal text-faint max-md:hidden">
              {launch.projectName}
            </span>
          </h1>
        </div>
        <div
          aria-hidden="true"
          className="mt-3 flex items-center gap-5 overflow-hidden pb-px shadow-[inset_0_-1px_0_var(--color-rule)] max-md:mt-1 max-md:gap-4"
        >
          {SESSION_TABS.map((entry) => (
            <span
              key={entry.tab}
              className={
                entry.tab === "conversation"
                  ? "relative pb-[11px] font-sans text-[13.5px] leading-[1.3] font-medium whitespace-nowrap text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-sm after:bg-primary max-md:min-h-11"
                  : "pb-[11px] font-sans text-[13.5px] leading-[1.3] font-medium whitespace-nowrap text-faint max-md:min-h-11"
              }
            >
              {entry.label}
            </span>
          ))}
        </div>
      </header>
      <ConversationPane composer={<StartingComposer agent={harnessName(launch.harness)} />}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-full max-w-[768px] gap-[18px] pb-[calc(var(--composer-height,0px)+16px)]">
            {launch.prompt === "" ? null : (
              <YouMessage text={launch.prompt} from={null} note={null} narrow={false} />
            )}
            {children}
          </div>
        </div>
      </ConversationPane>
    </main>
  );
}

/** The draft page: the person's words at once, while Mend creates the session. */
export function StartingSession({ draftId }: { readonly draftId: string }) {
  const launch = usePendingLaunches().find((row) => row.draftId === draftId);
  if (launch === undefined) return <Navigate to="/" replace />;
  if (launch.state._tag === "Created")
    return (
      <Navigate to="/sessions/$sessionId" params={{ sessionId: launch.state.sessionId }} replace />
    );
  return (
    <StartingFrame launch={launch}>
      {launch.state._tag === "Failed" ? (
        <div className="grid justify-items-start gap-3">
          <p role="alert" className="text-[13.5px] text-danger">
            {launch.state.words}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => void retryPendingLaunch(draftId)}>Try again</Button>
            <Button variant="ghost" onClick={() => editPendingLaunch(launch)}>
              Edit
            </Button>
          </div>
        </div>
      ) : (
        <StartLine words="Creating the worktree" />
      )}
    </StartingFrame>
  );
}

/** A created session whose own page is still loading: the same frame, one step further on. */
export function StartedSession({ launch }: { readonly launch: PendingLaunch }) {
  return (
    <StartingFrame launch={launch}>
      <StartLine words="Starting the workspace" />
    </StartingFrame>
  );
}
