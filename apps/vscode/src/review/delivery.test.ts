import { reviewTargetExists } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { changeRows } from "./change-rows.js";
import { commentTarget, postedComment, type PostAttempt } from "./comment-target.js";
import {
  admits,
  commentsOnTheirWay,
  mayRetry,
  needs,
  MAX_ACCOUNT_WAITS,
  nextAction,
  onFailure,
  openRecord,
  retryRecord,
  startSend,
  step,
  stepReview,
  type DriveFailure,
  type LiveAgent,
  type Needs,
  type PasteStep,
  type SendEvent,
  type SendPhase,
  type SendRecord,
} from "./delivery.js";
import type { PastePlan } from "./paste-plan.js";
import {
  acceptedDrafts,
  EMPTY_REVIEW,
  parseSessionReview,
  type PendingComment,
  type SessionReview,
} from "./pending.js";
import type { ChangeFile, CommentAnchor } from "./review-wire.js";
import { comment, FILES, instructionOf, pending, PINNED, readOf } from "./test-fixtures.js";

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
    document: null,
  },
  key = "key-1",
): SessionReview =>
  started(
    startSend(review, {
      key,
      slice: SLICE,
      instruction: instructionOf("the review"),
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
    agent: null,
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
      document: null,
    };
    const input = {
      key: "key-1",
      slice: SLICE,
      instruction: instructionOf("the review"),
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
    expect(only(failed).phase).toEqual({ kind: "failed", words: "Cannot reach Mend", at: NOW });
    expect(nextAction(only(failed))).toEqual({ kind: "idle" });
    const retried = apply(failed, { kind: "retry", at: NOW, agent: null, mend: null });
    expect(nextAction(only(retried))).toEqual(first);
  });

  it("reconciles a post a reload cut short before posting it again", () => {
    const cut = apply(sent(), { kind: "post-started", pendingId: "p1", attempt: ATTEMPT });
    const reloaded = apply(cut, { kind: "abandoned", why: { kind: "closed" } });
    expect(only(reloaded).phase).toEqual({
      kind: "failed",
      words: "VS Code closed before Mend answered",
      at: NOW,
    });
    expect(
      nextAction(only(apply(reloaded, { kind: "retry", at: NOW, agent: null, mend: null }))),
    ).toEqual({
      kind: "reconcile",
      pendingIds: ["p1"],
    });
    const kept = parseSessionReview(JSON.parse(JSON.stringify(cut))).review;
    expect(only(kept).items[0]).toMatchObject({ post: { kind: "posting", ...ATTEMPT } });
  });

  it("pastes into her live terminal agent once, and delivers that key again only when nothing was pasted and the agent is gone", () => {
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
    const pasted = apply(inTerminal, { kind: "paste-started" }, { kind: "pasted" });
    for (const later of [
      pasted,
      apply(pasted, { kind: "abandoned", why: { kind: "closed" } }),
      apply(pasted, { kind: "retry", at: NOW, agent: HERS, mend: null }),
      watched(pasted, { status: "pending" }),
    ])
      expect(nextAction(only(later))).toEqual({ kind: "idle" });
    expect(mayRetry(only(pasted), HERS)).toBe(false);
    expect(mayRetry(only(pasted), null)).toBe(false);
    // While claude holds the paste, its comments are not new to Send review, and Retry waits.
    expect(commentsOnTheirWay(pasted.sends, HERS)).toEqual(
      new Map([
        ["c1", "held"],
        ["c2", "held"],
      ]),
    );
    // Once no live agent holds it, the next Send carries them.
    expect(commentsOnTheirWay(pasted.sends, null)).toEqual(new Map());
    expect(retryRecord(pasted.sends, HERS)).toBeNull();
    expect(retryRecord(pasted.sends, null)).toBeNull();
    const unpasted = apply(inTerminal, { kind: "paste-failed", why: "not-attached" });
    expect(retryRecord(unpasted.sends, null)?.key).toBe("key-1");
    const relaunch = apply(unpasted, { kind: "retry", at: NOW, agent: null, mend: null });
    expect(nextAction(only(relaunch))).toMatchObject({
      kind: "deliver",
      request: { idempotencyKey: "key-1", instruction: "the review", commentIds: ["c1", "c2"] },
    });
  });

  it("reads a held review as replaced once a newer review of hers reaches Mend", () => {
    const held = apply(
      answered(posted(sent()), "pending"),
      { kind: "paste-started" },
      { kind: "pasted" },
    );
    const newer = started(
      startSend(held, {
        key: "key-2",
        slice: SLICE,
        instruction: instructionOf("the newer review"),
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
    ).toEqual({ kind: "failed", words: "no login", at: NOW });
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
    const kept = parseSessionReview(JSON.parse(JSON.stringify(posted(sent())))).review;
    expect(only(kept).key).toBe("key-1");
    expect(nextAction(only(kept))).toMatchObject({ kind: "deliver" });
  });
});

const terminal = (paste: Extract<SendPhase, { kind: "in-terminal" }>["paste"]): SendPhase => ({
  kind: "in-terminal",
  agent: "claude",
  processId: "agent-1",
  paste,
});

describe("a review whose paste into claude's terminal is due or under way", () => {
  const SEND_AGAIN = {
    key: "key-2",
    slice: SLICE,
    instruction: instructionOf("the newer review"),
    paste: ALL,
    pending: ["p3"],
    open: [],
    now: NOW,
  };
  const withPaste = (paste: PasteStep): SessionReview => {
    const held = posted(sent());
    return {
      ...held,
      pending: [pending({ id: "p3", line: 20, endLine: 20 })],
      sends: held.sends.map((record) => ({ ...record, phase: terminal(paste) })),
    };
  };

  const UNDER_WAY: ReadonlyArray<readonly [string, PasteStep]> = [
    ["due", { kind: "due" }],
    ["under way", { kind: "pasting" }],
  ];

  it.each(UNDER_WAY)(
    "takes no new Send while its paste is %s, and holds its comments",
    (_when, paste) => {
      const review = withPaste(paste);
      expect(startSend(review, SEND_AGAIN)).toBeNull();
      expect(openRecord(review.sends)?.key).toBe("key-1");
      expect(commentsOnTheirWay(review.sends, null)).toEqual(
        new Map([
          ["c1", "sending"],
          ["c2", "sending"],
        ]),
      );
    },
  );

  it("takes no new Send while an earlier review is still sending", () => {
    const sending = sent();
    const review = { ...sending, pending: [pending({ id: "p3", line: 20, endLine: 20 })] };
    expect(admits(review.sends)).toBe(false);
    expect(startSend(review, SEND_AGAIN)).toBeNull();
  });

  it("takes a new Send once its paste is done", () => {
    const review = withPaste({ kind: "done", input: { text: "the review", ids: ["c1", "c2"] } });
    expect(only(started(startSend(review, SEND_AGAIN)), "key-2").phase.kind).toBe("sending");
    expect(openRecord(review.sends)).toBeNull();
  });
});

describe("what a send leaves her to know", () => {
  const inTerminal = (paste: PasteStep): SessionReview => {
    const held = posted(sent());
    return { ...held, sends: held.sends.map((record) => ({ ...record, phase: terminal(paste) })) };
  };

  it("keeps a skipped paste's words as one warning, offering no Retry, that a reload still reads", () => {
    const words = "You changed the review claude's input already holds, so nothing was pasted.";
    const once = apply(inTerminal({ kind: "due" }), { kind: "skipped", words });
    const twice = apply(once, { kind: "skipped", words });
    expect(only(twice).notices).toEqual([
      { kind: "paste", at: NOW, words, tone: "warning", retry: false, text: false },
    ]);
    expect(only(parseSessionReview(JSON.parse(JSON.stringify(twice))).review).notices).toEqual(
      only(twice).notices,
    );
  });

  const inPhase = (phase: SendPhase): SendRecord => ({ ...only(posted(sent())), phase });
  const DONE = terminal({ kind: "done", input: { text: "the review", ids: ["c1", "c2"] } });
  const CUT_SHORT = terminal({ kind: "failed", mayHaveLanded: true, stopped: null });
  const REFUSED: SendPhase = { kind: "refused", words: "Mend refused it." };
  const NO_CHANGE: ReadonlyArray<readonly [string, SendRecord, SendEvent]> = [
    [
      "a paste that fails once more",
      inPhase(CUT_SHORT),
      { kind: "paste-failed", why: "interrupted", words: "the socket closed" },
    ],
    [
      "a paste that went nowhere, after it was done",
      inPhase(DONE),
      { kind: "paste-failed", why: "not-attached" },
    ],
    [
      "a drive found left after its paste",
      inPhase(DONE),
      { kind: "abandoned", why: { kind: "closed" } },
    ],
    [
      "a drive found left after its paste was cut short",
      inPhase(CUT_SHORT),
      { kind: "abandoned", why: { kind: "switched" } },
    ],
    [
      "a skipped paste, after it was done",
      inPhase(DONE),
      { kind: "skipped", words: "nothing to add" },
    ],
    [
      "a dismissed draft of a refused review",
      inPhase(REFUSED),
      { kind: "draft-gone", draftId: "d1" },
    ],
    [
      "a refusal of a refused review",
      inPhase(REFUSED),
      { kind: "failed", words: "Mend refused it again.", retryable: false },
    ],
    [
      "an answer to a review no longer sending",
      inPhase({ kind: "delivered", at: NOW }),
      { kind: "answered", status: "delivered", error: null, agent: { kind: "other" } },
    ],
  ];

  it.each(NO_CHANGE)(
    "writes no notice for %s, which leaves the review as it was",
    (_what, before, event) => {
      expect(step(before, event, NOW)).toEqual(before);
    },
  );

  it("keeps a paste that failed as an error offering Retry, and a later one beside it", () => {
    const failed = apply(inTerminal({ kind: "due" }), {
      kind: "paste-failed",
      why: "not-attached",
    });
    const again = apply(
      {
        ...failed,
        sends: failed.sends.map((record) => ({ ...record, phase: terminal({ kind: "due" }) })),
      },
      { kind: "paste-failed", why: "interrupted", words: "the socket closed" },
    );
    expect(only(again).notices.map(({ words, retry }) => ({ words, retry }))).toEqual([
      { words: expect.stringMatching(/could not attach claude's terminal here/), retry: true },
      {
        words: expect.stringMatching(/the socket closed, so some or all of it may be in/),
        retry: true,
      },
    ]);
  });
});

describe("every phase a review is kept in", () => {
  const PHASES: ReadonlyArray<readonly [string, SendPhase, Needs]> = [
    ["sending", { kind: "sending", since: NOW }, "driver"],
    ["delivering", { kind: "delivering" }, "driver"],
    ["in-terminal, paste due", terminal({ kind: "due" }), "driver"],
    ["in-terminal, pasting", terminal({ kind: "pasting" }), "driver"],
    [
      "in-terminal, not pasted",
      terminal({ kind: "failed", mayHaveLanded: false, stopped: null }),
      "her",
    ],
    [
      "in-terminal, paste cut short",
      terminal({ kind: "failed", mayHaveLanded: true, stopped: { kind: "closed" } }),
      "her",
    ],
    [
      "in-terminal, pasted",
      terminal({ kind: "done", input: { text: "the review", ids: ["c1", "c2"] } }),
      "nothing",
    ],
    ["pending", { kind: "pending" }, "her"],
    ["failed", { kind: "failed", words: "Mend is restarting", at: NOW }, "her"],
    ["delivered", { kind: "delivered", at: NOW }, "nothing"],
    ["refused", { kind: "refused", words: "Mend refused it" }, "nothing"],
  ];
  const AGENTS: ReadonlyArray<readonly [string, LiveAgent | null]> = [
    ["while claude lives", HERS],
    ["once claude exited", null],
  ];

  const CASES: ReadonlyArray<readonly [string, string, SendPhase, Needs, LiveAgent | null]> =
    PHASES.flatMap(([name, phase, who]) =>
      AGENTS.map(([when, agent]): readonly [string, string, SendPhase, Needs, LiveAgent | null] => [
        name,
        when,
        phase,
        who,
        agent,
      ]),
    );

  it.each(CASES)("%s has a way out %s", (_name, _when, phase, who, agent) => {
    const record: SendRecord = { ...only(posted(sent())), phase };
    expect(needs(record)).toBe(who);
    switch (who) {
      case "driver": {
        const abandoned = step(record, { kind: "abandoned", why: { kind: "closed" } }, NOW);
        expect(nextAction(record).kind !== "idle" || abandoned.phase !== record.phase).toBe(true);
        expect(needs(abandoned) !== "driver" || nextAction(abandoned).kind !== "idle").toBe(true);
        break;
      }
      case "her":
        expect(mayRetry(record, agent)).toBe(true);
        expect(retryRecord([record], agent)?.key).toBe(record.key);
        break;
      case "nothing":
        expect(mayRetry(record, agent)).toBe(false);
        expect(retryRecord([record], agent)).toBeNull();
        expect(openRecord([record])).toBeNull();
        break;
    }
  });
});

describe("a step of a drive that fails", () => {
  const DRIVEN: ReadonlyArray<readonly [string, SendPhase]> = [
    ["sending", { kind: "sending", since: NOW }],
    ["delivering", { kind: "delivering" }],
    ["in-terminal, paste due", terminal({ kind: "due" })],
    ["in-terminal, pasting", terminal({ kind: "pasting" })],
  ];
  const FAILURES: ReadonlyArray<readonly [string, DriveFailure]> = [
    [
      "VS Code connected to another server or account",
      { kind: "unbound", why: "switched", words: "" },
    ],
    ["VS Code was signed out", { kind: "unbound", why: "signed-out", words: "" }],
    ["Mend could not name VS Code's sign-in", { kind: "unbound", why: "unknown", words: "" }],
    ["Mend refused a write", { kind: "refused", words: "Mend refused the review" }],
    ["anything else failed", { kind: "failed", words: "Mend is restarting" }],
  ];
  const CASES: ReadonlyArray<readonly [string, string, SendPhase, DriveFailure]> = DRIVEN.flatMap(
    ([name, phase]) =>
      FAILURES.map(([what, failure]): readonly [string, string, SendPhase, DriveFailure] => [
        name,
        what,
        phase,
        failure,
      ]),
  );
  const inPhase = (phase: SendPhase): SendRecord => ({ ...only(posted(sent())), phase });

  it.each(CASES)(
    "%s, when %s, stops, waits, or leaves the review on her or on no one",
    (_name, _what, phase, failure) => {
      const next = onFailure(inPhase(phase), failure, 0);
      if (next.kind === "event")
        expect(needs(step(inPhase(phase), next.event, NOW))).not.toBe("driver");
      else expect(["stop", "wait"]).toContain(next.kind);
    },
  );

  it.each(DRIVEN)(
    "%s stops for a connection elsewhere or a sign-out, and waits a while for a sign-in Mend could not name",
    (_name, phase) => {
      expect(onFailure(inPhase(phase), { kind: "unbound", why: "switched", words: "" }, 0)).toEqual(
        {
          kind: "stop",
          why: { kind: "switched" },
        },
      );
      expect(
        onFailure(inPhase(phase), { kind: "unbound", why: "signed-out", words: "" }, 0),
      ).toEqual({
        kind: "stop",
        why: { kind: "signed-out" },
      });
      const unknown: DriveFailure = {
        kind: "unbound",
        why: "unknown",
        words: "Mend could not say",
      };
      expect(onFailure(inPhase(phase), unknown, MAX_ACCOUNT_WAITS - 1)).toEqual({ kind: "wait" });
      expect(onFailure(inPhase(phase), unknown, MAX_ACCOUNT_WAITS)).toEqual(
        onFailure(inPhase(phase), { kind: "failed", words: "Mend could not say" }, 0),
      );
    },
  );

  it("stops a paste on any other failure, in its words: Mend holds the follow-up", () => {
    expect(
      onFailure(
        inPhase(terminal({ kind: "due" })),
        { kind: "failed", words: "VS Code could not keep the review" },
        0,
      ),
    ).toEqual({ kind: "stop", why: { kind: "error", words: "VS Code could not keep the review" } });
  });

  it("keeps what Mend answered when her agent could not be read after it: the review waits on her", () => {
    const delivered = onFailure(
      inPhase({ kind: "sending", since: NOW }),
      { kind: "agent-unread", answer: { via: "deliver", status: "pending", error: null } },
      0,
    );
    const watch = onFailure(
      inPhase({ kind: "delivering" }),
      {
        kind: "agent-unread",
        answer: { via: "watch", status: "pending", error: null, others: false, sent: false },
      },
      0,
    );
    if (delivered.kind !== "event" || watch.kind !== "event") throw new Error("no event kept");
    expect(step(inPhase({ kind: "sending", since: NOW }), delivered.event, NOW).phase).toEqual({
      kind: "pending",
    });
    expect(step(inPhase({ kind: "delivering" }), watch.event, NOW).phase).toEqual({
      kind: "pending",
    });
  });

  it("reads a send failed, with Retry, or refused when Mend refused a write", () => {
    const sending = inPhase({ kind: "sending", since: NOW });
    expect(onFailure(sending, { kind: "failed", words: "Mend is restarting" }, 0)).toEqual({
      kind: "event",
      event: { kind: "failed", words: "Mend is restarting", retryable: true },
    });
    expect(onFailure(sending, { kind: "refused", words: "Mend refused the review" }, 0)).toEqual({
      kind: "event",
      event: { kind: "failed", words: "Mend refused the review", retryable: false },
    });
  });
});

describe("an accepted draft in a review she sent", () => {
  const accepted = pending({
    id: "a1",
    origin: {
      kind: "accepted",
      draftId: "d1",
      evidence: [],
      draftBody: "Use the shared limiter from guard.ts",
    },
  });

  it("stays hers while the review is on its way, not a draft beside it", () => {
    const review = sent({ pending: [accepted], sends: [], document: null });
    expect(acceptedDrafts(review).has("d1")).toBe(true);
  });

  it("stays hers once her words in its place are on Mend, though the review was refused", () => {
    const review = sent({
      pending: [{ ...accepted, body: "Run the burst test too." }],
      sends: [],
      document: null,
    });
    const refused = apply(
      review,
      { kind: "posted", pendingId: "a1", commentId: "c9" },
      { kind: "failed", words: "Mend refused this review", retryable: false },
    );
    expect(only(refused).phase.kind).toBe("refused");
    expect(acceptedDrafts(refused).has("d1")).toBe(true);
  });

  it("leaves the review when it is dismissed on Mend, and is never opened", () => {
    const review = sent({ pending: [accepted, pending({})], sends: [], document: null });
    expect(nextAction(only(review))).toMatchObject({ kind: "open", draftId: "d1" });
    const gone = apply(review, { kind: "draft-gone", draftId: "d1" });
    expect(only(gone).items.map((item) => item.kind)).toEqual(["own"]);
    const alone = apply(sent({ pending: [accepted], sends: [], document: null }), {
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

  it("is found for a reply on a renamed file's deleted line, under the old name Mend files it by", () => {
    const renamed: ChangeFile = {
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      binary: false,
      hunks: [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, contextHash: "r1" }],
    };
    const anchor: CommentAnchor = {
      sliceId: PINNED.id,
      baseId: PINNED.base.id,
      headId: PINNED.head.id,
      side: "old",
    };
    const reply = pending({ path: "src/old-name.ts", line: 5, endLine: 5, anchor });
    const attempt = { ...ATTEMPT, target: commentTarget([renamed], reply).target };
    const onMend = comment({ ...landed, file: "src/old-name.ts", line: 5, endLine: 5, anchor });
    expect(postedComment(attempt, PINNED.id, [onMend], new Set())).toBe("c9");
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

  it("is a deleted file, with her words unchanged, for a comment about that whole file", () => {
    const whole = pending({ path: "README", line: null, endLine: null, body: "Keep the notes." });
    const filed = commentTarget(FILES, whole);
    expect(filed).toEqual({
      target: {
        oldPath: "README",
        newPath: null,
        side: null,
        startLine: null,
        endLine: null,
        hunkContextHash: null,
      },
      body: "Keep the notes.",
    });
    expect(reviewTargetExists(FILES, filed.target)).toBe(true);
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
