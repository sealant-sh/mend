import {
  ChangeId,
  CheckpointId,
  FollowUpId,
  ReviewCommentId,
  ReviewSliceId,
  SessionId,
} from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { ReviewCommentDto } from "./api.ts";
import {
  answerNoteWords,
  checkpointRows,
  finishedWords,
  placedLines,
  rangeLabel,
  rangeNoteWords,
  sentWords,
  threadOf,
  unsentReplies,
} from "./review-range.ts";

const checkpoint = (ordinal: number) => ({ ordinal });
const opened = (
  from: number,
  to: number,
  kind: "whole" | "since-last-review" | "custom" = "whole",
) => ({
  checkpointA: checkpoint(from),
  checkpointB: checkpoint(to),
  range: { kind },
});

describe("rangeLabel", () => {
  it("names the whole change, since your last review, up to a checkpoint, and two checkpoints", () => {
    expect(rangeLabel(opened(0, 9), "main", false)).toEqual({
      range: "Whole change",
      detail: "main to checkpoint 9",
    });
    expect(rangeLabel(opened(7, 9, "since-last-review"), "main", false)).toEqual({
      range: "Since your last review",
      detail: "checkpoint 7 to 9",
    });
    expect(rangeLabel(opened(0, 5), "main", true)).toEqual({
      range: "Up to checkpoint 5",
      detail: "main to checkpoint 5",
    });
    expect(rangeLabel(opened(7, 8, "since-last-review"), "main", true)).toEqual({
      range: "Checkpoints",
      detail: "7 to 8",
    });
    expect(rangeLabel(opened(4, 6, "custom"), "main", true)).toEqual({
      range: "Checkpoints",
      detail: "4 to 6",
    });
  });
});

describe("checkpointRows", () => {
  const chain = [0, 1, 2, 3].map((ordinal) => ({
    id: `cp-${ordinal}`,
    ordinal,
    trigger: ordinal === 1 ? "session-start" : "turn-boundary",
    createdAt: new Date(Date.UTC(2026, 10, 19, 10, ordinal)),
  }));

  it("lists the checkpoints newest first, without the base, marking your last review and what came after", () => {
    const rows = checkpointRows(chain, { checkpointId: "cp-2", ordinal: 2 });
    expect(rows.map((row) => [row.ordinal, row.words, row.mark])).toEqual([
      [3, "Turn ended", "new"],
      [2, "Turn ended", "last-review"],
      [1, "Session started", null],
    ]);
    expect(checkpointRows(chain, null).every((row) => row.mark === null)).toBe(true);
  });
});

describe("rangeNoteWords", () => {
  it("says how many files changed in the range and names those that changed only before it", () => {
    expect(rangeNoteWords("since-last-review", 2, ["src/payments/charge.ts"])).toBe(
      "2 files changed since your last review. charge.ts didn't change.",
    );
    expect(rangeNoteWords("custom", 1, ["a.ts", "b.ts", "c.ts"])).toBe(
      "1 file changed between these checkpoints. 3 other files didn't change.",
    );
    expect(rangeNoteWords("whole", 2, undefined)).toBeNull();
  });
});

const answer = (
  turnOrdinal: number,
  outcome: "changed-code" | "no-code-change" | null,
  turnStatus: "running" | "completed" = "completed",
) => ({
  followUpId: FollowUpId.make(`follow-up-${turnOrdinal}`),
  sessionId: SessionId.make("session-1"),
  harness: "claude",
  turnOrdinal,
  turnStatus,
  body: turnStatus === "completed" ? "Done." : null,
  outcome,
  changedAt:
    outcome === "changed-code" ? { checkpointId: CheckpointId.make("cp-8"), ordinal: 8 } : null,
  at: new Date(Date.UTC(2026, 10, 19, 11, turnOrdinal)),
});

const comment = (overrides: Partial<ReviewCommentDto> = {}): ReviewCommentDto => ({
  id: ReviewCommentId.make("comment-1"),
  changeId: ChangeId.make("change-1"),
  file: "src/retry.ts",
  line: 31,
  endLine: null,
  anchor: null,
  authorKind: "reviewer",
  authorName: "Ada Lovelace",
  body: "Should we back off on a 409 too?",
  kind: "note",
  suggestion: null,
  state: "open",
  evidence: [],
  sentToSessionId: SessionId.make("session-1"),
  createdAt: new Date(Date.UTC(2026, 10, 19, 10, 0)),
  updatedAt: new Date(Date.UTC(2026, 10, 19, 10, 0)),
  ...overrides,
});

const reply = (id: string, minute: number, sent: string | null = null) => ({
  ...comment({
    id: ReviewCommentId.make(id),
    sentToSessionId: sent === null ? null : SessionId.make(sent),
  }),
  parentId: ReviewCommentId.make("comment-1"),
  body: "Run the refund tests too.",
  createdAt: new Date(Date.UTC(2026, 10, 19, 11, minute)),
});

describe("the agent's answer", () => {
  it("reads what the answer did to the code, or that the agent is still working", () => {
    expect(answerNoteWords(comment({ answers: [answer(4, "changed-code")] }), "Claude Code")).toBe(
      "Replied and changed the code",
    );
    expect(
      answerNoteWords(comment({ answers: [answer(4, "no-code-change")] }), "Claude Code"),
    ).toBe("Replied, no code change");
    expect(answerNoteWords(comment({ answers: [answer(4, null)] }), "Claude Code")).toBe("Replied");
    expect(answerNoteWords(comment({ answers: [answer(4, null, "running")] }), "Claude Code")).toBe(
      "Claude Code is working on it",
    );
    expect(answerNoteWords(comment(), "Claude Code")).toBeNull();
  });

  it("puts replies and answers under a comment in the order they came", () => {
    const thread = threadOf(
      comment({ answers: [answer(4, null), answer(9, null)], replies: [reply("reply-1", 6)] }),
    );
    expect(thread.map((entry) => entry.kind)).toEqual(["answer", "reply", "answer"]);
  });
});

describe("sentWords and placedLines", () => {
  const moved = {
    reviewSliceId: ReviewSliceId.make("slice-2"),
    mapping: "moved" as const,
    path: "src/retry.ts",
    side: "new" as const,
    startLine: 31,
    endLine: 33,
    linesChanged: true,
  };

  it("says which turn a comment went in and the line it was on when an edit moved it", () => {
    expect(sentWords(comment({ sentInTurn: 4, placement: moved }))).toEqual([
      "Sent in turn 4",
      "was line 31",
    ]);
    expect(sentWords(comment({ sentToSessionId: null }))).toEqual([]);
  });

  it("places a comment on the lines that now hold it, and nowhere once they are gone", () => {
    expect(placedLines(comment({ placement: moved }))).toEqual({
      path: "src/retry.ts",
      side: "new",
      line: 31,
      endLine: 33,
    });
    expect(
      placedLines(
        comment({
          placement: { ...moved, mapping: "not-found", startLine: null, endLine: null },
        }),
      ),
    ).toBeNull();
    // Read without a review, it sits on the lines it was written on.
    expect(placedLines(comment())).toEqual({
      path: "src/retry.ts",
      side: "new",
      line: 31,
      endLine: 31,
    });
  });
});

describe("unsentReplies", () => {
  it("sends a reply once, while it is open and not sent", () => {
    const replies = [reply("reply-1", 6), reply("reply-2", 7, "session-1")];
    expect(unsentReplies([comment({ replies })]).map((each) => each.id)).toEqual(["reply-1"]);
  });
});

describe("finishedWords", () => {
  const answered = [
    comment({ id: ReviewCommentId.make("a"), answers: [answer(4, "changed-code")] }),
    comment({ id: ReviewCommentId.make("b"), answers: [answer(4, null)] }),
  ];

  it("says the agent finished your last comments once every answer's turn has ended", () => {
    expect(
      finishedWords(answered, { ordinal: 7 }, 9, (harness) =>
        harness === "claude" ? "Claude Code" : harness,
      ),
    ).toEqual({
      title: "Claude Code finished working on your 2 comments.",
      detail:
        "It answered and changed the code for 1 of them. Checkpoint 7 is where you last reviewed, and the change is now at checkpoint 9.",
    });
  });

  it("says nothing before a last review, while the change hasn't moved, or while a turn runs", () => {
    expect(finishedWords(answered, null, 9, () => "Claude Code")).toBeNull();
    expect(finishedWords(answered, { ordinal: 9 }, 9, () => "Claude Code")).toBeNull();
    expect(
      finishedWords(
        [comment({ answers: [answer(4, null, "running")] })],
        { ordinal: 7 },
        9,
        () => "Claude Code",
      ),
    ).toBeNull();
  });
});
