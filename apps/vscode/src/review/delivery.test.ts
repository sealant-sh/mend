import { reviewTargetExists } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { changeRows } from "./change-rows.js";
import {
  commentTarget,
  heldIds,
  mayRetry,
  nextAction,
  postedComment,
  retryRecord,
  startSend,
  stepReview,
  type LiveAgent,
  type PostAttempt,
  type SendEvent,
  type SendRecord,
} from "./delivery.js";
import type { PastePlan } from "./delivery.js";
import {
  acceptedDrafts,
  EMPTY_REVIEW,
  parseSessionReview,
  type PendingComment,
  type SessionReview,
} from "./pending.js";
import type { ChangeFile, CommentAnchor } from "./review-wire.js";
import { comment, FILES, pending, PINNED, readOf } from "./test-fixtures.js";

const ALL: PastePlan = { kind: "all" };

const NOW = "2026-10-19T10:50:00.000Z";
const SLICE = {
  id: PINNED.id,
  baseId: PINNED.base.id,
  headId: PINNED.head.id,
  diffDigest: PINNED.diffDigest,
};

const started = (review: SessionReview | null): SessionReview => {
  if (review === null) throw new Error("the review did not start");
  return review;
};

const sent = (
  review: SessionReview = {
    pending: [pending({}), pending({ id: "p2", line: 13, endLine: 13 })],
    sends: [],
  },
  key = "key-1",
): SessionReview =>
  started(
    startSend(review, {
      key,
      slice: SLICE,
      instruction: "the review",
      paste: ALL,
      pending: review.pending.map(({ id }) => id),
      open: [],
      now: NOW,
    }),
  );

const only = (review: SessionReview, key = "key-1"): SendRecord => {
  const record = review.sends.find((candidate) => candidate.key === key);
  if (record === undefined) throw new Error("no send record");
  return record;
};

/** Every event in order, as the extension applies them. */
const apply = (review: SessionReview, ...events: ReadonlyArray<SendEvent>): SessionReview =>
  events.reduce((next, event) => stepReview(next, "key-1", event, NOW), review);

const ATTEMPT: PostAttempt = {
  body: "Use the shared limiter from guard.ts",
  target: commentTarget(FILES, pending({})).target,
  author: "Dana",
  before: ["c0"],
};

const posted = (review: SessionReview): SessionReview =>
  apply(
    review,
    { kind: "post-started", pendingId: "p1", attempt: ATTEMPT },
    { kind: "posted", pendingId: "p1", commentId: "c1" },
    { kind: "post-started", pendingId: "p2", attempt: ATTEMPT },
    { kind: "posted", pendingId: "p2", commentId: "c2" },
  );

const HERS: LiveAgent = { kind: "terminal", name: "claude", hers: true, processId: "agent-1" };

const answered = (review: SessionReview, status: "pending" | "delivered" | "delivering") =>
  apply(review, {
    kind: "answered",
    status,
    error: null,
    agent: status === "pending" ? HERS : { kind: "other" },
  });

const watched = (
  review: SessionReview,
  seen: Partial<Extract<SendEvent, { kind: "follow-up" }>>,
): SessionReview =>
  apply(review, {
    kind: "follow-up",
    status: null,
    error: null,
    others: false,
    sent: false,
    ...seen,
  });

describe("sending a review (story d, step 6)", () => {
  it("moves her pending comments into one record, posts each, then delivers them under one key", () => {
    const review = sent();
    expect(review.pending).toEqual([]);
    expect(nextAction(only(review))).toMatchObject({ kind: "post", pending: { id: "p1" } });
    const action = nextAction(only(posted(review)));
    expect(action).toEqual({
      kind: "deliver",
      request: {
        reviewSliceId: PINNED.id,
        checkpointAId: PINNED.base.id,
        checkpointBId: PINNED.head.id,
        diffDigest: PINNED.diffDigest,
        commentIds: ["c1", "c2"],
        instruction: "the review",
        idempotencyKey: "key-1",
      },
    });
  });

  it("moves only the comments the instruction lists, and starts nothing when one is gone", () => {
    const review: SessionReview = {
      pending: [pending({}), pending({ id: "p2", line: 13, endLine: 13 })],
      sends: [],
    };
    const input = {
      key: "key-1",
      slice: SLICE,
      instruction: "the review",
      paste: ALL,
      open: [],
      now: NOW,
    };
    const one = started(startSend(review, { ...input, pending: ["p1"] }));
    expect(one.pending.map(({ id }) => id)).toEqual(["p2"]);
    expect(startSend(review, { ...input, pending: ["p1", "p9"] })).toBe(null);
  });

  it("retries a failed delivery with the same key and the same text, posting nothing again", () => {
    const ready = posted(sent());
    const first = nextAction(only(ready));
    const failed = apply(ready, { kind: "failed", words: "Cannot reach Mend", retryable: true });
    expect(only(failed).phase).toEqual({ kind: "failed", words: "Cannot reach Mend" });
    expect(nextAction(only(failed))).toEqual({ kind: "idle" });
    const retried = apply(failed, { kind: "retry", at: NOW, agent: null });
    expect(nextAction(only(retried))).toEqual(first);
  });

  it("reconciles a post a reload cut short before posting it again", () => {
    const cut = apply(sent(), { kind: "post-started", pendingId: "p1", attempt: ATTEMPT });
    const reloaded = apply(cut, { kind: "loaded" });
    expect(only(reloaded).phase.kind).toBe("failed");
    expect(nextAction(only(apply(reloaded, { kind: "retry", at: NOW, agent: null })))).toEqual({
      kind: "reconcile",
      pendingIds: ["p1"],
    });
    const kept = parseSessionReview(JSON.parse(JSON.stringify(cut)));
    expect(only(kept).items[0]).toMatchObject({ post: { kind: "posting", ...ATTEMPT } });
  });

  it("pastes into her live terminal agent once, and delivers that key again only once the agent is gone", () => {
    const inTerminal = answered(posted(sent()), "pending");
    expect(only(inTerminal).phase).toEqual({
      kind: "in-terminal",
      agent: "claude",
      processId: "agent-1",
      paste: { kind: "due" },
    });
    // Into the agent process Mend held it for, never another terminal of the session.
    expect(nextAction(only(inTerminal))).toEqual({
      kind: "paste",
      text: "the review",
      processId: "agent-1",
    });
    const pasted = apply(inTerminal, { kind: "pasted" });
    for (const later of [
      pasted,
      apply(pasted, { kind: "loaded" }),
      apply(pasted, { kind: "retry", at: NOW, agent: HERS }),
      watched(pasted, { status: "pending" }),
    ])
      expect(nextAction(only(later))).toEqual({ kind: "idle" });
    expect(mayRetry(only(pasted), HERS)).toBe(false);
    expect(mayRetry(only(pasted), null)).toBe(true);
    // While claude holds the paste, its comments are not new to Send review, and Retry waits.
    expect(heldIds(pasted.sends)).toEqual(new Set(["c1", "c2"]));
    expect(retryRecord(pasted.sends, HERS)).toBeNull();
    expect(retryRecord(pasted.sends, null)?.key).toBe("key-1");
    const relaunch = apply(pasted, { kind: "retry", at: NOW, agent: null });
    expect(nextAction(only(relaunch))).toMatchObject({
      kind: "deliver",
      request: { idempotencyKey: "key-1", instruction: "the review", commentIds: ["c1", "c2"] },
    });
  });

  it("reads a held review as replaced once a newer review of hers reaches Mend", () => {
    const held = answered(posted(sent()), "pending");
    const newer = started(
      startSend(held, {
        key: "key-2",
        slice: SLICE,
        instruction: "the newer review",
        paste: ALL,
        pending: [],
        open: ["c1", "c2"],
        now: NOW,
      }),
    );
    const reached = stepReview(
      newer,
      "key-2",
      { kind: "answered", status: "delivering", error: null, agent: { kind: "other" } },
      NOW,
    );
    expect(only(reached).phase.kind).toBe("refused");
    expect(only(reached, "key-2").phase.kind).toBe("delivering");
  });

  it("reads delivered only once Mend reads the comments back as sent to the session", () => {
    const launching = answered(posted(sent()), "delivering");
    expect(nextAction(only(launching))).toEqual({ kind: "watch" });
    // Mend answering `delivered` is checked against the comments too.
    expect(only(answered(posted(sent()), "delivered")).phase).toEqual({ kind: "delivering" });
    expect(only(watched(launching, { sent: true })).phase).toEqual({ kind: "delivered", at: NOW });
    expect(only(watched(launching, {})).phase.kind).toBe("failed");
    expect(only(watched(launching, { others: true })).phase).toEqual({ kind: "delivering" });
    expect(
      only(watched(launching, { status: "delivery_failed", error: "no login" })).phase,
    ).toEqual({ kind: "failed", words: "no login" });
  });

  it("gives back to pending what never reached Mend when Mend refuses the review", () => {
    const half = apply(
      sent(),
      { kind: "post-started", pendingId: "p1", attempt: ATTEMPT },
      { kind: "posted", pendingId: "p1", commentId: "c1" },
    );
    const refused = apply(half, {
      kind: "failed",
      words: "Only Dana sends it a review",
      retryable: false,
    });
    expect(refused.pending.map((kept) => kept.id)).toEqual(["p2"]);
    expect(only(refused).phase.kind).toBe("refused");
  });

  it("keeps the record and its key across a reload", () => {
    const kept = parseSessionReview(JSON.parse(JSON.stringify(posted(sent()))));
    expect(only(kept).key).toBe("key-1");
    expect(nextAction(only(kept))).toMatchObject({ kind: "deliver" });
  });
});

describe("an accepted draft in a review she sent", () => {
  const accepted = pending({
    id: "a1",
    origin: { kind: "accepted", draftId: "d1", evidence: [] },
  });

  it("stays hers while the review is on its way, not a draft beside it", () => {
    const review = sent({ pending: [accepted], sends: [] });
    expect(acceptedDrafts(review).has("d1")).toBe(true);
  });

  it("leaves the review when it is dismissed on Mend, and is never opened", () => {
    const review = sent({ pending: [accepted, pending({})], sends: [] });
    expect(nextAction(only(review))).toEqual({ kind: "open", draftId: "d1" });
    const gone = apply(review, { kind: "draft-gone", draftId: "d1" });
    expect(only(gone).items.map((item) => item.kind)).toEqual(["own"]);
    const alone = apply(sent({ pending: [accepted], sends: [] }), {
      kind: "draft-gone",
      draftId: "d1",
    });
    expect(only(alone).phase.kind).toBe("refused");
    expect(alone.pending).toEqual([]);
  });
});

describe("the comment a cut-short post left on Mend", () => {
  const landed = comment({
    id: "c9",
    body: "Use the shared limiter from guard.ts",
    file: "src/auth/limit.ts",
    line: 12,
    endLine: 12,
    anchor: { sliceId: PINNED.id, baseId: PINNED.base.id, headId: PINNED.head.id, side: "new" },
  });

  it("is a new comment of hers, with the exact words and target posted", () => {
    expect(postedComment(ATTEMPT, PINNED.id, [landed], new Set())).toBe("c9");
    expect(postedComment(ATTEMPT, PINNED.id, [landed], new Set(["c9"]))).toBe(null);
  });

  it("is never one that was there before the post, nor another person's, nor other words", () => {
    expect(postedComment({ ...ATTEMPT, before: ["c9"] }, PINNED.id, [landed], new Set())).toBe(
      null,
    );
    const theirs = comment({ ...landed, author: { kind: "reviewer", name: "Ana" } });
    expect(postedComment(ATTEMPT, PINNED.id, [theirs], new Set())).toBe(null);
    expect(postedComment(ATTEMPT, PINNED.id, [{ ...landed, body: "Use it" }], new Set())).toBe(
      null,
    );
    expect(postedComment(ATTEMPT, PINNED.id, [{ ...landed, line: 13 }], new Set())).toBe(null);
  });
});

const changeFile = (
  oldPath: string | null,
  newPath: string | null,
  status: ChangeFile["status"],
  hunk: ChangeFile["hunks"][number],
): ChangeFile => ({
  oldPath,
  newPath,
  status,
  additions: 1,
  deletions: 1,
  binary: false,
  hunks: [hunk],
});

const lineOf = (path: string, line: number, anchor: CommentAnchor | null = null): PendingComment =>
  pending({ path, line, endLine: line, anchor });

describe("where a comment goes on Mend", () => {
  it("is its lines when a hunk of its slice holds them, else its file with the line in words", () => {
    expect(commentTarget(FILES, pending({ line: 3, endLine: 4 }))).toEqual({
      target: {
        oldPath: null,
        newPath: "src/auth/limit.ts",
        side: "new",
        startLine: 3,
        endLine: 4,
        hunkContextHash: "h1",
      },
      body: "Use the shared limiter from guard.ts",
    });
    expect(commentTarget(FILES, pending({ line: 40, endLine: 40 })).body).toBe(
      "line 40: Use the shared limiter from guard.ts",
    );
    expect(commentTarget(FILES, pending({ path: "gone.ts" })).target.newPath).toBe(null);
  });

  it("is a target Mend accepts on an added, modified, renamed or deleted file, on either side", () => {
    const files = [
      changeFile(null, "src/auth/limit.ts", "added", {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 15,
        contextHash: "a1",
      }),
      changeFile("src/app.ts", "src/app.ts", "modified", {
        oldStart: 10,
        oldLines: 4,
        newStart: 10,
        newLines: 5,
        contextHash: "m1",
      }),
      changeFile("src/old-name.ts", "src/new-name.ts", "renamed", {
        oldStart: 3,
        oldLines: 3,
        newStart: 3,
        newLines: 3,
        contextHash: "r1",
      }),
      changeFile("README", null, "deleted", {
        oldStart: 1,
        oldLines: 5,
        newStart: 0,
        newLines: 0,
        contextHash: "d1",
      }),
    ];
    const old: CommentAnchor = {
      sliceId: PINNED.id,
      baseId: PINNED.base.id,
      headId: PINNED.head.id,
      side: "old",
    };
    const cases: ReadonlyArray<readonly [string, PendingComment, "old" | "new" | null]> = [
      ["added, a new line", lineOf("src/auth/limit.ts", 3), "new"],
      ["modified, a new line", lineOf("src/app.ts", 11), "new"],
      ["modified, a deleted line", lineOf("src/app.ts", 12, old), "old"],
      ["modified, outside its hunks", lineOf("src/app.ts", 40), null],
      ["renamed, a new line", lineOf("src/new-name.ts", 4), "new"],
      ["renamed, a deleted line", lineOf("src/old-name.ts", 5, old), "old"],
      ["renamed, outside its hunks", lineOf("src/new-name.ts", 30), null],
      ["deleted, a deleted line", lineOf("README", 2, old), "old"],
    ];
    const refused = cases.flatMap(([name, written, side]) => {
      const { target } = commentTarget(files, written);
      const onItsFile = target.oldPath !== null || target.newPath !== null;
      return onItsFile && target.side === side && reviewTargetExists(files, target) ? [] : [name];
    });
    expect(refused).toEqual([]);
  });

  it("is the old side's lines for her reply under a Mend draft on a deleted line", () => {
    const files = FILES.map((file) =>
      file.oldPath === "README"
        ? {
            ...file,
            hunks: [{ oldStart: 1, oldLines: 5, newStart: 0, newLines: 0, contextHash: "r1" }],
          }
        : file,
    );
    const reply = pending({
      path: "README",
      line: 3,
      endLine: 3,
      body: "and keep the install steps",
      anchor: { sliceId: PINNED.id, baseId: PINNED.base.id, headId: PINNED.head.id, side: "old" },
    });
    expect(commentTarget(files, reply)).toEqual({
      target: {
        oldPath: "README",
        newPath: null,
        side: "old",
        startLine: 3,
        endLine: 3,
        hunkContextHash: "r1",
      },
      body: "and keep the install steps",
    });
    expect(commentTarget(FILES, reply)).toEqual({
      target: {
        oldPath: "README",
        newPath: null,
        side: null,
        startLine: null,
        endLine: null,
        hunkContextHash: null,
      },
      body: "line 3: and keep the install steps",
    });
  });
});

describe("the worktree moved on while she reviewed", () => {
  it("keeps the slice pinned and says how many files changed since, with Review the newer change", () => {
    const rows = changeRows(
      readOf({ kind: "pinned" }, { drift: { files: 3 } }),
      EMPTY_REVIEW,
      "Dana",
      new Date(NOW),
    );
    const [slice] = rows;
    if (slice?.kind !== "slice") throw new Error("no slice row");
    expect(slice.label).toBe("main → now ▾");
    expect(
      slice.above.map((row) => (row.kind === "note" || row.kind === "action" ? row.label : "")),
    ).toEqual(["worktree changed since this review · 3 new files", "Review the newer change"]);
  });

  it("offers since my last review once she sent a review on the pinned slice", () => {
    const review = apply(posted(sent()), {
      kind: "answered",
      status: "delivered",
      error: null,
      agent: { kind: "other" },
    });
    const rows = changeRows(
      readOf({ kind: "pinned" }, { drift: { files: 2 } }),
      review,
      "Dana",
      new Date(NOW),
    );
    const [slice] = rows;
    if (slice?.kind !== "slice") throw new Error("no slice row");
    expect(slice.above.at(-1)).toMatchObject({
      kind: "action",
      label: "since my last review · 2 files",
    });
  });

  it("says nothing of a worktree that has not moved", () => {
    const [slice] = changeRows(readOf({ kind: "pinned" }), EMPTY_REVIEW, "Dana", new Date(NOW));
    expect(slice?.kind === "slice" ? slice.above : null).toEqual([]);
  });
});
