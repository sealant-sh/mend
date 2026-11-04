import { Navigate } from "@tanstack/react-router";

import { Button } from "#/components/kit/button";
import { StatusWord } from "#/components/kit/status";
import {
  editPendingLaunch,
  retryPendingLaunch,
  usePendingLaunches,
  type PendingLaunch,
} from "#/lib/pending-launches";

import { BackToSessions } from "./header";
import { YouMessage } from "./you-message";

/** The same opening message on the draft page and while a real session's first reads arrive. */
export function LaunchMessage({
  launch,
  narrow = false,
}: {
  readonly launch: PendingLaunch;
  readonly narrow?: boolean;
}) {
  return launch.prompt === "" ? null : (
    <YouMessage text={launch.prompt} from={null} note="starting…" narrow={narrow} />
  );
}

/** A session-shaped page that needs no server answer before showing the person's words. */
export function StartingSession({ draftId }: { readonly draftId: string }) {
  const launch = usePendingLaunches().find((row) => row.draftId === draftId);
  if (launch === undefined) return <Navigate to="/" replace />;
  if (launch.state._tag === "Created")
    return (
      <Navigate to="/sessions/$sessionId" params={{ sessionId: launch.state.sessionId }} replace />
    );
  return (
    <main className="flex h-dvh min-w-0 flex-1 flex-col bg-background">
      <header className="border-b border-rule px-6 py-4 max-md:px-3">
        <div className="flex items-center gap-2">
          <BackToSessions />
          <h1 className="font-sans text-[15px] font-medium">{launch.projectName}</h1>
        </div>
        <div className="mt-2 flex gap-3 font-mono text-[11px] text-muted-foreground">
          <StatusWord tone={launch.state._tag === "Failed" ? "bad" : "run"}>
            {launch.state._tag === "Failed" ? "Could not start" : "Starting"}
          </StatusWord>
          <span>{launch.harness}</span>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 max-md:px-3">
        <div className="mx-auto grid w-full max-w-[768px] gap-[18px]">
          <LaunchMessage launch={launch} />
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
            <p role="status" className="font-mono text-[12px] text-muted-foreground">
              Creating the worktree…
            </p>
          )}
        </div>
      </div>
      <div className="pointer-events-none px-6 pb-[18px] max-md:px-3">
        <p className="composer-glass mx-auto w-full max-w-[768px] rounded-[18px] border border-input px-[18px] py-3.5 text-[13.5px] text-muted-foreground shadow-md">
          {launch.harness} is starting. Write to it here once it runs.
        </p>
      </div>
    </main>
  );
}
