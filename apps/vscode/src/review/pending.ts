import type { RecordLink } from "./review-wire.js";

/**
 * Her pending comments (story d, step 4): held by the extension, like a pending review in GitHub
 * Pull Requests, until Send review. Comment draft state is a proposed VS Code API and Mend has no
 * pending state, so they live in `globalState` per server and session, and survive a reload.
 */

/** Where a pending comment came from: her own words, or a Mend draft she accepted. */
export type PendingOrigin =
  | { readonly kind: "own" }
  | {
      readonly kind: "accepted";
      /** The draft on Mend: it stays a draft there until Send review opens it. */
      readonly draftId: string;
      readonly evidence: ReadonlyArray<RecordLink>;
    };

export interface PendingComment {
  readonly id: string;
  /** The pinned slice she wrote it on, and its head: its hunks anchor it when it is sent. */
  readonly sliceId: string;
  readonly headId: string;
  readonly path: string;
  /** Lines on the slice's new side, from 1. */
  readonly line: number;
  readonly endLine: number;
  /** The first commented line as it read: what carries the comment to a newer slice. */
  readonly lineText: string;
  readonly body: string;
  readonly createdAt: string;
  readonly origin: PendingOrigin;
}

/** One session's review on this machine. */
export interface SessionReview {
  readonly pending: ReadonlyArray<PendingComment>;
}

export const EMPTY_REVIEW: SessionReview = { pending: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: Record<string, unknown>, field: string): string | null => {
  const found = value[field];
  return typeof found === "string" ? found : null;
};

const whole = (value: Record<string, unknown>, field: string): number | null => {
  const found = value[field];
  return typeof found === "number" && Number.isInteger(found) && found > 0 ? found : null;
};

const parseEvidence = (value: unknown): ReadonlyArray<RecordLink> =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (!isRecord(item)) return [];
        const sequence = text(item, "sequence");
        const excerpt = text(item, "excerpt");
        return sequence === null || excerpt === null ? [] : [{ sequence, excerpt }];
      })
    : [];

const parseOrigin = (value: unknown): PendingOrigin | null => {
  if (!isRecord(value)) return null;
  if (value["kind"] === "own") return { kind: "own" };
  const draftId = text(value, "draftId");
  return value["kind"] === "accepted" && draftId !== null
    ? { kind: "accepted", draftId, evidence: parseEvidence(value["evidence"]) }
    : null;
};

const parsePending = (value: unknown): ReadonlyArray<PendingComment> => {
  if (!isRecord(value)) return [];
  const id = text(value, "id");
  const sliceId = text(value, "sliceId");
  const headId = text(value, "headId");
  const path = text(value, "path");
  const line = whole(value, "line");
  const endLine = whole(value, "endLine");
  const lineText = text(value, "lineText");
  const body = text(value, "body");
  const createdAt = text(value, "createdAt");
  const origin = parseOrigin(value["origin"]);
  if (
    id === null ||
    sliceId === null ||
    headId === null ||
    path === null ||
    line === null ||
    endLine === null ||
    lineText === null ||
    body === null ||
    createdAt === null ||
    origin === null
  )
    return [];
  return [{ id, sliceId, headId, path, line, endLine, lineText, body, createdAt, origin }];
};

/** A session's review as stored; a comment that does not read back is dropped alone. */
export const parseSessionReview = (value: unknown): SessionReview =>
  isRecord(value) && Array.isArray(value["pending"])
    ? { pending: value["pending"].flatMap(parsePending) }
    : EMPTY_REVIEW;

export const addPending = (review: SessionReview, comment: PendingComment): SessionReview => ({
  ...review,
  pending: [...review.pending, comment],
});

/** G1: a pending comment is edited freely until it is sent. */
export const editPending = (review: SessionReview, id: string, body: string): SessionReview => ({
  ...review,
  pending: review.pending.map((comment) => (comment.id === id ? { ...comment, body } : comment)),
});

export const removePending = (review: SessionReview, id: string): SessionReview => ({
  ...review,
  pending: review.pending.filter((comment) => comment.id !== id),
});

/** The drafts she accepted, by their id on Mend: their threads show as hers, not as drafts. */
export const acceptedDrafts = (review: SessionReview): ReadonlySet<string> =>
  new Set(
    review.pending.flatMap((comment) =>
      comment.origin.kind === "accepted" ? [comment.origin.draftId] : [],
    ),
  );
