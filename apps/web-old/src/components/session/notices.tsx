import { sharedWorkspaceLine } from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { FollowUpBanner } from "#/components/follow-up";
import { SummaryText } from "#/components/host-user-namespaces";
import { StatusWord } from "#/components/kit/status";
import { SessionLandingLineView } from "#/components/land-panel";
import { ResourceStatusLines } from "#/components/resource-status-lines";
import {
  PreReleaseMemoryNote,
  WaitingLine,
  WorkspaceRetirementNote,
} from "#/components/shared-workspace";
import { sessionCaptureLine, sessionServicesHold } from "#/lib/api";
import { sessionDotfilesLines } from "#/lib/session-dotfiles";
import { SESSION_STALE_MS } from "#/lib/session-queries";
import { useTRPC } from "#/lib/trpc";

import type { SessionFacts } from "./facts";

const ACTIVE = new Set(["starting", "running", "waiting", "idle"]);

/**
 * What Mend has to say about the session before its conversation: what holds the next turn, a
 * follow-up not yet sent, the workspace's retirement, what a stop left running or unsaved, the
 * landing, and the session summary. Each says nothing when there is nothing to say.
 */
export function SessionNotices({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const { session, control, detail, viewer } = facts;
  // Read beside the session, never in its way: until it arrives there is no banner to show.
  const followUp = useQuery(
    trpc.sessions.pendingFollowUp.queryOptions({ id: session.id }, { staleTime: SESSION_STALE_MS }),
  ).data;
  // The worktree's resources, read after the session shows: the read can restore a capture or
  // exec into the workspace, so it never holds the session back.
  const resourceLines = useQuery(
    trpc.sessions.resourceStatus.queryOptions({ id: session.id }, { staleTime: SESSION_STALE_MS }),
  ).data;
  // Another person's process live in this executor (docs/adr/0016, decision 13).
  const sharedLine =
    viewer === undefined ? null : sharedWorkspaceLine(session.livePeople, viewer?.userId ?? null);
  // A stop leaves Services running and they keep the workspace up: say so.
  const servicesHold = sessionServicesHold(session, detail.currentAgent, detail.liveServices);
  // A stop drains the executor before its workspace goes (docs/adr/0002): what it still holds.
  const captureLine = sessionCaptureLine(session);
  const settledCapture =
    session.captureNotSavedAt === null &&
    session.captureFailingSince === null &&
    (session.captureOverdueStep ?? null) === null;
  return (
    <div className="grid gap-2 empty:hidden">
      {/* The waiting line, wherever a turn shows (docs/adr/0016, decision 6). */}
      <WaitingLine
        session={session}
        live={ACTIVE.has(session.status)}
        viewerId={viewer?.userId ?? null}
        steer={control.steer}
      />
      {control.steer && followUp !== undefined ? (
        <FollowUpBanner sessionId={session.id} followUp={followUp} />
      ) : null}
      <WorkspaceRetirementNote session={session} />
      {servicesHold === null ? null : <StatusWord tone="off">{servicesHold}</StatusWord>}
      {captureLine === null ? null : (
        <StatusWord tone={settledCapture ? "off" : "wait"}>{captureLine}</StatusWord>
      )}
      {sharedLine === null ? null : (
        <p className="font-mono text-[11.5px] break-words text-ink-2">{sharedLine}</p>
      )}
      <ResourceStatusLines lines={resourceLines ?? []} />
      <PreReleaseMemoryNote memory={detail.preReleaseMemory} />
      {sessionDotfilesLines(session.dotfiles).map((line) => (
        <p
          key={line.text}
          className={`font-mono text-[11.5px] break-words ${line.notApplied ? "text-warning" : "text-faint"}`}
        >
          {line.text}
        </p>
      ))}
      {detail.change === null ? null : <LandingLine facts={facts} />}
      {session.summary === null ? null : (
        <p className="max-w-[760px] rounded-xl bg-secondary px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-line text-ink-2">
          <span className="mr-2 font-mono text-[10.5px] tracking-[0.06em] text-label uppercase">
            summary
          </span>
          <SummaryText summary={session.summary} />
        </p>
      )}
    </div>
  );
}

/** The latest landing fact, and the way to Land in the Change tab (docs/adr/0007-landing.md). */
function LandingLine({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const view = useQuery(trpc.landings.forSession.queryOptions({ id: facts.session.id })).data;
  if (view === undefined) return null;
  return (
    <SessionLandingLineView
      facts={view.facts}
      land={view.land}
      now={new Date()}
      link={
        <Link
          to="/sessions/$sessionId/change"
          params={{ sessionId: facts.session.id }}
          hash="land"
          search={true}
          className="font-sans text-xs font-medium text-info no-underline"
        >
          {view.land ? "Land →" : "Landing →"}
        </Link>
      }
    />
  );
}
