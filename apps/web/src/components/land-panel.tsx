import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  landSession,
  probeLandings,
  refreshLanding,
  type ChangeLandingsDto,
  type LandingFactDto,
  type LandingReportDto,
  type ReviewDiffFileDto,
} from "#/lib/api";
import {
  defaultPullRequestTitle,
  describedFileOfReview,
  descriptionPreview,
  factLine,
  factsWithProbe,
  factTone,
  headlineFact,
  heldBack,
  landButtonLabel,
  landingBase,
  landingReportLine,
  landRequestOf,
  nextRemoteBranch,
  pullRequestToUpdate,
  remoteLine,
  type FactTone,
} from "#/lib/landing";
import { useTRPC } from "#/lib/trpc";

/**
 * The Land panel (docs/adr/0007-landing.md, "Surfaces"): where the change goes, what its pull
 * request will say, what Mend observed about earlier landings, and the owner's one button.
 * Everyone who can see the change reads the facts; only the session's owner sees the form,
 * because landing pushes with their key and speaks as them on GitHub.
 */

const errorWords = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).replace(/^[A-Za-z]+: /, "");

const DOT: Record<FactTone, string> = {
  observed: "bg-success-dot",
  failure: "bg-danger-dot",
  neutral: "border-[1.5px] border-faint bg-transparent",
};

export function FactLine({ fact, now }: { readonly fact: LandingFactDto; readonly now: Date }) {
  const tone = factTone(fact);
  return (
    <p className="flex items-baseline gap-2 font-mono text-[11.5px] text-ink-2">
      <span
        aria-hidden="true"
        className={`relative top-[-1px] inline-block size-1.5 shrink-0 rounded-full ${DOT[tone]}`}
      />
      <span className={tone === "failure" ? "text-danger" : ""}>{factLine(fact, now)}</span>
    </p>
  );
}

export interface LandDraft {
  readonly title: string;
  readonly body: string;
}

export interface LandPanelViewProps {
  readonly view: ChangeLandingsDto;
  /** The owner's last "Check origin": the same record, with one fetch of origin's branch. */
  readonly probed: ChangeLandingsDto | null;
  readonly worktreeBranch: string;
  /** The branch the pull request merges into; null while the project is still loading. */
  readonly base: string | null;
  readonly defaultTitle: string;
  /** Mend's section as the landing would write it, with the owner's text above it. */
  readonly preview: string;
  readonly draft: LandDraft;
  readonly previewOpen: boolean;
  readonly pending: "land" | "probe" | "refresh" | null;
  readonly report: LandingReportDto | null;
  readonly error: string | null;
  readonly now: Date;
  readonly onDraft: (draft: LandDraft) => void;
  readonly onTogglePreview: () => void;
  readonly onLand: () => void;
  readonly onProbe: () => void;
  readonly onRefresh: () => void;
}

export function LandPanelView(props: LandPanelViewProps) {
  const { view, probed, draft, pending, now } = props;
  const facts = factsWithProbe(view.facts, probed);
  const updates = pullRequestToUpdate(view.landings);
  const branch = nextRemoteBranch(view.landings, props.worktreeBranch);
  const latestPullRequest = view.landings.find((landing) => landing.pullRequest !== null) ?? null;
  const remote = probed === null ? null : remoteLine(probed, now);
  const label = landButtonLabel({
    pullRequestAvailable: view.pullRequest.available,
    updates: updates !== null,
  });

  return (
    <section
      id="land"
      aria-labelledby="land-heading"
      className="mt-5 scroll-mt-24 rounded-2xl bg-panel px-5 py-4 shadow-[var(--shadow-sm)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="land-heading" className="font-sans text-sm font-semibold text-foreground">
          Land
        </h2>
        <p className="min-w-0 truncate font-mono text-[11px] text-label">
          push {props.worktreeBranch} to origin
          {branch === props.worktreeBranch ? "" : ` as ${branch}`}
          {props.base === null ? "" : ` · pull request into ${props.base}`}
        </p>
      </div>

      {facts.length === 0 ? (
        <p className="mt-3 font-mono text-[11.5px] text-faint">
          not landed · nothing pushed from Mend yet
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-1">
          {facts.map((fact, index) => (
            <FactLine key={`${fact._tag}-${index}`} fact={fact} now={now} />
          ))}
        </div>
      )}
      {!view.pullRequest.available && view.pullRequest.reason !== null && (
        <p className="mt-1 font-mono text-[11.5px] text-faint">{view.pullRequest.reason}</p>
      )}
      {remote !== null && <p className="mt-1 font-mono text-[11px] text-faint">{remote}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-4">
        {view.landings.length > 0 && (
          <button
            type="button"
            disabled={pending !== null}
            onClick={props.onProbe}
            title="Fetch origin's branch with your git access and compare it with the landed commit"
            className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {pending === "probe" ? "Checking origin…" : "Check origin"}
          </button>
        )}
        {view.land && latestPullRequest?.pullRequest != null && (
          <button
            type="button"
            disabled={pending !== null}
            onClick={props.onRefresh}
            title="Ask GitHub for the pull request's state now; Mend does not poll it"
            className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {pending === "refresh" ? "Asking GitHub…" : "Refresh pull request"}
          </button>
        )}
        {latestPullRequest?.pullRequest != null && (
          <a
            href={latestPullRequest.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            className="font-sans text-xs font-medium text-info no-underline"
          >
            Open #{latestPullRequest.pullRequest.number} on GitHub ↗
          </a>
        )}
      </div>

      {view.land ? (
        <div className="mt-4 border-t border-rule-faint pt-4">
          {heldBack(facts) && (
            <p className="mb-3 max-w-[760px] border-l-2 border-[var(--sw-accent)] pl-3 text-[13px] leading-relaxed text-ink-2">
              A completed turn left changes that Mend did not land. Landing now pushes them as you.
            </p>
          )}
          {view.pullRequest.available && (
            <>
              <label className="block">
                <span className="text-xs font-medium text-label">Pull request title</span>
                <input
                  value={draft.title}
                  disabled={pending === "land"}
                  onChange={(event) => props.onDraft({ ...draft, title: event.target.value })}
                  placeholder={updates === null ? props.defaultTitle : "kept as it is on GitHub"}
                  className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-sans text-sm text-foreground placeholder:text-faint"
                />
              </label>
              <label className="mt-3 block">
                <span className="text-xs font-medium text-label">Your description</span>
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
                  className="mt-1.5 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-sans text-sm text-foreground placeholder:text-faint"
                />
              </label>
              <button
                type="button"
                onClick={props.onTogglePreview}
                aria-expanded={props.previewOpen}
                className="mt-1 font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {props.previewOpen ? "Hide description preview" : "Preview description"}
              </button>
              {props.previewOpen && (
                <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-secondary px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
                  {props.preview}
                </pre>
              )}
            </>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={pending !== null}
              onClick={props.onLand}
              className="rounded-xl bg-primary px-4 py-2 font-sans text-sm font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:opacity-50"
            >
              {pending === "land" ? "Landing…" : label}
            </button>
            <p className="font-mono text-[10.5px] text-faint">
              checkpoints the worktree, commits what the agent left uncommitted, fast-forward only
            </p>
          </div>
        </div>
      ) : facts.length === 0 ? null : (
        <p className="mt-3 font-mono text-[10.5px] text-faint">
          only the session&apos;s owner lands this change
        </p>
      )}

      {props.report !== null && (
        <p role="status" className="mt-3 font-mono text-[11.5px] text-ink-2">
          {landingReportLine(props.report)}
        </p>
      )}
      {props.error !== null && (
        <p
          role="alert"
          className="mt-3 border-l-2 border-[var(--sw-red)] pl-3 text-[13px] leading-relaxed text-danger"
        >
          {props.error}
        </p>
      )}
    </section>
  );
}

export function LandPanel({
  changeId,
  sessionId,
  worktreeBranch,
  baseRef,
  defaultBranch,
  sessionLabel,
  tour,
  files,
}: {
  readonly changeId: string;
  readonly sessionId: string;
  readonly worktreeBranch: string;
  readonly baseRef: string | null;
  readonly defaultBranch: string | null;
  readonly sessionLabel: string | null;
  readonly tour: { readonly summary: string; readonly approach: string | null } | null;
  readonly files: ReadonlyArray<ReviewDiffFileDto>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const view = useQuery(trpc.landings.forChange.queryOptions({ id: changeId })).data;
  const [draft, setDraft] = useState<LandDraft>({ title: "", body: "" });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pending, setPending] = useState<"land" | "probe" | "refresh" | null>(null);
  const [probed, setProbed] = useState<ChangeLandingsDto | null>(null);
  const [report, setReport] = useState<LandingReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (view === undefined) return null;

  const settle = (work: Promise<unknown>) =>
    work
      .catch((cause: unknown) => setError(errorWords(cause)))
      .finally(() => {
        setPending(null);
        void queryClient.invalidateQueries(trpc.landings.pathFilter());
      });

  const land = () => {
    setPending("land");
    setError(null);
    setReport(null);
    void settle(
      landSession(sessionId, landRequestOf(draft)).then((landed) => {
        // What origin held before this landing no longer describes it.
        setProbed(null);
        return setReport(landed);
      }),
    );
  };
  const probe = () => {
    setPending("probe");
    setError(null);
    void settle(probeLandings(changeId).then(setProbed));
  };
  const refresh = () => {
    const recorded = view.landings.find((landing) => landing.pullRequest !== null);
    if (recorded === undefined) return;
    setPending("refresh");
    setError(null);
    void settle(refreshLanding(recorded.id));
  };

  const preview = descriptionPreview({
    ownerText: draft.body,
    tour,
    files: files.map(describedFileOfReview),
    webOrigin: window.location.origin,
    sessionId,
    changeId,
  });

  return (
    <LandPanelView
      view={view}
      probed={probed}
      worktreeBranch={worktreeBranch}
      base={defaultBranch === null ? null : landingBase(baseRef, defaultBranch)}
      defaultTitle={defaultPullRequestTitle({ label: sessionLabel, id: sessionId })}
      preview={preview}
      draft={draft}
      previewOpen={previewOpen}
      pending={pending}
      report={report}
      error={error}
      now={new Date()}
      onDraft={setDraft}
      onTogglePreview={() => setPreviewOpen((open) => !open)}
      onLand={land}
      onProbe={probe}
      onRefresh={refresh}
    />
  );
}

/**
 * The session page's one landing line: the fact that matters most now, and the way to the Land
 * panel on the change page. Held-back changes read first, then a failure, then the pull request,
 * then the push.
 */
export function SessionLandingLineView({
  facts,
  land,
  now,
  link,
}: {
  readonly facts: ReadonlyArray<LandingFactDto>;
  /** The viewer owns the session and may land it. */
  readonly land: boolean;
  readonly now: Date;
  readonly link: React.ReactNode;
}) {
  const fact = headlineFact(facts);
  if (fact === null && !land) return null;
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {fact === null ? (
        <p className="font-mono text-[11.5px] text-faint">not landed</p>
      ) : (
        <FactLine fact={fact} now={now} />
      )}
      {link}
    </div>
  );
}
