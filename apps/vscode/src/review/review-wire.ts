/**
 * What Mend's review routes answer, parsed at the boundary into the review's own types. Nothing
 * past this file sees the wire: a field the server renames fails here, once, in words.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`Mend returned an invalid ${what}.`);
  return value;
};

const text = (value: Record<string, unknown>, field: string, what: string): string => {
  const found = value[field];
  if (typeof found !== "string") throw new Error(`Mend returned an invalid ${what}.`);
  return found;
};

const textOrNull = (value: Record<string, unknown>, field: string): string | null => {
  const found = value[field];
  return typeof found === "string" ? found : null;
};

const count = (value: Record<string, unknown>, field: string, what: string): number => {
  const found = value[field];
  if (typeof found !== "number" || !Number.isInteger(found))
    throw new Error(`Mend returned an invalid ${what}.`);
  return found;
};

const list = <T>(value: unknown, parse: (item: unknown) => T, what: string): ReadonlyArray<T> => {
  if (!Array.isArray(value)) throw new Error(`Mend returned invalid ${what}.`);
  return value.map(parse);
};

const CHECKPOINT_TRIGGERS = [
  "session-start",
  "command-settle",
  "turn-boundary",
  "review-open",
  "user-mark",
] as const;

export type CheckpointTrigger = (typeof CHECKPOINT_TRIGGERS)[number];

/** One point in a worktree's chain. Ordinal 0 is where the worktree started: its base. */
export interface Checkpoint {
  readonly id: string;
  readonly ordinal: number;
  readonly trigger: CheckpointTrigger | null;
  readonly createdAt: string;
}

export const parseCheckpoint = (value: unknown): Checkpoint => {
  const raw = record(value, "checkpoint");
  return {
    id: text(raw, "id", "checkpoint"),
    ordinal: count(raw, "ordinal", "checkpoint"),
    trigger: CHECKPOINT_TRIGGERS.find((trigger) => trigger === raw["trigger"]) ?? null,
    createdAt: text(raw, "createdAt", "checkpoint"),
  };
};

const FILE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "unmerged",
  "unknown",
] as const;

export type FileStatus = (typeof FILE_STATUSES)[number];

/** A hunk of the pinned slice's canonical diff: what a line comment anchors inside. */
export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly contextHash: string;
}

/** One file of a slice. `hunks` is empty for a slice that is only viewed (G10). */
export interface ChangeFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly hunks: ReadonlyArray<Hunk>;
}

const parseHunk = (value: unknown): Hunk => {
  const raw = record(value, "hunk");
  return {
    oldStart: count(raw, "oldStart", "hunk"),
    oldLines: count(raw, "oldLines", "hunk"),
    newStart: count(raw, "newStart", "hunk"),
    newLines: count(raw, "newLines", "hunk"),
    contextHash: text(raw, "contextHash", "hunk"),
  };
};

const parseFile = (value: unknown): ChangeFile => {
  const raw = record(value, "file");
  return {
    oldPath: textOrNull(raw, "oldPath"),
    newPath: textOrNull(raw, "newPath"),
    status: FILE_STATUSES.find((status) => status === raw["status"]) ?? "unknown",
    additions: count(raw, "additions", "file"),
    deletions: count(raw, "deletions", "file"),
    binary: raw["binary"] === true,
    hunks: Array.isArray(raw["hunks"]) ? list(raw["hunks"], parseHunk, "hunks") : [],
  };
};

/** How Mend knows the diff it answered: seen in the worktree, or only claimed. */
export interface Observation {
  readonly state: "observed" | "claimed";
  readonly observedAt: string | null;
}

const parseObservation = (value: unknown): Observation | null => {
  if (!isRecord(value)) return null;
  const state = value["state"] === "observed" ? "observed" : "claimed";
  return { state, observedAt: textOrNull(value, "observedAt") };
};

/** The slice `reviews/open` pinned: base (ordinal 0) to a checkpoint taken for this review. */
export interface PinnedSlice {
  readonly id: string;
  readonly changeId: string;
  readonly diffDigest: string;
  readonly base: Checkpoint;
  readonly head: Checkpoint;
  readonly createdAt: string;
}

export const parseOpenedReview = (value: unknown): PinnedSlice => {
  const raw = record(value, "review");
  const slice = record(raw["slice"], "review slice");
  return {
    id: text(slice, "id", "review slice"),
    changeId: text(slice, "changeId", "review slice"),
    diffDigest: text(slice, "diffDigest", "review slice"),
    base: parseCheckpoint(raw["checkpointA"]),
    head: parseCheckpoint(raw["checkpointB"]),
    createdAt: text(slice, "createdAt", "review slice"),
  };
};

/** `GET /changes/:id/reviews/:sliceId/diff`: the pinned slice's canonical files, with hunks. */
export interface SliceDiff {
  readonly files: ReadonlyArray<ChangeFile>;
  readonly worktreeChangedSinceSnapshot: boolean;
  readonly observation: Observation | null;
  /** Mend listed only the first files, within its time and size budget: `files` is not all. */
  readonly listingCut: boolean;
}

export const parseSliceDiff = (value: unknown): SliceDiff => {
  const raw = record(value, "review diff");
  return {
    files: list(raw["anchorFiles"] ?? raw["files"], parseFile, "review files"),
    worktreeChangedSinceSnapshot: raw["worktreeChangedSinceSnapshot"] === true,
    observation: parseObservation(raw["observation"]),
    listingCut: false,
  };
};

/** `GET /worktrees/:id/diff`: any range of the chain, files only (it carries no hunks). */
export const parseRangeDiff = (value: unknown): SliceDiff => {
  const raw = record(value, "worktree diff");
  return {
    files: list(raw["files"], parseFile, "worktree files"),
    worktreeChangedSinceSnapshot: false,
    observation: parseObservation(raw["observation"]),
    listingCut: raw["listingCut"] === true,
  };
};

/** `GET /worktrees/:id`: where the worktree started, and its checkpoints in ordinal order. */
export interface WorktreeChain {
  readonly worktreeId: string;
  /** The ref the worktree started from (`main`), else its short base sha. */
  readonly baseName: string;
  readonly checkpoints: ReadonlyArray<Checkpoint>;
}

export const baseName = (baseRef: string | null, baseSha: string): string =>
  baseRef === null || baseRef === ""
    ? baseSha.slice(0, 7)
    : baseRef
        .replace(/^refs\/heads\//, "")
        .replace(/^refs\/remotes\//, "")
        .replace(/^origin\//, "");

export const parseWorktreeChain = (value: unknown): WorktreeChain => {
  const raw = record(value, "worktree");
  const worktree = record(raw["worktree"], "worktree");
  return {
    worktreeId: text(worktree, "id", "worktree"),
    baseName: baseName(textOrNull(worktree, "baseRef"), text(worktree, "baseSha", "worktree")),
    checkpoints: list(raw["checkpoints"], parseCheckpoint, "checkpoints").toSorted(
      (left, right) => left.ordinal - right.ordinal,
    ),
  };
};

/** A file's contents at a checkpoint, as the diff editor shows it. */
export type FileContents =
  | {
      readonly kind: "text";
      readonly text: string;
      /** Mend read only the file's first 1 MiB; `size` is the whole file's. */
      readonly truncated: boolean;
      readonly size: number;
    }
  | { readonly kind: "binary"; readonly size: number };

export const parseContents = (value: unknown): FileContents => {
  const file = record(record(value, "worktree contents")["file"], "worktree file");
  const contents = file["contents"];
  const size = typeof file["size"] === "number" ? file["size"] : 0;
  if (file["binary"] === true || typeof contents !== "string") return { kind: "binary", size };
  return { kind: "text", text: contents, truncated: file["truncated"] === true, size };
};

const COMMENT_STATES = ["draft", "open", "addressed", "dismissed"] as const;

export type CommentState = (typeof COMMENT_STATES)[number];

/** One record entry a comment carries as its evidence: `seq 214 · pnpm test auth · never ran`. */
export interface RecordLink {
  readonly sequence: string;
  readonly excerpt: string;
}

/** Where a comment was anchored, in the slice it was written on. */
export interface CommentAnchor {
  readonly sliceId: string;
  readonly baseId: string;
  readonly headId: string;
  readonly side: "old" | "new" | null;
}

/** A comment Mend holds on a change: one sent or accepted, or a draft Mend wrote. */
export interface ServerComment {
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly endLine: number | null;
  readonly anchor: CommentAnchor | null;
  readonly author: { readonly kind: "reviewer" | "mend"; readonly name: string };
  readonly body: string;
  readonly suggestion: string | null;
  readonly state: CommentState;
  readonly evidence: ReadonlyArray<RecordLink>;
  readonly sentToSessionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const lineOrNull = (value: Record<string, unknown>, field: string): number | null => {
  const found = value[field];
  return typeof found === "number" && Number.isInteger(found) ? found : null;
};

const parseAnchor = (value: unknown): CommentAnchor | null => {
  if (!isRecord(value)) return null;
  const side = value["side"];
  return {
    sliceId: text(value, "reviewSliceId", "comment anchor"),
    baseId: text(value, "checkpointAId", "comment anchor"),
    headId: text(value, "checkpointBId", "comment anchor"),
    side: side === "old" || side === "new" ? side : null,
  };
};

const parseRecordLink = (value: unknown): RecordLink => {
  const raw = record(value, "evidence");
  const sequence = raw["sequence"];
  return {
    sequence: typeof sequence === "string" || typeof sequence === "number" ? String(sequence) : "",
    excerpt: text(raw, "excerpt", "evidence"),
  };
};

export const parseComment = (value: unknown): ServerComment => {
  const raw = record(value, "comment");
  const state = COMMENT_STATES.find((candidate) => candidate === raw["state"]);
  if (state === undefined) throw new Error("Mend returned an invalid comment state.");
  return {
    id: text(raw, "id", "comment"),
    file: textOrNull(raw, "file"),
    line: lineOrNull(raw, "line"),
    endLine: lineOrNull(raw, "endLine"),
    anchor: parseAnchor(raw["anchor"]),
    author: {
      kind: raw["authorKind"] === "mend" ? "mend" : "reviewer",
      name: textOrNull(raw, "authorName") ?? "",
    },
    body: text(raw, "body", "comment"),
    suggestion: textOrNull(raw, "suggestion"),
    state,
    evidence: Array.isArray(raw["evidence"])
      ? list(raw["evidence"], parseRecordLink, "evidence")
      : [],
    sentToSessionId: textOrNull(raw, "sentToSessionId"),
    createdAt: text(raw, "createdAt", "comment"),
    updatedAt: textOrNull(raw, "updatedAt") ?? text(raw, "createdAt", "comment"),
  };
};

export const parseComments = (value: unknown): ReadonlyArray<ServerComment> =>
  list(value, parseComment, "comments");

/** Mend's last read of the change (`POST /changes/:id/read`), as `GET …/passes` reports it. */
export type ReadPass =
  | { readonly kind: "reading"; readonly since: string }
  | { readonly kind: "read"; readonly at: string; readonly findings: number | null }
  | { readonly kind: "failed"; readonly at: string; readonly words: string };

/** The `read` pass among a change's passes; null when Mend never read it. */
export const parseReadPass = (value: unknown): ReadPass | null => {
  const pass = list(value, (item) => record(item, "pass"), "passes").find(
    (item) => item["kind"] === "read",
  );
  if (pass === undefined) return null;
  const startedAt = text(pass, "startedAt", "pass");
  const at = textOrNull(pass, "finishedAt") ?? startedAt;
  switch (pass["status"]) {
    case "queued":
    case "running":
      return { kind: "reading", since: startedAt };
    case "failed":
      return {
        kind: "failed",
        at,
        words: textOrNull(pass, "detail") ?? "Mend could not read this change.",
      };
    default:
      return { kind: "read", at, findings: lineOrNull(pass, "findings") };
  }
};

/** One entry of a session's transcript, as the harness recorded it. */
export interface TranscriptEntry {
  readonly kind: string;
  readonly text: string | null;
  readonly name: string | null;
  readonly command: string | null;
  readonly output: string | null;
}

export const parseTranscript = (value: unknown): ReadonlyArray<TranscriptEntry> => {
  const raw = record(value, "transcript");
  return list(
    raw["events"],
    (item) => {
      const entry = record(item, "transcript entry");
      return {
        kind: textOrNull(entry, "kind") ?? "event",
        text: textOrNull(entry, "text"),
        name: textOrNull(entry, "name"),
        command: textOrNull(entry, "command"),
        output: textOrNull(entry, "output"),
      };
    },
    "transcript",
  );
};
