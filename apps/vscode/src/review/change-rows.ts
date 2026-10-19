import type { ChangeAddress } from "./change-content.js";
import type {
  ChangeFile,
  Checkpoint,
  PinnedSlice,
  ServerComment,
  SliceDiff,
  WorktreeChain,
} from "./review-wire.js";
import {
  checkpointName,
  diffTitle,
  filePath,
  headerFact,
  sliceName,
  statusLetter,
  type Slice,
} from "./slices.js";

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
  /** The file where the slice starts: Mend answers no file, and the editor shows it empty, once added. */
  readonly left: ChangeAddress;
  /** The file where the slice ends: empty once the slice deleted it. */
  readonly right: ChangeAddress;
  readonly title: string;
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
      readonly files: ReadonlyArray<FileRow>;
    }
  | { readonly kind: "note"; readonly id: string; readonly label: string; readonly icon: string }
  | {
      readonly kind: "comments";
      readonly id: string;
      readonly description: string;
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
  const at = (checkpoint: Checkpoint, where: string): ChangeAddress => ({
    worktreeId: read.chain.worktreeId,
    path: where,
    at: checkpoint.id,
  });
  const slash = path.lastIndexOf("/");
  return {
    kind: "file",
    id: `file:${read.slice.from.id}:${read.slice.to.id}:${path}`,
    name: path.slice(slash + 1),
    folder: slash === -1 ? "" : path.slice(0, slash),
    letter: statusLetter(file),
    file,
    left: at(read.slice.from, file.oldPath ?? path),
    right: at(read.slice.to, file.newPath ?? path),
    title: diffTitle(path, read.slice, read.chain.baseName),
  };
};

/** `1 Mend draft`, `2 sent · 1 addressed`: what the comments hold, by state, as observed. */
export const commentsLine = (comments: ReadonlyArray<ServerComment>): string => {
  const drafts = comments.filter((comment) => comment.state === "draft").length;
  const sent = comments.filter(
    (comment) => comment.state === "open" && comment.sentToSessionId !== null,
  ).length;
  const open = comments.filter(
    (comment) => comment.state === "open" && comment.sentToSessionId === null,
  ).length;
  const addressed = comments.filter((comment) => comment.state === "addressed").length;
  const parts = [
    open > 0 ? `${open} open` : null,
    sent > 0 ? `${sent} sent` : null,
    addressed > 0 ? `${addressed} addressed` : null,
    drafts > 0 ? `${drafts} Mend ${drafts === 1 ? "draft" : "drafts"}` : null,
  ].flatMap((part) => (part === null ? [] : [part]));
  return parts.length === 0 ? "none" : parts.join(" · ");
};

/** The section's rows for one read, at `now`. */
export const changeRows = (read: ChangeRead, now: Date): ReadonlyArray<ChangeRow> => {
  const base = read.chain.baseName;
  const rows: Array<ChangeRow> = [
    {
      kind: "slice",
      id: "slice",
      label: `${sliceName(read.slice, base)} ▾`,
      description: headerFact({
        files: read.diff.files,
        observation: read.diff.observation,
        readAt: read.readAt,
        now,
      }),
      files: read.diff.files.map((file) => fileRow(file, read)),
    },
  ];
  if (!read.slice.commentable)
    rows.push({
      kind: "note",
      id: "note:view-only",
      label: `viewing · comments go on ${base} → now`,
      icon: "eye",
    });
  rows.push(
    { kind: "comments", id: "comments", description: commentsLine(read.comments) },
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
