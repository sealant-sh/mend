import { queryOptions, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ProjectCrumbs } from "#/components/breadcrumb";
import { CommentStateActions, EvidenceLines, SuggestionBlock } from "#/components/comment-state";
import { WorkbenchDiff } from "#/components/diff";
import { FollowUpBanner } from "#/components/follow-up";
import { AppShell } from "#/components/shell";
import {
  composeTour,
  deliverFollowUp,
  openReview,
  postSliceReviewComment,
  readChange,
  suggestChange,
  type ChangePassDto,
  type ChangeTourDto,
  type ReviewCommentDto,
  type ReviewDiffDto,
  type SessionChangeDto,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";
import { useWorkbenchEvents } from "#/lib/workbench-events";

/**
 * Opening a review is an idempotent MUTATION used as a query: the loader runs
 * it once per per-tab idempotency key and pins the result (staleTime ∞), so
 * a revisit reuses the same slice instead of opening a new one.
 */
const openReviewQuery = (id: string, idempotencyKey: string) =>
  queryOptions({
    queryKey: ["change", id, "review-open", idempotencyKey],
    queryFn: () => openReview(id, idempotencyKey),
    staleTime: Number.POSITIVE_INFINITY,
  });

const reviewOpenKey = (changeId: string): string => {
  const storageKey = `mend.review.${changeId}.open-key`;
  const current = sessionStorage.getItem(storageKey);
  if (current !== null) return current;
  const created = crypto.randomUUID();
  sessionStorage.setItem(storageKey, created);
  return created;
};

export const Route = createFileRoute("/changes/$changeId")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    const key = reviewOpenKey(params.changeId);
    const opened = await queryClient.ensureQueryData(openReviewQuery(params.changeId, key));
    await Promise.all([
      queryClient.ensureQueryData(
        trpc.changes.reviewDiff.queryOptions({ id: params.changeId, sliceId: opened.slice.id }),
      ),
      queryClient.ensureQueryData(trpc.changes.comments.queryOptions({ id: params.changeId })),
      // The tour is composed at settle (automation cascade) — load it with
      // the page so the description heads the review instead of arriving late.
      queryClient.ensureQueryData(trpc.changes.tour.queryOptions({ id: params.changeId })),
      queryClient.ensureQueryData(trpc.changes.passes.queryOptions({ id: params.changeId })),
    ]);
    return { sliceId: opened.slice.id };
  },
  component: ChangePage,
});

/**
 * The review (plan §6.4, §7.3): the diff is primary; comments anchor to a
 * file and line (click a line) or to the change as a whole; the open comments
 * assemble into a follow-up instruction the user edits before sending — the
 * review-to-agent loop's first half. Provenance and the machine pass layer on
 * from here.
 */
function ChangePage() {
  const { changeId } = Route.useParams();
  const { sliceId } = Route.useLoaderData();
  const trpc = useTRPC();
  const review = useSuspenseQuery(
    trpc.changes.reviewDiff.queryOptions({ id: changeId, sliceId }),
  ).data;
  // The change's session mirror is null only for a worktree no conversation
  // has ever inhabited — nothing to review into, so no review page.
  if (review.change.sessionId === null) {
    return (
      <AppShell>
        <div className="min-w-0">
          <p className="ev-eyebrow">review</p>
          <p className="mt-4 font-mono text-xs text-faint">
            no conversation has inhabited this worktree yet · nothing to review
          </p>
        </div>
      </AppShell>
    );
  }
  return <ChangeReview changeId={changeId} sliceId={sliceId} sessionId={review.change.sessionId} />;
}

function ChangeReview({
  changeId,
  sliceId,
  sessionId,
}: {
  readonly changeId: string;
  readonly sliceId: string;
  readonly sessionId: string;
}) {
  const trpc = useTRPC();
  // Cache hit — the parent already ensured this query.
  const review = useSuspenseQuery(
    trpc.changes.reviewDiff.queryOptions({ id: changeId, sliceId }),
  ).data;
  const { change, patch: diff } = review;
  const files = review.files.map((file) => ({
    path: file.newPath ?? file.oldPath ?? "unknown path",
    additions: file.additions,
    deletions: file.deletions,
  }));
  const comments = useSuspenseQuery(trpc.changes.comments.queryOptions({ id: changeId })).data;
  const followUp = useSuspenseQuery(
    trpc.sessions.pendingFollowUp.queryOptions({ id: sessionId }),
  ).data;
  const sessionDetail = useQuery(trpc.sessions.detail.queryOptions({ id: sessionId })).data;
  const [sendOpen, setSendOpen] = useState(false);
  const [focusFile, setFocusFile] = useState<{
    readonly path: string;
    readonly nonce: number;
  } | null>(null);
  // The composed tour: null while walking is closed, 0..n-1 = the active stop.
  const tour = useQuery(trpc.changes.tour.queryOptions({ id: changeId })).data ?? null;
  // What ran over this change — SSE keeps these fresh as passes progress.
  const passes = useQuery(trpc.changes.passes.queryOptions({ id: changeId })).data ?? [];
  const passOf = (kind: ChangePassDto["kind"]) => passes.find((pass) => pass.kind === kind) ?? null;
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  useWorkbenchEvents();

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const openUnsent = comments.filter(
    (comment) => comment.state === "open" && comment.sentToSessionId === null,
  );

  const goToStop = (index: number) => {
    if (tour === null) return;
    const stop = tour.stops[index];
    if (stop === undefined) return;
    setTourIndex(index);
    if (stop.file !== null) setFocusFile({ path: stop.file, nonce: Date.now() });
  };

  // Walking shortcuts, both dialects: j/→ next, k/← prev, Esc ends. Active
  // only while walking, never while typing. A window listener is genuinely
  // imperative — there is no data-flow route to a keyboard.
  useEffect(() => {
    if (tour === null || tourIndex === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "j" || event.key === "ArrowRight") {
        if (tourIndex < tour.stops.length - 1) {
          event.preventDefault();
          goToStop(tourIndex + 1);
        }
      } else if (event.key === "k" || event.key === "ArrowLeft") {
        if (tourIndex > 0) {
          event.preventDefault();
          goToStop(tourIndex - 1);
        }
      } else if (event.key === "Escape") {
        setTourIndex(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const tourNav =
    tour !== null && tourIndex !== null
      ? {
          onPrev: () => goToStop(tourIndex - 1),
          onNext: () => goToStop(tourIndex + 1),
          hasPrev: tourIndex > 0,
          hasNext: tourIndex < tour.stops.length - 1,
        }
      : null;

  const activeStop =
    tour !== null && tourIndex !== null && tourIndex >= 0 ? (tour.stops[tourIndex] ?? null) : null;
  const tourMarker =
    activeStop !== null && activeStop.file !== null && activeStop.line !== null
      ? {
          file: activeStop.file,
          line: activeStop.line,
          endLine: activeStop.endLine,
          title: activeStop.title,
          narration: activeStop.narration,
          nonce: tourIndex ?? 0,
        }
      : null;

  return (
    <AppShell projectId={sessionDetail?.session.projectId}>
      <div className="min-w-0">
        {sessionDetail === undefined ? (
          <p className="ev-eyebrow">review</p>
        ) : (
          <ProjectCrumbs
            projectId={sessionDetail.session.projectId}
            sessionId={sessionId}
            leaf="review"
          />
        )}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
          <h1 className="font-display text-3xl font-medium tracking-tight text-foreground">
            {change.branch.replace(/^mend\/session\//, "session ")}
          </h1>
          <div className="flex items-center gap-2">
            <SuggestButton
              changeId={changeId}
              disabled={files.length === 0}
              pass={passOf("suggest")}
            />
            <ReadChangeButton changeId={changeId} pass={passOf("read")} />
            {sessionDetail?.control.steer === false ? null : (
              <button
                type="button"
                disabled={openUnsent.length === 0}
                onClick={() => setSendOpen(true)}
                className="rounded-xl bg-primary px-4 py-2 font-sans text-sm font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-opacity disabled:opacity-50"
              >
                Send review to session
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 font-mono text-xs text-faint">
          {review.checkpointA.sha.slice(0, 12)} → {review.checkpointB.sha.slice(0, 12)} ·{" "}
          {files.length} file
          {files.length === 1 ? "" : "s"} · +{additions} −{deletions} · {openUnsent.length} open
          comment{openUnsent.length === 1 ? "" : "s"}
          {sessionDetail?.session.baseRef == null
            ? ""
            : ` · base ${sessionDetail.session.baseRef}`}{" "}
          ·{" "}
          <Link to="/sessions/$sessionId" params={{ sessionId }} className="text-info no-underline">
            session
          </Link>
          {" · "}
          <ObservedStamp observation={review.observation} />
        </p>
        {sessionDetail?.control.steer === false ? (
          <p className="mt-2 max-w-[760px] border-l-2 border-[var(--sw-accent)] pl-3 text-[13px] leading-relaxed text-ink-2">
            Comments stay here; only the session&apos;s owner can send them to the session, unless
            they share control.
          </p>
        ) : null}
        {review.worktreeChangedSinceSnapshot && (
          <p className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 font-mono text-xs text-warning">
            Worktree changed since this review snapshot. This patch remains pinned.
          </p>
        )}
        <PassOutcomes passes={passes} />
        <FollowUpBanner sessionId={sessionId} followUp={followUp} />

        <DescriptionCard
          tour={tour}
          tourPass={passOf("tour")}
          diff={diff}
          composing={composing}
          canCompose={files.length > 0}
          onCompose={() => {
            setComposing(true);
            void composeTour(changeId).catch(() => setComposing(false));
          }}
          onStartTour={() => goToStop(0)}
        />

        {tour !== null && tourIndex !== null && (
          <TourPanel
            tour={tour}
            index={tourIndex}
            onGo={goToStop}
            onEnd={() => setTourIndex(null)}
          />
        )}

        <div className="mt-8 grid items-start gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          {/* The sidebar owns navigation AND the change-level comment surface —
              both stay in the viewport; only the file list scrolls internally. */}
          <section className="sticky top-6 flex max-h-[calc(100vh-10rem)] min-h-0 flex-col self-start">
            <p className="text-xs font-medium text-label">Files</p>
            <div className="mt-3 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              {files.length === 0 ? (
                <p className="font-mono text-xs text-faint">no changes yet</p>
              ) : (
                files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => setFocusFile({ path: file.path, nonce: Date.now() })}
                    className="rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-secondary"
                  >
                    <p className="truncate font-mono text-[11.5px] text-ink-2">{file.path}</p>
                    <p className="font-mono text-[10.5px] text-faint">
                      +{file.additions} −{file.deletions}
                    </p>
                  </button>
                ))
              )}
            </div>
            <ChangeComments changeId={changeId} sliceId={sliceId} comments={comments} />
          </section>

          <div className="min-w-0">
            <WorkbenchDiff
              diff={diff}
              changeId={changeId}
              comments={comments}
              stats={files}
              reviewSliceId={sliceId}
              reviewFiles={review.files}
              focus={focusFile}
              tourMarker={tourMarker}
              tourNav={tourNav}
            />
          </div>
        </div>
      </div>

      {sendOpen && (
        <SendReviewDialog
          change={change}
          sessionId={sessionId}
          review={review}
          comments={openUnsent}
          onClose={() => setSendOpen(false)}
        />
      )}
    </AppShell>
  );
}

/** "3 s ago" / "2 min ago" / "1 h ago": how far behind the executor the observed bytes are. */
const agoLabel = (iso: string, now: number): string => {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
};

/**
 * Where the bytes on this page were observed (ADR-0002 "Review"): the head capture Mend read,
 * and how far behind the executor that is — a fact in the recorder's voice, never a verdict.
 * "partial" names an `auto` capture, not atomic across files; the next capture corrects it.
 */
function ObservedStamp({ observation }: { readonly observation: ReviewDiffDto["observation"] }) {
  if (observation === undefined) return null;
  if (observation.source !== "capture") return <span>observed on the worktree</span>;
  const parts = [
    observation.state === "claimed" ? "claimed" : "observed",
    `capture ${observation.captureN ?? "?"}`,
    ...(observation.observedAt === null ? [] : [agoLabel(observation.observedAt, Date.now())]),
    ...(observation.partial ? ["partial"] : []),
  ];
  return <span title={observation.label}>{parts.join(" · ")}</span>;
}

/**
 * The change's description, at the head of the review the way a PR body
 * heads a PR: what the change IS (the tour's summary), how the session got
 * there (from the record), and the entry into the guided walk. Composed at
 * settle by the automation cascade so it is already here when review opens;
 * composable on demand when automation is off or the change moved on.
 */
function DescriptionCard({
  tour,
  tourPass,
  diff,
  composing,
  canCompose,
  onCompose,
  onStartTour,
}: {
  readonly tour: ChangeTourDto | null;
  /** The compose pass's recorded state — running/failed is truth, not a local guess. */
  readonly tourPass: ChangePassDto | null;
  readonly diff: string;
  readonly composing: boolean;
  readonly canCompose: boolean;
  readonly onCompose: () => void;
  readonly onStartTour: () => void;
}) {
  // The tour stamps the diff it read (sha256); hash what the page shows and
  // say when they differ. Keyed by digest + length — a proxy, so a same-length
  // rewrite is caught on the next mount rather than live; the honest marker
  // still beats silently guiding through a stale map.
  const staleQuery = useQuery({
    queryKey: [
      "change",
      tour?.changeId ?? "",
      "tour-freshness",
      tour?.diffDigest ?? "",
      diff.length,
    ],
    enabled: tour !== null,
    queryFn: async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(diff));
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return tour !== null && hex !== tour.diffDigest;
    },
  });
  const stale = staleQuery.data === true;

  if (tour === null && !canCompose) return null;

  // In flight when the reviewer just clicked OR the recorded pass says so
  // (the settle automation composes without a click on this page).
  const inFlight = composing || tourPass?.status === "running";
  const failedDetail =
    tourPass?.status === "failed" ? (tourPass.detail ?? "the pass failed") : null;

  return (
    <section className="mt-5 rounded-2xl bg-panel px-5 py-4 shadow-[var(--shadow-sm)]">
      {tour === null ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {inFlight ? (
            <p className="text-sm text-muted-foreground">Composing the description and tour…</p>
          ) : failedDetail !== null ? (
            <p className="text-sm text-danger">
              Description &amp; tour failed ·{" "}
              <span className="font-mono text-xs">{failedDetail.slice(0, 200)}</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No description yet. Composed when a session settles, or on demand.
            </p>
          )}
          <button
            type="button"
            disabled={inFlight}
            onClick={onCompose}
            title="Compose a description and guided tour from the diff and the session record"
            className="rounded-xl border border-border bg-card px-3.5 py-1.5 font-sans text-xs font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-60"
          >
            {inFlight
              ? "Composing…"
              : failedDetail !== null
                ? "Retry"
                : "Compose description & tour"}
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-mono text-[11px] text-label">
              description · composed {new Date(tour.createdAt).toLocaleTimeString()} ·{" "}
              {tour.stops.length} stop{tour.stops.length === 1 ? "" : "s"}
              {stale && <span className="text-warning"> · diff changed since</span>}
            </p>
            <div className="flex items-center gap-3">
              {stale && (
                <button
                  type="button"
                  disabled={inFlight}
                  onClick={onCompose}
                  className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                >
                  {inFlight ? "Recomposing…" : "Recompose"}
                </button>
              )}
              <button
                type="button"
                onClick={onStartTour}
                title="Walk the stops in Mend's order, each circled in the diff below"
                className="rounded-xl bg-primary px-3.5 py-1.5 font-sans text-xs font-medium text-primary-foreground shadow-[var(--shadow-cobalt)]"
              >
                Tour this change →
              </button>
            </div>
          </div>
          <p className="mt-3 text-[14px] leading-relaxed text-foreground">{tour.summary}</p>
          {tour.approach !== null && (
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              <span className="font-mono text-[10.5px] text-label">from the record · </span>
              {tour.approach}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The composed tour's walking surface: the stops in Mend's chosen order —
 * each narrated, evidence-linked or honestly marked as inferred reading, and
 * circled in the diff below when it points at a region. The overview lives
 * in the description card above, which never leaves the page.
 */
function TourPanel({
  tour,
  index,
  onGo,
  onEnd,
}: {
  readonly tour: ChangeTourDto;
  readonly index: number;
  readonly onGo: (index: number) => void;
  readonly onEnd: () => void;
}) {
  const stop = tour.stops[index];
  if (stop === undefined) return null;
  return (
    // Below the app header (sticky top-0 z-40), never under it — the walking
    // controls must stay visible the whole way down the diff.
    <div className="sticky top-[4.25rem] z-30 mt-5 rounded-2xl border border-[color-mix(in_oklab,var(--sw-accent)_35%,transparent)] bg-card px-5 py-4 shadow-md">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-label">
          stop {index + 1}/{tour.stops.length}
          {stop.file === null ? "" : ` · ${stop.file}`}
          {stop.line === null
            ? ""
            : `:${stop.line}${stop.endLine === null ? "" : `–${stop.endLine}`}`}
          {stop.grounded ? "" : " · inferred reading"}
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onGo(index - 1)}
            title="Previous stop (k or ←)"
            className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            ← Prev <kbd className="font-mono text-[10px] text-faint">k</kbd>
          </button>
          <button
            type="button"
            disabled={index >= tour.stops.length - 1}
            onClick={() => onGo(index + 1)}
            title="Next stop (j or →)"
            className="rounded-xl border border-border bg-card px-3 py-1 font-sans text-xs font-medium text-foreground shadow-xs disabled:opacity-40"
          >
            Next → <kbd className="font-mono text-[10px] text-faint">j</kbd>
          </button>
          <button
            type="button"
            onClick={onEnd}
            title="End the tour (Esc)"
            className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            End <kbd className="font-mono text-[10px] text-faint">esc</kbd>
          </button>
        </div>
      </div>
      <p className="mt-2 font-sans text-sm font-medium text-foreground">{stop.title}</p>
      <p className="mt-1 text-[13.5px] leading-relaxed text-ink-2">{stop.narration}</p>
      {stop.evidence.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {stop.evidence.map((link, evidenceIndex) => (
            <p key={evidenceIndex} className="truncate font-mono text-[10.5px] text-faint">
              seq {link.sequence} · <span className="text-ink-2">{link.excerpt}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Read this change" (plan §7.3): Mend reads the diff against the record and
 * drafts evidence-linked findings. The pass runs asynchronously; drafts land
 * as comments over SSE, each awaiting accept/edit/dismiss. On-demand only —
 * the human loop is never gated on the machine pass.
 */
/**
 * What ran over this change, said out loud (one line per recorded pass):
 * "completed, drafted nothing" and "never ran" must never look the same.
 * The tour's row lives on the description card; these cover the drafts.
 */
function PassOutcomes({ passes }: { readonly passes: ReadonlyArray<ChangePassDto> }) {
  const lines = passes.filter((pass) => pass.kind !== "tour");
  if (lines.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-0.5">
      {lines.map((pass) => (
        <PassOutcomeLine key={pass.kind} pass={pass} />
      ))}
    </div>
  );
}

function PassOutcomeLine({ pass }: { readonly pass: ChangePassDto }) {
  const label = pass.kind === "suggest" ? "suggestions" : "findings";
  const at = new Date(pass.finishedAt ?? pass.startedAt).toLocaleTimeString();
  if (pass.status === "running") {
    return (
      <p className="font-mono text-[11px] text-label">
        {label} · running · started {at}
      </p>
    );
  }
  if (pass.status === "failed") {
    return (
      <p className="font-mono text-[11px] text-danger">
        {label} · failed {at} · {(pass.detail ?? "no detail recorded").slice(0, 160)}
      </p>
    );
  }
  return (
    <p className="font-mono text-[11px] text-faint">
      {label} · completed {at} ·{" "}
      {pass.findings === null || pass.findings === 0 ? (
        "none"
      ) : (
        <span className="text-ink-2">
          {pass.findings} draft{pass.findings === 1 ? "" : "s"} below
        </span>
      )}
    </p>
  );
}

/**
 * The suggestion pass: Mend reads the diff and drafts exact replacements for
 * defects this change introduces — strict by contract, zero is the normal
 * outcome. Asynchronous like the read pass; the recorded pass row (over SSE)
 * is what says "running", so the button can never spin forever on a lie.
 */
function SuggestButton({
  changeId,
  disabled,
  pass,
}: {
  readonly changeId: string;
  readonly disabled: boolean;
  readonly pass: ChangePassDto | null;
}) {
  const [queueing, setQueueing] = useState(false);
  const running = pass?.status === "running";
  const request = () => {
    setQueueing(true);
    void suggestChange(changeId).finally(() => setQueueing(false));
  };
  return (
    <button
      type="button"
      disabled={disabled || queueing || running}
      onClick={request}
      title="Draft replacement suggestions for concrete defects in this change; most changes produce none"
      className="rounded-xl border border-border bg-card px-4 py-2 font-sans text-sm font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-60"
    >
      {running ? "Running…" : queueing ? "…" : "Suggest fixes"}
    </button>
  );
}

function ReadChangeButton({
  changeId,
  pass,
}: {
  readonly changeId: string;
  readonly pass: ChangePassDto | null;
}) {
  const [queueing, setQueueing] = useState(false);
  const running = pass?.status === "running";
  const request = () => {
    setQueueing(true);
    void readChange(changeId).finally(() => setQueueing(false));
  };
  return (
    <button
      type="button"
      disabled={queueing || running}
      onClick={request}
      title="Read the diff against the session record and draft evidence-linked findings"
      className="rounded-xl border border-border bg-card px-4 py-2 font-sans text-sm font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5 disabled:opacity-60"
    >
      {running ? "Running…" : queueing ? "…" : "Read this change"}
    </button>
  );
}

// ─── Change-level comments ──────────────────────────────────────────────────

function ChangeComments({
  changeId,
  sliceId,
  comments,
}: {
  readonly changeId: string;
  readonly sliceId: string;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const changeLevel = comments.filter((comment) => comment.file === null);

  const submit = () => {
    if (body.trim() === "") return;
    setPending(true);
    void postSliceReviewComment(
      changeId,
      sliceId,
      {
        oldPath: null,
        newPath: null,
        side: null,
        startLine: null,
        endLine: null,
        hunkContextHash: null,
      },
      body.trim(),
    )
      .then(() => {
        setBody("");
        return queryClient.invalidateQueries(trpc.changes.pathFilter());
      })
      .finally(() => setPending(false));
  };

  return (
    <section className="mt-6">
      <p className="text-xs font-medium text-label">Change-level comments</p>
      <div className="mt-3 flex max-h-56 flex-col gap-3 overflow-y-auto">
        {changeLevel.map((comment) => (
          <div
            key={comment.id}
            className={`rounded-xl bg-card p-3 shadow-xs ${comment.state === "dismissed" ? "opacity-60" : ""}`}
          >
            <p className="font-mono text-[10.5px] text-label">
              {comment.authorKind === "mend" ? "Mend" : comment.authorName} ·{" "}
              {comment.sentToSessionId === null ? comment.state : "sent to session"}
            </p>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{comment.body}</p>
            <SuggestionBlock comment={comment} />
            <EvidenceLines comment={comment} />
            <CommentStateActions comment={comment} />
          </div>
        ))}
        <div className="rounded-xl bg-card p-3 shadow-xs">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Comment on the change as a whole…"
            rows={2}
            className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-sans text-sm text-foreground placeholder:text-faint"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={pending || body.trim() === ""}
              onClick={submit}
              className="rounded-xl bg-primary px-3.5 py-1.5 font-sans text-sm font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-opacity disabled:opacity-50"
            >
              Comment
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Send review to session ─────────────────────────────────────────────────

const assembleInstruction = (
  change: SessionChangeDto,
  comments: ReadonlyArray<ReviewCommentDto>,
) => {
  const points = comments
    .map((comment, index) => {
      const anchor =
        comment.file === null
          ? "the change as a whole"
          : `${comment.file}${comment.line === null ? "" : `:${comment.line}${comment.endLine === null || comment.endLine === comment.line ? "" : `-${comment.endLine}`}`}`;
      const proposal =
        comment.suggestion === null
          ? ""
          : `\n   Proposed replacement:\n${comment.suggestion
              .split("\n")
              .map((line) => `   ${line}`)
              .join("\n")}`;
      return `${index + 1}. ${anchor} — ${comment.body}${proposal}`;
    })
    .join("\n");
  return `This is a follow-up on your earlier work in this worktree, responding to review feedback. The branch ${change.branch} is already checked out with your work on it: keep working there, and do not start a new branch or reset it.

Review comments:
${points}

Address each point using your own judgment about how. Check your work with the repository's own build, tests, or typecheck; a check that still fails is something to report, not to force green. Report honestly what you changed and what you did not — if a point cannot or should not be done, say so plainly.`;
};

/** The plan's rule (§7.3): the user inspects and edits the instruction before sending. */
function SendReviewDialog({
  change,
  sessionId,
  review,
  comments,
  onClose,
}: {
  readonly change: SessionChangeDto;
  /** The conversation the follow-up is delivered to (the change's last contributor). */
  readonly sessionId: string;
  readonly review: ReviewDiffDto;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(comments.map((comment) => comment.id)),
  );
  const [instruction, setInstruction] = useState(() => assembleInstruction(change, comments));
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => `web-follow-up:${change.id}:${crypto.randomUUID()}`,
  );
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<
    "delivering" | "delivered" | "pending" | "delivery_failed" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const resetDeliveryKey = () => {
    setIdempotencyKey(`web-follow-up:${change.id}:${crypto.randomUUID()}`);
    setResult(null);
    setError(null);
  };

  const select = (commentId: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(commentId);
    else next.delete(commentId);
    setSelected(next);
    resetDeliveryKey();
    setInstruction(
      assembleInstruction(
        change,
        comments.filter((comment) => next.has(comment.id)),
      ),
    );
  };

  const send = () => {
    setPending(true);
    setError(null);
    void deliverFollowUp(sessionId, {
      reviewSliceId: review.slice.id,
      checkpointAId: review.checkpointA.id,
      checkpointBId: review.checkpointB.id,
      diffDigest: review.slice.diffDigest,
      commentIds: comments
        .filter((comment) => selected.has(comment.id))
        .map((comment) => comment.id),
      instruction,
      idempotencyKey,
    })
      .then((followUp) => {
        setResult(followUp.status === "superseded" ? "delivery_failed" : followUp.status);
        return Promise.all([
          queryClient.invalidateQueries(trpc.changes.pathFilter()),
          queryClient.invalidateQueries(trpc.sessions.pathFilter()),
        ]);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6"
      style={{ background: "color-mix(in oklab, var(--sw-ink) 32%, transparent)" }}
      onClick={onClose}
    >
      <div
        className="mt-16 w-full max-w-[640px] rounded-2xl bg-background p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        {result === "delivered" || result === "pending" ? (
          <>
            <p className="font-sans text-base font-medium text-foreground">
              {result === "delivered" ? "Follow-up delivered" : "Follow-up saved pending"}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {result === "delivered"
                ? "Mend persisted the new run and marked only the selected comments sent."
                : "The session became active before launch. The same bundle remains pending and can be retried after it settles."}
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl bg-primary px-4 py-2 font-sans text-sm font-medium text-primary-foreground"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="font-sans text-base font-medium text-foreground">
              Send review to the session
            </p>
            <p className="mt-1 font-mono text-[11px] text-faint">
              {selected.size} of {comments.length} comments selected · resumes {change.branch}
            </p>
            <div className="mt-4 max-h-40 space-y-2 overflow-auto border-y border-rule-faint py-2">
              {comments.map((comment) => (
                <label key={comment.id} className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selected.has(comment.id)}
                    className="mt-0.5 accent-[var(--sw-accent)]"
                    onChange={(event) => select(comment.id, event.target.checked)}
                  />
                  <span className="leading-relaxed text-ink-2">
                    <span className="font-mono text-[10.5px] text-label">
                      {comment.file ?? "whole change"}
                      {comment.line === null ? "" : `:${comment.line}`}
                    </span>{" "}
                    · {comment.body}
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-4 text-xs font-medium text-label">Instruction — edit before sending</p>
            <textarea
              value={instruction}
              onChange={(event) => {
                resetDeliveryKey();
                setInstruction(event.target.value);
              }}
              rows={12}
              className="mt-2 w-full resize-y rounded-xl border border-input bg-card px-4 py-3 font-sans text-[13.5px] leading-relaxed text-ink-2"
            />
            <p className="mt-2 font-mono text-[10.5px] text-faint">
              persisted before launch; what you send is verbatim what the session receives
            </p>
            {result === "delivering" && (
              <p className="mt-2 font-mono text-xs text-warning">
                delivery accepted for processing · check the same bundle to reconcile membership
              </p>
            )}
            {result === "delivery_failed" && (
              <p className="mt-2 font-mono text-xs text-warning">
                delivery failed before membership finalized · retry uses the same key unless you
                edit
              </p>
            )}
            {error !== null && <p className="mt-2 font-mono text-xs text-warning">{error}</p>}
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="font-sans text-sm font-medium text-muted-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pending || selected.size === 0 || instruction.trim() === ""}
                onClick={send}
                className="rounded-xl bg-primary px-4 py-2 font-sans text-sm font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-opacity disabled:opacity-50"
              >
                {pending
                  ? "Delivering…"
                  : result === "delivering"
                    ? "Check delivery"
                    : result === "delivery_failed"
                      ? "Retry delivery"
                      : "Deliver to session"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
