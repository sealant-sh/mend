import type { Session } from "../types.js";
import type { ChangeAddress } from "./content-reader.js";
import { handedOver, type LiveAgent } from "./delivery.js";
import type { SessionReview } from "./pending.js";
import type {
  ChangeFile,
  Checkpoint,
  PinnedSlice,
  ReadPass,
  ServerComment,
  SliceDiff,
  WorktreeChain,
} from "./review-wire.js";
import {
  checkpointName,
  diffTitle,
  filePath,
  headerFact,
  newerChoice,
  resolveSlice,
  sliceName,
  sliceSpan,
  statusLetter,
  type Slice,
} from "./slices.js";
import { commentsLine, threadPlace, threadsOf, type ThreadView } from "./threads.js";

/**
 * The Change section as rows, from one read of a session's change (story d, steps 1, 2 and 5).
 * Pure: `change-view.ts` maps the rows onto VS Code.
 */

/** Everything one read of a session's change found. */
export interface ChangeRead {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly changeId: string;
  readonly chain: WorktreeChain;
  readonly pinned: PinnedSlice;
  /** The pinned slice's canonical diff: its hunks are what comments anchor in. */
  readonly pinnedDiff: SliceDiff;
  readonly slice: Slice;
  /** The diff of `slice`: the pinned diff itself when the pinned slice is chosen. */
  readonly diff: SliceDiff;
  readonly comments: ReadonlyArray<ServerComment>;
  /** The head checkpoint of her last sent review: where since my last review starts. */
  readonly reviewedHead: Checkpoint | null;
  /** The worktree moved on past the pinned slice: the files changed since, null when uncounted. */
  readonly drift: { readonly files: number | null } | null;
  /** Why the section shows another slice than she chose: hers could not be read. */
  readonly notice: string | null;
  /** Mend's last read of the change; null when it never read it. */
  readonly pass: ReadPass | null;
  /** Who may send a review to the session, and to what agent (story d, step 6). */
  readonly facts: {
    readonly session: Session;
    readonly viewer: string | null;
    readonly ownerName: string;
    readonly agent: LiveAgent | null;
    /** The follow-up goes to a terminal agent, live or one a stopped session starts with it. */
    readonly startsTerminal: boolean;
  };
  readonly readAt: string;
}

/** A file of the slice, and the two documents its diff compares. */
export interface FileRow {
  readonly kind: "file";
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly letter: string;
  readonly file: ChangeFile;
  /** The file where the slice starts: empty, read from nowhere, when the slice added it. */
  readonly left: ChangeAddress;
  /** The file where the slice ends: empty, read from nowhere, when the slice deleted it. */
  readonly right: ChangeAddress;
  readonly title: string;
}

/** One comment under Comments: `Use the shared limiter… · limit.ts:12 · pending`. */
export interface CommentRow {
  readonly kind: "comment";
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly mend: boolean;
  readonly thread: ThreadView;
}

export interface CheckpointRow {
  readonly kind: "checkpoint";
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export type ChangeRow =
  | {
      readonly kind: "slice";
      readonly id: string;
      readonly label: string;
      readonly description: string;
      /** What it says above its files: the worktree moved on, and what to do about it. */
      readonly above: ReadonlyArray<ChangeRow>;
      readonly files: ReadonlyArray<FileRow>;
    }
  | { readonly kind: "note"; readonly id: string; readonly label: string; readonly icon: string }
  /** A row that does what it says: `Review the newer change`, `since my last review · 2 files`. */
  | {
      readonly kind: "action";
      readonly id: string;
      readonly label: string;
      readonly command: "mend.change.repin" | "mend.change.readNewer";
      /** Review the newer change opens on since my last review, after a review she sent. */
      readonly sinceLastReview: boolean;
    }
  | {
      readonly kind: "comments";
      readonly id: string;
      readonly description: string;
      readonly comments: ReadonlyArray<CommentRow>;
    }
  | {
      readonly kind: "checkpoints";
      readonly id: string;
      readonly description: string;
      readonly checkpoints: ReadonlyArray<CheckpointRow>;
    };

const TRIGGER_WORDS: Readonly<Record<string, string>> = {
  "session-start": "session started",
  "command-settle": "command settled",
  "turn-boundary": "turn ended",
  "review-open": "review opened",
  "user-mark": "marked",
};

const clock = (iso: string): string => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

export const fileRow = (file: ChangeFile, read: ChangeRead): FileRow => {
  const path = filePath(file);
  const at = (
    checkpoint: Checkpoint,
    where: string,
    absent: boolean,
    slice: string | null,
  ): ChangeAddress => ({
    worktreeId: read.chain.worktreeId,
    path: where,
    at: checkpoint.id,
    absent,
    slice,
  });
  const slash = path.lastIndexOf("/");
  return {
    kind: "file",
    id: `file:${read.slice.from.id}:${read.slice.to.id}:${path}`,
    name: path.slice(slash + 1),
    folder: slash === -1 ? "" : path.slice(0, slash),
    letter: statusLetter(file),
    file,
    left: at(read.slice.from, file.oldPath ?? path, file.status === "added", null),
    right: at(
      read.slice.to,
      file.newPath ?? path,
      file.status === "deleted",
      read.slice.commentable ? read.pinned.id : null,
    ),
    title: diffTitle(path, read.slice, read.chain.baseName),
  };
};

/** The section's rows for one read, at `now`. */
export const changeRows = (
  read: ChangeRead,
  review: SessionReview,
  you: string,
  now: Date,
): ReadonlyArray<ChangeRow> => {
  const base = read.chain.baseName;
  const above: Array<ChangeRow> = [];
  if (read.notice !== null)
    above.push({ kind: "note", id: "note:notice", label: read.notice, icon: "info" });
  if (read.drift !== null) {
    // The slice stays pinned while she reviews; the newer change is hers to choose.
    const files = read.drift.files;
    above.push({
      kind: "note",
      id: "note:drift",
      label: `worktree changed since this review${files === null ? "" : ` · ${files} new ${files === 1 ? "file" : "files"}`}`,
      icon: "warning",
    });
    const sent = review.sends.some(
      (record) => handedOver(record) && record.sliceId === read.pinned.id,
    );
    above.push({
      kind: "action",
      id: sent ? "action:since-last-review" : "action:newer",
      label: sent
        ? `since my last review${files === null ? "" : ` · ${files} ${files === 1 ? "file" : "files"}`}`
        : "Review the newer change",
      command: "mend.change.repin",
      sinceLastReview: sent,
    });
  }
  const newer = newerChoice(read.slice.choice, {
    pinned: read.pinned,
    chain: read.chain.checkpoints,
    reviewedHead: read.reviewedHead,
  });
  const newerSlice =
    newer === null ? null : resolveSlice(newer, read.pinned, read.chain.checkpoints);
  if (newerSlice !== null)
    above.push({
      kind: "action",
      id: "action:read-newer",
      label: `newer checkpoints · read ${sliceSpan(newerSlice, base)}`,
      command: "mend.change.readNewer",
      sinceLastReview: false,
    });
  const threads = threadsOf(read, review, you);
  const rows: Array<ChangeRow> = [];
  if (read.pass?.kind === "reading")
    rows.push({
      kind: "note",
      id: "note:reading",
      label: `Mend is reading · ${clock(read.pass.since)}`,
      icon: "loading~spin",
    });
  rows.push({
    kind: "slice",
    id: "slice",
    label: `${sliceName(read.slice, base)} ▾`,
    description: headerFact({
      files: read.diff.files,
      observation: read.diff.observation,
      listingCut: read.diff.listingCut,
      readAt: read.readAt,
      now,
    }),
    above,
    files: read.diff.files.map((file) => fileRow(file, read)),
  });
  if (!read.slice.commentable)
    rows.push({
      kind: "note",
      id: "note:view-only",
      label: `viewing · comments go on ${base} → now`,
      icon: "eye",
    });
  rows.push(
    {
      kind: "comments",
      id: "comments",
      description: commentsLine(threads),
      comments: threads.map(
        (thread): CommentRow => ({
          kind: "comment",
          id: thread.key,
          label: thread.body.split("\n")[0] ?? "",
          description: `${threadPlace(thread)} · ${thread.kind === "draft" ? "Mend · draft" : thread.label}`,
          mend: thread.kind === "draft",
          thread,
        }),
      ),
    },
    {
      kind: "checkpoints",
      id: "checkpoints",
      description: String(read.chain.checkpoints.length),
      checkpoints: read.chain.checkpoints.toReversed().map((checkpoint) => ({
        kind: "checkpoint",
        id: `checkpoint:${checkpoint.id}`,
        label: checkpointName(checkpoint, base),
        description: [
          checkpoint.ordinal === 0 ? "base" : (TRIGGER_WORDS[checkpoint.trigger ?? ""] ?? null),
          checkpoint.id === read.pinned.head.id ? "pinned for review" : null,
          clock(checkpoint.createdAt),
        ]
          .flatMap((part) => (part === null ? [] : [part]))
          .join(" · "),
      })),
    },
  );
  return rows;
};
