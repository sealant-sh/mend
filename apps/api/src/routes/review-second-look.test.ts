import { createHash } from "node:crypto";

import {
  CheckpointId,
  FollowUpId,
  ReviewCommentId,
  ReviewSliceId,
  Sha,
  AgentTurnId,
} from "@mend/domain";
import {
  Checkpoint,
  DiffDigest,
  FollowUp,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewReply,
  ReviewSlice,
} from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import type { DiffFileFact } from "@mend/store";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * Second look (SLNT-1176): a review over a chosen range of checkpoints, "since your last review",
 * replies, and the agent's answer, through the real routes over in-memory repos and canned git.
 */
const world = ids("shared-a");
const at = (minute: number) => new Date(Date.UTC(2026, 10, 19, 10, minute));
const sha = (n: number) => Sha.make(String(n).repeat(40));
const digest = (patch: string) => DiffDigest.make(createHash("sha256").update(patch).digest("hex"));

// The worktree's chain: 0 the base, 2 where alice last sent comments, 3 the review-open
// checkpoint the worktree still matches, taken after the agent's turn ended at 10:30.
const chain = [0, 1, 2, 3].map(
  (ordinal) =>
    new Checkpoint({
      id: CheckpointId.make(`checkpoint-${ordinal}`),
      worktreeId: world.worktree,
      sessionId: world.session,
      ordinal,
      ref: `refs/mend/checkpoints/${world.worktree}/${ordinal}`,
      sha: sha(ordinal),
      sealantRunId: null,
      seq: 0n,
      trigger: ordinal === 3 ? "review-open" : "turn-boundary",
      createdAt: at(ordinal * 10 + 1),
    }),
);
const checkpoint = (ordinal: number): Checkpoint => {
  const found = chain.find((row) => row.ordinal === ordinal);
  if (found === undefined) throw new Error(`no checkpoint ${ordinal}`);
  return found;
};

// From checkpoint 2 to 3 the agent rewrote line 31 of retry.ts into three lines.
const retryRewrite = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "index 1111111..2222222 100644",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -31 +31,3 @@",
  "-  if (!RETRYABLE.has(res.status)) throw new ChargeError(res);",
  "+  if (!RETRYABLE.has(res.status) && res.status !== 409) {",
  "+    throw new ChargeError(res);",
  "+  }",
  "",
].join("\n");
const retryFacts: ReadonlyArray<DiffFileFact> = [
  {
    oldPath: "src/retry.ts",
    newPath: "src/retry.ts",
    status: "modified",
    additions: 3,
    deletions: 1,
    binary: false,
  },
];
const patchOf = (a: string, b: string) =>
  a === sha(2) && b === sha(3) ? retryRewrite : `patch ${a.slice(0, 1)}..${b.slice(0, 1)}\n`;

const sliceOf = (id: string, a: number, b: number) =>
  new ReviewSlice({
    id: ReviewSliceId.make(id),
    changeId: world.change,
    checkpointAId: checkpoint(a).id,
    checkpointBId: checkpoint(b).id,
    diffDigest: digest(patchOf(sha(a), sha(b))),
    createdAt: at(50),
  });

const comment = new ReviewComment({
  id: ReviewCommentId.make("comment-409"),
  changeId: world.change,
  file: "src/retry.ts",
  line: 31,
  endLine: null,
  anchor: new ReviewCommentAnchor({
    reviewSliceId: ReviewSliceId.make("slice-0-2"),
    checkpointAId: checkpoint(0).id,
    checkpointBId: checkpoint(2).id,
    diffDigest: digest(patchOf(sha(0), sha(2))),
    oldPath: "src/retry.ts",
    newPath: "src/retry.ts",
    side: "new",
    startLine: 31,
    endLine: 31,
    hunkContextHash: null,
    mapping: "anchored",
  }),
  authorKind: "reviewer",
  authorName: "Alice",
  body: "Should we back off on a 409 too?",
  kind: "note",
  suggestion: null,
  state: "open",
  evidence: [],
  sentToSessionId: world.session,
  createdAt: at(15),
  updatedAt: at(20),
});
const reply = new ReviewReply({
  ...comment,
  id: ReviewCommentId.make("reply-1"),
  parentId: comment.id,
  body: "Please run the refund tests too.",
  sentToSessionId: null,
  createdAt: at(40),
  updatedAt: at(40),
});
const draft = new ReviewComment({
  ...comment,
  id: ReviewCommentId.make("draft-1"),
  authorKind: "mend",
  state: "draft",
});
const followUp = new FollowUp({
  id: FollowUpId.make("follow-up-1"),
  sessionId: world.session,
  changeId: world.change,
  reviewSliceId: ReviewSliceId.make("slice-0-2"),
  checkpointAId: checkpoint(0).id,
  checkpointBId: checkpoint(2).id,
  diffDigest: digest(patchOf(sha(0), sha(2))),
  commentIds: [comment.id],
  idempotencyKey: "send-1",
  instruction: "Review comments…",
  status: "delivered",
  deliveryProcessId: null,
  deliverySealantRunId: null,
  deliveryError: null,
  deliveryStartedAt: at(21),
  createdAt: at(21),
  deliveredAt: at(21),
});

let api: TenancyApi;
const slices = new Map<string, ReviewSlice>();
const replies: Array<{ readonly parent: string; readonly body: string }> = [];

beforeAll(async () => {
  api = await createTenancyApi(
    {},
    {
      implement: {
        checkpoints: {
          listForWorktree: () => Effect.succeed(chain),
          byId: (id) => Effect.succeed(chain.find((row) => row.id === id) ?? null),
        },
        reads: {
          diffRange: (_project, _worktree, a, b) =>
            Effect.succeed({ value: patchOf(a, b), stamp: WORKTREE_STAMP }),
          diffFileFacts: (_project, _worktree, a, b) =>
            Effect.succeed({
              value: a === sha(2) && b === sha(3) ? retryFacts : [],
              stamp: WORKTREE_STAMP,
            }),
          worktreeMatchesCommit: (_project, _worktree, commit) =>
            Effect.succeed({ value: commit === sha(3), stamp: WORKTREE_STAMP }),
        },
        slices: {
          withChangeLock: (_changeId, effect) => effect,
          byIdempotencyKey: (_changeId, key) =>
            Effect.succeed([...slices.values()].find((row) => row.id === `slice-${key}`) ?? null),
          latestForChange: () => Effect.succeed(null),
          byId: (id) =>
            Effect.succeed(
              slices.get(id) ?? (id === "slice-2-3" ? sliceOf("slice-2-3", 2, 3) : null),
            ),
          create: (input) =>
            Effect.sync(() => {
              const created = new ReviewSlice({
                id: ReviewSliceId.make(`slice-${input.idempotencyKey}`),
                changeId: input.changeId,
                checkpointAId: input.checkpointAId,
                checkpointBId: input.checkpointBId,
                diffDigest: input.diffDigest,
                createdAt: at(50),
              });
              slices.set(created.id, created);
              return created;
            }),
        },
        followUps: {
          // Alice last sent comments at checkpoint 2; nobody else has sent any.
          lastSentBy: (_changeId, userId) =>
            Effect.succeed(
              userId === "alice"
                ? { followUpId: followUp.id, checkpointBId: checkpoint(2).id, sentAt: at(21) }
                : null,
            ),
          turnsForChange: () =>
            Effect.succeed([
              {
                followUp,
                harness: "claude",
                turnId: AgentTurnId.make("turn-4"),
                ordinal: 4,
                status: "completed",
                startedAt: at(22),
                endedAt: at(30),
                createdAt: at(21),
                lastMessage: "Yes. A 409 now backs off like a 503.",
              },
            ]),
        },
        comments: {
          listForChange: () => Effect.succeed([comment]),
          listReplies: () => Effect.succeed([reply]),
          byId: (id) =>
            id === comment.id
              ? Effect.succeed(comment)
              : id === draft.id
                ? Effect.succeed(draft)
                : Effect.succeed(new ReviewComment({ ...reply })),
          createReply: (parent, input) =>
            Effect.sync(() => {
              replies.push({ parent: parent.id, body: input.body });
              return new ReviewReply({ ...reply, parentId: parent.id, body: input.body });
            }),
        },
      },
    },
  );
});
afterAll(() => api.dispose());
beforeEach(() => {
  slices.clear();
  replies.length = 0;
});

const open = async (user: "alice" | "carol", body: Record<string, unknown>) => {
  const response = await api.request(
    user,
    "POST",
    `/api/changes/${world.change}/reviews/open`,
    body,
  );
  const json: unknown = await response.json();
  return { status: response.status, body: json };
};

describe("POST /changes/:id/reviews/open with a range", () => {
  it("opens the whole change as before when no range is asked", async () => {
    const opened = await open("alice", { idempotencyKey: "whole" });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      checkpointA: { ordinal: 0 },
      checkpointB: { ordinal: 3 },
      slice: { diffDigest: digest(patchOf(sha(0), sha(3))) },
      range: { kind: "whole" },
      lastReview: { checkpointId: "checkpoint-2", ordinal: 2 },
    });
  });

  it("starts at the checkpoint where the asker last sent comments", async () => {
    const opened = await open("alice", { idempotencyKey: "since", range: { from: "last-review" } });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      checkpointA: { ordinal: 2 },
      checkpointB: { ordinal: 3 },
      slice: { diffDigest: digest(retryRewrite) },
      range: { kind: "since-last-review" },
    });
  });

  it("opens the whole change for someone who has never sent comments, and says so", async () => {
    const opened = await open("carol", { idempotencyKey: "carol", range: { from: "last-review" } });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      checkpointA: { ordinal: 0 },
      range: { kind: "whole" },
      lastReview: null,
    });
  });

  it("covers exactly the checkpoints asked for, taking none", async () => {
    const opened = await open("alice", {
      idempotencyKey: "custom",
      range: { from: "checkpoint-1", to: "checkpoint-2" },
    });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      checkpointA: { ordinal: 1 },
      checkpointB: { ordinal: 2 },
      range: { kind: "custom" },
    });
  });

  it("refuses a range that runs backwards or names a checkpoint not in the change", async () => {
    const reversed = await open("alice", {
      idempotencyKey: "backwards",
      range: { from: "checkpoint-2", to: "checkpoint-1" },
    });
    expect(reversed.status).toBe(422);
    expect(reversed.body).toMatchObject({ _tag: "ReviewRangeRefused", reason: "reversed" });
    const unknown = await open("alice", {
      idempotencyKey: "elsewhere",
      range: { from: "checkpoint-elsewhere" },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({
      _tag: "ReviewRangeRefused",
      reason: "unknown-checkpoint",
    });
    expect(slices.size).toBe(0);
  });
});

const postReply = async (commentId: string, body: string) => {
  const response = await api.request(
    "carol",
    "POST",
    `/api/changes/${world.change}/comments/${commentId}/replies`,
    { body },
  );
  const json: unknown = await response.json();
  return { status: response.status, body: json };
};

describe("POST /changes/:id/comments/:commentId/replies", () => {
  it("keeps a reply under the comment, in the replier's words", async () => {
    const answered = await postReply(comment.id, "  Please run the refund tests too.  ");
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ parentId: comment.id });
    expect(replies).toEqual([{ parent: comment.id, body: "Please run the refund tests too." }]);
  });

  it("refuses a reply to a reply, to Mend's draft, or with no words", async () => {
    expect((await postReply(reply.id, "Two deep")).body).toMatchObject({
      _tag: "ReviewReplyRefused",
      reason: "reply-to-reply",
    });
    expect((await postReply(draft.id, "On a draft")).body).toMatchObject({
      reason: "draft",
    });
    const empty = await postReply(comment.id, "   ");
    expect(empty.status).toBe(422);
    expect(empty.body).toMatchObject({ reason: "empty" });
    expect(replies).toEqual([]);
  });
});

describe("GET /changes/:id/comments", () => {
  const list = async (query: string) => {
    const response = await api.request(
      "alice",
      "GET",
      `/api/changes/${world.change}/comments${query}`,
    );
    const json: unknown = await response.json();
    return { status: response.status, body: json };
  };

  it("lists comments only, each with its replies and the agent's answer", async () => {
    const listed = await list("");
    expect(listed.status).toBe(200);
    // The reply is only ever under its comment: a client that predates replies sees one comment.
    expect(listed.body).toEqual([
      expect.objectContaining({
        id: comment.id,
        replies: [expect.objectContaining({ id: reply.id, parentId: comment.id })],
        sentInTurn: 4,
        // The agent's turn rewrote the commented line; checkpoint 3 is the first that shows it.
        answers: [
          expect.objectContaining({
            followUpId: followUp.id,
            harness: "claude",
            turnOrdinal: 4,
            body: "Yes. A 409 now backs off like a 503.",
            outcome: "changed-code",
            changedAt: { checkpointId: "checkpoint-3", ordinal: 3 },
          }),
        ],
      }),
    ]);
    expect(listed.body).not.toEqual([expect.objectContaining({ placement: expect.anything() })]);
  });

  it("carries a comment to the lines that replaced its own on a later review", async () => {
    const listed = await list("?sliceId=slice-2-3");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        placement: {
          reviewSliceId: "slice-2-3",
          mapping: "moved",
          path: "src/retry.ts",
          side: "new",
          startLine: 31,
          endLine: 33,
          linesChanged: true,
        },
      }),
    ]);
  });

  it("refuses a slice that isn't this change's", async () => {
    expect((await list("?sliceId=slice-missing")).status).toBe(404);
  });
});
