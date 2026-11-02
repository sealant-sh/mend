import {
  canRelaunchSession,
  checkpointSourceWords,
  noReviewFollowUpLine,
  takesReviewFollowUp,
  terminalOwnerOnlyLine,
} from "@mend/domain/workbench";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useState } from "react";

import { ChangeProofArtifacts } from "#/components/change-proof-artifacts";
import { CommentStateActions, EvidenceLines, SuggestionBlock } from "#/components/comment-state";
import { type DiffStyle, lineLabel, WorkbenchDiff } from "#/components/diff";
import { Button, focusRing } from "#/components/kit/button";
import { ModalDialog } from "#/components/kit/modal";
import { Segment } from "#/components/kit/segment";
import { Dot, StatusWord } from "#/components/kit/status";
import { LandPanel } from "#/components/land-panel";
import {
  composeTour,
  postSliceReviewComment,
  readChange,
  suggestChange,
  type ChangePassDto,
  type ReviewCommentDto,
  type ReviewDiffDto,
} from "#/lib/api";
import { observedChecks } from "#/lib/checks";
import { clearSentDraft, type ReviewDraftScope, reviewDraftKey, useDraft } from "#/lib/drafts";
import { createLocalStore } from "#/lib/local-store";
import { failureWords } from "#/lib/refusal";
import { openReviewQuery, renewReviewOpenKey, useReviewOpenKey } from "#/lib/review-open";
import { clockTime } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";
import { viewedFiles } from "#/lib/viewed-files";

import { useConversation } from "./conversation";
import type { SessionFacts } from "./facts";
import { SendReviewDialog } from "./send-review";
import { PanelSection } from "./side-panel";

/** Unified or split diffs, kept per browser. */
const diffStyleStore = createLocalStore<DiffStyle>(
  "mend-diff-style",
  (stored) => (stored === "split" ? "split" : "unified"),
  "unified",
);

const errorWords = (cause: unknown) => failureWords(cause, "Mend could not do that.");

/**
 * The Change tab (screens P2, C2, X1): the review. The diff with line comments; and, beside it in
 * the side-panel layout or above and below it elsewhere, the comments not yet sent, Send N to the
 * agent, what Mend read in the change, the checks the agent ran, and Land.
 */
export function ChangeTab({
  facts,
  place,
  withActions = true,
}: {
  readonly facts: SessionFacts;
  readonly place: "main" | "work" | "full" | "panel";
  readonly withActions?: boolean;
}) {
  const change = facts.detail.change;
  if (change === null)
    return place === "panel" ? (
      <p className="text-[12.5px] text-muted-foreground">No change to review yet.</p>
    ) : (
      <p className="font-mono text-[12px] text-muted-foreground">
        No change yet. Once the agent edits the worktree, its change is reviewed here.
      </p>
    );
  return (
    <ChangeReview facts={facts} changeId={change.id} place={place} withActions={withActions} />
  );
}

function ChangeReview({
  facts,
  changeId,
  place,
  withActions,
}: {
  readonly facts: SessionFacts;
  readonly changeId: string;
  readonly place: "main" | "work" | "full" | "panel";
  readonly withActions: boolean;
}) {
  const trpc = useTRPC();
  // One key for every view of this change: renewing it moves the diff and the panel together.
  const openKey = useReviewOpenKey(changeId);
  const opened = useQuery(openReviewQuery(changeId, openKey));
  const review = useQuery({
    ...trpc.changes.reviewDiff.queryOptions({ id: changeId, sliceId: opened.data?.slice.id ?? "" }),
    enabled: opened.isSuccess,
  });
  const comments = useQuery(trpc.changes.comments.queryOptions({ id: changeId }));
  const readAgain = () => renewReviewOpenKey(changeId);
  if (place === "panel")
    return (
      <ReviewPanel
        facts={facts}
        changeId={changeId}
        review={review.data}
        comments={comments.data}
      />
    );
  return (
    <div className="grid gap-3.5 pb-4">
      {opened.isPending || (opened.isSuccess && review.isPending) ? (
        <p role="status" className="font-mono text-[12px] text-muted-foreground">
          Opening the review…
        </p>
      ) : opened.isError || review.isError ? (
        <p role="alert" className="font-mono text-[12px] text-danger">
          The review did not open: {errorWords(opened.error ?? review.error)}{" "}
          <button
            type="button"
            className={cn("text-info underline-offset-2 hover:underline", focusRing)}
            onClick={() => {
              void opened.refetch();
              void review.refetch();
            }}
          >
            Try again
          </button>
        </p>
      ) : review.data === undefined ? null : (
        <ReviewBody
          facts={facts}
          changeId={changeId}
          review={review.data}
          comments={comments.data ?? []}
          withActions={withActions}
          onReadAgain={readAgain}
        />
      )}
    </div>
  );
}

function ReviewBody({
  facts,
  changeId,
  review,
  comments,
  withActions,
  onReadAgain,
}: {
  readonly facts: SessionFacts;
  readonly changeId: string;
  readonly review: ReviewDiffDto;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly withActions: boolean;
  readonly onReadAgain: () => void;
}) {
  const trpc = useTRPC();
  const diffStyle = diffStyleStore.use();
  const viewedStore = viewedFiles(changeId);
  const viewed = new Set(viewedStore.use());
  const files = review.files.map((file) => ({
    path: file.newPath ?? file.oldPath ?? "unknown path",
    additions: file.additions,
    deletions: file.deletions,
  }));
  const viewedCount = files.filter((file) => viewed.has(file.path)).length;
  const passes = useQuery(trpc.changes.passes.queryOptions({ id: changeId })).data ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-1.5 rounded-[9px] border border-rule px-2.5 py-[5px] font-sans text-[12.5px] font-medium text-ink-2">
          Whole change
          <span className="font-mono text-[11.5px] text-muted-foreground">
            #{review.checkpointA.ordinal} → #{review.checkpointB.ordinal}
          </span>
        </span>
        <Segment
          label="Diff layout"
          value={diffStyle}
          onChange={diffStyleStore.set}
          options={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
          ]}
        />
        <span className="flex-1" />
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {viewedCount} of {files.length} viewed
        </span>
      </div>
      <ReviewFacts facts={facts} review={review} onReadAgain={onReadAgain} />
      <PassLines passes={passes} />
      <Description changeId={changeId} hasFiles={files.length > 0} passes={passes} />
      {withActions ? (
        <ReviewActions facts={facts} changeId={changeId} review={review} comments={comments} />
      ) : null}
      <WorkbenchDiff
        diff={review.patch}
        changeId={changeId}
        comments={comments}
        stats={files}
        reviewSliceId={review.slice.id}
        reviewFiles={review.files}
        diffStyle={diffStyle}
        draftScope={{
          userId: facts.viewer?.userId ?? "unknown",
          changeId,
          sliceId: review.slice.id,
        }}
        viewed={viewed}
        onViewed={(path, mark) =>
          viewedStore.set(
            mark ? [...viewed, path] : [...viewed].filter((candidate) => candidate !== path),
          )
        }
      />
      <ChangeProofArtifacts changeId={changeId} />
      {withActions ? (
        <div className="grid gap-6 rounded-[22px] bg-panel px-5 py-4 shadow-sm md:grid-cols-2">
          <CommentsSection facts={facts} changeId={changeId} review={review} comments={comments} />
          <ChecksSection facts={facts} />
        </div>
      ) : null}
    </>
  );
}

/** "3 s ago" / "2 min ago" / "1 h ago": how far behind the executor the observed bytes are. */
const agoLabel = (when: Date, now: number): string => {
  const seconds = Math.max(0, Math.round((now - when.getTime()) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
};

/**
 * Where the bytes in this review were observed (ADR-0002 "Review"), in the recorder's voice, and
 * what the review cannot show: paths outside git, the session's other repositories, and a worktree
 * that moved on since the review opened.
 */
function ReviewFacts({
  facts,
  review,
  onReadAgain,
}: {
  readonly facts: SessionFacts;
  readonly review: ReviewDiffDto;
  readonly onReadAgain: () => void;
}) {
  const now = Date.now();
  const source = review.checkpointB.source;
  const observation = review.observation;
  const stamp = [
    `${review.checkpointA.sha.slice(0, 12)} → ${review.checkpointB.sha.slice(0, 12)}`,
    facts.session.baseRef === null ? null : `base ${facts.session.baseRef}`,
    source === undefined ? null : checkpointSourceWords(source, agoLabel(source.observedAt, now)),
    observation === undefined
      ? null
      : observation.source !== "capture"
        ? "observed on the worktree"
        : [
            observation.state === "claimed" ? "claimed" : "observed",
            `capture ${observation.captureN ?? "?"}`,
            ...(observation.observedAt === null
              ? []
              : [agoLabel(new Date(observation.observedAt), now)]),
            ...(observation.partial ? ["partial"] : []),
          ].join(" · "),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const repositories = facts.detail.repositories;
  return (
    <div className="grid gap-1 font-mono text-[11.5px] text-faint">
      <p title={observation?.label}>{stamp}</p>
      {review.outsideGit == null ? null : (
        // Saved and restored, but no patch git computes can list them: said, never hidden.
        <p title={review.outsideGit.paths.join("\n")}>{review.outsideGit.label}</p>
      )}
      {repositories.length === 0 ? null : (
        <p>
          repositories ·{" "}
          {repositories.map((view, index) => (
            <span key={view.repository.id}>
              {index === 0 ? "" : " · "}
              {view.change !== null && view.checkpointsBeyondStart > 0 ? (
                <Link
                  to="/changes/$changeId"
                  params={{ changeId: view.change.id }}
                  className="text-info no-underline"
                >
                  {view.repository.path}
                </Link>
              ) : (
                view.repository.path
              )}{" "}
              {view.repository.state}
              {view.repository.state === "ready" && view.checkpointsBeyondStart === 0
                ? " · nothing of its own to review yet"
                : ""}
            </span>
          ))}
        </p>
      )}
      {review.worktreeChangedSinceSnapshot ? (
        <p className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-warning">
          The worktree changed since this review opened. This diff stays as it was.
          <button
            type="button"
            onClick={onReadAgain}
            className={cn("font-sans text-[12px] font-medium underline", focusRing)}
          >
            Review the change as it is now
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * What ran over this change, one line per recorded pass: "completed, drafted nothing" and "never
 * ran" must never look the same.
 */
function PassLines({ passes }: { readonly passes: ReadonlyArray<ChangePassDto> }) {
  const lines = passes.filter((pass) => pass.kind !== "tour");
  if (lines.length === 0) return null;
  return (
    <div className="grid gap-0.5 font-mono text-[11px]">
      {lines.map((pass) => {
        const label = pass.kind === "suggest" ? "suggestions" : "findings";
        const at = clockTime(new Date(pass.finishedAt ?? pass.startedAt));
        return (
          <p key={pass.kind} className={pass.status === "failed" ? "text-danger" : "text-faint"}>
            {pass.status === "queued"
              ? `${label} · queued ${at}`
              : pass.status === "running"
                ? `${label} · running · started ${at}`
                : pass.status === "failed"
                  ? `${label} · failed ${at} · ${(pass.detail ?? "no detail recorded").slice(0, 160)}`
                  : `${label} · completed ${at} · ${
                      pass.findings === null || pass.findings === 0
                        ? "none"
                        : `${pass.findings} draft${pass.findings === 1 ? "" : "s"} in the diff`
                    }`}
          </p>
        );
      })}
    </div>
  );
}

/**
 * The change's description, as a pull request body heads a pull request: what the change is and
 * how the session got there. Composed when a session settles, or on demand.
 */
function Description({
  changeId,
  hasFiles,
  passes,
}: {
  readonly changeId: string;
  readonly hasFiles: boolean;
  readonly passes: ReadonlyArray<ChangePassDto>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tour = useQuery(trpc.changes.tour.queryOptions({ id: changeId })).data ?? null;
  const pass = passes.find((row) => row.kind === "tour") ?? null;
  const compose = useMutation({
    mutationFn: () => composeTour(changeId),
    onSettled: () => queryClient.invalidateQueries(trpc.changes.passes.pathFilter()),
  });
  if (tour === null && !hasFiles) return null;
  if (tour !== null)
    return (
      <section className="rounded-[18px] bg-panel px-5 py-4 shadow-xs">
        <p className="font-mono text-[11px] text-label">
          description · composed {clockTime(tour.createdAt)}
        </p>
        <p className="mt-2 text-[14px] leading-relaxed text-foreground">{tour.summary}</p>
        {tour.approach === null ? null : (
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            <span className="font-mono text-[10.5px] text-label">from the record · </span>
            {tour.approach}
          </p>
        )}
      </section>
    );
  const queued = pass?.status === "queued";
  const running = compose.isPending || queued || pass?.status === "running";
  const failed = pass?.status === "failed" ? (pass.detail ?? "the pass failed") : null;
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-[18px] bg-panel px-5 py-3 shadow-xs">
      <p
        role={running ? "status" : undefined}
        className={cn(
          "min-w-0 flex-1 text-[13px]",
          failed === null ? "text-muted-foreground" : "text-danger",
        )}
      >
        {queued
          ? "Description queued."
          : running
            ? "Mend is writing the description…"
            : failed !== null
              ? `The description failed · ${failed.slice(0, 200)}`
              : "No description yet. Mend writes one when the session settles, or now."}
      </p>
      <Button size="sm" disabled={running} onClick={() => compose.mutate()}>
        {queued
          ? "Queued"
          : running
            ? "Writing…"
            : failed !== null
              ? "Try again"
              : "Write a description"}
      </Button>
      {compose.isError ? (
        <p role="alert" className="basis-full text-[12.5px] text-danger">
          {errorWords(compose.error)}
        </p>
      ) : null}
    </section>
  );
}

/** Who may send the review back to the session, and in what words everyone else is told why not. */
const sendRule = (facts: SessionFacts): { readonly can: boolean; readonly why: string | null } => {
  const { control, detail, session } = facts;
  if (!control.steer)
    return {
      can: false,
      why: "Comments stay here; only the session's owner sends them, unless they share control.",
    };
  if (!takesReviewFollowUp(session.harness))
    return { can: false, why: `Comments stay here. ${noReviewFollowUpLine(session.harness)}` };
  // Sending to a terminal session starts its agent with them, which is typing there: the owner's
  // alone, even while control is shared (docs/adr/0013).
  if (!canRelaunchSession(control, detail.currentAgent?.kind ?? null))
    return {
      can: false,
      why: `Comments stay here. ${terminalOwnerOnlyLine(facts.ownerName ?? "its owner", "send-back")}`,
    };
  return { can: true, why: null };
};

const openUnsentOf = (comments: ReadonlyArray<ReviewCommentDto>) =>
  comments.filter((comment) => comment.state === "open" && comment.sentToSessionId === null);

/** Send N, Land, and Mend's passes, above the diff where no side panel holds them. */
function ReviewActions({
  facts,
  changeId,
  review,
  comments,
}: {
  readonly facts: SessionFacts;
  readonly changeId: string;
  readonly review: ReviewDiffDto;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
}) {
  const unsent = openUnsentOf(comments);
  const rule = sendRule(facts);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[18px] bg-panel px-4 py-3 shadow-xs">
      <span className="font-mono text-[11.5px] text-muted-foreground">
        {unsent.length} comment{unsent.length === 1 ? "" : "s"} not sent
      </span>
      {rule.can ? <SendButton facts={facts} review={review} comments={unsent} /> : null}
      <span className="flex-1" />
      <MendReads changeId={changeId} hasFiles={review.files.length > 0} />
      <LandButton facts={facts} changeId={changeId} review={review} />
    </div>
  );
}

function SendButton({
  facts,
  review,
  comments,
  wide = false,
}: {
  readonly facts: SessionFacts;
  readonly review: ReviewDiffDto | undefined;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const change = facts.detail.change;
  return (
    <>
      <Button
        size={wide ? "default" : "sm"}
        variant="primary"
        disabled={comments.length === 0 || review === undefined}
        onClick={() => setOpen(true)}
        className={wide ? "w-full justify-center" : undefined}
      >
        Send {comments.length} to {facts.agent}
      </Button>
      {open && review !== undefined && change !== null ? (
        <SendReviewDialog
          change={change}
          sessionId={facts.session.id}
          agent={facts.agent}
          review={review}
          comments={comments}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * "Mend reads the change" (plan §7.3): draft findings against the record, and suggested fixes.
 * Both run on their own; the pass lines say how they went.
 */
function MendReads({
  changeId,
  hasFiles,
}: {
  readonly changeId: string;
  readonly hasFiles: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const passes = useQuery(trpc.changes.passes.queryOptions({ id: changeId })).data ?? [];
  const busy = (kind: ChangePassDto["kind"]) => {
    const pass = passes.find((row) => row.kind === kind);
    return pass?.status === "queued" || pass?.status === "running";
  };
  const settle = () => queryClient.invalidateQueries(trpc.changes.passes.pathFilter());
  const read = useMutation({ mutationFn: () => readChange(changeId), onSettled: settle });
  const suggest = useMutation({ mutationFn: () => suggestChange(changeId), onSettled: settle });
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={read.isPending || busy("read")}
        title="Read the diff against the session record and draft evidence-linked findings"
        onClick={() => read.mutate()}
      >
        {busy("read") ? "Reading…" : "Read this change"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!hasFiles || suggest.isPending || busy("suggest")}
        title="Draft replacements for concrete defects in this change; most changes get none"
        onClick={() => suggest.mutate()}
      >
        {busy("suggest") ? "Suggesting…" : "Suggest fixes"}
      </Button>
      {read.isError || suggest.isError ? (
        <span role="alert" className="text-[12px] text-danger">
          {errorWords(read.error ?? suggest.error)}
        </span>
      ) : null}
    </>
  );
}

/** Land: the owner pushes the change and opens its pull request (docs/adr/0007-landing.md). */
function LandButton({
  facts,
  changeId,
  review,
  wide = false,
}: {
  readonly facts: SessionFacts;
  readonly changeId: string;
  readonly review: ReviewDiffDto | undefined;
  readonly wide?: boolean;
}) {
  const trpc = useTRPC();
  const hash = useLocation({ select: (location) => location.hash });
  const [open, setOpen] = useState(hash === "land");
  const tour = useQuery(trpc.changes.tour.queryOptions({ id: changeId })).data ?? null;
  const project = useQuery(trpc.projects.detail.queryOptions({ id: facts.session.projectId })).data;
  const change = facts.detail.change;
  return (
    <>
      <Button
        size={wide ? "default" : "sm"}
        onClick={() => setOpen(true)}
        className={wide ? "w-full justify-center" : undefined}
      >
        Land change
      </Button>
      <ModalDialog open={open} onOpenChange={setOpen} title="Land this change" width={680}>
        {review === undefined || change === null ? (
          <p role="status" className="font-mono text-[12px] text-muted-foreground">
            Opening the review…
          </p>
        ) : (
          <LandPanel
            changeId={changeId}
            sessionId={facts.session.id}
            worktreeBranch={change.branch}
            baseRef={facts.session.baseRef}
            defaultBranch={project?.project.defaultBranch ?? null}
            sessionLabel={facts.session.label}
            tour={tour}
            files={review.files}
          />
        )}
      </ModalDialog>
    </>
  );
}

/** The comments not yet sent, the change-level composer, and Send N (screen P2's panel). */
function CommentsSection({
  facts,
  changeId,
  review,
  comments,
  wide = false,
}: {
  readonly facts: SessionFacts;
  readonly changeId: string;
  readonly review: ReviewDiffDto | undefined;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly wide?: boolean;
}) {
  const unsent = openUnsentOf(comments);
  const rule = sendRule(facts);
  const changeLevel = comments.filter((comment) => comment.file === null);
  return (
    <PanelSection
      heading="title"
      title={
        <span className="flex items-baseline gap-2">
          Comments
          <span className="font-mono text-[11.5px] font-normal text-muted-foreground">
            {unsent.length} not sent
          </span>
        </span>
      }
    >
      {unsent.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          None waiting. Click a line number in the diff to comment on it.
        </p>
      ) : (
        <ul className="grid">
          {unsent.map((comment) => (
            <li
              key={comment.id}
              className="grid gap-0.5 py-[7px] text-[13px] [&+&]:border-t [&+&]:border-rule-faint"
            >
              <span className="font-mono text-[11px] text-muted-foreground">
                {comment.file === null
                  ? "whole change"
                  : `${comment.file.split("/").at(-1)}${comment.line === null ? "" : `:${lineLabel(comment.line, comment.endLine)}`}`}
              </span>
              <span className="line-clamp-2 text-ink-2">{comment.body}</span>
            </li>
          ))}
        </ul>
      )}
      {changeLevel
        .filter((comment) => !unsent.includes(comment))
        .map((comment) => (
          <div key={comment.id} className="grid gap-1 rounded-xl bg-secondary p-3">
            <p className="font-mono text-[10.5px] text-label">
              {comment.authorKind === "mend" ? "Mend" : comment.authorName} ·{" "}
              {comment.sentToSessionId === null ? comment.state : "sent"}
            </p>
            <p className="text-[13px] text-ink-2">{comment.body}</p>
            <SuggestionBlock comment={comment} />
            <EvidenceLines comment={comment} />
            <CommentStateActions comment={comment} />
          </div>
        ))}
      {review === undefined ? null : (
        <ChangeComment
          changeId={changeId}
          sliceId={review.slice.id}
          scope={{
            userId: facts.viewer?.userId ?? "unknown",
            changeId,
            sliceId: review.slice.id,
          }}
        />
      )}
      {rule.can ? (
        <SendButton facts={facts} review={review} comments={unsent} wide={wide} />
      ) : (
        <p className="border-l-2 border-primary pl-3 text-[12.5px] text-ink-2">{rule.why}</p>
      )}
    </PanelSection>
  );
}

/** A comment on the change as a whole. Its words are kept as a draft until they are saved. */
function ChangeComment({
  changeId,
  sliceId,
  scope,
}: {
  readonly changeId: string;
  readonly sliceId: string;
  readonly scope: ReviewDraftScope;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const draftKey = reviewDraftKey(scope, "whole");
  const [body, setBody] = useDraft(draftKey);
  const post = useMutation({
    mutationFn: (text: string) =>
      postSliceReviewComment(
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
        text,
      ),
    onSuccess: (_, text) => clearSentDraft(draftKey, text),
    onSettled: () => queryClient.invalidateQueries(trpc.changes.pathFilter()),
  });
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim() !== "") post.mutate(body.trim());
      }}
    >
      <textarea
        aria-label="Comment on the whole change"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Comment on the whole change"
        rows={2}
        className="w-full resize-y rounded-[10px] border border-input bg-panel px-3 py-2 font-sans text-[13px] text-foreground outline-none placeholder:text-faint focus-visible:border-primary"
      />
      <div className="flex items-center justify-end gap-2">
        {post.isError ? (
          <span role="alert" className="mr-auto text-[12px] text-danger">
            {errorWords(post.error)}
          </span>
        ) : null}
        <Button size="sm" type="submit" disabled={post.isPending || body.trim() === ""}>
          {post.isPending ? "Saving…" : "Comment"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Checks (screen P2): the tests, typechecks, lints and builds the agent ran, as its command steps
 * recorded them, and how each ended. A check the agent only says it ran has no step, so it is
 * not here.
 */
function ChecksSection({ facts }: { readonly facts: SessionFacts }) {
  const conversation = useConversation(facts.session.id);
  const checks = observedChecks(conversation.data?.items ?? []);
  return (
    <PanelSection heading="title" title="Checks">
      {conversation.isPending ? (
        <p role="status" className="text-[12.5px] text-muted-foreground">
          Reading the record…
        </p>
      ) : checks.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          No test, typecheck, lint or build seen in the record.
        </p>
      ) : (
        <ul className="grid">
          {checks.slice(0, 6).map((check) => (
            <li
              key={check.command}
              className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 py-[7px] text-[13px] [&+&]:border-t [&+&]:border-rule-faint"
            >
              <Dot
                tone={
                  check.result === "passed"
                    ? "ok"
                    : check.result === "failed"
                      ? "bad"
                      : check.result === "running"
                        ? "run"
                        : "off"
                }
                className="mt-[7px]"
              />
              <span className="truncate font-mono text-[12px] text-ink-2" title={check.command}>
                {check.command}
              </span>
              <StatusWord
                tone={null}
                className={cn(
                  "col-start-2",
                  check.result === "passed"
                    ? "text-[#3f7d54]"
                    : check.result === "failed"
                      ? "text-danger"
                      : undefined,
                )}
              >
                {check.result === "running"
                  ? "running"
                  : check.result === "unknown"
                    ? `ran ${clockTime(new Date(check.at))} · outcome not recorded`
                    : `${check.exitCode === null ? check.result : `exit ${check.exitCode}`} · ran ${clockTime(new Date(check.at))}`}
              </StatusWord>
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}

/** The side panel of the Change tab (screen P2): comments, checks and Land. */
function ReviewPanel({
  facts,
  changeId,
  review,
  comments,
}: {
  readonly facts: SessionFacts;
  readonly changeId: string;
  readonly review: ReviewDiffDto | undefined;
  readonly comments: ReadonlyArray<ReviewCommentDto> | undefined;
}) {
  const change = facts.detail.change;
  return (
    <div className="grid gap-6">
      <CommentsSection
        facts={facts}
        changeId={changeId}
        review={review}
        comments={comments ?? []}
        wide
      />
      <ChecksSection facts={facts} />
      <PanelSection heading="title" title="Mend reads the change">
        <div className="flex flex-wrap gap-1">
          <MendReads changeId={changeId} hasFiles={(review?.files.length ?? 0) > 0} />
        </div>
      </PanelSection>
      <section id="land" className="grid scroll-mt-4 gap-2.5">
        <h2 className="font-sans text-[15px] font-semibold">Land</h2>
        <p className="text-[12.5px] text-muted-foreground">
          Push {change?.branch ?? "the branch"} and open a pull request.
        </p>
        <LandButton facts={facts} changeId={changeId} review={review} wide />
      </section>
    </div>
  );
}
