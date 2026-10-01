// The review loop's data: comments anchored to the diff (or the change as a
// whole), the composed description/tour, the recorded machine passes, and
// the follow-up bundle. Polling stands in for the web's SSE — passes poll
// fast only while one is running, so a queued pass surfaces quickly and a
// quiet screen stays cheap.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  api,
  ApiError,
  requireFollowUpDelivery,
  useSession,
  type FollowUpDto,
  type SessionChangeDto,
} from "@/data/live";
import {
  advanceTarget,
  newerCheckpoint,
  type CheckpointDto,
  type ObservationDto,
} from "@/data/review-state";

// ─── wire types (the server's DTOs, minimally) ──────────────────────────────

/** A finding's link into the session record; sequence is a decimal string. */
export interface RecordLinkDto {
  readonly sealantRunId: string;
  readonly sequence: string;
  readonly excerpt: string;
}

export interface ReviewCommentDto {
  readonly id: string;
  readonly changeId: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly endLine: number | null;
  readonly authorKind: "reviewer" | "mend";
  readonly authorName: string;
  readonly body: string;
  /** `suggestion` carries a concrete replacement for the anchored lines. */
  readonly kind: "note" | "suggestion";
  readonly suggestion: string | null;
  readonly state: "draft" | "open" | "addressed" | "dismissed";
  readonly evidence: ReadonlyArray<RecordLinkDto>;
  readonly sentToSessionId: string | null;
  readonly createdAt: string;
  /** The slice the comment was written on; null for a legacy live-diff comment. */
  readonly anchor?: ReviewCommentAnchorDto | null;
}

/** Where a comment was written: one slice, and the checkpoints that bound it. */
export interface ReviewCommentAnchorDto {
  readonly reviewSliceId: string;
  readonly checkpointAId: string;
  readonly checkpointBId: string;
}

/** One stop of the composed review tour. Coordinates are new-file lines. */
export interface TourStopDto {
  readonly title: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly endLine: number | null;
  readonly narration: string;
  readonly evidence: ReadonlyArray<RecordLinkDto>;
  readonly grounded: boolean;
}

export interface ChangeTourDto {
  readonly id: string;
  readonly changeId: string;
  readonly sessionId: string;
  readonly summary: string;
  readonly approach: string | null;
  readonly stops: ReadonlyArray<TourStopDto>;
  readonly diffDigest: string;
  readonly createdAt: string;
}

/**
 * A machine pass's recorded outcome. Zero findings on a completed pass is
 * an outcome, not an absence — "completed · none" and "never ran" must
 * never look the same.
 */
export interface ChangePassDto {
  readonly changeId: string;
  readonly kind: "tour" | "read" | "suggest";
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly detail: string | null;
  readonly findings: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** The pinned Review slice: comments and the follow-up anchor to it, never to the moving worktree. */
export interface ReviewSliceDto {
  readonly id: string;
  readonly checkpointAId: string;
  readonly checkpointBId: string;
  readonly diffDigest: string;
}

export interface ReviewDiffHunkDto {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly contextHash: string;
}

export interface ReviewDiffFileDto {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: ReadonlyArray<ReviewDiffHunkDto>;
}

export interface OpenReviewDto {
  readonly slice: ReviewSliceDto;
  readonly checkpointA: CheckpointDto;
  readonly checkpointB: CheckpointDto;
  readonly reused: boolean;
}

export interface ReviewDiffDto {
  readonly change: SessionChangeDto;
  readonly slice: ReviewSliceDto;
  readonly checkpointA: CheckpointDto;
  readonly checkpointB: CheckpointDto;
  readonly patch: string;
  readonly files: ReadonlyArray<ReviewDiffFileDto>;
  /**
   * A live observation only — the rendered patch stays the slice's. In
   * capture mode it is judged against the newest capture, which
   * `observation` names.
   */
  readonly worktreeChangedSinceSnapshot: boolean;
  /** Absent from servers that predate captures. */
  readonly observation?: ObservationDto;
}

// ─── queries ────────────────────────────────────────────────────────────────

// Opening a review is an idempotent mutation used as a query, as the web
// review does per tab. Here one screen visit is the tab: every visit opens at
// the change's current state (the server reuses the last slice when nothing
// moved), and a newer checkpoint from the session reopens it while the
// screen stays up. Pull-to-refresh starts a new visit.
let visitSequence = 0;

const newVisitKey = (changeId: string): string => {
  visitSequence += 1;
  return `mobile-review:${changeId}:${Date.now().toString(36)}:${visitSequence.toString(36)}`;
};

/**
 * The slice a screen renders, and the requests behind it. `hold` keeps the
 * slice where it is while the reviewer writes on it — a draft stays on the
 * slice it was started on, and the review advances once it is sent or
 * dropped.
 */
export const usePinnedReview = (changeId: string | null, hold: boolean) => {
  const queryClient = useQueryClient();
  const [visit, setVisit] = useState(() => newVisitKey(changeId ?? ""));
  const [advancedFor, setAdvancedFor] = useState<string | null>(null);
  // The key a pull-to-refresh opened, so the spinner answers the pull only —
  // an automatic advance or a background re-read never pulls the list down.
  const [pulledKey, setPulledKey] = useState<string | null>(null);
  const idempotencyKey = `${visit}:${advancedFor ?? "open"}`;

  const open = useQuery({
    queryKey: ["change", changeId, "review-open", idempotencyKey],
    enabled: changeId !== null,
    // Pinned for this key: a refetch with the same key answers the same slice.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () =>
      api<OpenReviewDto>("POST", `/changes/${changeId}/reviews/open`, { idempotencyKey }),
  });
  const sliceId = open.data?.slice.id ?? null;
  const diff = useQuery({
    queryKey: ["change", changeId, "review-diff", sliceId],
    enabled: changeId !== null && sliceId !== null,
    // The patch is pinned by digest; re-reading (every 30 s on screen, and on
    // foreground) refreshes only the moved-since observation beside it, so
    // an agent mid-turn shows as "differs from checkpoint N" before its
    // turn-boundary checkpoint advances the slice.
    staleTime: 30_000,
    refetchInterval: 30_000,
    // The slice on screen stays while the next one opens (or fails to).
    placeholderData: keepPreviousData,
    queryFn: () => api<ReviewDiffDto>("GET", `/changes/${changeId}/reviews/${sliceId}/diff`),
  });
  const review = diff.data ?? null;

  // The session's detail carries the worktree's checkpoint chain and is
  // already polled — it is the phone's stand-in for the web's live events.
  const session = useSession(review?.change.sessionId ?? null);
  const chain = session.data?.checkpoints ?? [];
  const target = advanceTarget({
    chain,
    pinned: review?.checkpointB ?? null,
    advancedFor,
    hold,
  });
  // Adjusting state from what was just read, during render (no effect): the
  // guard in advanceTarget makes this fire once per newer checkpoint.
  if (target !== null) setAdvancedFor(target);
  const waiting = newerCheckpoint(chain, review?.checkpointB ?? null);

  return {
    open,
    diff,
    review,
    /** The newest checkpoint past the pinned one, while the review waits on a draft. */
    heldFor: hold ? waiting : null,
    /** A newer open in flight while the older slice stays on screen. */
    advancing: diff.isPlaceholderData && open.status !== "error",
    refreshing: pulledKey === idempotencyKey && (open.isLoading || diff.isPlaceholderData),
    /** Pull-to-refresh: a new visit, opened at the change's current state. */
    refresh: () => {
      const next = newVisitKey(changeId ?? "");
      // Keyed on the newest checkpoint already seen, so the new visit opens
      // once rather than opening and then advancing straight after.
      const nextAdvancedFor = waiting?.id ?? null;
      setVisit(next);
      setAdvancedFor(nextAdvancedFor);
      setPulledKey(`${next}:${nextAdvancedFor ?? "open"}`);
      // The comments, tour and passes; the new key reads its own slice.
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "change" &&
          query.queryKey[1] === changeId &&
          query.queryKey[2] !== "review-open" &&
          query.queryKey[2] !== "review-diff",
      });
      void session.refetch();
    },
  };
};

export const useChangeComments = (changeId: string | null) =>
  useQuery({
    queryKey: ["change", changeId, "comments"],
    enabled: changeId !== null,
    queryFn: () => api<ReadonlyArray<ReviewCommentDto>>("GET", `/changes/${changeId}/comments`),
    // Draft findings land asynchronously as passes complete.
    refetchInterval: 10_000,
  });

export const useChangeTour = (changeId: string | null) =>
  useQuery({
    queryKey: ["change", changeId, "tour"],
    enabled: changeId !== null,
    queryFn: () => api<ChangeTourDto | null>("GET", `/changes/${changeId}/tour`),
    // Composed at settle by the automation cascade — it can arrive while
    // the screen is already open.
    refetchInterval: 15_000,
  });

export const useChangePasses = (changeId: string | null) =>
  useQuery({
    queryKey: ["change", changeId, "passes"],
    enabled: changeId !== null,
    queryFn: () => api<ReadonlyArray<ChangePassDto>>("GET", `/changes/${changeId}/passes`),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((pass) => pass.status === "running" || pass.status === "queued")
        ? 2_500
        : 12_000,
  });

// ─── actions ────────────────────────────────────────────────────────────────

/** Null paths = the change as a whole; paths + side/lines/hash = a diff line. */
export interface SliceCommentTarget {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly side: "old" | "new" | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly hunkContextHash: string | null;
}

export const CHANGE_LEVEL_TARGET: SliceCommentTarget = {
  oldPath: null,
  newPath: null,
  side: null,
  startLine: null,
  endLine: null,
  hunkContextHash: null,
};

export interface NewCommentInput {
  readonly sliceId: string;
  readonly target: SliceCommentTarget;
  readonly body: string;
}

export const useReviewActions = (changeId: string) => {
  const queryClient = useQueryClient();
  // Prefix key: catches the diff (["change", id]) and every sub-query.
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["change", changeId] });
  const comment = useMutation({
    mutationFn: (input: NewCommentInput) =>
      api<ReviewCommentDto>("POST", `/changes/${changeId}/reviews/${input.sliceId}/comments`, {
        target: input.target,
        body: input.body,
      }),
    onSettled: invalidate,
  });
  const setState = useMutation({
    mutationFn: (input: {
      readonly commentId: string;
      readonly state: "open" | "addressed" | "dismissed";
    }) =>
      api<ReviewCommentDto>("POST", `/changes/${changeId}/comments/${input.commentId}/state`, {
        state: input.state,
      }),
    onSettled: invalidate,
  });
  // read | suggest | tour — the kind is the route; findings arrive as draft
  // comments (or the tour row) when the queued job completes.
  const queuePass = useMutation({
    mutationFn: (kind: "read" | "suggest" | "tour") =>
      api<{ readonly queued: boolean }>("POST", `/changes/${changeId}/${kind}`, {}),
    onSettled: invalidate,
  });
  return { comment, setState, queuePass };
};

let reviewDeliverySequence = 0;

const nextReviewDeliveryKey = (changeId: string): string => {
  reviewDeliverySequence += 1;
  return `mobile-review:${changeId}:${Date.now().toString(36)}:${reviewDeliverySequence.toString(36)}`;
};

/**
 * Hand the exact edited instruction to server-owned delivery, anchored to the
 * slice this screen rendered — the comments and the instruction pin to the
 * same patch, and the server verifies the digest.
 */
export const useSendReview = (
  changeId: string,
  /** The change's last contributing conversation; null = nowhere to deliver. */
  sessionId: string | null,
  commentIds: ReadonlyArray<string>,
  slice: ReviewSliceDto,
) => {
  const queryClient = useQueryClient();
  const selectedCommentIds = useRef(commentIds);
  const idempotencyKey = useRef(nextReviewDeliveryKey(changeId));
  return useMutation({
    mutationFn: async (instruction: string) => {
      if (sessionId === null) {
        throw new ApiError("No conversation has inhabited this worktree yet.", 0);
      }
      const followUp = await api<FollowUpDto>("POST", `/sessions/${sessionId}/follow-up/deliver`, {
        reviewSliceId: slice.id,
        checkpointAId: slice.checkpointAId,
        checkpointBId: slice.checkpointBId,
        diffDigest: slice.diffDigest,
        commentIds: selectedCommentIds.current,
        instruction,
        idempotencyKey: idempotencyKey.current,
      });
      return requireFollowUpDelivery(followUp);
    },
    onSettled: () => queryClient.invalidateQueries(),
  });
};
