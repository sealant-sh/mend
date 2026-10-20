import { describe, expect, it } from "vitest";

import { startSend, stepReview } from "./delivery.js";
import type { LiveAgent, PastePlan } from "./delivery.js";
import { EMPTY_REVIEW } from "./pending.js";
import { checkpoint, CHECKPOINTS, comment, pending, PINNED, readOf } from "./test-fixtures.js";
import { commentableLines, commentsLine, threadPlace, threadsOf } from "./threads.js";

const ALL: PastePlan = { kind: "all" };

const NOW = "2026-10-19T10:50:00.000Z";
const SLICE = {
  id: PINNED.id,
  baseId: PINNED.base.id,
  headId: PINNED.head.id,
  diffDigest: PINNED.diffDigest,
};

const pinnedDoc = {
  worktreeId: "w1",
  path: "src/auth/limit.ts",
  at: PINNED.head.id,
  absent: false,
  slice: PINNED.id,
};

describe("where a comment may be written (G10)", () => {
  it("is the pinned slice's hunks on its new side", () => {
    expect(commentableLines(readOf({ kind: "pinned" }), pinnedDoc)).toEqual([
      { start: 1, end: 15 },
    ]);
  });

  it("is nowhere while she reads a slice other than base → now", () => {
    const viewing = readOf({ kind: "between", from: checkpoint(1), to: PINNED.head });
    expect(commentableLines(viewing, pinnedDoc)).toEqual([]);
    expect(commentableLines(viewing, { ...pinnedDoc, slice: null })).toEqual([]);
  });

  it("is nowhere on the base side, or on an earlier pin's document", () => {
    const read = readOf({ kind: "pinned" });
    expect(commentableLines(read, { ...pinnedDoc, at: PINNED.base.id, slice: null })).toEqual([]);
    expect(commentableLines(read, { ...pinnedDoc, slice: "slice-0" })).toEqual([]);
  });
});

describe("a change's comments as threads", () => {
  it("shows her pending comment as hers, pending, on the pinned new side", () => {
    const threads = threadsOf(
      readOf({ kind: "pinned" }),
      { pending: [pending({})], sends: [] },
      "Dana",
    );
    expect(threads).toMatchObject([
      { kind: "pending", author: "Dana", label: "pending", at: pinnedDoc, line: 12 },
    ]);
  });

  it("shows a Mend draft authored `Mend · draft` with its evidence, until she accepts it", () => {
    const draft = comment({
      id: "d1",
      state: "draft",
      line: 13,
      author: { kind: "mend", name: "Mend" },
      body: "Nothing in this session ran the tests after limit.ts changed.",
      evidence: [{ runId: "run-1", sequence: "214", excerpt: "pnpm test auth · never ran" }],
    });
    const read = readOf({ kind: "pinned" }, { comments: [draft] });
    expect(threadsOf(read, EMPTY_REVIEW, "Dana")).toMatchObject([
      { kind: "draft", author: "Mend · draft", label: "draft", commentId: "d1" },
    ]);
    const accepted = threadsOf(
      read,
      {
        pending: [
          pending({
            id: "a1",
            line: 13,
            body: draft.body,
            origin: { kind: "accepted", draftId: "d1", evidence: draft.evidence },
          }),
        ],
        sends: [],
      },
      "Dana",
    );
    expect(accepted).toMatchObject([
      { kind: "accepted", author: "Dana · accepted from Mend", label: "pending" },
    ]);
    expect(accepted[0]?.evidence).toEqual(draft.evidence);
  });

  it("hangs a sent comment at its anchor's checkpoint, the left side of since my last review (d7)", () => {
    const chain = [...CHECKPOINTS, checkpoint(3, "turn-boundary"), checkpoint(4, "review-open")];
    const sent = comment({
      id: "s1",
      sentToSessionId: "session-1",
      anchor: { sliceId: "slice-0", baseId: "cp0", headId: "cp2", side: "new" },
    });
    const later = readOf(
      {
        kind: "since-last-review",
        from: checkpoint(2, "review-open"),
        to: checkpoint(4, "review-open"),
      },
      { comments: [sent], chain: { worktreeId: "w1", baseName: "main", checkpoints: chain } },
    );
    const [thread] = threadsOf(
      { ...later, pinned: { ...PINNED, id: "slice-2", head: checkpoint(4, "review-open") } },
      EMPTY_REVIEW,
      "Dana",
    );
    expect(thread).toMatchObject({
      kind: "sent",
      label: "sent",
      at: { at: "cp2", absent: false, slice: null, path: "src/auth/limit.ts" },
      line: 12,
    });
    expect(later.slice.from.id).toBe("cp2");
  });

  it("shows nothing of a dismissed comment, and a draft about the whole change on the change's note", () => {
    const whole = comment({
      id: "w",
      state: "draft",
      file: null,
      line: null,
      author: { kind: "mend", name: "Mend" },
      body: "No test ran after the change.\nThe record never shows pnpm test.",
      evidence: [{ runId: "run-1", sequence: "9", excerpt: "turn ended" }],
    });
    const threads = threadsOf(
      readOf({ kind: "pinned" }, { comments: [comment({ id: "x", state: "dismissed" }), whole] }),
      EMPTY_REVIEW,
      "Dana",
    );
    expect(threads).toMatchObject([
      {
        kind: "draft",
        at: null,
        line: 1,
        body: whole.body,
        evidence: whole.evidence,
        commentId: "w",
      },
    ]);
    expect(commentsLine(threads)).toBe("1 Mend draft");
    const [thread] = threads;
    if (thread === undefined) throw new Error("no thread");
    expect(threadPlace(thread)).toBe("the whole change");
  });

  it("hangs a comment written on the old side at its slice's base, not on the pinned new side", () => {
    const old = comment({
      id: "o1",
      file: "README",
      line: 1,
      anchor: { sliceId: PINNED.id, baseId: PINNED.base.id, headId: PINNED.head.id, side: "old" },
    });
    const [thread] = threadsOf(
      readOf({ kind: "pinned" }, { comments: [old] }),
      EMPTY_REVIEW,
      "Dana",
    );
    expect(thread?.at).toEqual({
      worktreeId: "w1",
      absent: false,
      path: "README",
      at: PINNED.base.id,
      slice: null,
    });
  });
});

describe("the threads of a review she sent", () => {
  const draft = comment({
    id: "d1",
    state: "draft",
    line: 13,
    endLine: 13,
    author: { kind: "mend", name: "Mend" },
  });
  const accepted = pending({
    id: "a1",
    line: 13,
    endLine: 13,
    origin: { kind: "accepted", draftId: "d1", evidence: [] },
  });

  it("show a draft she accepted once while its review is on its way, as hers", () => {
    const review = startSend(
      { pending: [accepted], sends: [] },
      {
        key: "k1",
        slice: SLICE,
        instruction: "the review",
        paste: ALL,
        pending: ["a1"],
        open: [],
        now: NOW,
      },
    );
    if (review === null) throw new Error("the review did not start");
    const threads = threadsOf(readOf({ kind: "pinned" }, { comments: [draft] }), review, "Dana");
    expect(threads.map(({ kind, author }) => [kind, author])).toEqual([
      ["sending", "Dana · accepted from Mend"],
    ]);
  });

  it("offer Retry delivery on a follow-up Mend holds pending once the session has no live agent", () => {
    const open = comment({ id: "c1" });
    const started = startSend(EMPTY_REVIEW, {
      key: "k1",
      slice: SLICE,
      instruction: "the review",
      paste: ALL,
      pending: [],
      open: ["c1"],
      now: NOW,
    });
    if (started === null) throw new Error("the review did not start");
    const held = stepReview(
      started,
      "k1",
      { kind: "answered", status: "pending", error: null, agent: { kind: "other" } },
      NOW,
    );
    const gone = readOf({ kind: "pinned" }, { comments: [open] });
    const live = readOf(
      { kind: "pinned" },
      { comments: [open], facts: { ...gone.facts, agent: { kind: "other" } } },
    );
    // Held by Mend while an agent lives is not sent: it waits, with no Retry to offer.
    expect(threadsOf(live, held, "Dana")[0]).toMatchObject({
      kind: "waiting",
      label: "follow-up pending",
    });
    expect(threadsOf(gone, held, "Dana")[0]).toMatchObject({
      kind: "held",
      label: "follow-up pending",
      sendKey: "k1",
    });
  });
});

describe("the Comments row's count", () => {
  it("counts a review VS Code pasted into claude's terminal as follow-up pending, never as sent", () => {
    const open = comment({ id: "c1" });
    const started = startSend(EMPTY_REVIEW, {
      key: "k1",
      slice: SLICE,
      instruction: "the review",
      paste: ALL,
      pending: [],
      open: ["c1"],
      now: NOW,
    });
    if (started === null) throw new Error("the review did not start");
    const claude: LiveAgent = {
      kind: "terminal",
      name: "claude",
      hers: true,
      processId: "agent-1",
    };
    const held = stepReview(
      stepReview(
        started,
        "k1",
        { kind: "answered", status: "pending", error: null, agent: claude },
        NOW,
      ),
      "k1",
      { kind: "pasted" },
      NOW,
    );
    const gone = readOf({ kind: "pinned" }, { comments: [open] });
    const live = readOf(
      { kind: "pinned" },
      { comments: [open], facts: { ...gone.facts, agent: claude } },
    );
    const threads = threadsOf(live, held, "Dana");
    expect(threads.map(({ kind, label }) => [kind, label])).toEqual([
      ["waiting", "follow-up pending · pasted into claude's terminal"],
    ]);
    expect(commentsLine(threads)).toBe("1 follow-up pending · pasted into claude's terminal");
  });

  it("counts each comment by the state it was observed in", () => {
    expect(
      commentsLine([
        { kind: "sending", label: "sending" },
        { kind: "failed", label: "delivery failed · retryable" },
        { kind: "held", label: "follow-up pending" },
        { kind: "sent", label: "sent" },
        { kind: "pending", label: "pending" },
      ]),
    ).toBe("1 pending · 1 sending · 1 delivery failed · retryable · 1 follow-up pending · 1 sent");
  });
});
