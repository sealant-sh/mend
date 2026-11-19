import { describe, expect, it } from "vitest";

import type { ChangePassDto, FollowUpDto, ReviewCommentDto, ReviewDiffFileDto } from "./api.ts";
import {
  anchorFor,
  assembleInstruction,
  commentGroups,
  deliveryOf,
  parseAnchor,
  passWords,
  placeLongWords,
  placeWords,
  sendRuleOf,
  stateActions,
  stateWords,
  toolbarNoteWords,
} from "./review-comments.ts";

let made = 0;
const comment = (over: Partial<ReviewCommentDto> = {}): ReviewCommentDto => {
  made += 1;
  return {
    id: `comment-${made}`,
    changeId: "change-1",
    file: "src/payments/retry.ts",
    line: 31,
    endLine: null,
    anchor: null,
    authorKind: "human",
    authorName: "Ada Lovelace",
    body: "Should we back off on a 409 too?",
    kind: "comment",
    suggestion: null,
    state: "open",
    evidence: [],
    sentToSessionId: null,
    createdAt: new Date(Date.UTC(2026, 10, 19, 11, made)),
    updatedAt: new Date(Date.UTC(2026, 10, 19, 11, made)),
    ...over,
  } as ReviewCommentDto;
};

const followUp = (over: Partial<FollowUpDto> = {}): FollowUpDto =>
  ({
    id: "follow-up-1",
    sessionId: "session-1",
    changeId: "change-1",
    reviewSliceId: "slice-1",
    checkpointAId: "checkpoint-a",
    checkpointBId: "checkpoint-b",
    diffDigest: "digest",
    commentIds: ["comment-1"],
    idempotencyKey: "key-1",
    instruction: "Address these.",
    status: "pending",
    deliveryProcessId: null,
    deliverySealantRunId: null,
    deliveryError: null,
    deliveryStartedAt: null,
    createdAt: new Date(),
    deliveredAt: null,
    ...over,
  }) as FollowUpDto;

describe("where a comment sits", () => {
  it("names the file and its lines, or the whole change", () => {
    expect(placeWords(comment())).toBe("retry.ts:31");
    expect(placeWords(comment({ line: 37, endLine: 40 }))).toBe("retry.ts:37–40");
    expect(placeWords(comment({ file: null, line: null }))).toBe("Whole change");
    expect(placeLongWords(comment({ line: 37, endLine: 40 }))).toBe("retry.ts lines 37–40");
    expect(placeLongWords(comment())).toBe("retry.ts line 31");
  });
});

describe("the column's lists", () => {
  it("keeps Mend's drafts apart from the comments until someone adds them", () => {
    const mine = comment();
    const draft = comment({ authorKind: "mend", authorName: "Mend", state: "draft" });
    const added = comment({ authorKind: "mend", authorName: "Mend", state: "open" });
    const dropped = comment({ authorKind: "mend", authorName: "Mend", state: "dismissed" });
    const groups = commentGroups([dropped, added, draft, mine]);
    expect(groups.comments.map((each) => each.id)).toEqual([mine.id, added.id]);
    expect(groups.drafts).toEqual([draft]);
    expect(groups.dismissedDrafts).toEqual([dropped]);
    expect(groups.unsent.map((each) => each.id)).toEqual([mine.id, added.id]);
  });

  it("sends only open comments that weren't sent", () => {
    const groups = commentGroups([
      comment({ sentToSessionId: "session-1" }),
      comment({ state: "addressed" }),
      comment({ state: "dismissed" }),
    ]);
    expect(groups.unsent).toEqual([]);
  });
});

describe("what a comment says and offers", () => {
  it("words each state as what was observed", () => {
    expect(stateWords(comment())).toBe("Not sent");
    expect(stateWords(comment({ sentToSessionId: "session-1" }))).toBe("Sent");
    expect(stateWords(comment({ state: "addressed" }))).toBe("Resolved");
    expect(stateWords(comment({ state: "dismissed" }))).toBe("Dismissed");
  });

  it("adds or dismisses a draft, resolves or dismisses an open comment, and reopens the rest", () => {
    const labels = (each: ReviewCommentDto) => stateActions(each).map((action) => action.label);
    expect(labels(comment({ authorKind: "mend", state: "draft" }))).toEqual([
      "Add to comments",
      "Dismiss",
    ]);
    expect(stateActions(comment({ authorKind: "mend", state: "draft" }))[0]?.state).toBe("open");
    expect(labels(comment())).toEqual(["Resolve", "Dismiss"]);
    expect(labels(comment({ authorKind: "mend" }))).toEqual(["Resolve", "Remove"]);
    expect(labels(comment({ sentToSessionId: "session-1" }))).toEqual(["Resolve"]);
    expect(labels(comment({ state: "addressed" }))).toEqual(["Reopen"]);
    expect(labels(comment({ state: "dismissed" }))).toEqual(["Reopen"]);
  });
});

describe("the message the agent receives", () => {
  it("lists each comment with its place and a suggestion's lines, in order", () => {
    const text = assembleInstruction("mend/fix-retry", [
      comment({ line: 37, endLine: 40, suggestion: "a\nb", kind: "suggestion", body: "Take random." }),
      comment({ file: null, line: null, body: "Keep the signature." }),
    ]);
    expect(text).toContain("The branch mend/fix-retry is already checked out");
    expect(text).toContain("1. src/payments/retry.ts:37-40 — Take random.");
    expect(text).toContain("   Proposed replacement:\n   a\n   b");
    expect(text).toContain("2. the change as a whole — Keep the signature.");
  });
});

describe("where a new line comment anchors", () => {
  const files = [
    {
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      hunks: [
        { newStart: 10, newLines: 5, contextHash: "h1" },
        { newStart: 40, newLines: 0, contextHash: "h2" },
      ],
    },
  ] as unknown as ReadonlyArray<ReviewDiffFileDto>;

  it("pins lines inside one changed part to that part", () => {
    expect(anchorFor(files, "src/a.ts", 11, 14)).toEqual({
      file: "src/a.ts",
      line: 11,
      endLine: 14,
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      hunkContextHash: "h1",
    });
    expect(anchorFor(files, "src/a.ts", 12, 12)?.endLine).toBeNull();
  });

  it("refuses lines outside a changed part, across two, or in another file", () => {
    expect(anchorFor(files, "src/a.ts", 2, null)).toBeNull();
    expect(anchorFor(files, "src/a.ts", 12, 20)).toBeNull();
    expect(anchorFor(files, "src/b.ts", 11, null)).toBeNull();
  });

  it("reads back an open box from its stored anchor, and nothing else", () => {
    const anchor = anchorFor(files, "src/a.ts", 11, null);
    expect(parseAnchor(JSON.stringify(anchor))).toEqual(anchor);
    expect(parseAnchor("")).toBeNull();
    expect(parseAnchor("{nope")).toBeNull();
    expect(parseAnchor(JSON.stringify({ file: "src/a.ts" }))).toBeNull();
  });
});

describe("who sends", () => {
  const detail = (over: {
    readonly steer?: boolean;
    readonly terminalInput?: boolean;
    readonly harness?: string;
    readonly agentKind?: string | null;
  }) =>
    ({
      control: { steer: over.steer ?? true, terminalInput: over.terminalInput ?? true, own: true },
      currentAgent: over.agentKind === null ? null : { kind: over.agentKind ?? "agent-protocol" },
      session: { harness: over.harness ?? "claude" },
    }) as unknown as Parameters<typeof sendRuleOf>[0];

  it("lets anyone who steers send to an agent", () => {
    expect(sendRuleOf(detail({}), "Ada Lovelace")).toEqual({ can: true });
  });

  it("says why everyone else can't", () => {
    expect(sendRuleOf(detail({ steer: false }), null)).toEqual({
      can: false,
      why: "Comments stay here. Only the session's owner sends them, unless they share control.",
    });
    const run = sendRuleOf(detail({ harness: "run" }), null);
    expect(run.can).toBe(false);
    expect(run.can ? "" : run.why).toContain("has no agent to send the review to");
  });

  it("keeps a terminal agent's send to its owner", () => {
    const rule = sendRuleOf(
      detail({ terminalInput: false, agentKind: "agent-pty" }),
      "Grace Hopper",
    );
    expect(rule.can ? "" : rule.why).toContain("Only Grace Hopper sends comments to it");
  });
});

describe("where a send stands", () => {
  it("is nothing without a follow-up of this change", () => {
    expect(deliveryOf(null, "change-1", null)).toEqual({ kind: "none" });
    expect(deliveryOf(followUp({ changeId: "change-2" }), "change-1", null)).toEqual({
      kind: "none",
    });
    expect(deliveryOf(followUp({ status: "delivered" }), "change-1", null)).toEqual({
      kind: "none",
    });
  });

  it("is pending, under way or failed as the server says", () => {
    expect(deliveryOf(followUp(), "change-1", null).kind).toBe("pending");
    expect(deliveryOf(followUp({ status: "delivering" }), "change-1", null).kind).toBe(
      "delivering",
    );
    expect(
      deliveryOf(followUp({ status: "delivery_failed", deliveryError: "No answer." }), "change-1", null),
    ).toMatchObject({ kind: "failed", reason: "No answer." });
  });

  it("is failed when the request itself failed, with what the page heard", () => {
    expect(deliveryOf(null, "change-1", "The server didn't answer.")).toEqual({
      kind: "failed",
      followUp: null,
      reason: "The server didn't answer.",
    });
  });
});

describe("the toolbar's note", () => {
  it("says how commenting works before any comment", () => {
    expect(toolbarNoteWords("Claude Code", commentGroups([]), false)).toBe(
      "Click a line to comment. Claude Code gets your comments when you send them.",
    );
  });

  it("says comments wait, and when the agent has finished that it starts on them", () => {
    const groups = commentGroups([comment()]);
    expect(toolbarNoteWords("Codex", groups, false)).toBe(
      "Your comments stay here until you send them.",
    );
    expect(toolbarNoteWords("Codex", groups, true)).toBe(
      "Codex has finished, so it starts on your comments as soon as you send them.",
    );
  });

  it("counts resolved and open once comments were sent", () => {
    const groups = commentGroups([
      comment({ sentToSessionId: "session-1", state: "addressed" }),
      comment({ sentToSessionId: "session-1" }),
    ]);
    expect(toolbarNoteWords("Codex", groups, true)).toBe("1 comment resolved, 1 open.");
  });
});

describe("what Mend's passes did", () => {
  const now = new Date(Date.UTC(2026, 10, 19, 12, 0));
  const pass = (over: Partial<ChangePassDto>): ChangePassDto =>
    ({
      changeId: "change-1",
      kind: "read",
      status: "completed",
      detail: null,
      findings: 0,
      startedAt: new Date(Date.UTC(2026, 10, 19, 11, 55)),
      finishedAt: new Date(Date.UTC(2026, 10, 19, 11, 57)),
      ...over,
    }) as ChangePassDto;

  it("never words a pass that found nothing like one that never ran", () => {
    expect(passWords(null, null, now)).toEqual([]);
    expect(passWords(pass({}), null, now)).toEqual([
      { text: "Mend read the change 3 min ago and drafted nothing.", failed: false },
    ]);
  });

  it("counts drafts, and says when a pass is waiting, running or failed", () => {
    expect(passWords(pass({ findings: 2 }), null, now)[0]?.text).toBe(
      "Mend read the change 3 min ago and drafted 2 comments.",
    );
    expect(passWords(null, pass({ kind: "suggest", findings: 1 }), now)[0]?.text).toBe(
      "Mend looked for fixes 3 min ago and drafted 1 fix.",
    );
    expect(passWords(pass({ status: "queued" }), null, now)[0]?.text).toBe(
      "Mend is waiting to read the change.",
    );
    expect(passWords(pass({ status: "running" }), null, now)[0]?.text).toBe(
      "Mend is reading the change…",
    );
    expect(passWords(pass({ status: "failed", detail: "Out of time." }), null, now)[0]).toEqual({
      text: "Mend couldn't read the change (3 min ago). Out of time.",
      failed: true,
    });
  });
});
