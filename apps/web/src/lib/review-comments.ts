import {
  canRelaunchSession,
  noReviewFollowUpLine,
  takesReviewFollowUp,
  terminalOwnerOnlyLine,
} from "@mend/domain/workbench";

import type {
  ChangePassDto,
  FollowUpDto,
  ReviewCommentDto,
  ReviewDiffFileDto,
  SessionDetailDto,
} from "./api.ts";

/**
 * The rules behind comments on a change and sending them to the agent (route PR 24): which comment
 * sits where, what each says about itself, what a person can do to it, and the one message the
 * agent receives. What was observed, never a verdict: a comment is open, sent, resolved or
 * dismissed, and Mend's drafts are drafts until a person adds them.
 */

/** "12" or "12–18": one label for a line and a range. */
export const lineLabel = (line: number | null, endLine: number | null): string | null =>
  line === null ? null : endLine === null || endLine === line ? `${line}` : `${line}–${endLine}`;

/** "line 31", "lines 37–40". */
export const linesWords = (line: number | null, endLine: number | null): string | null => {
  const label = lineLabel(line, endLine);
  if (label === null) return null;
  return endLine === null || endLine === line ? `line ${label}` : `lines ${label}`;
};

const baseName = (path: string): string => path.split("/").at(-1) ?? path;

/** Where a comment sits, short, for a list: "retry.ts:31", "retry.ts", "Whole change". */
export const placeWords = (comment: ReviewCommentDto): string => {
  if (comment.file === null) return "Whole change";
  const label = lineLabel(comment.line, comment.endLine);
  return label === null ? baseName(comment.file) : `${baseName(comment.file)}:${label}`;
};

/** Where a comment sits, for the agent and the Your review list: "retry.ts line 31". */
export const placeLongWords = (comment: ReviewCommentDto): string => {
  if (comment.file === null) return "Whole change";
  const lines = linesWords(comment.line, comment.endLine);
  return lines === null ? baseName(comment.file) : `${baseName(comment.file)} ${lines}`;
};

/** A draft Mend wrote and nobody has added or dismissed yet. */
export const isDraft = (comment: ReviewCommentDto): boolean =>
  comment.authorKind === "mend" && comment.state === "draft";

/** A draft of Mend's a person dismissed, or removed after adding it. */
export const isDismissedDraft = (comment: ReviewCommentDto): boolean =>
  comment.authorKind === "mend" &&
  comment.state === "dismissed" &&
  comment.sentToSessionId === null;

/** Open and not sent yet: what Send sends. */
export const isUnsent = (comment: ReviewCommentDto): boolean =>
  comment.state === "open" && comment.sentToSessionId === null;

/** The column's three lists: the comments, Mend's drafts, and the drafts dismissed. */
export interface CommentGroups {
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly drafts: ReadonlyArray<ReviewCommentDto>;
  readonly dismissedDrafts: ReadonlyArray<ReviewCommentDto>;
  /** Open and not sent, in the order they were written. */
  readonly unsent: ReadonlyArray<ReviewCommentDto>;
}

const byCreated = (a: ReviewCommentDto, b: ReviewCommentDto) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

export const commentGroups = (all: ReadonlyArray<ReviewCommentDto>): CommentGroups => {
  const sorted = all.toSorted(byCreated);
  return {
    comments: sorted.filter((comment) => !isDraft(comment) && !isDismissedDraft(comment)),
    drafts: sorted.filter(isDraft),
    dismissedDrafts: sorted.filter(isDismissedDraft),
    unsent: sorted.filter(isUnsent),
  };
};

/** What a comment says about itself after its author's name: "Not sent", "Sent", "Resolved". */
export const stateWords = (comment: ReviewCommentDto): string => {
  if (comment.state === "draft") return "Draft";
  if (comment.state === "addressed") return "Resolved";
  if (comment.state === "dismissed") return "Dismissed";
  return comment.sentToSessionId === null ? "Not sent" : "Sent";
};

/** The state a comment can be moved to, and the word on its button. */
export interface StateAction {
  readonly state: "open" | "addressed" | "dismissed";
  readonly label: string;
}

/**
 * What a person can do to a comment: add or dismiss Mend's draft; resolve or dismiss an open
 * comment (Remove for one added from Mend's draft, which goes back among the dismissed drafts); and
 * reopen one resolved or dismissed. A sent comment is resolved by its outcome, so it keeps Resolve.
 */
export const stateActions = (comment: ReviewCommentDto): ReadonlyArray<StateAction> => {
  if (comment.state === "draft")
    return [
      { state: "open", label: "Add to comments" },
      { state: "dismissed", label: "Dismiss" },
    ];
  if (comment.state === "open") {
    if (comment.sentToSessionId !== null) return [{ state: "addressed", label: "Resolve" }];
    return comment.authorKind === "mend"
      ? [
          { state: "addressed", label: "Resolve" },
          { state: "dismissed", label: "Remove" },
        ]
      : [
          { state: "addressed", label: "Resolve" },
          { state: "dismissed", label: "Dismiss" },
        ];
  }
  return [{ state: "open", label: "Reopen" }];
};

/** `count` with the noun in the right number: "1 comment", "2 comments". */
export const countWords = (count: number, one: string, many: string): string =>
  `${count.toLocaleString("en")} ${count === 1 ? one : many}`;

/**
 * The message the agent receives: the comments in order, each with where it sits, and how to treat
 * them. The person can edit it before it goes (Choose and edit); what goes is what the agent reads.
 */
export const assembleInstruction = (
  branch: string,
  comments: ReadonlyArray<ReviewCommentDto>,
): string => {
  const points = comments
    .map((comment, index) => {
      const anchor =
        comment.file === null
          ? "the change as a whole"
          : `${comment.file}${comment.line === null ? "" : `:${lineLabel(comment.line, comment.endLine)?.replace("–", "-")}`}`;
      const proposal =
        comment.suggestion === null
          ? ""
          : `\n   Proposed replacement:\n${comment.suggestion
              .split("\n")
              .map((line) => `   ${line}`)
              .join("\n")}`;
      return `${index + 1}. ${anchor} — ${comment.body}${proposal}`;
    })
    .join("\n");
  return `This is a follow-up on your earlier work in this worktree, responding to review feedback. The branch ${branch} is already checked out with your work on it: keep working there, and do not start a new branch or reset it.

Review comments:
${points}

Address each point using your own judgment about how. Check your work with the repository's own build, tests, or typecheck; a check that still fails is something to report, not to force green. Report honestly what you changed and what you did not — if a point cannot or should not be done, say so plainly.`;
};

/** Where a new line comment anchors: lines on the new side, inside one changed part of a file. */
export interface LineAnchor {
  readonly file: string;
  readonly line: number;
  readonly endLine: number | null;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly hunkContextHash: string;
}

/**
 * The anchor for lines `line` to `endLine` (null for one line) of `file`, or null when they are
 * not inside one changed part of it: the server pins a comment to its hunk.
 */
/** What anchoring reads of a review's file: its paths and where its changed parts are. */
export type AnchorFile = Pick<ReviewDiffFileDto, "oldPath" | "newPath"> & {
  readonly hunks: ReadonlyArray<
    Pick<ReviewDiffFileDto["hunks"][number], "newStart" | "newLines" | "contextHash">
  >;
};

export const anchorFor = (
  files: ReadonlyArray<AnchorFile>,
  file: string,
  line: number,
  endLine: number | null,
): LineAnchor | null => {
  const reviewFile = files.find((each) => (each.newPath ?? each.oldPath) === file);
  if (reviewFile === undefined) return null;
  const last = endLine ?? line;
  const hunk = reviewFile.hunks.find(
    (candidate) =>
      candidate.newLines > 0 &&
      line >= candidate.newStart &&
      last <= candidate.newStart + candidate.newLines - 1,
  );
  if (hunk === undefined) return null;
  return {
    file,
    line,
    endLine: endLine === null || endLine === line ? null : endLine,
    oldPath: reviewFile.oldPath,
    newPath: reviewFile.newPath,
    hunkContextHash: hunk.contextHash,
  };
};

/** The part of a draft key that names where a comment goes. */
export const anchorKey = (anchor: LineAnchor): string =>
  `${anchor.file}:${anchor.line}-${anchor.endLine ?? anchor.line}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** A stored open composer, read back; anything not shaped like an anchor is none. */
export const parseAnchor = (stored: string): LineAnchor | null => {
  if (stored === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { file, line, endLine, oldPath, newPath, hunkContextHash } = value;
  if (typeof file !== "string" || typeof line !== "number") return null;
  if (!(endLine === null || typeof endLine === "number")) return null;
  if (!nullableString(oldPath) || !nullableString(newPath)) return null;
  if (typeof hunkContextHash !== "string") return null;
  return { file, line, endLine, oldPath, newPath, hunkContextHash };
};

/** Who may send comments to the session, and the words for everyone else. */
export type SendRule = { readonly can: true } | { readonly can: false; readonly why: string };

/**
 * Who sends: anyone who steers the session, when its harness takes a follow-up. Sending to an
 * agent that runs in a terminal starts it with the comments, which is typing there: its owner's
 * alone, even while control is shared (docs/adr/0013).
 */
export const sendRuleOf = (
  detail: {
    readonly control: Pick<SessionDetailDto["control"], "steer" | "terminalInput">;
    readonly currentAgent: { readonly kind: string } | null;
    readonly session: Pick<SessionDetailDto["session"], "harness">;
  },
  ownerName: string | null,
): SendRule => {
  if (!detail.control.steer)
    return {
      can: false,
      why: "Comments stay here. Only the session's owner sends them, unless they share control.",
    };
  if (!takesReviewFollowUp(detail.session.harness))
    return {
      can: false,
      why: `Comments stay here. ${noReviewFollowUpLine(detail.session.harness)}`,
    };
  if (!canRelaunchSession(detail.control, detail.currentAgent?.kind ?? null))
    return {
      can: false,
      why: `Comments stay here. ${terminalOwnerOnlyLine(ownerName ?? "its owner", "send-back")}`,
    };
  return { can: true };
};

/**
 * Where a send stands, for the band under the toolbar: nothing; saved and waiting for a terminal
 * agent to stop; delivery under way; or not sent, with the reason when Mend has one.
 */
export type Delivery<F = FollowUpDto> =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly followUp: F }
  | { readonly kind: "delivering"; readonly followUp: F }
  | { readonly kind: "failed"; readonly followUp: F | null; readonly reason: string | null };

/**
 * The send's state from the server's active follow-up for the session and, when the last attempt
 * from this page failed before the server answered, that failure. A follow-up of another change is
 * not this view's.
 */
export const deliveryOf = <
  F extends Pick<FollowUpDto, "changeId" | "status" | "deliveryError"> = FollowUpDto,
>(
  active: F | null,
  changeId: string,
  failure: string | null,
): Delivery<F> => {
  const own = active !== null && active.changeId === changeId ? active : null;
  if (failure !== null) return { kind: "failed", followUp: own, reason: failure };
  if (own === null) return { kind: "none" };
  switch (own.status) {
    case "pending":
      return { kind: "pending", followUp: own };
    case "delivering":
      return { kind: "delivering", followUp: own };
    case "delivery_failed":
      return { kind: "failed", followUp: own, reason: own.deliveryError };
    default:
      return { kind: "none" };
  }
};

/** The comments a follow-up holds, in the order they were written. */
export const commentsOf = (
  followUp: FollowUpDto,
  all: ReadonlyArray<ReviewCommentDto>,
): ReadonlyArray<ReviewCommentDto> => {
  const ids = new Set(followUp.commentIds);
  return all.filter((comment) => ids.has(comment.id));
};

/**
 * The toolbar's note: what happens to comments, said once. "Click a line to comment…" before
 * any; "Your comments stay here until you send them." while some wait; after a send, how many are
 * resolved and open.
 */
export const toolbarNoteWords = (
  agent: string,
  groups: CommentGroups,
  finished: boolean,
): string => {
  if (groups.unsent.length > 0)
    return finished
      ? `${agent} has finished, so it starts on your comments as soon as you send them.`
      : "Your comments stay here until you send them.";
  const sent = groups.comments.filter((comment) => comment.sentToSessionId !== null);
  if (sent.length > 0) {
    const resolved = sent.filter((comment) => comment.state === "addressed").length;
    const open = sent.filter((comment) => comment.state === "open").length;
    return `${countWords(resolved, "comment", "comments")} resolved, ${open.toLocaleString("en")} open.`;
  }
  return `Click a line to comment. ${agent} gets your comments when you send them.`;
};

/** The newest pass of one kind, or null when none ran. */
export const passOf = <P extends Pick<ChangePassDto, "kind">>(
  passes: ReadonlyArray<P>,
  kind: ChangePassDto["kind"],
): P | null => passes.find((pass) => pass.kind === kind) ?? null;

/** What the pass lines read of a pass. */
export type PassFacts = Pick<
  ChangePassDto,
  "status" | "detail" | "findings" | "startedAt" | "finishedAt"
>;

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export const agoWords = (at: Date, now: Date): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
};

const RUNNING = new Set(["queued", "running"]);

/** Whether a pass is queued or running now. */
export const passBusy = (pass: PassFacts | null): boolean =>
  pass !== null && RUNNING.has(pass.status);

/**
 * What Mend's reading and suggesting passes did, under its drafts: "Mend read the change 3 min ago
 * and drafted 1 comment." Completed with nothing and never ran must not read the same. Null when
 * neither ran.
 */
export const passWords = (
  read: PassFacts | null,
  suggest: PassFacts | null,
  now: Date,
): ReadonlyArray<{ readonly text: string; readonly failed: boolean }> => {
  const line = (
    pass: PassFacts | null,
    doing: string,
    running: string,
    done: string,
    noun: string,
  ) => {
    if (pass === null) return null;
    const at = new Date(pass.finishedAt ?? pass.startedAt);
    switch (pass.status) {
      case "queued":
        return { text: `Mend is waiting to ${doing}.`, failed: false };
      case "running":
        return { text: `Mend is ${running}…`, failed: false };
      case "failed":
        return {
          text: `Mend couldn't ${doing} (${agoWords(at, now)}).${pass.detail === null ? "" : ` ${pass.detail.slice(0, 200)}`}`,
          failed: true,
        };
      default: {
        const found = pass.findings ?? 0;
        return {
          text:
            found === 0
              ? `Mend ${done} ${agoWords(at, now)} and drafted nothing.`
              : `Mend ${done} ${agoWords(at, now)} and drafted ${countWords(found, noun, `${noun}s`)}.`,
          failed: false,
        };
      }
    }
  };
  return [
    line(read, "read the change", "reading the change", "read the change", "comment"),
    line(suggest, "suggest fixes", "looking for fixes", "looked for fixes", "fix"),
  ].filter((each) => each !== null);
};
