import { KEPT_SENDS, type PendingComment, type SessionReview } from "./pending.js";
import type { ChangeFile, ServerComment } from "./review-wire.js";

/**
 * Sending a review back (story d, step 6), as a pure state machine. Her pending comments move into
 * one send record, are posted to Mend (that route takes no idempotency key, so a post in flight is
 * reconciled before it is made again), and then the follow-up is delivered with one idempotency
 * key kept in the record: a retry sends the same key and the same text. Nothing here, and nothing
 * that reads Mend, ever delivers a key again on its own: Mend holds a terminal agent's follow-up
 * `pending` and nothing flushes it, so it is delivered again only when she asks, once the agent is
 * gone (the route then launches the session on the review). A record is `delivered` only once Mend
 * reads its comments back as sent to the session.
 */

/** A post on its way, kept before the request goes: a reload matches only what it made. */
export interface PostAttempt {
  /** The words and the target posted, exactly. */
  readonly body: string;
  readonly target: CommentTarget;
  /** Her name as Mend writes it on her comments; null when Mend could not say who she is. */
  readonly author: string | null;
  /** Every comment id on the change before the post: the one it made is not among them. */
  readonly before: ReadonlyArray<string>;
}

/** Where one of her own comments is on its way to Mend. */
export type PostState =
  | { readonly kind: "unposted" }
  | ({ readonly kind: "posting" } & PostAttempt)
  | { readonly kind: "posted"; readonly commentId: string };

/** One comment of the review she sends. */
export type SendItem =
  | { readonly kind: "own"; readonly pending: PendingComment; readonly post: PostState }
  /** A Mend draft she accepted: Send opens it on Mend, then sends it. */
  | {
      readonly kind: "accepted";
      readonly pending: PendingComment;
      readonly draftId: string;
      readonly opened: boolean;
    }
  /** Open on Mend and not sent: accepted or written elsewhere. */
  | { readonly kind: "open"; readonly commentId: string };

/** Where the follow-up is. */
export type SendPhase =
  | { readonly kind: "sending"; readonly since: string }
  /** A stopped session is being launched on the review (the route resumes it). */
  | { readonly kind: "delivering" }
  /** G12 fallback: Mend holds it pending while the terminal agent lives; the extension pasted it. */
  | { readonly kind: "in-terminal"; readonly agent: string; readonly pasted: boolean }
  /** Mend holds it pending, and this window had no terminal of hers to paste it into. */
  | { readonly kind: "pending" }
  | { readonly kind: "delivered"; readonly at: string }
  | { readonly kind: "failed"; readonly words: string }
  /** Mend refused this key or this person: a new review, with a new key, is the way on. */
  | { readonly kind: "refused"; readonly words: string };

export interface SendRecord {
  /** The follow-up's idempotency key: the same on every retry. */
  readonly key: string;
  readonly sliceId: string;
  readonly baseId: string;
  readonly headId: string;
  readonly diffDigest: string;
  /** The text Mend sends, exactly as she sent it. */
  readonly instruction: string;
  readonly items: ReadonlyArray<SendItem>;
  readonly phase: SendPhase;
  readonly createdAt: string;
}

/** What a live agent is, for where a pending follow-up lands. */
export type LiveAgent =
  | { readonly kind: "terminal"; readonly name: string; readonly hers: boolean }
  | { readonly kind: "other" };

/** What Mend answered `follow-up/deliver` (or `GET …/follow-up`) about this key. */
export type FollowUpStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "delivery_failed"
  | "superseded";

export type SendEvent =
  | { readonly kind: "post-started"; readonly pendingId: string; readonly attempt: PostAttempt }
  | { readonly kind: "posted"; readonly pendingId: string; readonly commentId: string }
  /** The reconcile read found nothing posted for this comment: it is posted again. */
  | { readonly kind: "not-posted"; readonly pendingId: string }
  | { readonly kind: "opened"; readonly draftId: string }
  /** The draft she accepted is dismissed on Mend, or gone: it leaves the review, never reopened. */
  | { readonly kind: "draft-gone"; readonly draftId: string }
  /** A newer review of hers reached Mend, which supersedes every follow-up it held before. */
  | { readonly kind: "superseded" }
  | {
      readonly kind: "answered";
      readonly status: FollowUpStatus;
      readonly error: string | null;
      readonly agent: LiveAgent;
    }
  | { readonly kind: "pasted" }
  /** Her terminal could not be attached here: Mend still holds the follow-up pending. */
  | { readonly kind: "paste-failed" }
  | { readonly kind: "failed"; readonly words: string; readonly retryable: boolean }
  /**
   * Retry delivery, with everything kept: from a failure, or from a follow-up Mend holds pending
   * once the session has no live agent. `agent` is the session's live agent as read just now.
   */
  | { readonly kind: "retry"; readonly at: string; readonly agent: LiveAgent | null }
  /** A window loaded with this record in it: a send it did not see end is not known to be sent. */
  | { readonly kind: "loaded" }
  /**
   * A watch of a launch: `GET …/follow-up` lists only the newest follow-up not yet delivered, so
   * `status` is ours when it is listed, and `sent` is whether Mend reads every comment of the
   * review back as sent to the session, the only proof it was delivered.
   */
  | {
      readonly kind: "follow-up";
      readonly status: FollowUpStatus | null;
      readonly error: string | null;
      /** Another follow-up of the session is listed: ours may still be on its way. */
      readonly others: boolean;
      readonly sent: boolean;
    };

/** What the extension does next for a record. */
export type SendAction =
  | { readonly kind: "reconcile"; readonly pendingIds: ReadonlyArray<string> }
  | { readonly kind: "post"; readonly pending: PendingComment }
  | { readonly kind: "open"; readonly draftId: string }
  | { readonly kind: "deliver"; readonly request: DeliverRequest }
  | { readonly kind: "paste"; readonly text: string }
  | { readonly kind: "watch" }
  | { readonly kind: "idle" };

export interface DeliverRequest {
  readonly reviewSliceId: string;
  readonly checkpointAId: string;
  readonly checkpointBId: string;
  readonly diffDigest: string;
  readonly commentIds: ReadonlyArray<string>;
  readonly instruction: string;
  readonly idempotencyKey: string;
}

/** The ids Mend knows the review's comments by; null while one is not on Mend yet. */
export const commentIds = (record: SendRecord): ReadonlyArray<string> | null => {
  const ids: Array<string> = [];
  for (const item of record.items) {
    if (item.kind === "open") ids.push(item.commentId);
    else if (item.kind === "accepted") {
      if (!item.opened) return null;
      ids.push(item.draftId);
    } else if (item.post.kind === "posted") ids.push(item.post.commentId);
    else return null;
  }
  return ids;
};

export const deliverRequest = (record: SendRecord, ids: ReadonlyArray<string>): DeliverRequest => ({
  reviewSliceId: record.sliceId,
  checkpointAId: record.baseId,
  checkpointBId: record.headId,
  diffDigest: record.diffDigest,
  commentIds: ids,
  instruction: record.instruction,
  idempotencyKey: record.key,
});

/**
 * The next thing to do: only a record that is sending posts, opens or delivers, and only one in a
 * terminal not yet pasted into pastes. Every other record waits for her.
 */
export const nextAction = (record: SendRecord): SendAction => {
  if (record.phase.kind === "in-terminal")
    return record.phase.pasted ? { kind: "idle" } : { kind: "paste", text: record.instruction };
  if (record.phase.kind === "delivering") return { kind: "watch" };
  if (record.phase.kind !== "sending") return { kind: "idle" };
  const posting = record.items.flatMap((item) =>
    item.kind === "own" && item.post.kind === "posting" ? [item.pending.id] : [],
  );
  if (posting.length > 0) return { kind: "reconcile", pendingIds: posting };
  for (const item of record.items) {
    if (item.kind === "own" && item.post.kind === "unposted")
      return { kind: "post", pending: item.pending };
    if (item.kind === "accepted" && !item.opened) return { kind: "open", draftId: item.draftId };
  }
  const ids = commentIds(record);
  return ids === null
    ? { kind: "idle" }
    : { kind: "deliver", request: deliverRequest(record, ids) };
};

const withPost = (record: SendRecord, pendingId: string, post: PostState): SendRecord => ({
  ...record,
  items: record.items.map((item) =>
    item.kind === "own" && item.pending.id === pendingId ? { ...item, post } : item,
  ),
});

const answeredPhase = (
  status: FollowUpStatus,
  error: string | null,
  agent: LiveAgent,
): SendPhase => {
  switch (status) {
    case "pending":
      return agent.kind === "terminal" && agent.hers
        ? { kind: "in-terminal", agent: agent.name, pasted: false }
        : { kind: "pending" };
    // Delivered is concluded from the comments read back as sent, by the watch.
    case "delivering":
    case "delivered":
      return { kind: "delivering" };
    case "delivery_failed":
      return { kind: "failed", words: error ?? "Mend could not deliver the review." };
    case "superseded":
      return { kind: "refused", words: "Mend replaced this follow-up with a newer one." };
  }
};

/** A record after an event; an event its phase does not take leaves it as it was. */
export const step = (record: SendRecord, event: SendEvent, now: string): SendRecord => {
  switch (event.kind) {
    case "post-started":
      return withPost(record, event.pendingId, { kind: "posting", ...event.attempt });
    case "posted":
      return withPost(record, event.pendingId, { kind: "posted", commentId: event.commentId });
    case "not-posted":
      return withPost(record, event.pendingId, { kind: "unposted" });
    case "opened":
      return {
        ...record,
        items: record.items.map((item) =>
          item.kind === "accepted" && item.draftId === event.draftId
            ? { ...item, opened: true }
            : item,
        ),
      };
    case "answered":
      return record.phase.kind === "sending"
        ? { ...record, phase: answeredPhase(event.status, event.error, event.agent) }
        : record;
    case "pasted":
      return record.phase.kind === "in-terminal"
        ? { ...record, phase: { ...record.phase, pasted: true } }
        : record;
    case "paste-failed":
      return record.phase.kind === "in-terminal"
        ? { ...record, phase: { kind: "pending" } }
        : record;
    case "failed":
      return record.phase.kind === "sending" || record.phase.kind === "delivering"
        ? {
            ...record,
            phase: event.retryable
              ? { kind: "failed", words: event.words }
              : { kind: "refused", words: event.words },
          }
        : record;
    case "draft-gone": {
      const items = record.items.filter(
        (item) => item.kind !== "accepted" || item.draftId !== event.draftId,
      );
      if (items.length > 0 || record.phase.kind === "refused") return { ...record, items };
      return {
        ...record,
        items,
        phase: {
          kind: "refused",
          words: "Every comment in this review was dismissed on Mend: nothing is left to send.",
        },
      };
    }
    case "superseded":
      return record.phase.kind === "pending" ||
        record.phase.kind === "in-terminal" ||
        record.phase.kind === "failed"
        ? {
            ...record,
            phase: { kind: "refused", words: "Mend replaced this follow-up with a newer review." },
          }
        : record;
    case "retry":
      return mayRetry(record, event.agent)
        ? { ...record, phase: { kind: "sending", since: event.at } }
        : record;
    case "loaded":
      return record.phase.kind === "sending"
        ? {
            ...record,
            phase: { kind: "failed", words: "VS Code closed before Mend answered" },
          }
        : record;
    case "follow-up":
      if (record.phase.kind !== "delivering") return record;
      if (event.sent) return { ...record, phase: { kind: "delivered", at: now } };
      if (event.status === "delivery_failed")
        return {
          ...record,
          phase: { kind: "failed", words: event.error ?? "Mend could not deliver the review." },
        };
      // Mend holds it pending (the session went live, or a reload never heard the answer): it waits
      // there until she retries it.
      if (event.status === "pending") return { ...record, phase: { kind: "pending" } };
      if (event.status !== null || event.others) return record;
      return {
        ...record,
        phase: {
          kind: "failed",
          words:
            "Mend no longer lists this follow-up, and it does not read its comments as sent to the session",
        },
      };
  }
};

/**
 * Retry delivery is offered on a failed record, and on a follow-up Mend holds pending once the
 * session has no live agent: the same key then launches the stopped session on the review.
 */
export const mayRetry = (record: SendRecord, agent: LiveAgent | null): boolean =>
  record.phase.kind === "failed" ||
  ((record.phase.kind === "pending" || record.phase.kind === "in-terminal") && agent === null);

const isHeld = (record: SendRecord): boolean =>
  record.phase.kind === "pending" || record.phase.kind === "in-terminal";

/**
 * The review Retry delivery acts on: the newest one failed, else the newest Mend holds pending once
 * the session has no live agent to paste into.
 */
export const retryRecord = (
  records: ReadonlyArray<SendRecord>,
  agent: LiveAgent | null,
): SendRecord | null => {
  const open = openRecord(records);
  if (open !== null) return open.phase.kind === "failed" ? open : null;
  const held = records.findLast(isHeld);
  return held !== undefined && mayRetry(held, agent) ? held : null;
};

/**
 * The comments of reviews Mend holds pending. They are not counted as new for Send review: a held
 * review waits in her terminal, or for Retry. A newer key still carries them, as Mend supersedes it.
 */
export const heldIds = (records: ReadonlyArray<SendRecord>): ReadonlySet<string> =>
  new Set(records.filter(isHeld).flatMap((record) => commentIds(record) ?? []));

/**
 * A review after an event on one of its records. Mend supersedes every follow-up it holds pending
 * or failed when a newer key arrives, so once a record is answered every older one it would have
 * superseded reads so.
 */
export const stepReview = (
  review: SessionReview,
  key: string,
  event: SendEvent,
  now: string,
): SessionReview => {
  const next = withSend(review, key, (record) => step(record, event, now));
  if (event.kind !== "answered" || event.status === "superseded") return next;
  const at = next.sends.findIndex((record) => record.key === key);
  return next.sends
    .slice(0, Math.max(at, 0))
    .reduce(
      (kept, older) =>
        withSend(kept, older.key, (record) => step(record, { kind: "superseded" }, now)),
      next,
    );
};

/** A record that still holds its comments: this window is sending or delivering it. */
export const holdsComments = (record: SendRecord): boolean =>
  record.phase.kind === "sending" || record.phase.kind === "delivering";

/** What a thread of a comment in this record reads, as Mend observed it. */
export const recordLabel = (phase: SendPhase): string => {
  switch (phase.kind) {
    case "sending":
      return "sending";
    case "delivering":
      return "delivery in progress";
    case "in-terminal":
      return `follow-up pending · in ${phase.agent}'s terminal`;
    case "pending":
      return "follow-up pending";
    case "delivered":
      return "sent";
    case "failed":
      return "delivery failed · retryable";
    case "refused":
      return "not sent";
  }
};

/** A record whose comments were handed to the session: its head is where her last review was. */
export const handedOver = (record: SendRecord): boolean =>
  record.phase.kind === "delivered" ||
  record.phase.kind === "in-terminal" ||
  record.phase.kind === "pending" ||
  record.phase.kind === "delivering";

/** The record a new Send waits on, or retries: the newest one not handed over or refused. */
export const openRecord = (records: ReadonlyArray<SendRecord>): SendRecord | null =>
  records.findLast((record) => record.phase.kind === "sending" || record.phase.kind === "failed") ??
  null;

/** Where a comment goes on Mend: on a line inside one of the slice's hunks, else on its file. */
export type CommentTarget = {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly side: "old" | "new" | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly hunkContextHash: string | null;
};

/**
 * The target for a pending comment in the slice it was written on: its lines when one hunk holds
 * them, else its file (the words then say which line), else the change as a whole.
 */
export const commentTarget = (
  files: ReadonlyArray<ChangeFile>,
  comment: Pick<PendingComment, "path" | "line" | "endLine" | "body">,
): { readonly target: CommentTarget; readonly body: string } => {
  const file =
    comment.path === null
      ? undefined
      : files.find((candidate) => candidate.newPath === comment.path);
  const hunk = file?.hunks.find(
    (candidate) =>
      candidate.newLines > 0 &&
      comment.line >= candidate.newStart &&
      comment.endLine <= candidate.newStart + candidate.newLines - 1,
  );
  if (file !== undefined && hunk !== undefined)
    return {
      target: {
        oldPath: null,
        newPath: comment.path,
        side: "new",
        startLine: comment.line,
        endLine: comment.endLine,
        hunkContextHash: hunk.contextHash,
      },
      body: comment.body,
    };
  const where = `line ${comment.line}: `;
  if (file !== undefined)
    return {
      target: {
        oldPath: null,
        newPath: comment.path,
        side: null,
        startLine: null,
        endLine: null,
        hunkContextHash: null,
      },
      body: `${where}${comment.body}`,
    };
  return {
    target: {
      oldPath: null,
      newPath: null,
      side: null,
      startLine: null,
      endLine: null,
      hunkContextHash: null,
    },
    body: comment.path === null ? comment.body : `${comment.path}:${comment.line}: ${comment.body}`,
  };
};

/**
 * The comment a post in flight left on Mend, if it landed: one that was not there before the post,
 * not claimed by another item, written by her, with exactly the words and the target posted, on
 * the slice it was posted to. Mend trims the words it keeps.
 */
export const postedComment = (
  attempt: PostAttempt,
  sliceId: string,
  comments: ReadonlyArray<ServerComment>,
  claimed: ReadonlySet<string>,
): string | null => {
  const before = new Set(attempt.before);
  const { target } = attempt;
  return (
    comments.find(
      (comment) =>
        !before.has(comment.id) &&
        !claimed.has(comment.id) &&
        comment.author.kind === "reviewer" &&
        (attempt.author === null || comment.author.name === attempt.author) &&
        comment.body === attempt.body.trim() &&
        comment.anchor?.sliceId === sliceId &&
        comment.file === (target.newPath ?? target.oldPath) &&
        comment.line === target.startLine &&
        comment.endLine === target.endLine,
    )?.id ?? null
  );
};

/**
 * Send review: the pending comments and the comments open on Mend her instruction lists move into
 * a new record with its key; null when one of those comments is no longer pending. From here the
 * record owns them until it ends.
 */
export const startSend = (
  review: SessionReview,
  input: {
    readonly key: string;
    readonly slice: {
      readonly id: string;
      readonly baseId: string;
      readonly headId: string;
      readonly diffDigest: string;
    };
    readonly instruction: string;
    /** The pending comments the instruction lists: each must still be pending. */
    readonly pending: ReadonlyArray<string>;
    readonly open: ReadonlyArray<string>;
    readonly now: string;
  },
): SessionReview | null => {
  const chosen = new Set(input.pending);
  const moving = review.pending.filter((pending) => chosen.has(pending.id));
  if (moving.length !== chosen.size) return null;
  const items: ReadonlyArray<SendItem> = [
    ...moving.map(
      (pending): SendItem =>
        pending.origin.kind === "accepted"
          ? { kind: "accepted", pending, draftId: pending.origin.draftId, opened: false }
          : { kind: "own", pending, post: { kind: "unposted" } },
    ),
    ...input.open.map((commentId): SendItem => ({ kind: "open", commentId })),
  ];
  const record: SendRecord = {
    key: input.key,
    sliceId: input.slice.id,
    baseId: input.slice.baseId,
    headId: input.slice.headId,
    diffDigest: input.slice.diffDigest,
    instruction: input.instruction,
    items,
    phase: { kind: "sending", since: input.now },
    createdAt: input.now,
  };
  return {
    pending: review.pending.filter((pending) => !chosen.has(pending.id)),
    sends: [...review.sends, record].slice(-KEPT_SENDS),
  };
};

/** The record with this key, after `change`; a record that is refused gives back what Mend lacks. */
export const withSend = (
  review: SessionReview,
  key: string,
  change: (record: SendRecord) => SendRecord,
): SessionReview => {
  const record = review.sends.find((candidate) => candidate.key === key);
  if (record === undefined) return review;
  const next = change(record);
  if (next.phase.kind !== "refused" || record.phase.kind === "refused")
    return {
      ...review,
      sends: review.sends.map((candidate) => (candidate.key === key ? next : candidate)),
    };
  // Refused: a comment not on Mend yet is pending again, so nothing she wrote is lost.
  const back = next.items.flatMap((item) =>
    (item.kind === "own" && item.post.kind !== "posted") ||
    (item.kind === "accepted" && !item.opened)
      ? [item.pending]
      : [],
  );
  return {
    pending: [...review.pending, ...back],
    sends: review.sends.map((candidate) => (candidate.key === key ? next : candidate)),
  };
};
