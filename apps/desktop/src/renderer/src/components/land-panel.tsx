import { pullRequestTitle } from "@mend/domain/workbench";
import { Sheet, SheetHeader } from "@mend/ui/sheet";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  landSession,
  refreshLanding,
  sessionLandings,
  type ChangeLandingDto,
  type ChangeLandingsDto,
  type LandingFactDto,
  type LandingReportDto,
} from "#/lib/api";
import {
  factLine,
  factsWithProbe,
  factTone,
  heldBack,
  landButtonLabel,
  landingRecordLine,
  landingRecordMeta,
  landingReportLine,
  landRequestOf,
  latestPullRequest,
  nextRemoteBranch,
  pullRequestToUpdate,
  remoteLine,
  type FactTone,
} from "#/lib/landing";
import { useNow } from "#/lib/now";
import { queryClient, sessionLandingsQuery } from "#/lib/queries";

/**
 * Landing (docs/adr/0007-landing.md), the desktop's half of the web's Land panel: where the
 * change goes, what Mend observed about earlier landings, and the owner's one button. Everyone
 * who can see the change reads the facts; only the change's owner (the owner of its worktree's
 * first session, which the server answers as `land`) sees the form, because landing pushes with
 * their key and speaks as them on GitHub. Mend never merges: the pull request is where the
 * project reviews it.
 */

const DOT: Record<FactTone, string> = {
  observed: "bg-success-dot",
  failure: "bg-danger-dot",
  neutral: "border-[1.5px] border-faint bg-transparent",
};

const errorWords = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * One observed fact: a dot and a mono line, red only for an observed failure. It wraps unless
 * `truncate` asks for one line, so a refusal keeps the remote's whole sentence.
 */
export function LandingFactLine({
  fact,
  now,
  truncate = false,
  className = "",
}: {
  readonly fact: LandingFactDto;
  readonly now: Date;
  readonly truncate?: boolean;
  readonly className?: string;
}) {
  const tone = factTone(fact);
  return (
    <p
      className={`flex min-w-0 items-baseline gap-2 font-mono text-[11.5px] text-ink-2 ${className}`}
    >
      <span
        aria-hidden="true"
        className={`relative top-[-1px] inline-block size-1.5 shrink-0 rounded-full ${DOT[tone]}`}
      />
      <span
        className={`min-w-0 ${truncate ? "truncate" : "break-words"} ${tone === "failure" ? "text-danger" : ""}`}
      >
        {factLine(fact, now)}
      </span>
    </p>
  );
}

export interface LandDraft {
  readonly title: string;
  readonly body: string;
}

export type LandPending = "land" | "probe" | "refresh" | null;

export interface LandPanelViewProps {
  readonly view: ChangeLandingsDto;
  /** The session detail's landings, newest first: the history this change has. */
  readonly landings: ReadonlyArray<ChangeLandingDto>;
  /** The last "Check origin": the same record, with one fetch of origin's branch. */
  readonly probed: ChangeLandingsDto | null;
  readonly worktreeBranch: string;
  /** The branch the pull request merges into; null while the project loads. */
  readonly base: string | null;
  readonly defaultTitle: string;
  readonly draft: LandDraft;
  readonly pending: LandPending;
  readonly report: LandingReportDto | null;
  readonly error: string | null;
  readonly now: Date;
  readonly onDraft: (draft: LandDraft) => void;
  readonly onLand: () => void;
  readonly onProbe: () => void;
  readonly onRefresh: () => void;
  readonly onOpenPullRequest: (url: string) => void;
}

/** Quiet text action, the sheet's scale. */
function TextAction({ children, className = "", ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={`font-sans text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function LandPanelView(props: LandPanelViewProps) {
  const { view, draft, pending, now } = props;
  // The detail's list answers first; the landing read carries the same rows once it answers.
  const landings = props.landings.length > 0 ? props.landings : view.landings;
  const facts = factsWithProbe(view.facts, props.probed);
  const updates = pullRequestToUpdate(landings);
  const branch = nextRemoteBranch(landings, props.worktreeBranch);
  const recorded = latestPullRequest(landings);
  const remote = props.probed === null ? null : remoteLine(props.probed, now);
  const label = landButtonLabel({
    pullRequestAvailable: view.pullRequest.available,
    updates: updates !== null,
  });

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <p className="font-mono text-[11px] leading-relaxed text-label">
        push {props.worktreeBranch} to origin
        {branch === props.worktreeBranch ? "" : ` as ${branch}`}
        {props.base === null ? "" : ` · pull request into ${props.base}`}
      </p>

      <section aria-label="What Mend observed">
        {facts.length === 0 ? (
          <p className="font-mono text-[11.5px] text-faint">
            not landed · nothing pushed from Mend yet
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {facts.map((fact, index) => (
              <LandingFactLine key={`${fact._tag}-${index}`} fact={fact} now={now} />
            ))}
          </div>
        )}
        {!view.pullRequest.available && view.pullRequest.reason !== null && (
          <p className="mt-1 font-mono text-[11.5px] text-faint">{view.pullRequest.reason}</p>
        )}
        {remote !== null && <p className="mt-1 font-mono text-[11px] text-faint">{remote}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {landings.length > 0 && (
            <TextAction
              disabled={pending !== null}
              onClick={props.onProbe}
              title="Fetch origin's branch with your git access and compare it with the landed commit"
            >
              {pending === "probe" ? "Checking origin…" : "Check origin"}
            </TextAction>
          )}
          {view.land && recorded !== null && (
            <TextAction
              disabled={pending !== null}
              onClick={props.onRefresh}
              title="Ask GitHub for the pull request's state now; Mend does not poll it"
            >
              {pending === "refresh" ? "Asking GitHub…" : "Refresh pull request"}
            </TextAction>
          )}
          {recorded !== null && (
            <TextAction
              className="text-info hover:text-info"
              onClick={() => props.onOpenPullRequest(recorded.pullRequest.url)}
            >
              Open #{recorded.pullRequest.number} on GitHub ↗
            </TextAction>
          )}
        </div>
      </section>

      {view.land ? (
        <section aria-label="Land this change" className="border-t border-rule-faint pt-4">
          {heldBack(facts) && (
            <p className="mb-3 border-l-2 border-[var(--sw-accent)] pl-3 font-sans text-[12.5px] leading-relaxed text-ink-2">
              A completed turn left changes that Mend did not land. Landing now pushes them as you.
            </p>
          )}
          {view.pullRequest.available && (
            <>
              <label className="block">
                <span className="font-sans text-xs font-medium text-label">Pull request title</span>
                <input
                  value={draft.title}
                  disabled={pending === "land"}
                  onChange={(event) => props.onDraft({ ...draft, title: event.target.value })}
                  placeholder={updates === null ? props.defaultTitle : "kept as it is on GitHub"}
                  className="mt-1.5 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 font-sans text-[13px] text-foreground outline-none placeholder:text-faint focus:border-[var(--sw-accent)]"
                />
              </label>
              <label className="mt-3 block">
                <span className="font-sans text-xs font-medium text-label">Your description</span>
                <textarea
                  value={draft.body}
                  disabled={pending === "land"}
                  onChange={(event) => props.onDraft({ ...draft, body: event.target.value })}
                  rows={3}
                  placeholder={
                    updates === null
                      ? "Optional. Written above Mend's section."
                      : "Optional. Left empty, text people wrote on GitHub is kept."
                  }
                  className="mt-1.5 w-full resize-y rounded-lg border border-input bg-background px-2.5 py-1.5 font-sans text-[13px] leading-relaxed text-foreground outline-none placeholder:text-faint focus:border-[var(--sw-accent)]"
                />
              </label>
              <p className="mt-1 font-sans text-[11px] leading-relaxed text-label">
                Mend&apos;s section follows yours: the review tour&apos;s summary when there is one,
                the changed files, and links back to the session and the landed checkpoint.
              </p>
            </>
          )}
          <button
            type="button"
            disabled={pending !== null}
            onClick={props.onLand}
            className="mt-4 rounded-xl bg-primary px-3.5 py-1.5 font-sans text-[13px] font-medium text-primary-foreground shadow-cobalt transition-transform hover:-translate-y-px disabled:opacity-50"
          >
            {pending === "land" ? "Landing…" : label}
          </button>
          <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-faint">
            checkpoints the worktree, commits what the agent left uncommitted, fast-forward only ·
            merging stays on GitHub
          </p>
        </section>
      ) : facts.length === 0 ? null : (
        <p className="font-mono text-[10.5px] text-faint">only the change&apos;s owner lands it</p>
      )}

      {props.report !== null && (
        <p role="status" className="font-mono text-[11.5px] text-ink-2">
          {landingReportLine(props.report)}
        </p>
      )}
      {props.error !== null && (
        <p
          role="alert"
          className="border-l-2 border-[var(--sw-red)] pl-3 font-sans text-[12.5px] leading-relaxed text-danger"
        >
          {props.error}
        </p>
      )}

      {landings.length > 0 && (
        <section aria-label="Landings" className="border-t border-rule-faint pt-3">
          <p className="ev-eyebrow">Landings</p>
          <ol className="mt-1.5">
            {landings.map((landing) => (
              <li key={landing.id} className="border-b border-rule-faint py-2 last:border-0">
                <p
                  className={`font-mono text-[11px] break-words ${
                    landing.outcome === "refused" || landing.outcome === "failed"
                      ? "text-danger"
                      : "text-ink-2"
                  }`}
                >
                  {landingRecordLine(landing)}
                </p>
                <p className="mt-0.5 font-mono text-[10.5px] text-faint">
                  {landingRecordMeta(landing, now)}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/**
 * The Land panel for one session's change, wired to the server: the landing record from
 * `GET /api/sessions/:id/landings`, the history from the session detail, and the owner's land,
 * check and refresh. A server from before landing answers the read with 404, and the panel says
 * so instead of offering a button that would fail.
 */
export function LandPanel({
  sessionId,
  sessionLabel,
  worktreeBranch,
  base,
  landings,
}: {
  readonly sessionId: string;
  readonly sessionLabel: string | null;
  readonly worktreeBranch: string;
  readonly base: string | null;
  readonly landings: ReadonlyArray<ChangeLandingDto>;
}) {
  const view = useQuery(sessionLandingsQuery(sessionId));
  const now = new Date(useNow());
  const [draft, setDraft] = useState<LandDraft>({ title: "", body: "" });
  const [pending, setPending] = useState<LandPending>(null);
  const [probed, setProbed] = useState<ChangeLandingsDto | null>(null);
  const [report, setReport] = useState<LandingReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (view.isError) {
    return (
      <p className="px-4 py-4 font-mono text-[11.5px] text-faint">
        landing record unavailable · {errorWords(view.error)}
      </p>
    );
  }
  if (view.data === undefined) {
    return <p className="px-4 py-4 font-mono text-[11.5px] text-faint">reading the landings…</p>;
  }
  const data = view.data;
  // A landing runs as the change's session, which the record names.
  const landingSession = data.sessionId ?? sessionId;

  const settle = (work: Promise<unknown>) =>
    work
      .catch((cause: unknown) => setError(errorWords(cause)))
      .finally(() => {
        setPending(null);
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
        if (landingSession !== sessionId) {
          void queryClient.invalidateQueries({ queryKey: ["session", landingSession] });
        }
      });

  return (
    <LandPanelView
      view={data}
      landings={landings}
      probed={probed}
      worktreeBranch={worktreeBranch}
      base={base}
      defaultTitle={pullRequestTitle({ explicit: null, label: sessionLabel, sessionId })}
      draft={draft}
      pending={pending}
      report={report}
      error={error}
      now={now}
      onDraft={setDraft}
      onLand={() => {
        setPending("land");
        setError(null);
        setReport(null);
        void settle(
          landSession(landingSession, landRequestOf(draft)).then((landed) => {
            // What origin held before this landing no longer describes it.
            setProbed(null);
            return setReport(landed);
          }),
        );
      }}
      onProbe={() => {
        setPending("probe");
        setError(null);
        void settle(sessionLandings(sessionId, true).then(setProbed));
      }}
      onRefresh={() => {
        const recorded = latestPullRequest(data.landings);
        if (recorded === null) return;
        setPending("refresh");
        setError(null);
        void settle(refreshLanding(recorded.landingId));
      }}
      onOpenPullRequest={(url) => void window.mend.shell.openExternal(url)}
    />
  );
}

/** The Land panel as a side sheet over the session's terminal, like Services. */
export function LandSheet({
  sessionId,
  sessionLabel,
  worktreeBranch,
  base,
  landings,
  onClose,
}: {
  readonly sessionId: string;
  readonly sessionLabel: string | null;
  readonly worktreeBranch: string;
  readonly base: string | null;
  readonly landings: ReadonlyArray<ChangeLandingDto>;
  readonly onClose: () => void;
}) {
  return (
    <Sheet
      label="Land the change"
      header={
        <SheetHeader title="Land" meta={sessionLabel ?? worktreeBranch}>
          <TextAction onClick={onClose}>Close</TextAction>
        </SheetHeader>
      }
    >
      <LandPanel
        sessionId={sessionId}
        sessionLabel={sessionLabel}
        worktreeBranch={worktreeBranch}
        base={base}
        landings={landings}
      />
    </Sheet>
  );
}
