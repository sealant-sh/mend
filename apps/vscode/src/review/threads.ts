import type { ChangeAddress } from "./change-content.js";
import type { ChangeRead } from "./change-rows.js";
import { commentLabel, mayRetry, type LiveAgent, type SendRecord } from "./delivery.js";
import { acceptedDrafts, type PendingComment, type SessionReview } from "./pending.js";
import type { CommentAnchor, RecordLink, ServerComment } from "./review-wire.js";

/**
 * Every comment of a change as a thread in the editor (story d, steps 3, 4 and 7), decided without
 * VS Code: where it hangs, who wrote it, and the one word of its state. A thread hangs on the
 * document of the checkpoint it was written at, so it shows on whichever side of a diff holds
 * that checkpoint; her pending comments and Mend's drafts sit on the pinned slice's new side. A
 * comment about the change as a whole hangs on the change's own note (`change-note.ts`).
 */

export type ThreadKind =
  /** Her own pending comment, on this machine until Send review. */
  | "pending"
  /** A Mend draft she accepted: hers, pending like her own. */
  | "accepted"
  /** Mend's draft from reading the change: [Accept] [Dismiss]. */
  | "draft"
  /** Open on Mend and not sent: accepted or written elsewhere. */
  | "open"
  /** In a review on its way: posting, delivering, or a stopped session being launched. */
  | "sending"
  /** In a review whose delivery failed: [Retry delivery]. */
  | "failed"
  /** In a review Mend holds pending that Retry delivery acts on now: [Retry delivery]. */
  | "held"
  /** In a review Mend holds pending for her live agent, in its terminal or on its way there. */
  | "waiting"
  /** Handed to the session, as Mend observed it: [Addressed]. */
  | "sent"
  /** She marked it addressed: [Reopen]. Mend never says so itself. */
  | "addressed";

export interface ThreadView {
  readonly key: string;
  readonly kind: ThreadKind;
  /** The document it hangs on; null for the change as a whole, on the change's note. */
  readonly at: ChangeAddress | null;
  /** Lines from 1. */
  readonly line: number;
  readonly endLine: number;
  readonly author: string;
  readonly label: string;
  readonly body: string;
  readonly evidence: ReadonlyArray<RecordLink>;
  readonly createdAt: string;
  /** The pending comment it shows; null for a comment on Mend. */
  readonly pendingId: string | null;
  /** The comment on Mend it shows; for an accepted draft, the draft. */
  readonly commentId: string | null;
  /** The key of the review it went out in, for Retry delivery; null for one not sent. */
  readonly sendKey: string | null;
}

const pinnedAt = (read: ChangeRead, path: string): ChangeAddress => ({
  worktreeId: read.chain.worktreeId,
  absent: false,
  path,
  at: read.pinned.head.id,
  slice: read.pinned.id,
});

const pendingThread = (read: ChangeRead, comment: PendingComment, you: string): ThreadView => ({
  key: `pending:${comment.id}`,
  kind: comment.origin.kind === "accepted" ? "accepted" : "pending",
  // A comment written on an earlier pin stays on that slice's document until it is carried over.
  at:
    comment.path === null
      ? null
      : comment.anchor !== null
        ? anchoredAt(read, comment.anchor, comment.path)
        : comment.sliceId === read.pinned.id
          ? pinnedAt(read, comment.path)
          : {
              worktreeId: read.chain.worktreeId,
              absent: false,
              path: comment.path,
              at: comment.headId,
              slice: comment.sliceId,
            },
  line: comment.line,
  endLine: comment.endLine,
  author: comment.origin.kind === "accepted" ? `${you} · accepted from Mend` : you,
  label: "pending",
  body: comment.body,
  evidence: comment.origin.kind === "accepted" ? comment.origin.evidence : [],
  createdAt: comment.createdAt,
  pendingId: comment.id,
  commentId: comment.origin.kind === "accepted" ? comment.origin.draftId : null,
  sendKey: null,
});

const serverKind = (comment: ServerComment): ThreadKind | null => {
  switch (comment.state) {
    case "draft":
      return "draft";
    case "addressed":
      return "addressed";
    case "dismissed":
      return null;
    case "open":
      return comment.sentToSessionId === null ? "open" : "sent";
  }
};

const LABELS: Readonly<Record<ThreadKind, string>> = {
  pending: "pending",
  accepted: "pending",
  draft: "draft",
  open: "open",
  sending: "sending",
  failed: "delivery failed · retryable",
  held: "follow-up pending",
  waiting: "follow-up pending",
  sent: "sent",
  addressed: "addressed",
};

/**
 * Where a comment on Mend hangs: on the side of its anchor's slice it was written on, the old side
 * at the slice's base, the new side at its head (the pinned slice's new side when that is the
 * pinned head); with no anchor, on the pinned new side.
 */
const serverAt = (read: ChangeRead, comment: ServerComment, file: string): ChangeAddress =>
  comment.anchor === null ? pinnedAt(read, file) : anchoredAt(read, comment.anchor, file);

const anchoredAt = (read: ChangeRead, anchor: CommentAnchor, file: string): ChangeAddress => {
  const at = (checkpoint: string): ChangeAddress => ({
    worktreeId: read.chain.worktreeId,
    absent: false,
    path: file,
    at: checkpoint,
    slice: null,
  });
  if (anchor.side === "old") return at(anchor.baseId);
  if (anchor.headId === read.pinned.head.id) return pinnedAt(read, file);
  return at(anchor.headId);
};

/**
 * The kind and words a comment in a send record reads, from where its follow-up is. A follow-up
 * Mend holds pending offers Retry delivery once the session's agent is gone.
 */
const fromRecord = (
  record: SendRecord,
  agent: LiveAgent | null,
  /** The comment on Mend the thread shows; null for one not on Mend yet. */
  commentId: string | null,
): { readonly kind: ThreadKind; readonly label: string; readonly sendKey: string } => {
  const label = commentLabel(record, commentId, agent);
  const sendKey = record.key;
  switch (record.phase.kind) {
    case "sending":
    case "delivering":
    case "refused":
      return { kind: "sending", label, sendKey };
    case "failed":
      return { kind: "failed", label, sendKey };
    case "in-terminal":
    case "pending":
      return { kind: mayRetry(record, agent) ? "held" : "waiting", label, sendKey };
    case "delivered":
      return { kind: "sent", label, sendKey };
  }
};

export const threadsOf = (
  read: ChangeRead,
  review: SessionReview,
  you: string,
  /** Her words VS Code could not keep yet: pending comments marked not kept. */
  held: ReadonlyArray<PendingComment> = [],
): ReadonlyArray<ThreadView> => {
  const accepted = acceptedDrafts(review);
  // A comment in a review she sent reads where that follow-up is; a refused one, as Mend holds it.
  const sentIn = new Map<string, SendRecord>();
  const acceptedIn = new Set<string>();
  const threads: Array<ThreadView> = [
    ...review.pending.map((comment) => pendingThread(read, comment, you)),
    ...held.map((comment) => ({ ...pendingThread(read, comment, you), label: "not kept" })),
  ];
  for (const record of review.sends) {
    if (record.phase.kind === "refused") continue;
    for (const item of record.items) {
      if (item.kind === "open") sentIn.set(item.commentId, record);
      else if (item.kind === "accepted" && item.opened) {
        sentIn.set(item.draftId, record);
        acceptedIn.add(item.draftId);
      } else if (item.kind === "own" && item.post.kind === "posted")
        sentIn.set(item.post.commentId, record);
      else
        threads.push({
          ...pendingThread(read, item.pending, you),
          ...fromRecord(record, read.facts.agent, null),
        });
    }
  }
  for (const comment of read.comments) {
    const state = serverKind(comment);
    if (state === null || (state === "draft" && accepted.has(comment.id))) continue;
    const record = sentIn.get(comment.id);
    const { kind, label, sendKey } =
      record === undefined || state === "addressed"
        ? { kind: state, label: LABELS[state], sendKey: null }
        : fromRecord(record, read.facts.agent, comment.id);
    const author = acceptedIn.has(comment.id)
      ? `${you} · accepted from Mend`
      : comment.author.kind === "mend"
        ? kind === "draft"
          ? "Mend · draft"
          : "Mend"
        : comment.author.name === ""
          ? "a reviewer"
          : comment.author.name;
    const line = comment.file === null ? 1 : (comment.line ?? 1);
    threads.push({
      key: `comment:${comment.id}`,
      kind,
      at: comment.file === null ? null : serverAt(read, comment, comment.file),
      line,
      endLine: Math.max(line, comment.endLine ?? line),
      author,
      label,
      body: comment.body,
      evidence: comment.evidence,
      createdAt: comment.createdAt,
      pendingId: null,
      commentId: comment.id,
      sendKey,
    });
  }
  return threads;
};

/**
 * The lines a new comment may go on in this document: the pinned slice's hunks on its new side,
 * and nothing in any other document, so no slice but base → now takes a comment (G10).
 */
export const commentableLines = (
  read: ChangeRead,
  address: ChangeAddress,
): ReadonlyArray<{ readonly start: number; readonly end: number }> => {
  if (
    !read.slice.commentable ||
    address.slice !== read.pinned.id ||
    address.at !== read.pinned.head.id
  )
    return [];
  const file = read.pinnedDiff.files.find((candidate) => candidate.newPath === address.path);
  return (file?.hunks ?? [])
    .filter((hunk) => hunk.newLines > 0)
    .map((hunk) => ({ start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 }));
};

/**
 * `2 pending · 1 Mend draft`, `2 follow-up pending · pasted into claude's terminal`: the change's comments
 * counted by the state each was observed in; a follow-up Mend holds, by where its words are.
 */
export const commentsLine = (
  threads: ReadonlyArray<Pick<ThreadView, "kind" | "label">>,
): string => {
  const count = (kind: ThreadKind): number =>
    threads.filter((thread) => thread.kind === kind).length;
  const pending = count("pending") + count("accepted");
  const held = new Map<string, number>();
  for (const thread of threads)
    if (thread.kind === "held" || thread.kind === "waiting")
      held.set(thread.label, (held.get(thread.label) ?? 0) + 1);
  const parts = [
    pending > 0 ? `${pending} pending` : null,
    count("open") > 0 ? `${count("open")} open` : null,
    count("sending") > 0 ? `${count("sending")} sending` : null,
    count("failed") > 0 ? `${count("failed")} delivery failed · retryable` : null,
    ...[...held].map(([label, n]) => `${n} ${label}`),
    count("sent") > 0 ? `${count("sent")} sent` : null,
    count("addressed") > 0 ? `${count("addressed")} addressed` : null,
    count("draft") > 0
      ? `${count("draft")} Mend ${count("draft") === 1 ? "draft" : "drafts"}`
      : null,
  ].flatMap((part) => (part === null ? [] : [part]));
  return parts.length === 0 ? "none" : parts.join(" · ");
};

/** Where a thread is, as its label and its row say: `limit.ts:12`, or the whole change. */
export const threadPlace = (thread: Pick<ThreadView, "at" | "line">): string =>
  thread.at === null
    ? "the whole change"
    : `${thread.at.path.split("/").at(-1) ?? thread.at.path}:${thread.line}`;

/** `seq 214 · pnpm test auth · never ran`: a record entry as a thread shows it. */
export const evidenceLine = (link: RecordLink): string =>
  link.sequence === "" ? link.excerpt : `seq ${link.sequence} · ${link.excerpt}`;
