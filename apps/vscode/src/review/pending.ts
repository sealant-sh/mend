import type {
  CommentTarget,
  PastePlan,
  PasteStep,
  PostState,
  SendItem,
  SendPhase,
  SendRecord,
  TerminalInput,
} from "./delivery.js";
import type { CommentAnchor, RecordLink } from "./review-wire.js";

/**
 * Her pending comments (story d, step 4): held by the extension, like a pending review in GitHub
 * Pull Requests, until Send review. Comment draft state is a proposed VS Code API and Mend has no
 * pending state, so they are kept on this machine per person and session (`kept-reviews.ts`), and
 * survive a reload.
 */

/** As many pending comments as one session's review holds. */
export const MAX_PENDING = 200;

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
  /** Null for a comment on the change as a whole, as a Mend draft about the whole change is. */
  readonly path: string | null;
  /** Lines on the slice's new side, from 1; 1 for the whole change. */
  readonly line: number;
  readonly endLine: number;
  /** The first commented line as it read: what carries the comment to a newer slice. */
  readonly lineText: string;
  readonly body: string;
  readonly createdAt: string;
  readonly origin: PendingOrigin;
  /**
   * Where the Mend draft it came from hangs, kept through Accept and her reply under it: a draft on
   * a deleted line stays on the old side. Null for a comment she wrote on a line of the pinned slice.
   */
  readonly anchor: CommentAnchor | null;
}

/**
 * One session's review on this machine: her pending comments, and the reviews she sent. A comment
 * is pending or in exactly one send record, never both.
 */
export interface SessionReview {
  readonly pending: ReadonlyArray<PendingComment>;
  readonly sends: ReadonlyArray<SendRecord>;
}

export const EMPTY_REVIEW: SessionReview = { pending: [], sends: [] };

/** The reviews kept: the newest few, enough for since my last review and a retry. */
export const KEPT_SENDS = 5;

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
        return sequence === null || excerpt === null
          ? []
          : [{ runId: text(item, "runId"), sequence, excerpt }];
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

const parseAnchor = (value: unknown): CommentAnchor | null => {
  if (!isRecord(value)) return null;
  const sliceId = text(value, "sliceId");
  const baseId = text(value, "baseId");
  const headId = text(value, "headId");
  const side = value["side"];
  return sliceId === null || baseId === null || headId === null
    ? null
    : { sliceId, baseId, headId, side: side === "old" || side === "new" ? side : null };
};

const parsePending = (value: unknown): ReadonlyArray<PendingComment> => {
  if (!isRecord(value)) return [];
  const id = text(value, "id");
  const sliceId = text(value, "sliceId");
  const headId = text(value, "headId");
  const path = value["path"] === null ? null : text(value, "path");
  const line = whole(value, "line");
  const endLine = whole(value, "endLine");
  const lineText = text(value, "lineText");
  const body = text(value, "body");
  const createdAt = text(value, "createdAt");
  const origin = parseOrigin(value["origin"]);
  const anchor = parseAnchor(value["anchor"]);
  if (
    id === null ||
    sliceId === null ||
    headId === null ||
    (path === null && value["path"] !== null) ||
    line === null ||
    endLine === null ||
    lineText === null ||
    body === null ||
    createdAt === null ||
    origin === null
  )
    return [];
  return [{ id, sliceId, headId, path, line, endLine, lineText, body, createdAt, origin, anchor }];
};

const nullableText = (value: Record<string, unknown>, field: string): string | null | undefined => {
  const found = value[field];
  return found === null ? null : typeof found === "string" ? found : undefined;
};

const nullableWhole = (
  value: Record<string, unknown>,
  field: string,
): number | null | undefined => {
  const found = value[field];
  return found === null ? null : (whole(value, field) ?? undefined);
};

const parseTarget = (value: unknown): CommentTarget | null => {
  if (!isRecord(value)) return null;
  const oldPath = nullableText(value, "oldPath");
  const newPath = nullableText(value, "newPath");
  const side = value["side"];
  const startLine = nullableWhole(value, "startLine");
  const endLine = nullableWhole(value, "endLine");
  const hunkContextHash = nullableText(value, "hunkContextHash");
  if (
    oldPath === undefined ||
    newPath === undefined ||
    (side !== null && side !== "old" && side !== "new") ||
    startLine === undefined ||
    endLine === undefined ||
    hunkContextHash === undefined
  )
    return null;
  return { oldPath, newPath, side, startLine, endLine, hunkContextHash };
};

const parsePost = (value: unknown): PostState | null => {
  if (!isRecord(value)) return null;
  const commentId = text(value, "commentId");
  const body = text(value, "body");
  const target = parseTarget(value["target"]);
  const author = nullableText(value, "author");
  const listed = value["before"];
  const before = Array.isArray(listed)
    ? listed.flatMap((id) => (typeof id === "string" ? [id] : []))
    : null;
  if (value["kind"] === "unposted") return { kind: "unposted" };
  if (
    value["kind"] === "posting" &&
    body !== null &&
    target !== null &&
    author !== undefined &&
    before !== null &&
    Array.isArray(listed) &&
    before.length === listed.length
  )
    return { kind: "posting", body, target, author, before };
  if (value["kind"] === "posted" && commentId !== null) return { kind: "posted", commentId };
  return null;
};

const parseItem = (value: unknown): ReadonlyArray<SendItem> => {
  if (!isRecord(value)) return [];
  const [pending] = parsePending(value["pending"]);
  const post = parsePost(value["post"]);
  const draftId = text(value, "draftId");
  const commentId = text(value, "commentId");
  if (value["kind"] === "own" && pending !== undefined && post !== null)
    return [{ kind: "own", pending, post }];
  if (value["kind"] === "accepted" && pending !== undefined && draftId !== null)
    return [{ kind: "accepted", pending, draftId, opened: value["opened"] === true }];
  if (value["kind"] === "open" && commentId !== null) return [{ kind: "open", commentId }];
  return [];
};

const parsePhase = (value: unknown): SendPhase | null => {
  if (!isRecord(value)) return null;
  const words = text(value, "words");
  switch (value["kind"]) {
    case "sending":
      return { kind: "sending", since: text(value, "since") ?? "" };
    case "delivering":
      return { kind: "delivering" };
    case "in-terminal": {
      // A review pasted without the agent's process named goes nowhere: it waits for Retry.
      const processId = text(value, "processId");
      return processId === null
        ? { kind: "pending" }
        : {
            kind: "in-terminal",
            agent: text(value, "agent") ?? "the agent",
            processId,
            paste: parsePasteStep(value["paste"]),
          };
    }
    case "pending":
      return { kind: "pending" };
    case "delivered":
      return { kind: "delivered", at: text(value, "at") ?? "" };
    case "failed":
      return { kind: "failed", words: words ?? "Mend could not deliver the review." };
    case "refused":
      return { kind: "refused", words: words ?? "Mend refused the review." };
    default:
      return null;
  }
};

const parseInput = (value: unknown): TerminalInput | null => {
  if (!isRecord(value) || !Array.isArray(value["ids"])) return null;
  const input = text(value, "text");
  const ids = value["ids"].flatMap((id) => (typeof id === "string" ? [id] : []));
  return input === null || ids.length !== value["ids"].length ? null : { text: input, ids };
};

const parsePasteStep = (value: unknown): PasteStep => {
  if (isRecord(value) && value["kind"] === "failed") return { kind: "failed" };
  const input = isRecord(value) && value["kind"] === "done" ? parseInput(value["input"]) : null;
  return input === null ? { kind: "due" } : { kind: "done", input };
};

/** What a review pastes; null for a plan that does not read back, so it is never pasted whole. */
const parsePaste = (value: unknown): PastePlan | null => {
  if (!isRecord(value) || value["kind"] === "all") return { kind: "all" };
  const pasted = text(value, "text");
  const words = text(value, "words");
  const onto = parseInput(value["onto"]);
  const processId = text(value, "processId");
  if (onto === null || processId === null) return null;
  if (value["kind"] === "added" && pasted !== null)
    return { kind: "added", text: pasted, onto, processId };
  if (value["kind"] === "none" && words !== null) return { kind: "none", words, onto, processId };
  return null;
};

const parseSend = (value: unknown): ReadonlyArray<SendRecord> => {
  if (!isRecord(value) || !Array.isArray(value["items"])) return [];
  const key = text(value, "key");
  const sliceId = text(value, "sliceId");
  const baseId = text(value, "baseId");
  const headId = text(value, "headId");
  const diffDigest = text(value, "diffDigest");
  const instruction = text(value, "instruction");
  const createdAt = text(value, "createdAt");
  const phase = parsePhase(value["phase"]);
  const paste = parsePaste(value["paste"]);
  const items = value["items"].flatMap(parseItem);
  if (
    key === null ||
    sliceId === null ||
    baseId === null ||
    headId === null ||
    diffDigest === null ||
    instruction === null ||
    createdAt === null ||
    phase === null ||
    paste === null ||
    items.length !== value["items"].length
  )
    return [];
  return [
    {
      key,
      sliceId,
      baseId,
      headId,
      diffDigest,
      instruction,
      paste,
      items,
      phase,
      createdAt,
    },
  ];
};

/** A session's review as stored; a comment or a review that does not read back is dropped alone. */
export const parseSessionReview = (value: unknown): SessionReview =>
  isRecord(value)
    ? {
        pending: Array.isArray(value["pending"]) ? value["pending"].flatMap(parsePending) : [],
        sends: Array.isArray(value["sends"]) ? value["sends"].flatMap(parseSend) : [],
      }
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
  new Set([
    ...review.pending.flatMap((comment) =>
      comment.origin.kind === "accepted" ? [comment.origin.draftId] : [],
    ),
    // One on its way in a review she sent is hers too, until Mend opens it.
    ...review.sends.flatMap((record) =>
      record.phase.kind === "refused"
        ? []
        : record.items.flatMap((item) => (item.kind === "accepted" ? [item.draftId] : [])),
    ),
  ]);
