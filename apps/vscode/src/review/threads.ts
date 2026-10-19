import type { ChangeAddress } from "./change-content.js";
import type { ChangeRead } from "./change-rows.js";
import { acceptedDrafts, type PendingComment, type SessionReview } from "./pending.js";
import type { RecordLink, ServerComment } from "./review-wire.js";

/**
 * Every comment of a change as a thread in the editor (story d, steps 3, 4 and 7), decided without
 * VS Code: where it hangs, who wrote it, and the one word of its state. A thread hangs on the
 * document of the checkpoint it was written at, so it shows on whichever side of a diff holds
 * that checkpoint; her pending comments and Mend's drafts sit on the pinned slice's new side.
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
  | "sent"
  | "addressed";

export interface ThreadView {
  readonly key: string;
  readonly kind: ThreadKind;
  readonly at: ChangeAddress;
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
}

/** A comment of the change no document can hold: a Mend draft about the change as a whole. */
export interface LooseComment {
  readonly key: string;
  readonly kind: ThreadKind;
  readonly label: string;
  readonly body: string;
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
    comment.sliceId === read.pinned.id
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
  sent: "sent",
  addressed: "addressed",
};

/** Where a comment on Mend hangs: at its anchor's checkpoint, else on the pinned new side. */
const serverAt = (read: ChangeRead, comment: ServerComment, file: string): ChangeAddress => {
  const anchor = comment.anchor;
  if (anchor === null || anchor.headId === read.pinned.head.id) return pinnedAt(read, file);
  return {
    worktreeId: read.chain.worktreeId,
    absent: false,
    path: file,
    at: anchor.side === "old" ? anchor.baseId : anchor.headId,
    slice: null,
  };
};

export const threadsOf = (
  read: ChangeRead,
  review: SessionReview,
  you: string,
): { readonly threads: ReadonlyArray<ThreadView>; readonly loose: ReadonlyArray<LooseComment> } => {
  const accepted = acceptedDrafts(review);
  const threads: Array<ThreadView> = review.pending.map((comment) =>
    pendingThread(read, comment, you),
  );
  const loose: Array<LooseComment> = [];
  for (const comment of read.comments) {
    const kind = serverKind(comment);
    if (kind === null || (kind === "draft" && accepted.has(comment.id))) continue;
    const author =
      comment.author.kind === "mend"
        ? kind === "draft"
          ? "Mend · draft"
          : "Mend"
        : comment.author.name === ""
          ? "a reviewer"
          : comment.author.name;
    if (comment.file === null) {
      loose.push({ key: `comment:${comment.id}`, kind, label: LABELS[kind], body: comment.body });
      continue;
    }
    const line = comment.line ?? 1;
    threads.push({
      key: `comment:${comment.id}`,
      kind,
      at: serverAt(read, comment, comment.file),
      line,
      endLine: Math.max(line, comment.endLine ?? line),
      author,
      label: LABELS[kind],
      body: comment.body,
      evidence: comment.evidence,
      createdAt: comment.createdAt,
      pendingId: null,
      commentId: comment.id,
    });
  }
  return { threads, loose };
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

/** `2 pending · 1 Mend draft`: the change's comments by the word each reads. */
export const commentsLine = (
  threads: ReadonlyArray<Pick<ThreadView, "kind">>,
  loose: ReadonlyArray<Pick<LooseComment, "kind">>,
): string => {
  const all = [...threads, ...loose];
  const count = (kinds: ReadonlyArray<ThreadKind>): number =>
    all.filter((thread) => kinds.includes(thread.kind)).length;
  const pending = count(["pending", "accepted"]);
  const open = count(["open"]);
  const sent = count(["sent"]);
  const addressed = count(["addressed"]);
  const drafts = count(["draft"]);
  const parts = [
    pending > 0 ? `${pending} pending` : null,
    open > 0 ? `${open} open` : null,
    sent > 0 ? `${sent} sent` : null,
    addressed > 0 ? `${addressed} addressed` : null,
    drafts > 0 ? `${drafts} Mend ${drafts === 1 ? "draft" : "drafts"}` : null,
  ].flatMap((part) => (part === null ? [] : [part]));
  return parts.length === 0 ? "none" : parts.join(" · ");
};

/** `seq 214 · pnpm test auth · never ran`: a record entry as a thread shows it. */
export const evidenceLine = (link: RecordLink): string =>
  link.sequence === "" ? link.excerpt : `seq ${link.sequence} · ${link.excerpt}`;
