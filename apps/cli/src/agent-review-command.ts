import { createHash, randomUUID } from "node:crypto";

import type {
  OpenReviewResult,
  ReviewDiffView,
  SessionDetail,
  WorktreeRangeDiff,
} from "@mend/api-contracts";
import {
  targetFileFor,
  type ChangePass,
  type ChangeTour,
  type Checkpoint,
  type FollowUp,
  type ReviewComment,
  type ReviewCommentTarget,
} from "@mend/domain/workbench";
import type { Schema } from "effect";

import { sessionWebUrl, type ConversationBoundary } from "./agent-conversation-command.ts";
import { CommandInputError, needsInput, type CommandResult } from "./command-result.ts";
import {
  landingSucceeded,
  parseLandArgs,
  pickSession,
  type ChangeLandingDto,
  type LandedPullRequestDto,
  type LandingReportDto,
  type PullRequestCheckDto,
} from "./landing.ts";
import { assembleReviewInstruction } from "./review-model.ts";
import { takeFlagValue } from "./shared.ts";

type Detail = Schema.Codec.Encoded<typeof SessionDetail>;
type PinnedDiff = Schema.Codec.Encoded<typeof ReviewDiffView>;
type Comment = Schema.Codec.Encoded<typeof ReviewComment>;
type FollowUpWire = Schema.Codec.Encoded<typeof FollowUp>;

const inputError = (code: string, message: string, fix: string): never => {
  throw new CommandInputError(code, message, fix);
};

const takeReviewOption = (args: ReadonlyArray<string>, flag: string) => {
  const index = args.indexOf(flag);
  return {
    value: takeFlagValue(args, flag),
    rest: index < 0 ? args : args.filter((_, at) => at !== index && at !== index + 1),
  };
};

const checkpointView = (checkpoint: Schema.Codec.Encoded<typeof Checkpoint>) => ({
  id: checkpoint.id,
  ordinal: checkpoint.ordinal,
  sha: checkpoint.sha,
  sessionId: checkpoint.sessionId,
  sealantRunId: checkpoint.sealantRunId,
  seq: checkpoint.seq,
  trigger: checkpoint.trigger,
  createdAt: checkpoint.createdAt,
  ...(checkpoint.source === undefined
    ? {}
    : {
        source: {
          kind: checkpoint.source.kind,
          captureN: checkpoint.source.captureN,
          observedAt: checkpoint.source.observedAt,
        },
      }),
});

const recordLinks = (evidence: Comment["evidence"]) =>
  evidence.map((link) => ({
    sealantRunId: link.sealantRunId,
    sequence: link.sequence,
    excerpt: link.excerpt,
  }));

const commentView = (comment: Comment) => ({
  id: comment.id,
  changeId: comment.changeId,
  file: comment.file,
  line: comment.line,
  endLine: comment.endLine,
  authorKind: comment.authorKind,
  authorName: comment.authorName,
  body: comment.body,
  kind: comment.kind,
  suggestion: comment.suggestion,
  state: comment.state,
  evidence: recordLinks(comment.evidence),
  sentToSessionId: comment.sentToSessionId,
  anchor:
    comment.anchor === null
      ? null
      : {
          reviewSliceId: comment.anchor.reviewSliceId,
          checkpointAId: comment.anchor.checkpointAId,
          checkpointBId: comment.anchor.checkpointBId,
          diffDigest: comment.anchor.diffDigest,
          oldPath: comment.anchor.oldPath,
          newPath: comment.anchor.newPath,
          side: comment.anchor.side,
          startLine: comment.anchor.startLine,
          endLine: comment.anchor.endLine,
          hunkContextHash: comment.anchor.hunkContextHash,
          mapping: comment.anchor.mapping,
        },
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
});

const sliceView = (pinned: PinnedDiff) => ({
  id: pinned.slice.id,
  checkpointAId: pinned.slice.checkpointAId,
  checkpointBId: pinned.slice.checkpointBId,
  diffDigest: pinned.slice.diffDigest,
  createdAt: pinned.slice.createdAt,
});

const changeDetail = async (
  boundary: ConversationBoundary,
  word: string,
): Promise<Detail & { readonly change: NonNullable<Detail["change"]> }> => {
  const session = await boundary.resolve(word);
  const detail = await boundary.api<Detail>("GET", `/sessions/${session.id}`);
  if (detail.change === null)
    return inputError(
      "change_not_found",
      "This session's worktree has no change yet.",
      "Wait for the session to start, then run mend change again.",
    );
  return { ...detail, change: detail.change };
};

const pinnedDiff = async (
  boundary: ConversationBoundary,
  changeId: string,
  slice: string | null,
): Promise<PinnedDiff> => {
  const id =
    slice ??
    (
      await boundary.api<Schema.Codec.Encoded<typeof OpenReviewResult>>(
        "POST",
        `/changes/${changeId}/reviews/open`,
        { idempotencyKey: `cli-agent:${randomUUID()}` },
      )
    ).slice.id;
  return boundary.api<PinnedDiff>(
    "GET",
    `/changes/${changeId}/reviews/${encodeURIComponent(id)}/diff`,
  );
};

export const changeCommand = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const { value: slice, rest } = takeReviewOption(args, "--slice");
  const words = rest.filter((word) => word !== "--json");
  const [word] = words;
  if (word === undefined || words.length !== 1)
    return needsInput("Name one session to review.", "Run mend change <session> --json.");
  const detail = await changeDetail(boundary, word);
  const changeId = detail.change.id;
  const [pinned, comments, passes, tour] = await Promise.all([
    pinnedDiff(boundary, changeId, slice),
    boundary.api<ReadonlyArray<Comment>>("GET", `/changes/${changeId}/comments`),
    boundary.api<ReadonlyArray<Schema.Codec.Encoded<typeof ChangePass>>>(
      "GET",
      `/changes/${changeId}/passes`,
    ),
    boundary.api<Schema.Codec.Encoded<typeof ChangeTour> | null>(
      "GET",
      `/changes/${changeId}/tour`,
    ),
  ]);
  return {
    status: "done",
    data: {
      sessionId: detail.session.id,
      changeId,
      worktreeId: detail.change.worktreeId,
      branch: detail.change.branch,
      url: sessionWebUrl(boundary.url, detail.session.id),
      slice: sliceView(pinned),
      checkpointA: checkpointView(pinned.checkpointA),
      checkpointB: checkpointView(pinned.checkpointB),
      checkpoints: [
        ...new Map(
          [...detail.checkpoints, pinned.checkpointA, pinned.checkpointB].map((checkpoint) => [
            checkpoint.id,
            checkpoint,
          ]),
        ).values(),
      ]
        .toSorted((a, b) => a.ordinal - b.ordinal)
        .map(checkpointView),
      files: pinned.files.map((file) => ({
        oldPath: file.oldPath,
        newPath: file.newPath,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        binary: file.binary,
      })),
      stats: {
        files: pinned.files.length,
        additions: pinned.files.reduce((n, file) => n + file.additions, 0),
        deletions: pinned.files.reduce((n, file) => n + file.deletions, 0),
      },
      worktreeChangedSinceSnapshot: pinned.worktreeChangedSinceSnapshot,
      outsideGit: pinned.outsideGit ?? null,
      comments: comments.map(commentView),
      passes: passes.map((pass) => ({
        kind: pass.kind,
        status: pass.status,
        detail: pass.detail,
        findings: pass.findings,
        startedAt: pass.startedAt,
        finishedAt: pass.finishedAt,
      })),
      tour:
        tour === null
          ? null
          : {
              summary: tour.summary,
              approach: tour.approach,
              diffDigest: tour.diffDigest,
              matchesSlice: tour.diffDigest === pinned.slice.diffDigest,
              createdAt: tour.createdAt,
              stops: tour.stops.map((stop) => ({
                title: stop.title,
                file: stop.file,
                line: stop.line,
                endLine: stop.endLine,
                narration: stop.narration,
                grounded: stop.grounded,
                evidence: recordLinks(stop.evidence),
              })),
            },
    },
  };
};

export const diffCommand = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<{ readonly patch: string; readonly [key: string]: unknown }>> => {
  const from = takeReviewOption(args, "--from");
  const to = takeReviewOption(from.rest, "--to");
  const slice = takeReviewOption(to.rest, "--slice");
  const words = slice.rest.filter((word) => word !== "--json");
  const [word] = words;
  if (word === undefined || words.length !== 1)
    return needsInput(
      "Name one session for the diff.",
      "Run mend diff <session> [--from <checkpoint>] [--to <checkpoint>] [--json].",
    );
  if (slice.value !== null && (from.value !== null || to.value !== null))
    return needsInput(
      "Choose a review slice or checkpoint endpoints.",
      "Use --slice <id>, or --from/--to.",
    );
  const detail = await changeDetail(boundary, word);
  const pinned =
    to.value === null ? await pinnedDiff(boundary, detail.change.id, slice.value) : null;
  if (from.value !== null || to.value !== null) {
    const endpoint = (id: string) =>
      detail.checkpoints.find((checkpoint) => checkpoint.id === id) ??
      (pinned?.checkpointB.id === id ? pinned.checkpointB : undefined);
    const end = to.value ?? pinned?.checkpointB.id;
    if (
      end === undefined ||
      endpoint(end) === undefined ||
      (from.value !== null && endpoint(from.value) === undefined)
    )
      return needsInput(
        "A checkpoint does not belong to this worktree.",
        "Read mend change <session> --json and pass full checkpoint ids from its chain.",
      );
    const query = new URLSearchParams({ to: end });
    if (from.value !== null) query.set("from", from.value);
    const range = await boundary.api<Schema.Codec.Encoded<typeof WorktreeRangeDiff>>(
      "GET",
      `/worktrees/${detail.change.worktreeId}/diff?${query}`,
    );
    return {
      status: "done",
      data: {
        sessionId: detail.session.id,
        changeId: detail.change.id,
        worktreeId: range.worktreeId,
        from: range.from === null ? null : checkpointView(range.from),
        to: checkpointView(range.to),
        fromSha: range.fromSha,
        patch: range.diff,
        files: range.files.map((file) => ({
          oldPath: file.oldPath,
          newPath: file.newPath,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          binary: file.binary,
        })),
        truncated: range.truncated,
        omitted: range.omitted,
        listingCut: range.listingCut,
      },
    };
  }
  if (pinned === null)
    return needsInput("The review slice is missing.", "Run mend change <session> --json first.");
  return {
    status: "done",
    data: {
      sessionId: detail.session.id,
      changeId: detail.change.id,
      slice: sliceView(pinned),
      checkpointA: checkpointView(pinned.checkpointA),
      checkpointB: checkpointView(pinned.checkpointB),
      patch: pinned.patch,
      worktreeChangedSinceSnapshot: pinned.worktreeChangedSinceSnapshot,
      outsideGit: pinned.outsideGit ?? null,
    },
  };
};

const commentTarget = (
  pinned: PinnedDiff,
  location: string,
  side: "old" | "new",
): ReviewCommentTarget => {
  const empty = {
    oldPath: null,
    newPath: null,
    side: null,
    startLine: null,
    endLine: null,
    hunkContextHash: null,
  };
  if (location === "--change") return empty;
  const parts = /^(.*):(\d+)(?:-(\d+))?$/.exec(location);
  const path = parts?.[1] ?? location;
  const startLine = parts === null ? null : Number(parts[2]);
  const endLine = parts === null ? null : Number(parts[3] ?? parts[2]);
  const file = targetFileFor(pinned.anchorFiles, path, startLine === null ? null : side);
  if (file === undefined)
    return inputError(
      "comment_target_not_found",
      `The pinned slice has no file "${path}" on this side.`,
      "Read mend diff with the same --slice; for removed lines pass --side old.",
    );
  if (startLine === null || endLine === null)
    return { ...empty, oldPath: file.oldPath, newPath: file.newPath };
  const hunk = file.hunks.find((candidate) => {
    const first = side === "old" ? candidate.oldStart : candidate.newStart;
    const count = side === "old" ? candidate.oldLines : candidate.newLines;
    return (
      count > 0 &&
      startLine >= first &&
      endLine < first + count &&
      endLine >= startLine &&
      startLine > 0
    );
  });
  if (hunk === undefined)
    return inputError(
      "comment_target_not_found",
      "These lines are outside a hunk in the pinned slice.",
      "Choose lines from mend diff with the same --slice, or comment on the file without a line number.",
    );
  return {
    oldPath: file.oldPath,
    newPath: file.newPath,
    side,
    startLine,
    endLine,
    hunkContextHash: hunk.contextHash,
  };
};

export const commentAdd = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const slice = takeReviewOption(args, "--slice");
  const side = takeReviewOption(slice.rest, "--side");
  const words = side.rest.filter((word) => word !== "--json");
  const [word, location, text] = words;
  if (word === undefined || location === undefined || text === undefined || words.length !== 3)
    return needsInput(
      "Name a session, file[:line[-end]] or --change, and comment text.",
      'Run mend comment add <session> src/auth.ts:42 "Comment" --json; use - for text from stdin.',
    );
  if (side.value !== null && side.value !== "old" && side.value !== "new")
    return needsInput("The comment side must be old or new.", "Pass --side old or --side new.");
  const body = text === "-" ? await boundary.readStdin() : text;
  if (body.trim() === "")
    return needsInput(
      "The comment is empty.",
      "Pass a nonempty comment or pipe text through stdin with -.",
    );
  const detail = await changeDetail(boundary, word);
  const pinned = await pinnedDiff(boundary, detail.change.id, slice.value);
  const target = commentTarget(pinned, location, side.value === "old" ? "old" : "new");
  const comment = await boundary.api<Comment>(
    "POST",
    `/changes/${detail.change.id}/reviews/${pinned.slice.id}/comments`,
    { target, body },
  );
  return {
    status: "done",
    data: { sessionId: detail.session.id, slice: sliceView(pinned), comment: commentView(comment) },
  };
};

export const commentSend = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const slice = takeReviewOption(args, "--slice");
  const words = slice.rest.filter((word) => word !== "--json");
  const [word] = words;
  if (word === undefined || words.length !== 1)
    return needsInput(
      "Name one session to receive the comments.",
      "Run mend comment send <session> --json.",
    );
  const detail = await changeDetail(boundary, word);
  const route = `/sessions/${detail.session.id}/follow-up`;
  const pending = await boundary.api<FollowUpWire | null>("GET", route);
  let input;
  if (pending !== null && ["pending", "delivering", "delivery_failed"].includes(pending.status)) {
    if (
      pending.reviewSliceId === null ||
      pending.checkpointAId === null ||
      pending.checkpointBId === null ||
      pending.diffDigest === null ||
      pending.idempotencyKey === null
    )
      return needsInput(
        "The saved follow-up predates pinned reviews.",
        "Prepare a new review bundle in Mend's review page.",
      );
    if (slice.value !== null && slice.value !== pending.reviewSliceId)
      return needsInput(
        "Another slice already has a pending delivery.",
        "Retry without --slice to reconcile that delivery before sending another bundle.",
      );
    input = {
      reviewSliceId: pending.reviewSliceId,
      checkpointAId: pending.checkpointAId,
      checkpointBId: pending.checkpointBId,
      diffDigest: pending.diffDigest,
      commentIds: pending.commentIds,
      instruction: pending.instruction,
      idempotencyKey: pending.idempotencyKey,
    };
  } else {
    const comments = await boundary.api<ReadonlyArray<Comment>>(
      "GET",
      `/changes/${detail.change.id}/comments`,
    );
    const selected = comments.filter(
      (comment) => comment.state === "open" && comment.sentToSessionId === null,
    );
    if (selected.length === 0)
      return needsInput(
        "There are no unsent open comments.",
        "Add the person's remarks with mend comment add first. Draft findings need the person's review in Mend.",
      );
    const pinned = await pinnedDiff(boundary, detail.change.id, slice.value);
    const instruction = assembleReviewInstruction(detail.change, selected);
    const commentIds = selected.map((comment) => comment.id).toSorted();
    const key = createHash("sha256")
      .update(JSON.stringify([detail.session.id, pinned.slice.id, commentIds, instruction]))
      .digest("hex");
    input = {
      reviewSliceId: pinned.slice.id,
      checkpointAId: pinned.checkpointA.id,
      checkpointBId: pinned.checkpointB.id,
      diffDigest: pinned.slice.diffDigest,
      commentIds,
      instruction,
      idempotencyKey: `cli-review-send:${key}`,
    };
  }
  const sent = await boundary.api<FollowUpWire>("POST", `${route}/deliver`, input);
  const data = {
    sessionId: detail.session.id,
    followUpId: sent.id,
    status: sent.status,
    reviewSliceId: sent.reviewSliceId,
    commentIds: sent.commentIds,
    requestKey: sent.idempotencyKey,
    processId: sent.deliveryProcessId,
    sealantRunId: sent.deliverySealantRunId,
    deliveredAt: sent.deliveredAt,
    url: sessionWebUrl(boundary.url, detail.session.id),
  };
  if (sent.status === "delivered") return { status: "done", data };
  return {
    status: "failed",
    data,
    error: {
      code: "follow_up_unconfirmed",
      message: sent.deliveryError ?? `Follow-up delivery is ${sent.status}.`,
      fix: "Run mend comment send again to reconcile the same saved bundle and request key. It will not attach or create a second run.",
    },
  };
};

const pullRequestView = (pr: LandedPullRequestDto | null) =>
  pr === null
    ? null
    : { number: pr.number, url: pr.url, state: pr.state, observedAt: pr.observedAt };

const landingView = (landing: ChangeLandingDto) => ({
  remoteBranch: landing.remoteBranch,
  pushedSha: landing.pushedSha,
  commitSha: landing.commitSha,
  checkpointSha: landing.checkpointSha,
  outcome: landing.outcome,
  message: landing.message,
  pullRequest: pullRequestView(landing.pullRequest),
});

export const landJson = async (
  boundary: ConversationBoundary,
  args: ReadonlyArray<string>,
): Promise<CommandResult<unknown>> => {
  const parsed = parseLandArgs(args.filter((word) => word !== "--json"));
  if ("error" in parsed)
    return needsInput(parsed.error, "Run mend help land and pass one explicit session.");
  let word = parsed.args.session;
  if (parsed.args.project !== null) {
    const projects = await boundary.api<
      ReadonlyArray<{ readonly id: string; readonly name: string }>
    >("GET", "/projects");
    const project = projects.find(
      (candidate) => candidate.id === parsed.args.project || candidate.name === parsed.args.project,
    );
    if (project === undefined)
      return inputError(
        "project_not_found",
        `No adopted project has the id or name "${parsed.args.project}".`,
        "Run mend projects and choose an existing project.",
      );
    const scope = await boundary.api<{
      readonly sessions: ReadonlyArray<{
        readonly id: string;
        readonly projectId: string;
        readonly harness: string;
        readonly label: string | null;
        readonly worktree: string;
        readonly branch: string;
        readonly createdAt: string;
      }>;
    }>("GET", `/projects/${project.id}?deadEnds=include`);
    const picked = pickSession(scope.sessions, word);
    if ("error" in picked)
      return inputError(
        "session_unresolved",
        picked.error,
        "Pass a full session id from the selected project.",
      );
    word = picked.session.id;
  }
  const detail = await changeDetail(boundary, word);
  if (parsed.args.check) {
    const check = await boundary.api<PullRequestCheckDto>(
      "POST",
      `/changes/${detail.change.id}/pull-request/check`,
    );
    return {
      status: "done",
      data: {
        sessionId: detail.session.id,
        changeId: detail.change.id,
        outcome: check.outcome,
        reason: check.reason,
        landing: check.landing === null ? null : landingView(check.landing),
      },
    };
  }
  const report = await boundary.api<LandingReportDto>(
    "POST",
    `/sessions/${detail.session.id}/land`,
    {
      branch: parsed.args.branch,
      pullRequest: parsed.args.pullRequest,
      title: parsed.args.title,
      body: null,
    },
  );
  const landing = report.landing;
  const data = {
    sessionId: detail.session.id,
    changeId: detail.change.id,
    landing: landingView(landing),
    pullRequest:
      report.pullRequest._tag === "opened" || report.pullRequest._tag === "updated"
        ? {
            status: report.pullRequest._tag,
            pullRequest: pullRequestView(report.pullRequest.pullRequest),
          }
        : report.pullRequest._tag === "unavailable"
          ? { status: "unavailable", reason: report.pullRequest.reason }
          : report.pullRequest._tag === "failed"
            ? { status: "failed", message: report.pullRequest.message }
            : { status: report.pullRequest._tag },
  };
  return landingSucceeded(report) && report.pullRequest._tag !== "failed"
    ? { status: "done", data }
    : {
        status: "failed",
        data,
        error: {
          code: "landing_failed",
          message:
            report.pullRequest._tag === "failed"
              ? report.pullRequest.message
              : (landing.message ?? "Mend did not push the change."),
          fix: "Address the reported refusal. Use mend git check --json for transport failures, then retry mend land.",
        },
      };
};
