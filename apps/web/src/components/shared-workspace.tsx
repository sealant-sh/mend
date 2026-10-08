import {
  preReleaseMemoryLine,
  REPLACE_WORKSPACE_ACTION,
  SHARED_CONTROL_CONFIRM,
} from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mend/ui/components/ui/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  type ConversationWaitDto,
  type ConversationWaitWorkDto,
  endBackgroundWork,
  replaceWorkspace,
  type SessionDto,
} from "#/lib/api";
import {
  replaceRefusalWords,
  retirementView,
  type RetirementView,
  useMemberNames,
} from "#/lib/shared-workspace";
import { useTRPC } from "#/lib/trpc";

/**
 * What the session page says where people share a workspace (docs/adr/0016-per-person-harness-homes.md,
 * decisions 6, 13 and 14), in the domain's words. Each view here is pure and takes its facts; the
 * wrappers below read them through the API.
 */

/** How often a live session re-reads what can change without an event: the waiting line. */
const WAIT_POLL_MS = 5_000;
/** And its executor's retirement, which a replacement attempt moves on its own. */
const RETIREMENT_POLL_MS = 10_000;

// ─── The waiting line (decision 6) ─────────────────────────────────────────────

/** "Waits for Alice's 2 background tasks … before Bob's turn starts.", and what can end it. */
export function WaitingLineView({
  wait,
  canEnd,
  pending,
  error,
  onEnd,
}: {
  readonly wait: ConversationWaitDto;
  /** The viewer is the person the work runs as, or the session's owner. */
  readonly canEnd: boolean;
  /** The work being ended, by its harness id. */
  readonly pending: string | null;
  readonly error: string | null;
  readonly onEnd: (work: ConversationWaitWorkDto) => void;
}) {
  const endable = canEnd ? wait.work.filter((work) => work.endable) : [];
  return (
    <div className="mb-3">
      <p role="status" className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-2">
        <span
          aria-hidden="true"
          className="mend-status-running mt-[7px] size-2 shrink-0 rounded-full border-[1.5px] border-faint"
        />
        <span>{wait.line}</span>
      </p>
      {endable.length > 0 && (
        <ul aria-label="Work the turn waits for" className="mt-1.5 ml-4 space-y-1">
          {endable.map((work) => (
            <li key={`${work.kind}:${work.id}`} className="flex items-baseline gap-3">
              <span className="min-w-0 truncate font-mono text-[11.5px] text-faint">
                {work.kind} · {work.description ?? work.id}
              </span>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => onEnd(work)}
                className="shrink-0 font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {pending === work.id ? "Ending…" : "End"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error === null ? null : (
        <p role="alert" className="mt-1.5 ml-4 font-mono text-xs text-warning">
          {error}
        </p>
      )}
    </div>
  );
}

/** The waiting line wherever the session's turns show; nothing while no turn waits. */
export function WaitingLine({
  sessionId,
  live,
  viewerId,
  ownerUserId,
}: {
  readonly sessionId: string;
  readonly live: boolean;
  readonly viewerId: string | null;
  readonly ownerUserId: string | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const wait = useQuery(
    trpc.sessions.conversationWait.queryOptions(
      { id: sessionId },
      { refetchInterval: live ? WAIT_POLL_MS : false, retry: false },
    ),
  ).data;
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (wait === undefined || wait === null) return null;
  const end = (work: ConversationWaitWorkDto) => {
    setPending(work.id);
    setError(null);
    void endBackgroundWork(sessionId, work)
      .then(() =>
        queryClient.invalidateQueries(
          trpc.sessions.conversationWait.queryFilter({ id: sessionId }),
        ),
      )
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(null));
  };
  return (
    <WaitingLineView
      wait={wait}
      canEnd={viewerId !== null && (viewerId === wait.runsAs || viewerId === ownerUserId)}
      pending={pending}
      error={error}
      onEnd={end}
    />
  );
}

// ─── An executor waiting to be replaced (decision 14) ─────────────────────────

/** The retirement line, what would stop, and "Replace this workspace now" for the change's owner. */
export function WorkspaceRetirementView({
  view,
  pending,
  refusal,
  onReplace,
}: {
  readonly view: RetirementView;
  readonly pending: boolean;
  /** Why the last "Replace this workspace now" was refused, in the server's words. */
  readonly refusal: string | null;
  readonly onReplace: () => void;
}) {
  return (
    <div className="mt-4 max-w-[760px] border-l-2 border-[var(--sw-accent)] pl-3">
      <p className="text-[13px] leading-relaxed text-ink-2">{view.line}</p>
      {view.canReplace && (
        <>
          <ul aria-label="What would stop" className="mt-2 space-y-0.5">
            {view.stops.map((stop) => (
              <li key={stop} className="font-mono text-[11.5px] text-faint">
                {stop}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={pending}
            onClick={onReplace}
            className="mt-3 rounded-xl border border-border bg-card px-4 py-2 font-sans text-sm font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            {pending ? "Replacing…" : REPLACE_WORKSPACE_ACTION}
          </button>
        </>
      )}
      {refusal === null ? null : (
        <p
          role="alert"
          className="mt-2 border-l-2 border-[var(--sw-amber)] pl-3 text-[13px] leading-relaxed text-ink-2"
        >
          {refusal}
        </p>
      )}
    </div>
  );
}

/** The session's executor retirement, as the API reports it; nothing while none is under way. */
export function WorkspaceRetirementNote({
  sessionId,
  live,
  livePeople,
}: {
  readonly sessionId: string;
  readonly live: boolean;
  readonly livePeople: SessionDto["livePeople"];
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const names = useMemberNames();
  const retirement = useQuery(
    trpc.sessions.workspaceRetirement.queryOptions(
      { id: sessionId },
      { refetchInterval: live ? RETIREMENT_POLL_MS : false, retry: false },
    ),
  ).data;
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  if (retirement === undefined || retirement === null) return null;
  const replace = () => {
    setPending(true);
    setRefusal(null);
    void replaceWorkspace(sessionId)
      .then(() => queryClient.invalidateQueries(trpc.sessions.pathFilter()))
      .catch((cause: unknown) => setRefusal(replaceRefusalWords(cause)))
      .finally(() => setPending(false));
  };
  return (
    <WorkspaceRetirementView
      view={retirementView(retirement, names, livePeople)}
      pending={pending}
      refusal={refusal}
      onReplace={replace}
    />
  );
}

// ─── Memory from before per-person homes (decision 14) ────────────────────────

/** "memory from before 0.36, not credited · 2 files", with the paths on hover; null otherwise. */
export function PreReleaseMemoryNote({ worktreeId }: { readonly worktreeId: string }) {
  const trpc = useTRPC();
  const memory = useQuery(
    trpc.worktrees.detail.queryOptions({ id: worktreeId }, { retry: false, staleTime: 60_000 }),
  ).data?.preReleaseMemory;
  const line = preReleaseMemoryLine(memory ?? null);
  if (line === null || memory === undefined || memory === null) return null;
  return (
    <p
      className="mt-1 font-mono text-xs break-words text-faint"
      title={memory.notCredited.join("\n")}
    >
      {line}
    </p>
  );
}

// ─── Shared control's confirmation (decision 13) ──────────────────────────────

/** What the switch asks before shared control goes on. Pure: the switch owns the state. */
export function SharedControlConfirmBody({
  pending,
  onConfirm,
  onCancel,
}: {
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
        {SHARED_CONTROL_CONFIRM.cancel}
      </Button>
      <Button type="button" disabled={pending} onClick={onConfirm} className="min-w-24">
        {pending ? "Turning on…" : SHARED_CONTROL_CONFIRM.confirm}
      </Button>
    </div>
  );
}

export function SharedControlConfirmDialog({
  open,
  pending,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      disablePointerDismissal={pending}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      {open && (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{SHARED_CONTROL_CONFIRM.title}</DialogTitle>
            <DialogDescription>{SHARED_CONTROL_CONFIRM.body}</DialogDescription>
          </DialogHeader>
          <SharedControlConfirmBody pending={pending} onConfirm={onConfirm} onCancel={onCancel} />
        </DialogContent>
      )}
    </Dialog>
  );
}
