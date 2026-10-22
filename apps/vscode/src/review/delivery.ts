import type { PostAttempt } from "./comment-target.js";
import type { Instruction } from "./instruction.js";
import { inputAfter, planFor, type PastePlan, type TerminalInput } from "./paste-plan.js";
import {
  KEPT_SENDS,
  rewritten,
  type AcceptedComment,
  type PendingComment,
  type SessionReview,
} from "./pending.js";

/**
 * Sending a review back (story d, step 6), as a pure state machine. Her pending comments move into
 * one send record, are posted to Mend (that route takes no idempotency key, so a post in flight is
 * reconciled before it is made again), and then the follow-up is delivered with one idempotency
 * key kept in the record: a retry sends the same key and the same text. Nothing here, and nothing
 * that reads Mend, ever delivers a key again on its own: Mend holds a terminal agent's follow-up
 * `pending` and nothing flushes it, so it is delivered again only when she asks, once the agent is
 * gone (the route then launches the session on the review). A record is `delivered` only once Mend
 * reads its comments back as sent to the session.
 */

/** Where one of her own comments is on its way to Mend. */
export type PostState =
  | { readonly kind: "unposted" }
  | ({ readonly kind: "posting" } & PostAttempt)
  | { readonly kind: "posted"; readonly commentId: string };

/**
 * Where the Mend draft her posted words replace is: to dismiss, dismissed (or gone), or left on
 * Mend because the dismissal failed, with why. A draft left never holds the review back.
 */
export type DraftDismissal =
  | { readonly kind: "due" }
  | { readonly kind: "dismissed" }
  | { readonly kind: "left"; readonly words: string };

/** One comment of the review she sends. */
export type SendItem =
  | { readonly kind: "own"; readonly pending: PendingComment; readonly post: PostState }
  /**
   * Her words in place of a Mend draft she accepted (`pending.origin` names it): posted as hers,
   * then the draft is dismissed, if still a draft.
   */
  | {
      readonly kind: "rewrite";
      readonly pending: AcceptedComment;
      readonly post: PostState;
      readonly dismissal: DraftDismissal;
    }
  /** A Mend draft she accepted: Send opens it on Mend, then sends it. */
  | {
      readonly kind: "accepted";
      readonly pending: PendingComment;
      readonly draftId: string;
      readonly opened: boolean;
    }
  /** Open on Mend and not sent: accepted or written elsewhere. */
  | { readonly kind: "open"; readonly commentId: string };

/** Where the follow-up is. */
export type SendPhase =
  | { readonly kind: "sending"; readonly since: string }
  /** A stopped session is being launched on the review (the route resumes it). */
  | { readonly kind: "delivering" }
  /**
   * G12 fallback: Mend holds it pending while the terminal agent lives, and the extension pastes it
   * into that one agent process, never another.
   */
  | {
      readonly kind: "in-terminal";
      readonly agent: string;
      readonly processId: string;
      readonly paste: PasteStep;
    }
  /** Mend holds it pending, and this window had no terminal of hers to paste it into. */
  | { readonly kind: "pending" }
  | { readonly kind: "delivered"; readonly at: string }
  | { readonly kind: "failed"; readonly words: string; readonly at: string }
  /** Mend refused this key or this person: a new review, with a new key, is the way on. */
  | { readonly kind: "refused"; readonly words: string };

/** The paste step of a review Mend holds pending in her agent's terminal. */
export type PasteStep =
  | { readonly kind: "due" }
  | { readonly kind: "pasting" }
  /** Pasted, or nothing to paste and she was told why: what VS Code pasted into the agent's input. */
  | { readonly kind: "done"; readonly input: TerminalInput }
  /** Not pasted, or cut short; `stopped` is why the drive stopped, when it did, as it stopped. */
  | {
      readonly kind: "failed";
      readonly mayHaveLanded: boolean;
      readonly stopped: StopReason | null;
    };

/**
 * Why a drive stopped before the send moved on: VS Code closed (as a window that finds it left
 * reads it), VS Code connected to another server or account, VS Code was signed out, or a failure
 * in its own words.
 */
export type StopReason =
  | { readonly kind: "closed" }
  | { readonly kind: "switched" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "error"; readonly words: string };

/** What VS Code did when a drive stopped. */
export const stopWords = (why: StopReason): string => {
  switch (why.kind) {
    case "closed":
      return "VS Code closed";
    case "switched":
      return "VS Code connected to another Mend server or account";
    case "signed-out":
      return "VS Code was signed out of Mend";
    case "error":
      return why.words;
  }
};

/** What VS Code did when a drive stopped, before `when`; a failure says itself in its own words. */
const stopClause = (why: StopReason, when: string): string =>
  why.kind === "error" ? why.words : `${stopWords(why)} ${when}`;

/** A paste that may have reached the agent's input, in part or whole, and why it stopped. */
export const cutShortWords = (why: string, agent: string): string =>
  `${why}, so some or all of it may be in ${agent}'s input. Mend holds the follow-up pending: check ${agent}'s input before Retry delivery pastes it again.`;

export interface SendSlice {
  readonly id: string;
  readonly baseId: string;
  readonly headId: string;
  readonly diffDigest: string;
}

/**
 * Something a send leaves her to know, kept with it as the step that found it wrote it: every
 * window reads the same notice, and the one she looks at says it once, claimed by the send's key,
 * the notice's kind and when it was written. A failed delivery says itself from its phase.
 */
export interface SendNotice {
  readonly kind: "paste" | "draft-gone" | "draft-left" | "refused";
  readonly at: string;
  readonly words: string;
  readonly tone: "error" | "warning";
  /** It offers Retry delivery, while the send still waits on her. */
  readonly retry: boolean;
  /** It offers the review's own words, for a review that stopped before Mend sent it. */
  readonly text: boolean;
}

/** How many notices a send keeps, the newest. */
export const KEPT_NOTICES = 8;

export interface SendRecord {
  /** The follow-up's idempotency key: the same on every retry. */
  readonly key: string;
  readonly sliceId: string;
  readonly baseId: string;
  readonly headId: string;
  readonly diffDigest: string;
  /** The text Mend sends, exactly as she sent it. */
  readonly instruction: string;
  readonly paste: PastePlan;
  readonly items: ReadonlyArray<SendItem>;
  readonly phase: SendPhase;
  readonly notices: ReadonlyArray<SendNotice>;
  readonly createdAt: string;
}

/** What a live agent is, for where a pending follow-up lands. */
export type LiveAgent =
  | {
      readonly kind: "terminal";
      readonly name: string;
      readonly hers: boolean;
      /** The agent's process: a paste goes into this one, never into a shell beside it. */
      readonly processId: string;
    }
  | { readonly kind: "other" };

/** What Mend answered `follow-up/deliver` (or `GET …/follow-up`) about this key. */
export type FollowUpStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "delivery_failed"
  | "superseded";

/**
 * What Mend reads about one key: `GET …/follow-up` lists only the newest follow-up not yet
 * delivered, so `status` is ours when it is listed, and `sent` is whether Mend reads every comment
 * of the review back as sent to the session, the only proof it was delivered.
 */
export interface FollowUpRead {
  readonly status: FollowUpStatus | null;
  readonly error: string | null;
  /** Another follow-up of the session is listed: a newer one of hers, or ours still on its way. */
  readonly others: boolean;
  readonly sent: boolean;
}

export type SendEvent =
  | { readonly kind: "post-started"; readonly pendingId: string; readonly attempt: PostAttempt }
  | { readonly kind: "posted"; readonly pendingId: string; readonly commentId: string }
  /** The reconcile read found nothing posted for this comment: it is posted again. */
  | { readonly kind: "not-posted"; readonly pendingId: string }
  | { readonly kind: "opened"; readonly draftId: string }
  /** The draft her posted words replace reads dismissed on Mend, or is gone. */
  | { readonly kind: "draft-dismissed"; readonly draftId: string }
  /** VS Code could not dismiss the draft her posted words replace: it stays on Mend. */
  | { readonly kind: "draft-left"; readonly draftId: string; readonly words: string }
  /** The draft she accepted is dismissed on Mend, or gone: it leaves the review, never reopened. */
  | { readonly kind: "draft-gone"; readonly draftId: string }
  /** A newer review of hers reached Mend, which supersedes every follow-up it held before. */
  | { readonly kind: "superseded" }
  | {
      readonly kind: "answered";
      readonly status: FollowUpStatus;
      readonly error: string | null;
      readonly agent: LiveAgent;
    }
  | { readonly kind: "paste-started" }
  /** The paste was refused before anything reached the terminal: it is due again. */
  | { readonly kind: "paste-unstarted" }
  /** The paste reached the agent's input. */
  | { readonly kind: "pasted" }
  /** Nothing was pasted, and `words` tell her why: the input holds what it held. */
  | { readonly kind: "skipped"; readonly words: string }
  | { readonly kind: "paste-failed"; readonly why: "agent-gone" | "not-attached" }
  /** The paste threw while it pasted, for `words`: some or all of it may be in the input. */
  | { readonly kind: "paste-failed"; readonly why: "interrupted"; readonly words: string }
  | { readonly kind: "failed"; readonly words: string; readonly retryable: boolean }
  /**
   * Retry delivery, with everything kept: from a failure, or from a follow-up Mend holds pending
   * once the session has no live agent. `agent` is the session's live agent as read just now, and
   * `mend` what Mend read about the key just now, for a retry that pastes into her agent.
   */
  | {
      readonly kind: "retry";
      readonly at: string;
      readonly agent: LiveAgent | null;
      readonly mend: FollowUpRead | null;
    }
  /** The drive stopped, or a window found it left: it moves on by why. */
  | { readonly kind: "abandoned"; readonly why: StopReason }
  /** A watch of a launch. */
  | ({ readonly kind: "follow-up"; readonly agent: LiveAgent | null } & FollowUpRead);

/** What the extension does next for a record. */
export type SendAction =
  | { readonly kind: "reconcile"; readonly pendingIds: ReadonlyArray<string> }
  | { readonly kind: "post"; readonly pending: PendingComment }
  | { readonly kind: "open"; readonly draftId: string; readonly pending: PendingComment }
  | { readonly kind: "dismiss-draft"; readonly draftId: string }
  | { readonly kind: "deliver"; readonly request: DeliverRequest }
  | { readonly kind: "paste"; readonly text: string; readonly processId: string }
  /** Nothing to paste into the agent's terminal, and why, said once. */
  | { readonly kind: "skip-paste"; readonly words: string }
  | { readonly kind: "watch" }
  | { readonly kind: "idle" };

export interface DeliverRequest {
  readonly reviewSliceId: string;
  readonly checkpointAId: string;
  readonly checkpointBId: string;
  readonly diffDigest: string;
  readonly commentIds: ReadonlyArray<string>;
  readonly instruction: string;
  readonly idempotencyKey: string;
}

/** An item whose words VS Code posts to Mend. */
export type PostedItem = Extract<SendItem, { readonly post: PostState }>;

export const posts = (item: SendItem): item is PostedItem =>
  item.kind === "own" || item.kind === "rewrite";

/** Every comment a record carries, by the id Mend knows it by once it is there. */
const idsOf = (record: SendRecord): ReadonlyArray<string> =>
  record.items.flatMap((item) =>
    item.kind === "open"
      ? [item.commentId]
      : item.kind === "accepted"
        ? [item.draftId]
        : item.post.kind === "posted"
          ? [item.post.commentId]
          : [],
  );

/** The ids Mend knows the review's comments by; null while one is not on Mend yet. */
export const commentIds = (record: SendRecord): ReadonlyArray<string> | null => {
  const ids: Array<string> = [];
  for (const item of record.items) {
    if (item.kind === "open") ids.push(item.commentId);
    else if (item.kind === "accepted") {
      if (!item.opened) return null;
      ids.push(item.draftId);
    } else if (item.post.kind === "posted") ids.push(item.post.commentId);
    else return null;
  }
  return ids;
};

export const deliverRequest = (record: SendRecord, ids: ReadonlyArray<string>): DeliverRequest => ({
  reviewSliceId: record.sliceId,
  checkpointAId: record.baseId,
  checkpointBId: record.headId,
  diffDigest: record.diffDigest,
  commentIds: ids,
  instruction: record.instruction,
  idempotencyKey: record.key,
});

/**
 * The next thing to do: only a record that is sending posts, opens or delivers, and only one in a
 * terminal not yet pasted into pastes. Every other record waits for her.
 */
export const nextAction = (record: SendRecord): SendAction => {
  if (record.phase.kind === "in-terminal") {
    if (record.phase.paste.kind !== "due") return { kind: "idle" };
    const { processId } = record.phase;
    const plan = planFor(record.paste, processId);
    switch (plan.kind) {
      case "all":
        return { kind: "paste", text: record.instruction, processId };
      case "added":
        return { kind: "paste", text: plan.text, processId };
      case "none":
        return { kind: "skip-paste", words: plan.words };
    }
  }
  if (record.phase.kind === "delivering") return { kind: "watch" };
  if (record.phase.kind !== "sending") return { kind: "idle" };
  const posting = record.items.flatMap((item) =>
    posts(item) && item.post.kind === "posting" ? [item.pending.id] : [],
  );
  if (posting.length > 0) return { kind: "reconcile", pendingIds: posting };
  for (const item of record.items) {
    if (posts(item) && item.post.kind === "unposted")
      return { kind: "post", pending: item.pending };
    if (item.kind === "rewrite" && item.dismissal.kind === "due")
      return { kind: "dismiss-draft", draftId: item.pending.origin.draftId };
    if (item.kind === "accepted" && !item.opened)
      return { kind: "open", draftId: item.draftId, pending: item.pending };
  }
  const ids = commentIds(record);
  return ids === null
    ? { kind: "idle" }
    : { kind: "deliver", request: deliverRequest(record, ids) };
};

const withPost = (record: SendRecord, pendingId: string, post: PostState): SendRecord => ({
  ...record,
  items: record.items.map((item) =>
    posts(item) && item.pending.id === pendingId ? { ...item, post } : item,
  ),
});

const answeredPhase = (
  status: FollowUpStatus,
  error: string | null,
  agent: LiveAgent,
  now: string,
): SendPhase => {
  switch (status) {
    case "pending":
      return agent.kind === "terminal" && agent.hers
        ? {
            kind: "in-terminal",
            agent: agent.name,
            processId: agent.processId,
            paste: { kind: "due" },
          }
        : { kind: "pending" };
    // Delivered is concluded from the comments read back as sent, by the watch.
    case "delivering":
    case "delivered":
      return { kind: "delivering" };
    case "delivery_failed":
      return { kind: "failed", words: error ?? "Mend could not deliver the review.", at: now };
    case "superseded":
      return { kind: "refused", words: "Mend replaced this follow-up with a newer one." };
  }
};

const NOT_LISTED =
  "Mend no longer lists this follow-up, and it does not read its comments as sent to the session";

/** What a step leaves her to know, before it is stamped with when. */
type Notice = Omit<SendNotice, "at">;

/** A send after an event, and what the change it made leaves her to know, if anything. */
interface Stepped {
  readonly record: SendRecord;
  readonly notice: Notice | null;
}

const quiet = (record: SendRecord): Stepped => ({ record, notice: null });

/** The send after `event`; an event its phase does not take leaves it as it was, with no notice. */
export const step = (record: SendRecord, event: SendEvent, now: string): SendRecord => {
  const { record: next, notice } = transition(record, event, now);
  if (notice === null) return next;
  return { ...next, notices: [...next.notices, { ...notice, at: now }].slice(-KEPT_NOTICES) };
};

/** A paste that went nowhere, and why. */
const notPastedWords = (why: "agent-gone" | "not-attached", agent: string): string =>
  why === "agent-gone"
    ? `${agent} exited before the review was pasted, so nothing was pasted. Mend holds the follow-up pending: Retry delivery sends it to the stopped session.`
    : `VS Code could not attach ${agent}'s terminal here, so nothing was pasted. Mend holds the follow-up pending: Retry delivery pastes it again.`;

/** A paste that failed: she checks the terminal and retries. */
const pasteFailed = (words: string): Notice => ({
  kind: "paste",
  words,
  tone: "error",
  retry: true,
  text: false,
});

/** What a review whose drive stopped before or during its paste into `agent` reads. */
const stoppedPasteWords = (agent: string, why: StopReason, mayHaveLanded: boolean): string => {
  const terminal = `the review into ${agent}'s terminal`;
  return mayHaveLanded
    ? cutShortWords(stopClause(why, `while it pasted ${terminal}`), agent)
    : `${stopClause(why, `before it pasted ${terminal}`)}, so nothing was pasted. Mend holds the follow-up pending: Retry delivery pastes it.`;
};

const transition = (record: SendRecord, event: SendEvent, now: string): Stepped => {
  switch (event.kind) {
    case "post-started":
      return quiet(withPost(record, event.pendingId, { kind: "posting", ...event.attempt }));
    case "posted":
      return quiet(
        withPost(record, event.pendingId, { kind: "posted", commentId: event.commentId }),
      );
    case "not-posted":
      return quiet(withPost(record, event.pendingId, { kind: "unposted" }));
    case "opened":
      return quiet({
        ...record,
        items: record.items.map((item) =>
          item.kind === "accepted" && item.draftId === event.draftId
            ? { ...item, opened: true }
            : item,
        ),
      });
    case "draft-dismissed":
      return quiet({
        ...record,
        items: record.items.map((item) =>
          item.kind === "rewrite" && item.pending.origin.draftId === event.draftId
            ? { ...item, dismissal: { kind: "dismissed" } }
            : item,
        ),
      });
    case "draft-left":
      return quiet({
        ...record,
        items: record.items.map((item) =>
          item.kind === "rewrite" && item.pending.origin.draftId === event.draftId
            ? { ...item, dismissal: { kind: "left", words: event.words } }
            : item,
        ),
      });
    case "answered": {
      if (record.phase.kind !== "sending") return quiet(record);
      const next = { ...record, phase: answeredPhase(event.status, event.error, event.agent, now) };
      const left = handedOver(next) ? draftsLeft(next) : [];
      return {
        record: next,
        notice:
          left.length === 0
            ? null
            : {
                kind: "draft-left",
                words: `Mend sent the review. The Mend draft your words replace is still on Mend, because VS Code could not dismiss it: ${left.join(" ")}`,
                tone: "warning",
                retry: false,
                text: false,
              },
      };
    }
    case "paste-started":
      return quiet(withPaste(record, "due", { kind: "pasting" }));
    case "paste-unstarted":
      return quiet(withPaste(record, "pasting", { kind: "due" }));
    case "pasted":
      return quiet(
        record.phase.kind === "in-terminal"
          ? withPaste(record, "pasting", {
              kind: "done",
              input: inputAfter(record, commentIds(record) ?? [], record.phase.processId, true),
            })
          : record,
      );
    case "skipped":
      if (record.phase.kind !== "in-terminal" || record.phase.paste.kind !== "due")
        return quiet(record);
      return {
        record: withPaste(record, "due", {
          kind: "done",
          input: inputAfter(record, commentIds(record) ?? [], record.phase.processId, false),
        }),
        notice: { kind: "paste", words: event.words, tone: "warning", retry: false, text: false },
      };
    case "paste-failed": {
      const { phase } = record;
      if (
        phase.kind !== "in-terminal" ||
        (phase.paste.kind !== "due" && phase.paste.kind !== "pasting")
      )
        return quiet(record);
      const notice = pasteFailed(
        event.why === "interrupted"
          ? cutShortWords(
              `VS Code could not finish pasting the review into ${phase.agent}'s terminal: ${event.words}`,
              phase.agent,
            )
          : notPastedWords(event.why, phase.agent),
      );
      return event.why === "agent-gone"
        ? { record: { ...record, phase: { kind: "pending" } }, notice }
        : {
            record: {
              ...record,
              phase: {
                ...phase,
                paste: {
                  kind: "failed",
                  mayHaveLanded: event.why === "interrupted",
                  stopped: null,
                },
              },
            },
            notice,
          };
    }
    case "failed":
      if (record.phase.kind !== "sending" && record.phase.kind !== "delivering")
        return quiet(record);
      // A failed delivery says itself from its phase; only a refusal is a notice.
      return event.retryable
        ? quiet({ ...record, phase: { kind: "failed", words: event.words, at: now } })
        : {
            record: { ...record, phase: { kind: "refused", words: event.words } },
            notice: {
              kind: "refused",
              words: `Mend could not deliver the review: ${event.words}`,
              tone: "error",
              retry: false,
              text: false,
            },
          };
    case "draft-gone": {
      // Its words are in the instruction: the review stops, and Send review composes it anew.
      const items = record.items.filter(
        (item) => item.kind !== "accepted" || item.draftId !== event.draftId,
      );
      if (record.phase.kind === "refused") return quiet({ ...record, items });
      return {
        record: { ...record, items, phase: { kind: "refused", words: DRAFT_GONE } },
        notice: {
          kind: "draft-gone",
          words: `${DRAFT_GONE}. Send review composes it again without that draft, from your comments as they are now.`,
          tone: "warning",
          retry: false,
          text: true,
        },
      };
    }
    case "superseded":
      return quiet(
        record.phase.kind === "pending" ||
          record.phase.kind === "in-terminal" ||
          record.phase.kind === "failed"
          ? {
              ...record,
              phase: {
                kind: "refused",
                words: "Mend replaced this follow-up with a newer review.",
              },
            }
          : record,
      );
    case "retry":
      if (!mayRetry(record, event.agent)) return quiet(record);
      // Mend held it pending for her live agent: only the paste is done again, and only while
      // Mend still holds this key and has not sent its comments.
      if (
        (record.phase.kind === "in-terminal" || record.phase.kind === "pending") &&
        event.agent?.kind === "terminal"
      )
        return quiet(
          event.mend === null
            ? record
            : { ...record, phase: heldPhase(event.mend, event.agent, now) },
        );
      return quiet({ ...record, phase: { kind: "sending", since: event.at } });
    case "abandoned": {
      const { phase } = record;
      if (phase.kind === "sending")
        return quiet({
          ...record,
          phase: { kind: "failed", words: stopClause(event.why, "before Mend answered"), at: now },
        });
      if (
        phase.kind !== "in-terminal" ||
        (phase.paste.kind !== "due" && phase.paste.kind !== "pasting")
      )
        return quiet(record);
      // Under way, some or all of it may be in the agent's input.
      const mayHaveLanded = phase.paste.kind === "pasting";
      return {
        record: {
          ...record,
          phase: { ...phase, paste: { kind: "failed", mayHaveLanded, stopped: event.why } },
        },
        notice: pasteFailed(stoppedPasteWords(phase.agent, event.why, mayHaveLanded)),
      };
    }
    case "follow-up":
      return quiet(followedUp(record, event, now));
  }
};

/** A launch after a watch read what Mend holds for its key. */
const followedUp = (
  record: SendRecord,
  event: Extract<SendEvent, { kind: "follow-up" }>,
  now: string,
): SendRecord => {
  if (record.phase.kind !== "delivering") return record;
  if (event.sent) return { ...record, phase: { kind: "delivered", at: now } };
  if (event.status === "delivery_failed")
    return {
      ...record,
      phase: {
        kind: "failed",
        words: event.error ?? "Mend could not deliver the review.",
        at: now,
      },
    };
  if (event.status === "pending")
    return {
      ...record,
      phase: answeredPhase("pending", null, event.agent ?? { kind: "other" }, now),
    };
  if (event.status !== null || event.others) return record;
  return { ...record, phase: { kind: "failed", words: NOT_LISTED, at: now } };
};

/** Where a review Mend held pending is, as Mend reads its key now. */
const heldPhase = (read: FollowUpRead, agent: LiveAgent, now: string): SendPhase => {
  if (read.sent) return { kind: "delivered", at: now };
  if (read.status !== null) return answeredPhase(read.status, read.error, agent, now);
  // Mend lists only the newest follow-up it holds: another one listed replaced ours.
  return read.others
    ? answeredPhase("superseded", null, agent, now)
    : { kind: "failed", words: NOT_LISTED, at: now };
};

const withPaste = (record: SendRecord, from: PasteStep["kind"], to: PasteStep): SendRecord =>
  record.phase.kind === "in-terminal" && record.phase.paste.kind === from
    ? { ...record, phase: { ...record.phase, paste: to } }
    : record;

export const DRAFT_GONE =
  "A Mend draft in this review was dismissed before it was sent, and the review's text still asks for it, so nothing was sent";

export const mayRetry = (record: SendRecord, agent: LiveAgent | null): boolean =>
  needs(record) === "her" &&
  (record.phase.kind === "failed" || agent === null || (agent.kind === "terminal" && agent.hers));

export type Needs = "driver" | "her" | "nothing";

export const needs = (record: SendRecord): Needs => {
  switch (record.phase.kind) {
    case "sending":
    case "delivering":
      return "driver";
    case "in-terminal":
      switch (record.phase.paste.kind) {
        case "due":
        case "pasting":
          return "driver";
        case "failed":
          return "her";
        case "done":
          return "nothing";
      }
    case "pending":
    case "failed":
      return "her";
    case "delivered":
    case "refused":
      return "nothing";
  }
};

/** What Mend answered a drive's deliver, or its watch, before the drive read her agent. */
export type MendAnswer =
  | { readonly via: "deliver"; readonly status: FollowUpStatus; readonly error: string | null }
  | ({ readonly via: "watch" } & FollowUpRead);

/**
 * What failed in a step of a send's drive: VS Code's connection is not the send's (another server
 * or account, signed out, or a sign-in Mend could not name), Mend refused a write, or anything else
 * failed: a read, a write Mend never answered, VS Code's own keep.
 */
export type DriveFailure =
  | {
      readonly kind: "unbound";
      readonly why: "switched" | "signed-out" | "unknown";
      readonly words: string;
    }
  /** Mend answered, and the read of her agent that answer needs failed. */
  | { readonly kind: "agent-unread"; readonly answer: MendAnswer }
  | { readonly kind: "refused"; readonly words: string }
  | { readonly kind: "failed"; readonly words: string };

/** What a drive does after a failed step: stops for why, waits and tries again, or keeps an event. */
export type OnFailure =
  | { readonly kind: "stop"; readonly why: StopReason }
  | { readonly kind: "wait" }
  | { readonly kind: "event"; readonly event: SendEvent };

/**
 * How many times a drive waits on a sign-in Mend could not name before the send reads failed: Mend
 * that cannot answer for that long cannot take the review either.
 */
export const MAX_ACCOUNT_WAITS = 5;

/**
 * What the drive does when a step fails, by the send as the drive read it before that step and
 * how many times the drive already waited on a sign-in Mend could not name.
 */
export const onFailure = (record: SendRecord, failure: DriveFailure, waited: number): OnFailure => {
  // What Mend answered stands without her agent: a review it holds pending then waits on her.
  if (failure.kind === "agent-unread") {
    const { answer } = failure;
    return {
      kind: "event",
      event:
        answer.via === "deliver"
          ? {
              kind: "answered",
              status: answer.status,
              error: answer.error,
              agent: { kind: "other" },
            }
          : {
              kind: "follow-up",
              status: answer.status,
              error: answer.error,
              others: answer.others,
              sent: answer.sent,
              agent: null,
            },
    };
  }
  // Nothing more is sent on a connection that is not the send's: a read of its own server, signed
  // in, picks the send up. One Mend could not name yet is waited on, for a while.
  if (failure.kind === "unbound" && failure.why !== "unknown")
    return { kind: "stop", why: { kind: failure.why } };
  if (failure.kind === "unbound" && waited < MAX_ACCOUNT_WAITS) return { kind: "wait" };
  // Mend holds the follow-up: what failed is VS Code's, and the paste step stops on it.
  if (record.phase.kind === "in-terminal")
    return { kind: "stop", why: { kind: "error", words: failure.words } };
  return {
    kind: "event",
    event: { kind: "failed", words: failure.words, retryable: failure.kind !== "refused" },
  };
};

const isHeld = (record: SendRecord): boolean =>
  record.phase.kind === "pending" || record.phase.kind === "in-terminal";

/** A review pasted into an agent process other than `agent`, or into one no agent is now. */
const pastedIntoAnother = (record: SendRecord, agent: LiveAgent | null): boolean =>
  record.phase.kind === "in-terminal" &&
  record.phase.paste.kind === "done" &&
  (agent?.kind !== "terminal" || agent.processId !== record.phase.processId);

export const retryRecord = (
  records: ReadonlyArray<SendRecord>,
  agent: LiveAgent | null,
): SendRecord | null => {
  const open = openRecord(records);
  if (open !== null) return open.phase.kind === "failed" ? open : null;
  const held = records.findLast(isHeld);
  return held !== undefined && mayRetry(held, agent) ? held : null;
};

/**
 * Where each comment of a review on its way is: `sending` while a drive sends, delivers or pastes
 * it, `held` while Mend holds it pending and Retry delivery or her live agent's input carries it.
 * A review pasted into an agent process `agent` is not, as after it exited, holds nothing: no
 * Retry delivers it again, so the next Send carries its comments under a new key.
 */
export const commentsOnTheirWay = (
  records: ReadonlyArray<SendRecord>,
  agent: LiveAgent | null,
): ReadonlyMap<string, "sending" | "held"> => {
  const where = new Map<string, "sending" | "held">();
  for (const record of records)
    if (isHeld(record) && !pastedIntoAnother(record, agent))
      for (const id of idsOf(record)) if (!where.has(id)) where.set(id, "held");
  for (const record of records)
    if (holdsComments(record)) for (const id of idsOf(record)) where.set(id, "sending");
  return where;
};

/**
 * A review after an event on one of its records. Mend supersedes every follow-up it holds pending
 * or failed when a newer key arrives, so once a record is answered every older one it would have
 * superseded reads so.
 */
export const stepReview = (
  review: SessionReview,
  key: string,
  event: SendEvent,
  now: string,
): SessionReview => {
  const next = withSend(review, key, (record) => step(record, event, now));
  if (event.kind !== "answered" || event.status === "superseded") return next;
  const at = next.sends.findIndex((record) => record.key === key);
  return next.sends
    .slice(0, Math.max(at, 0))
    .reduce(
      (kept, older) =>
        withSend(kept, older.key, (record) => step(record, { kind: "superseded" }, now)),
      next,
    );
};

/** A record that still holds its comments: a drive sends, delivers or pastes it. */
const holdsComments = (record: SendRecord): boolean => needs(record) === "driver";

/** A paste into her agent's terminal not yet made, or being made. */
export const pasteUnderway = (record: SendRecord): boolean =>
  record.phase.kind === "in-terminal" &&
  (record.phase.paste.kind === "due" || record.phase.paste.kind === "pasting");

/**
 * Whether a send may start its drive now, a new one or a Retry: one review at a time goes to Mend
 * and into her agent's input, so none starts while another is sending, or its paste is due or under
 * way. A newer review would supersede it on Mend, or paste over it. Send and Retry both ask under
 * the kept review's lock.
 */
export const admits = (records: ReadonlyArray<SendRecord>): boolean =>
  !records.some((record) => record.phase.kind === "sending" || pasteUnderway(record));

/** What a thread of a comment in this record reads, as Mend observed it. */
export const recordLabel = (phase: SendPhase): string => {
  switch (phase.kind) {
    case "sending":
      return "sending";
    case "delivering":
      return "delivery in progress";
    case "in-terminal":
      switch (phase.paste.kind) {
        case "done":
          return `follow-up pending · pasted into ${phase.agent}'s terminal`;
        case "failed":
          return phase.paste.mayHaveLanded
            ? `follow-up pending · paste into ${phase.agent}'s terminal cut short`
            : `follow-up pending · not pasted into ${phase.agent}'s terminal`;
        case "pasting":
          return `follow-up pending · pasting into ${phase.agent}'s terminal`;
        case "due":
          return "follow-up pending";
      }
    case "pending":
      return "follow-up pending";
    case "delivered":
      return "sent";
    case "failed":
      return "delivery failed · retryable";
    case "refused":
      return "not sent";
  }
};

/**
 * What the thread of a comment in this record reads (`commentId` null for one not on Mend yet): in
 * her terminal, whether VS Code pasted its words, and into which agent process. Only what VS Code
 * did: Enter, a reload or her own edits since are not observed.
 */
export const commentLabel = (
  record: SendRecord,
  commentId: string | null,
  agent: LiveAgent | null,
): string => {
  const { phase } = record;
  if (phase.kind !== "in-terminal" || phase.paste.kind !== "done") return recordLabel(phase);
  if (commentId !== null && !phase.paste.input.ids.includes(commentId))
    return `follow-up pending · not pasted into ${phase.agent}'s terminal`;
  return agent?.kind === "terminal" && agent.processId === phase.processId
    ? recordLabel(phase)
    : `follow-up pending · pasted into an earlier ${phase.agent}`;
};

/** Why each Mend draft her posted words replace was left on Mend. */
export const draftsLeft = (record: SendRecord): ReadonlyArray<string> =>
  record.items.flatMap((item) =>
    item.kind === "rewrite" && item.dismissal.kind === "left" ? [item.dismissal.words] : [],
  );

/** A record whose comments were handed to the session: its head is where her last review was. */
export const handedOver = (record: SendRecord): boolean =>
  record.phase.kind === "delivered" ||
  record.phase.kind === "in-terminal" ||
  record.phase.kind === "pending" ||
  record.phase.kind === "delivering";

/**
 * The record a new Send waits on, or retries: the newest one not handed over or refused, or one
 * whose paste into her agent's terminal is due or under way.
 */
export const openRecord = (records: ReadonlyArray<SendRecord>): SendRecord | null =>
  records.findLast(
    (record) =>
      record.phase.kind === "sending" || record.phase.kind === "failed" || pasteUnderway(record),
  ) ?? null;

/**
 * Send review: the pending comments and the comments open on Mend her instruction lists move into
 * a new record with its key; null when one of those comments is no longer pending. From here the
 * record owns them until it ends.
 */
export const startSend = (
  review: SessionReview,
  input: {
    readonly key: string;
    readonly slice: SendSlice;
    readonly instruction: Instruction;
    readonly paste: PastePlan;
    /** The pending comments the instruction lists: each must still be pending. */
    readonly pending: ReadonlyArray<string>;
    /** The comments open on Mend it lists: none may be in a review still on its way. */
    readonly open: ReadonlyArray<string>;
    readonly now: string;
  },
): SessionReview | null => {
  const chosen = new Set(input.pending);
  const moving = review.pending.filter((pending) => chosen.has(pending.id));
  if (moving.length !== chosen.size) return null;
  if (!admits(review.sends)) return null;
  // Another window sent these comments a moment ago: one review takes them, under one key.
  const onTheirWay = commentsOnTheirWay(review.sends, null);
  if (input.open.some((id) => onTheirWay.get(id) === "sending")) return null;
  const items: ReadonlyArray<SendItem> = [
    ...moving.map((pending): SendItem => {
      if (rewritten(pending))
        return {
          kind: "rewrite",
          pending,
          post: { kind: "unposted" },
          dismissal: { kind: "due" },
        };
      const { origin } = pending;
      return origin.kind === "own"
        ? { kind: "own", pending, post: { kind: "unposted" } }
        : { kind: "accepted", pending, draftId: origin.draftId, opened: false };
    }),
    ...input.open.map((commentId): SendItem => ({ kind: "open", commentId })),
  ];
  const record: SendRecord = {
    key: input.key,
    sliceId: input.slice.id,
    baseId: input.slice.baseId,
    headId: input.slice.headId,
    diffDigest: input.slice.diffDigest,
    instruction: input.instruction.text,
    paste: input.paste,
    items,
    phase: { kind: "sending", since: input.now },
    notices: [],
    createdAt: input.now,
  };
  return {
    ...review,
    pending: review.pending.filter((pending) => !chosen.has(pending.id)),
    sends: [...review.sends, record].slice(-KEPT_SENDS),
  };
};

/** The record with this key, after `change`; a record that is refused gives back what Mend lacks. */
export const withSend = (
  review: SessionReview,
  key: string,
  change: (record: SendRecord) => SendRecord,
): SessionReview => {
  const record = review.sends.find((candidate) => candidate.key === key);
  if (record === undefined) return review;
  const next = change(record);
  if (next.phase.kind !== "refused" || record.phase.kind === "refused")
    return {
      ...review,
      sends: review.sends.map((candidate) => (candidate.key === key ? next : candidate)),
    };
  // Refused: a comment not on Mend yet is pending again, so nothing she wrote is lost.
  const back = next.items.flatMap((item) =>
    (posts(item) && item.post.kind !== "posted") || (item.kind === "accepted" && !item.opened)
      ? [item.pending]
      : [],
  );
  return {
    ...review,
    pending: [...review.pending, ...back],
    sends: review.sends.map((candidate) => (candidate.key === key ? next : candidate)),
  };
};
