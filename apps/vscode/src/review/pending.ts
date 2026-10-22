import type { ReviewCommentTarget } from "@mend/domain/workbench";

import type {
  DraftDismissal,
  PasteStep,
  PostState,
  SendItem,
  SendPhase,
  SendNotice,
  SendRecord,
  SendSlice,
  StopReason,
} from "./delivery.js";
import { withEarlierText } from "./instruction.js";
import type { HeldInput, PastePlan, TerminalInput } from "./paste-plan.js";
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
export type PendingOrigin = { readonly kind: "own" } | AcceptedOrigin;

export interface AcceptedOrigin {
  readonly kind: "accepted";
  /** The draft on Mend: it stays a draft there until Send review opens it. */
  readonly draftId: string;
  readonly evidence: ReadonlyArray<RecordLink>;
  /** The draft's words as Mend wrote them: see `rewritten`. */
  readonly draftBody: string;
}

export interface PendingComment {
  readonly id: string;
  /**
   * The slice she wrote it on, and its head: its hunks anchor it when it is sent. The pinned slice,
   * or for words on a Mend draft, the slice the draft was written on.
   */
  readonly sliceId: string;
  readonly headId: string;
  /** Null for a comment on the change as a whole, as a Mend draft about the whole change is. */
  readonly path: string | null;
  /** Lines from 1; null for a comment about its whole file, or the change as a whole. */
  readonly line: number | null;
  readonly endLine: number | null;
  /** The first commented line as it read: what carries the comment to a newer slice. */
  readonly lineText: string;
  readonly body: string;
  readonly createdAt: string;
  readonly origin: PendingOrigin;
  /**
   * Where the Mend draft it came from hangs, kept through Accept and her reply under it: a draft on
   * a deleted line stays on the old side. Null for a comment she wrote on a line of the pinned
   * slice.
   */
  readonly anchor: CommentAnchor | null;
}

export type AcceptedComment = PendingComment & { readonly origin: AcceptedOrigin };

/**
 * An accepted draft whose words she changed: Send review posts hers on the draft's place, and
 * dismisses the draft. Words she edits back to the draft's are the draft's again.
 */
export const rewritten = (comment: PendingComment): comment is AcceptedComment =>
  comment.origin.kind === "accepted" && comment.body.trim() !== comment.origin.draftBody.trim();

export interface Composed {
  readonly documentId: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly slice: SendSlice;
  readonly pending: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
  readonly digest: string;
  readonly generation: string;
  readonly base: HeldInput | null;
}

export interface ReviewDocument {
  readonly composed: Composed;
  readonly text: string;
  readonly revision: number;
  readonly earlier: string | null;
}

export interface SessionReview {
  readonly pending: ReadonlyArray<PendingComment>;
  readonly sends: ReadonlyArray<SendRecord>;
  /** The review Send review opened for the session, until it is sent: one per session. */
  readonly document: ReviewDocument | null;
}

export const EMPTY_REVIEW: SessionReview = { pending: [], sends: [], document: null };

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

/** An accepted draft kept with no words of its own reads as accepted with `body`, unchanged. */
const parseOrigin = (value: unknown, body: string): PendingOrigin | null => {
  if (!isRecord(value)) return null;
  if (value["kind"] === "own") return { kind: "own" };
  const draftId = text(value, "draftId");
  return value["kind"] === "accepted" && draftId !== null
    ? {
        kind: "accepted",
        draftId,
        evidence: parseEvidence(value["evidence"]),
        draftBody: text(value, "draftBody") ?? body,
      }
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
  const line = nullableWhole(value, "line");
  const endLine = nullableWhole(value, "endLine");
  const lineText = text(value, "lineText");
  const body = text(value, "body");
  const createdAt = text(value, "createdAt");
  const origin = body === null ? null : parseOrigin(value["origin"], body);
  const anchor = parseAnchor(value["anchor"]);
  if (
    id === null ||
    sliceId === null ||
    headId === null ||
    (path === null && value["path"] !== null) ||
    line === undefined ||
    endLine === undefined ||
    (line === null) !== (endLine === null) ||
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

const parseTarget = (value: unknown): ReviewCommentTarget | null => {
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
  if (value["kind"] === "rewrite" && pending !== undefined && post !== null) {
    const { origin } = pending;
    const dismissal = parseDismissal(value["dismissal"]);
    return origin.kind === "accepted" && dismissal !== null
      ? [{ kind: "rewrite", pending: { ...pending, origin }, post, dismissal }]
      : [];
  }
  if (value["kind"] === "accepted" && pending !== undefined && draftId !== null)
    return [{ kind: "accepted", pending, draftId, opened: value["opened"] === true }];
  if (value["kind"] === "open" && commentId !== null) return [{ kind: "open", commentId }];
  return [];
};

const parseDismissal = (value: unknown): DraftDismissal | null => {
  if (!isRecord(value)) return null;
  if (value["kind"] === "due") return { kind: "due" };
  if (value["kind"] === "dismissed") return { kind: "dismissed" };
  const words = text(value, "words");
  return value["kind"] === "left" && words !== null ? { kind: "left", words } : null;
};

const parsePhase = (value: unknown, failedAtFallback: string): SendPhase | null => {
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
      const paste = parsePasteStep(value["paste"]);
      if (processId === null) return { kind: "pending" };
      return paste === null
        ? null
        : { kind: "in-terminal", agent: text(value, "agent") ?? "the agent", processId, paste };
    }
    case "pending":
      return { kind: "pending" };
    case "delivered":
      return { kind: "delivered", at: text(value, "at") ?? "" };
    case "failed":
      return {
        kind: "failed",
        words: words ?? "Mend could not deliver the review.",
        at: text(value, "at") ?? failedAtFallback,
      };
    case "refused":
      return { kind: "refused", words: words ?? "Mend refused the review." };
    default:
      return null;
  }
};

const parseInput = (value: unknown): TerminalInput | null => {
  if (!isRecord(value)) return null;
  const input = text(value, "text");
  const ids = parseIds(value["ids"]);
  return input === null || ids === null ? null : { text: input, ids };
};

const parseStop = (value: unknown): StopReason | null => {
  if (!isRecord(value)) return null;
  switch (value["kind"]) {
    case "closed":
      return { kind: "closed" };
    case "switched":
      return { kind: "switched" };
    case "signed-out":
      return { kind: "signed-out" };
    case "error": {
      const words = text(value, "words");
      return words === null ? null : { kind: "error", words };
    }
    default:
      return null;
  }
};

/** Null for a step this build does not know: read as due, it would paste the review again. */
const parsePasteStep = (value: unknown): PasteStep | null => {
  if (!isRecord(value)) return null;
  switch (value["kind"]) {
    case "due":
      return { kind: "due" };
    case "pasting":
      return { kind: "pasting" };
    case "failed": {
      const said = value["stopped"] ?? null;
      const stopped = said === null ? null : parseStop(said);
      return stopped === null && said !== null
        ? null
        : { kind: "failed", mayHaveLanded: value["mayHaveLanded"] === true, stopped };
    }
    case "done": {
      const input = parseInput(value["input"]);
      return input === null ? null : { kind: "done", input };
    }
    default:
      return null;
  }
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

const NOTICE_KINDS: ReadonlyArray<SendNotice["kind"]> = [
  "paste",
  "draft-gone",
  "draft-left",
  "refused",
];

const parseNotice = (value: unknown): ReadonlyArray<SendNotice> => {
  if (!isRecord(value)) return [];
  const kind = NOTICE_KINDS.find((one) => one === value["kind"]);
  const at = text(value, "at");
  const words = text(value, "words");
  if (kind === undefined || at === null || words === null) return [];
  return [
    {
      kind,
      at,
      words,
      tone: value["tone"] === "warning" ? "warning" : "error",
      retry: value["retry"] === true,
      text: value["text"] === true,
    },
  ];
};

/** A send kept before notices were kept says nothing more; one it cannot read is not read. */
const parseNotices = (value: unknown): ReadonlyArray<SendNotice> | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const notices = value.flatMap(parseNotice);
  return notices.length === value.length ? notices : null;
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
  const phase = createdAt === null ? null : parsePhase(value["phase"], createdAt);
  const paste = parsePaste(value["paste"]);
  const items = value["items"].flatMap(parseItem);
  const notices = parseNotices(value["notices"]);
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
    items.length !== value["items"].length ||
    notices === null
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
      notices,
      createdAt,
    },
  ];
};

const parseIds = (value: unknown): ReadonlyArray<string> | null => {
  if (!Array.isArray(value)) return null;
  const ids = value.flatMap((id) => (typeof id === "string" ? [id] : []));
  return ids.length === value.length ? ids : null;
};

const parseHeld = (value: unknown): HeldInput | null => {
  if (!isRecord(value)) return null;
  const input = parseInput(value["input"]);
  const agent = text(value, "agent");
  const processId = text(value, "processId");
  return input === null || agent === null || processId === null
    ? null
    : { input, agent, processId };
};

const parseDocument = (value: unknown): ReviewDocument | null => {
  if (!isRecord(value)) return null;
  const composed = value["composed"];
  const saved = text(value, "text");
  const revision = whole(value, "revision");
  if (!isRecord(composed) || !isRecord(composed["slice"]) || saved === null || revision === null)
    return null;
  const slice = composed["slice"];
  const documentId = text(composed, "documentId");
  const sessionId = text(composed, "sessionId");
  const sessionName = text(composed, "sessionName");
  const sliceId = text(slice, "id");
  const baseId = text(slice, "baseId");
  const headId = text(slice, "headId");
  const diffDigest = text(slice, "diffDigest");
  const pending = parseIds(composed["pending"]);
  const open = parseIds(composed["open"]);
  const digest = text(composed, "digest");
  const generation = text(composed, "generation");
  const base = composed["base"] === null ? null : parseHeld(composed["base"]);
  if (
    documentId === null ||
    sessionId === null ||
    sessionName === null ||
    sliceId === null ||
    baseId === null ||
    headId === null ||
    diffDigest === null ||
    pending === null ||
    open === null ||
    digest === null ||
    generation === null ||
    (base === null && composed["base"] !== null)
  )
    return null;
  return {
    composed: {
      documentId,
      sessionId,
      sessionName,
      slice: { id: sliceId, baseId, headId, diffDigest },
      pending,
      open,
      digest,
      generation,
      base,
    },
    text: saved,
    revision,
    earlier: text(value, "earlier"),
  };
};

/**
 * What a kept review holds that this build cannot read, as it was: a newer build wrote it, and
 * writes it back as it is (`kept-reviews.ts`). Null for no document.
 */
export interface Unread {
  readonly pending: ReadonlyArray<unknown>;
  readonly sends: ReadonlyArray<unknown>;
  readonly document: unknown;
}

export const NOTHING_UNREAD: Unread = { pending: [], sends: [], document: null };

/** Each entry of `values` this build reads, and the ones it cannot. */
const partition = <T>(
  values: unknown,
  parse: (value: unknown) => ReadonlyArray<T>,
): { readonly read: ReadonlyArray<T>; readonly unread: ReadonlyArray<unknown> } => {
  const read: Array<T> = [];
  const unread: Array<unknown> = [];
  for (const value of Array.isArray(values) ? values : []) {
    const [parsed] = parse(value);
    if (parsed === undefined) unread.push(value);
    else read.push(parsed);
  }
  return { read, unread };
};

/** A session's review as stored: what this build reads of it, and each entry it cannot. */
export const parseSessionReview = (
  value: unknown,
): { readonly review: SessionReview; readonly unread: Unread } => {
  if (!isRecord(value)) return { review: EMPTY_REVIEW, unread: NOTHING_UNREAD };
  const pending = partition(value["pending"], parsePending);
  const sends = partition(value["sends"], parseSend);
  const stored = value["document"] ?? null;
  const document = parseDocument(stored);
  return {
    review: { pending: pending.read, sends: sends.read, document },
    unread: {
      pending: pending.unread,
      sends: sends.unread,
      document: document === null ? stored : null,
    },
  };
};

/** A review document's revision before she saves it: the text as Send review composed it. */
const AS_COMPOSED = 1;

/**
 * The session's review for a fresh composition: the one kept while it still lists the same
 * comments, with the same words, after the same reviews; else the composition, replacing it. The
 * text she saved in the one it replaces follows the composition (`carried`), in the same write.
 */
export const keepComposed = (
  review: SessionReview,
  composed: Composed,
  words: string,
): { readonly review: SessionReview; readonly carried: boolean } => {
  const kept = review.document;
  if (
    kept !== null &&
    kept.composed.digest === composed.digest &&
    kept.composed.generation === composed.generation
  )
    return { review, carried: false };
  const earlier = kept === null ? null : kept.revision > AS_COMPOSED ? kept.text : kept.earlier;
  const written = earlier === null ? words : withEarlierText(words, earlier, composed.sessionName);
  const carried = written !== words;
  const document: ReviewDocument = {
    composed,
    text: written,
    revision: AS_COMPOSED,
    earlier: carried ? earlier : null,
  };
  return { review: { ...review, document }, carried };
};

/** A review she is writing whose text is as Send review composed it, with none of hers in it. */
export const asComposed = (document: ReviewDocument): boolean =>
  document.revision === AS_COMPOSED && document.earlier === null;

export type DocumentSave =
  | { readonly kind: "saved"; readonly review: SessionReview; readonly revision: number }
  | { readonly kind: "gone" }
  | { readonly kind: "newer" };

/**
 * Her words saved over `revision`, the one her editor's text is based on; never over a newer one.
 */
export const saveDocument = (
  review: SessionReview,
  documentId: string,
  revision: number,
  words: string,
): DocumentSave => {
  const found = review.document;
  if (found?.composed.documentId !== documentId) return { kind: "gone" };
  if (found.revision !== revision) return { kind: "newer" };
  if (found.text === words) return { kind: "saved", review, revision: found.revision };
  const saved: ReviewDocument = { ...found, text: words, revision: found.revision + 1 };
  return { kind: "saved", review: { ...review, document: saved }, revision: saved.revision };
};

export const removeDocument = (review: SessionReview, documentId: string): SessionReview =>
  review.document?.composed.documentId === documentId ? { ...review, document: null } : review;

export const addPending = (review: SessionReview, comment: PendingComment): SessionReview => ({
  ...review,
  pending: [...review.pending, comment],
});

/**
 * G1: a pending comment is edited freely until it is sent. A Mend draft's words she edits are hers.
 */
export const editPending = (review: SessionReview, id: string, body: string): SessionReview => ({
  ...review,
  pending: review.pending.map((comment) => (comment.id === id ? { ...comment, body } : comment)),
});

export interface HeldWords {
  readonly comment: PendingComment;
  readonly edits: { readonly id: string; readonly body: string } | null;
}

/**
 * Her words VS Code held, kept, and which of them were. Words held for a comment still pending, or
 * for an edit whose comment still reads the words she edited (or already hers), edit it in place.
 * Any other, for a comment a review took, another window changed or she deleted, is added under
 * the id minted when it was held, so both words stay. One to add while the review holds
 * `MAX_PENDING` stays held.
 */
export const keepHeld = (
  review: SessionReview,
  held: ReadonlyArray<HeldWords>,
): { readonly review: SessionReview; readonly kept: ReadonlyArray<HeldWords> } =>
  held.reduce<{ review: SessionReview; kept: ReadonlyArray<HeldWords> }>(
    (done, words) => {
      const { comment, edits } = words;
      const next = done.review;
      const find = (id: string): PendingComment | undefined =>
        next.pending.find((candidate) => candidate.id === id);
      const edited = edits === null ? undefined : find(edits.id);
      const into =
        find(comment.id) !== undefined
          ? comment.id
          : edited !== undefined && (edited.body === edits?.body || edited.body === comment.body)
            ? edited.id
            : null;
      if (into !== null)
        return {
          review: editPending(next, into, comment.body),
          kept: [...done.kept, words],
        };
      if (next.pending.length >= MAX_PENDING) return done;
      return { review: addPending(next, comment), kept: [...done.kept, words] };
    },
    { review, kept: [] },
  );

export const removePending = (review: SessionReview, id: string): SessionReview => ({
  ...review,
  pending: review.pending.filter((comment) => comment.id !== id),
});

/**
 * The drafts she accepted, by their id on Mend: their threads show as hers, not as drafts. One
 * her posted words replace stays hers though its review was refused: her words are on Mend.
 */
export const acceptedDrafts = (review: SessionReview): ReadonlySet<string> =>
  new Set([
    ...review.pending.flatMap((comment) =>
      comment.origin.kind === "accepted" ? [comment.origin.draftId] : [],
    ),
    ...review.sends.flatMap((record) =>
      record.items.flatMap((item) =>
        item.kind === "open" ||
        item.pending.origin.kind !== "accepted" ||
        (record.phase.kind === "refused" &&
          (item.kind !== "rewrite" || item.post.kind !== "posted"))
          ? []
          : [item.pending.origin.draftId],
      ),
    ),
  ]);
