import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ProjectCrumbs } from "#/components/breadcrumb";
import { FollowUpBanner } from "#/components/follow-up";
import { ServicesCard } from "#/components/services-card";
import { AppShell } from "#/components/shell";
import { SessionStatusDot } from "#/components/status";
import { SessionTerminal } from "#/components/terminal";
import {
  agentIsLive,
  checkpointSession,
  removeSession,
  resumeSession,
  setSessionLabel,
  setSharedControl,
  stopSession,
  type TranscriptEventDto,
} from "#/lib/api";
import { sessionDotfilesLines } from "#/lib/session-dotfiles";
import { useResolvedDark } from "#/lib/theme";
import { useTRPC } from "#/lib/trpc";
import { runsAsLine, useViewer } from "#/lib/viewer";
import { useWorkbenchEvents } from "#/lib/workbench-events";

export const Route = createFileRoute("/sessions/$sessionId")({
  ssr: false,
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      context.trpc.sessions.detail.queryOptions({ id: params.sessionId }),
    );
  },
  component: SessionPage,
});

const ACTIVE = new Set(["starting", "running", "waiting", "idle"]);

function TranscriptEvent({ event }: { readonly event: TranscriptEventDto }) {
  if (event.kind === "user" && event.text !== null) {
    return (
      <div className="ml-auto max-w-[85%] rounded-xl bg-secondary px-3.5 py-2.5">
        <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-foreground">
          {event.text}
        </p>
      </div>
    );
  }
  if (event.kind === "assistant" && event.text !== null) {
    return (
      <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{event.text}</p>
    );
  }
  if (event.kind === "reasoning" && event.text !== null) {
    return <p className="line-clamp-2 font-mono text-[11px] text-faint">{event.text}</p>;
  }
  if (event.kind === "tool") {
    return (
      <div className="rounded-lg bg-secondary px-3 py-2">
        <p className="font-mono text-[11.5px] text-ink-2">
          {event.command !== null ? `$ ${event.command}` : `⚙ ${event.name ?? "tool"}`}
        </p>
        {event.output !== null && event.output !== "" && (
          <p className="mt-1 line-clamp-3 font-mono text-[10.5px] whitespace-pre-wrap text-faint">
            {event.output}
          </p>
        )}
      </div>
    );
  }
  return null;
}

/** The durable record, conversation-shaped — what the ephemeral SSE lines could never replay. */
function TranscriptPane({ sessionId }: { readonly sessionId: string }) {
  const trpc = useTRPC();
  const transcript = useQuery(trpc.sessions.transcript.queryOptions({ id: sessionId }));
  if (transcript.isLoading) {
    return <p className="p-4 font-mono text-xs text-faint">reading the record…</p>;
  }
  const events = transcript.data?.events ?? [];
  if (events.length === 0) {
    return (
      <p className="p-4 font-mono text-xs text-faint">
        {transcript.isError
          ? "the record could not be read — it stays on the platform"
          : "no conversation recorded — open the change for the reviewed diff"}
      </p>
    );
  }
  return (
    <div className="flex max-h-[480px] flex-col gap-2.5 overflow-y-auto p-4">
      {events.map((event, index) => (
        <TranscriptEvent key={index} event={event} />
      ))}
    </div>
  );
}

function SessionPage() {
  const { sessionId } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { session, checkpoints, change, currentAgent, control } = useSuspenseQuery(
    trpc.sessions.detail.queryOptions({ id: sessionId }),
  ).data;
  // Steering is the owner's unless they share control (docs/adr/0003); the API says what this
  // viewer may do, and the roster names whose credentials the session runs on.
  const viewer = useViewer();
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { retry: false }));
  const names = new Map((members.data ?? []).map((member) => [member.userId, member.name]));
  const runsAs = runsAsLine(session, viewer?.userId ?? null, names);
  const ownerName =
    session.ownerUserId === null ? null : (names.get(session.ownerUserId) ?? "its owner");
  // The agent's liveness, not the session fold: a shell holding the workspace keeps the session
  // `idle`, but the terminal, stop, and resume controls are about the AGENT.
  const agentLive = agentIsLive(session, currentAgent);
  const agentPty = currentAgent?.sealantSessionId ?? session.sealantSessionId;
  const followUp = useSuspenseQuery(
    trpc.sessions.pendingFollowUp.queryOptions({ id: sessionId }),
  ).data;
  const [pending, setPending] = useState<"stop" | "checkpoint" | "resume" | null>(null);
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<"idle" | "armed" | "working">("idle");
  const navigate = useNavigate();
  const dark = useResolvedDark();
  useWorkbenchEvents();

  const saveLabel = () => {
    if (labelDraft === null) return;
    const next = labelDraft.trim();
    setLabelDraft(null);
    if (next === (session.label ?? "")) return;
    void setSessionLabel(sessionId, next === "" ? null : next).then(() =>
      queryClient.invalidateQueries(trpc.sessions.pathFilter()),
    );
  };

  /** Second click executes — destructive actions confirm explicitly (plan §15). */
  const deleteSession = () => {
    if (deleting === "idle") {
      setDeleting("armed");
      return;
    }
    if (deleting !== "armed") return;
    setDeleting("working");
    void removeSession(sessionId)
      .then(() => {
        void queryClient.invalidateQueries();
        return navigate({ to: "/projects/$projectId", params: { projectId: session.projectId } });
      })
      .catch(() => setDeleting("idle"));
  };

  const act = (kind: "stop" | "checkpoint") => {
    setPending(kind);
    const action =
      kind === "stop" ? stopSession(sessionId) : checkpointSession(sessionId, "user-mark");
    void action
      .then(() => queryClient.invalidateQueries(trpc.sessions.pathFilter()))
      .finally(() => setPending(null));
  };

  return (
    <AppShell projectId={session.projectId}>
      <div className="min-w-0">
        <ProjectCrumbs projectId={session.projectId} leaf="session" />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
          {labelDraft === null ? (
            <h1 className="font-display text-3xl font-medium tracking-tight text-foreground">
              {session.harness}
              {session.label === null ? "" : ` — ${session.label}`}
              {control.own ? (
                <button
                  type="button"
                  onClick={() => setLabelDraft(session.label ?? "")}
                  title="Rename this session"
                  className="ml-3 align-middle font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  rename
                </button>
              ) : null}
            </h1>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="font-display text-3xl font-medium tracking-tight text-foreground">
                {session.harness} —
              </h1>
              <input
                autoFocus
                value={labelDraft}
                onChange={(event) => setLabelDraft(event.target.value)}
                onBlur={saveLabel}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveLabel();
                  if (event.key === "Escape") setLabelDraft(null);
                }}
                placeholder="what this session is about"
                className="rounded-lg border border-input bg-background px-3 py-1.5 font-sans text-lg text-foreground placeholder:text-faint"
              />
            </div>
          )}
          <SessionStatusDot status={session.status} recorded={session.sealantRunId !== null} />
        </div>
        <p className="mt-2 font-mono text-xs text-faint">
          {session.branch} · worktree {session.worktree} · base{" "}
          {session.baseRef === null
            ? session.baseSha.slice(0, 12)
            : `${session.baseRef} @ ${session.baseSha.slice(0, 7)}`}
          {session.startedAt === null
            ? ""
            : ` · started ${new Date(session.startedAt).toLocaleTimeString()}`}
          {runsAs === null ? "" : ` · ${runsAs}`}
        </p>
        {sessionDotfilesLines(session.dotfiles).map((line) => (
          <p
            key={line.text}
            className={`mt-1 font-mono text-xs break-words ${line.notApplied ? "text-warning" : "text-faint"}`}
          >
            {line.text}
          </p>
        ))}
        {session.summary !== null && (
          <p className="mt-3 max-w-[760px] text-[14.5px] leading-relaxed text-ink-2">
            {session.summary}
          </p>
        )}
        {/* Legacy note for settled pre-platform sessions only — a session that is
            still ACTIVE without a run is provisioning, not unsupervised. */}
        {session.sealantRunId === null && !ACTIVE.has(session.status) && (
          <p className="mt-3 font-mono text-xs text-warning">
            recording: off — launched before the platform&apos;s supervised path; worktree,
            checkpoints, and review are live
          </p>
        )}
        {control.steer ? <FollowUpBanner sessionId={sessionId} followUp={followUp} /> : null}
        <SharedControl
          sessionId={sessionId}
          ownerSteers={viewer !== null && viewer.userId === session.ownerUserId}
          shared={session.sharedControlEnabledAt !== null}
          canToggle={control.toggleSharedControl}
          steer={control.steer}
          ownerName={ownerName}
        />

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {change !== null && (
            <Link
              to="/changes/$changeId"
              params={{ changeId: change.id }}
              className="rounded-xl bg-primary px-4 py-2 font-sans text-sm font-medium text-primary-foreground no-underline shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5"
            >
              Review the change
            </Link>
          )}
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => act("checkpoint")}
            className="rounded-xl border border-border bg-card px-4 py-2 font-sans text-sm font-medium text-foreground shadow-xs transition-opacity disabled:opacity-50"
          >
            {pending === "checkpoint" ? "Marking…" : "Mark checkpoint"}
          </button>
          {agentLive && control.stop && (
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => act("stop")}
              className="font-sans text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {pending === "stop" ? "Stopping…" : "Stop"}
            </button>
          )}
          {!agentLive && control.own && (
            <button
              type="button"
              disabled={deleting === "working"}
              onClick={deleteSession}
              onBlur={() => setDeleting((current) => (current === "armed" ? "idle" : current))}
              className={`font-sans text-sm font-medium transition-colors disabled:opacity-50 ${deleting === "armed" ? "text-[var(--sw-red)]" : "text-muted-foreground hover:text-foreground"}`}
            >
              {deleting === "working"
                ? "Deleting…"
                : deleting === "armed"
                  ? "Really delete this session? The worktree, its change, and checkpoints remain."
                  : "Delete…"}
            </button>
          )}
          {!agentLive && control.steer && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-label">resume with:</span>
              {(["claude", "codex", "opencode"] as const).map((harness) => (
                <button
                  key={harness}
                  type="button"
                  disabled={pending !== null}
                  onClick={() => {
                    setPending("resume");
                    void resumeSession(sessionId, harness === session.harness ? null : harness)
                      .catch(() => undefined)
                      .finally(() => {
                        void queryClient.invalidateQueries(trpc.sessions.pathFilter());
                        setPending(null);
                      });
                  }}
                  className={`rounded-xl border px-3 py-1.5 font-mono text-xs shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-50 ${harness === session.harness ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] text-foreground" : "border-border text-muted-foreground"}`}
                >
                  {pending === "resume" ? "…" : harness}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-9 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-w-0">
            {agentPty === null && agentLive ? (
              <>
                <p className="text-xs font-medium text-label">Terminal</p>
                <div className="mt-3 overflow-hidden rounded-2xl bg-card shadow-sm">
                  <div className="border-b border-rule-faint bg-secondary px-4 py-2">
                    <p className="font-mono text-[11.5px] text-muted-foreground">
                      provisioning workspace — a first launch builds the harness image (can take
                      minutes)…
                    </p>
                  </div>
                  <p className="p-4 font-mono text-xs text-faint">
                    The terminal attaches here the moment the PTY is live.
                  </p>
                </div>
              </>
            ) : agentPty !== null && agentLive && control.steer ? (
              <>
                <p className="text-xs font-medium text-label">Terminal</p>
                <div className="mt-3 overflow-hidden rounded-2xl bg-card shadow-sm">
                  <div className="flex items-center gap-2 border-b border-rule-faint bg-secondary px-4 py-2">
                    <span className="size-1.5 animate-pulse rounded-full bg-[var(--sw-red)]" />
                    <p className="font-mono text-[11.5px] text-muted-foreground">
                      run {session.sealantRunId} · live — the same session your terminal holds
                    </p>
                  </div>
                  {/* Keyed on the PLATFORM session: `mend continue` reopens the
                      session with a fresh PTY, and the pane must reconnect. */}
                  {/* Keyed on theme too: the terminal snapshots CSS variables at
                      attach, and a remount replays the record into the new palette. */}
                  <SessionTerminal
                    key={`${agentPty}:${dark ? "dark" : "light"}`}
                    sessionId={session.id}
                  />
                </div>
              </>
            ) : (
              <>
                <p className="text-xs font-medium text-label">Record</p>
                <div className="mt-3 overflow-hidden rounded-2xl bg-card shadow-sm">
                  <div className="border-b border-rule-faint bg-secondary px-4 py-2">
                    <p className="font-mono text-[11.5px] text-muted-foreground">
                      {session.sealantRunId === null
                        ? "no record — the session was not supervised"
                        : agentLive
                          ? `run ${session.sealantRunId} · the owner's terminal; the record updates as the session runs`
                          : `run ${session.sealantRunId} · the durable record`}
                    </p>
                  </div>
                  {session.sealantRunId === null ? (
                    <p className="p-4 font-mono text-xs text-faint">
                      Progress appears here once sessions launch supervised.
                    </p>
                  ) : (
                    <TranscriptPane sessionId={sessionId} />
                  )}
                </div>
              </>
            )}
          </section>

          <section>
            <p className="text-xs font-medium text-label">Checkpoints</p>
            <div className="mt-3 overflow-hidden rounded-2xl bg-card shadow-sm">
              {checkpoints.length === 0 ? (
                <p className="p-4 font-mono text-xs text-faint">none yet</p>
              ) : (
                checkpoints.map((checkpoint, index) => (
                  <div
                    key={checkpoint.id}
                    className={`px-4 py-3 ${index === 0 ? "" : "border-t border-rule-faint"}`}
                  >
                    <p className="font-mono text-xs text-ink-2">
                      {index} · {checkpoint.trigger}
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-faint">
                      {checkpoint.sha.slice(0, 12)} · seq {checkpoint.seq} ·{" "}
                      {new Date(checkpoint.createdAt).toLocaleTimeString()}
                    </p>
                  </div>
                ))
              )}
            </div>
            <ServicesCard
              sessionId={sessionId}
              sessionLive={ACTIVE.has(session.status)}
              steer={control.steer}
            />
          </section>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * Shared control (docs/adr/0003): the owner lends their credentials so everyone who can see the
 * project may steer; an organization owner may take it back. Everyone else is told who steers.
 */
export function SharedControl({
  sessionId,
  ownerSteers,
  shared,
  canToggle,
  steer,
  ownerName,
}: {
  readonly sessionId: string;
  /** The viewer owns the session. */
  readonly ownerSteers: boolean;
  readonly shared: boolean;
  readonly canToggle: boolean;
  readonly steer: boolean;
  readonly ownerName: string | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (enabled: boolean) => {
    setPending(true);
    setError(null);
    void setSharedControl(sessionId, enabled)
      .then(() => queryClient.invalidateQueries(trpc.sessions.pathFilter()))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false));
  };

  if (!ownerSteers && !canToggle) {
    if (steer || ownerName === null) return null;
    return (
      <p className="mt-4 max-w-[760px] border-l-2 border-[var(--sw-accent)] pl-3 text-[13px] leading-relaxed text-ink-2">
        Only {ownerName} steers this session. You can read the record and review the change.
      </p>
    );
  }

  return (
    <div className="mt-4 max-w-[760px]">
      {ownerSteers ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-label">Shared control</span>
          <div role="group" aria-label="Shared control" className="flex rounded-lg bg-wash p-0.5">
            {([false, true] as const).map((enabled) => (
              <button
                key={String(enabled)}
                type="button"
                aria-pressed={shared === enabled}
                disabled={pending}
                onClick={() => {
                  if (shared !== enabled) toggle(enabled);
                }}
                className={`rounded-md px-2.5 py-1 font-sans text-xs font-medium transition-colors ${
                  shared === enabled
                    ? "bg-panel text-foreground shadow-[var(--shadow-xs)]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {enabled ? "On" : "Off"}
              </button>
            ))}
          </div>
          <p className="basis-full text-[12.5px] leading-relaxed text-muted-foreground">
            On lets everyone who can see this project send turns, answer approvals, interrupt, and
            type in the terminal, using your provider logins and Git access. Every action is
            recorded with who sent it.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-ink-2">
            {ownerName ?? "Its owner"} shares control of this session.
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => toggle(false)}
            className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {pending ? "Turning off…" : "Turn off"}
          </button>
        </div>
      )}
      {error === null ? null : (
        <p
          role="alert"
          className="mt-2 border-l-2 border-[var(--sw-red)] pl-3 text-[13px] leading-relaxed text-danger"
        >
          {error}
        </p>
      )}
    </div>
  );
}
