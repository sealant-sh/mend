import { reviewTargetFile, targetFileFor, type ReviewCommentTarget } from "@mend/domain/workbench";

import type { Instruction } from "./instruction.js";
import {
  KEPT_SENDS,
  rewritten,
  type AcceptedComment,
  type PendingComment,
  type SessionReview,
} from "./pending.js";
import type { ChangeFile, ServerComment } from "./review-wire.js";

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

/** A post on its way, kept before the request goes: a reload matches only what it made. */
export interface PostAttempt {
  /** The words and the target posted, exactly. */
  readonly body: string;
  readonly target: ReviewCommentTarget;
  /** Her name as Mend writes it on her comments; null when Mend could not say who she is. */
  readonly author: string | null;
  /** Every comment id on the change before the post: the one it made is not among them. */
  readonly before: ReadonlyArray<string>;
}

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
  /** `at`: when it failed, so every window names this failure alike. */
  | { readonly kind: "failed"; readonly words: string; readonly at: string }
  /** Mend refused this key or this person: a new review, with a new key, is the way on. */
  | { readonly kind: "refused"; readonly words: string };

/**
 * What the agent's input holds as VS Code pasted it, not entered: the text, exactly, and the
 * comments whose words are in it. Mend's follow-up can hold more, after a paste that was skipped.
 */
export interface TerminalInput {
  readonly text: string;
  readonly ids: ReadonlyArray<string>;
}

/** What one agent process's input holds, as VS Code pasted it: another process's input holds none of it. */
export interface HeldInput {
  readonly input: TerminalInput;
  readonly agent: string;
  readonly processId: string;
}

/**
 * What Send to session pastes into the agent's terminal (G12 fallback): the whole text; only what
 * she added onto what its input holds; or nothing, with why, when she changed the part already
 * there. `onto` is what the input of the agent process `processId` held when she composed it: a
 * paste into any other process is the whole text.
 */
export type PastePlan =
  | { readonly kind: "all" }
  | {
      readonly kind: "added";
      readonly text: string;
      readonly onto: TerminalInput;
      readonly processId: string;
    }
  | {
      readonly kind: "none";
      readonly words: string;
      readonly onto: TerminalInput;
      readonly processId: string;
    };

/** The paste step of a review Mend holds pending in her agent's terminal. */
export type PasteStep =
  | { readonly kind: "due" }
  /** Kept before the paste is made: a window that closes now leaves a paste it cannot vouch for. */
  | { readonly kind: "pasting" }
  /** Pasted, or nothing to paste and she was told why: what VS Code pasted into the agent's input. */
  | { readonly kind: "done"; readonly input: TerminalInput }
  /**
   * Not pasted, as far as VS Code knows: Retry delivery pastes it again. `mayHaveLanded` when the
   * paste was cut short, so some or all of it may be in the agent's input.
   */
  | { readonly kind: "failed"; readonly mayHaveLanded: boolean };

export interface SendSlice {
  readonly id: string;
  readonly baseId: string;
  readonly headId: string;
  readonly diffDigest: string;
}

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
  /** The paste is about to be made. */
  | { readonly kind: "paste-started" }
  /** The paste reached the agent's input. */
  | { readonly kind: "pasted" }
  /** Nothing was pasted, and she was told why: the input holds what it held. */
  | { readonly kind: "skipped" }
  /**
   * Mend still holds the follow-up pending, and the paste did not reach the agent's input: its
   * process is gone, its terminal could not be attached here, or the paste was cut short.
   */
  | { readonly kind: "paste-failed"; readonly why: "agent-gone" | "not-attached" | "interrupted" }
  | { readonly kind: "failed"; readonly words: string; readonly retryable: boolean }
  /**
   * Retry delivery, with everything kept: from a failure, or from a follow-up Mend holds pending
   * once the session has no live agent. `agent` is the session's live agent as read just now.
   */
  | { readonly kind: "retry"; readonly at: string; readonly agent: LiveAgent | null }
  /**
   * No window drives this record any more: a send it did not see end is not known to be sent, and
   * a paste it did not see end is not known to be in the agent's input.
   */
  | { readonly kind: "abandoned"; readonly words: string }
  /**
   * A watch of a launch: `GET …/follow-up` lists only the newest follow-up not yet delivered, so
   * `status` is ours when it is listed, and `sent` is whether Mend reads every comment of the
   * review back as sent to the session, the only proof it was delivered.
   */
  | {
      readonly kind: "follow-up";
      readonly status: FollowUpStatus | null;
      readonly error: string | null;
      /** Another follow-up of the session is listed: ours may still be on its way. */
      readonly others: boolean;
      readonly sent: boolean;
      /** The session's live agent, read when Mend lists ours pending; null otherwise. */
      readonly agent: LiveAgent | null;
    };

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
    // A paste in flight is its own window's: once no window drives it, it is abandoned.
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

/**
 * The plan for a paste into the agent process `processId`: one composed onto another process's
 * input is the whole text, since this process's input holds none of it.
 */
const planFor = (plan: PastePlan, processId: string): PastePlan =>
  plan.kind !== "all" && plan.processId !== processId ? { kind: "all" } : plan;

/**
 * What the agent's input holds after this record's paste step, in the process it was pasted into:
 * what it was pasted onto, and the paste.
 */
const inputAfter = (record: SendRecord, processId: string, pasted: boolean): TerminalInput => {
  const ids = commentIds(record) ?? [];
  const plan = planFor(record.paste, processId);
  switch (plan.kind) {
    case "all":
      return pasted ? { text: record.instruction, ids } : { text: "", ids: [] };
    case "added":
      return pasted ? { text: `${plan.onto.text}${plan.text}`, ids } : plan.onto;
    case "none":
      return plan.onto;
  }
};

/** What an agent process's input holds, by the newest review not refused; null when nothing of hers is. */
const recordedInput = (records: ReadonlyArray<SendRecord>): HeldInput | null => {
  const latest = records.findLast((record) => record.phase.kind !== "refused");
  if (latest?.phase.kind !== "in-terminal") return null;
  const { agent, processId, paste } = latest.phase;
  if (paste.kind === "done") return { input: paste.input, agent, processId };
  // Nothing was pasted, as far as VS Code knows: the input holds what it was composed onto.
  return paste.kind === "failed" && latest.paste.kind !== "all"
    ? { input: latest.paste.onto, agent, processId: latest.paste.processId }
    : null;
};

/**
 * What the input of her live agent holds; null when nothing of hers is, or when the agent is a
 * process other than the one VS Code pasted into, as after a stop and a resume.
 */
export const terminalInput = (
  records: ReadonlyArray<SendRecord>,
  agent: LiveAgent | null,
): HeldInput | null => {
  const held = recordedInput(records);
  return held !== null && agent?.kind === "terminal" && agent.processId === held.processId
    ? held
    : null;
};

/**
 * The reviews a composition was made after: the newest one kept, and what an agent's input holds.
 * One composed before another review went out, in any window, no longer says what it would send.
 */
export const sendGeneration = (records: ReadonlyArray<SendRecord>): string =>
  JSON.stringify([records.at(-1)?.key ?? null, recordedInput(records)]);

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

/** A record after an event; an event its phase does not take leaves it as it was. */
export const step = (record: SendRecord, event: SendEvent, now: string): SendRecord => {
  switch (event.kind) {
    case "post-started":
      return withPost(record, event.pendingId, { kind: "posting", ...event.attempt });
    case "posted":
      return withPost(record, event.pendingId, { kind: "posted", commentId: event.commentId });
    case "not-posted":
      return withPost(record, event.pendingId, { kind: "unposted" });
    case "opened":
      return {
        ...record,
        items: record.items.map((item) =>
          item.kind === "accepted" && item.draftId === event.draftId
            ? { ...item, opened: true }
            : item,
        ),
      };
    case "draft-dismissed":
      return {
        ...record,
        items: record.items.map((item) =>
          item.kind === "rewrite" && item.pending.origin.draftId === event.draftId
            ? { ...item, dismissal: { kind: "dismissed" } }
            : item,
        ),
      };
    case "draft-left":
      return {
        ...record,
        items: record.items.map((item) =>
          item.kind === "rewrite" && item.pending.origin.draftId === event.draftId
            ? { ...item, dismissal: { kind: "left", words: event.words } }
            : item,
        ),
      };
    case "answered":
      return record.phase.kind === "sending"
        ? { ...record, phase: answeredPhase(event.status, event.error, event.agent, now) }
        : record;
    case "paste-started":
      return withPaste(record, "due", { kind: "pasting" });
    case "pasted":
      return record.phase.kind === "in-terminal"
        ? withPaste(record, "pasting", {
            kind: "done",
            input: inputAfter(record, record.phase.processId, true),
          })
        : record;
    case "skipped":
      return record.phase.kind === "in-terminal"
        ? withPaste(record, "due", {
            kind: "done",
            input: inputAfter(record, record.phase.processId, false),
          })
        : record;
    case "paste-failed": {
      const { phase } = record;
      if (
        phase.kind !== "in-terminal" ||
        (phase.paste.kind !== "due" && phase.paste.kind !== "pasting")
      )
        return record;
      return event.why === "agent-gone"
        ? { ...record, phase: { kind: "pending" } }
        : {
            ...record,
            phase: {
              ...phase,
              paste: { kind: "failed", mayHaveLanded: event.why === "interrupted" },
            },
          };
    }
    case "failed":
      return record.phase.kind === "sending" || record.phase.kind === "delivering"
        ? {
            ...record,
            phase: event.retryable
              ? { kind: "failed", words: event.words, at: now }
              : { kind: "refused", words: event.words },
          }
        : record;
    case "draft-gone": {
      // Its words are in the instruction: the review stops, and Send review composes it anew.
      const items = record.items.filter(
        (item) => item.kind !== "accepted" || item.draftId !== event.draftId,
      );
      if (record.phase.kind === "refused") return { ...record, items };
      return { ...record, items, phase: { kind: "refused", words: DRAFT_GONE } };
    }
    case "superseded":
      return record.phase.kind === "pending" ||
        record.phase.kind === "in-terminal" ||
        record.phase.kind === "failed"
        ? {
            ...record,
            phase: { kind: "refused", words: "Mend replaced this follow-up with a newer review." },
          }
        : record;
    case "retry":
      if (!mayRetry(record, event.agent)) return record;
      // Mend holds it pending for her live agent: only the paste is done again.
      return (record.phase.kind === "in-terminal" || record.phase.kind === "pending") &&
        event.agent?.kind === "terminal"
        ? {
            ...record,
            phase: {
              kind: "in-terminal",
              agent: event.agent.name,
              processId: event.agent.processId,
              paste: { kind: "due" },
            },
          }
        : { ...record, phase: { kind: "sending", since: event.at } };
    case "abandoned":
      if (record.phase.kind === "sending")
        return { ...record, phase: { kind: "failed", words: event.words, at: now } };
      if (record.phase.kind !== "in-terminal") return record;
      switch (record.phase.paste.kind) {
        case "due":
          return withPaste(record, "due", { kind: "failed", mayHaveLanded: false });
        case "pasting":
          return withPaste(record, "pasting", { kind: "failed", mayHaveLanded: true });
        default:
          return record;
      }
    case "follow-up":
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
      // Mend holds it pending (the session went live, or a reload never heard the answer): into her
      // own live terminal agent it is pasted, as when Mend answers so; otherwise it waits for her.
      if (event.status === "pending")
        return {
          ...record,
          phase: answeredPhase("pending", null, event.agent ?? { kind: "other" }, now),
        };
      if (event.status !== null || event.others) return record;
      return {
        ...record,
        phase: {
          kind: "failed",
          words:
            "Mend no longer lists this follow-up, and it does not read its comments as sent to the session",
          at: now,
        },
      };
  }
};

/** A record in its paste step `from`, moved to `to`; any other record as it was. */
const withPaste = (record: SendRecord, from: PasteStep["kind"], to: PasteStep): SendRecord =>
  record.phase.kind === "in-terminal" && record.phase.paste.kind === from
    ? { ...record, phase: { ...record.phase, paste: to } }
    : record;

export const DRAFT_GONE =
  "A Mend draft in this review was dismissed before it was sent, and the review's text still asks for it, so nothing was sent";

/**
 * Retry delivery is offered on a failed record, and on a follow-up Mend holds pending that VS Code
 * did not paste: pasted into her own live terminal agent, or, once the session has no live agent,
 * delivered with the same key, which launches the stopped session on the review. Never on one VS
 * Code pasted: she may have entered it, and the same key would hand the agent that review again.
 */
export const mayRetry = (record: SendRecord, agent: LiveAgent | null): boolean => {
  const hers = agent === null || (agent.kind === "terminal" && agent.hers);
  switch (record.phase.kind) {
    case "failed":
      return true;
    case "pending":
      return hers;
    case "in-terminal":
      return record.phase.paste.kind === "failed" && hers;
    default:
      return false;
  }
};

/**
 * Who moves a record on from where it is: a window's driver, which posts, delivers, pastes and
 * watches; her, with Retry delivery or a new Send; or nobody, as it ended, or its words are in her
 * agent's input. A record a driver needs and no window drives is abandoned.
 */
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

/**
 * A record a toast of hers offered Retry delivery on, and that still waits for it: failed, or held
 * pending with nothing pasted. One sent, or retried meanwhile, does not.
 */
export const awaitsRetry = (record: SendRecord): boolean =>
  record.phase.kind === "failed" ||
  record.phase.kind === "pending" ||
  (record.phase.kind === "in-terminal" && record.phase.paste.kind === "failed");

const isHeld = (record: SendRecord): boolean =>
  record.phase.kind === "pending" || record.phase.kind === "in-terminal";

/**
 * The review Retry delivery acts on: the newest one failed, else the newest Mend holds pending once
 * the session has no live agent to paste into.
 */
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
 * Where each comment of her reviews stands, by the id Mend knows it by (an accepted draft not yet
 * opened counts by its draft id). `sending`: a review being sent or delivered holds it, so no new
 * Send lists it. `held`: Mend holds it pending, in her terminal or for Retry. It is not counted as
 * new for Send review, and a newer key still carries it, as Mend supersedes the held one.
 */
export const commentsOnTheirWay = (
  records: ReadonlyArray<SendRecord>,
): ReadonlyMap<string, "sending" | "held"> => {
  const where = new Map<string, "sending" | "held">();
  for (const record of records)
    if (isHeld(record)) for (const id of idsOf(record)) if (!where.has(id)) where.set(id, "held");
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

/** A record that still holds its comments: this window is sending or delivering it. */
export const holdsComments = (record: SendRecord): boolean =>
  record.phase.kind === "sending" || record.phase.kind === "delivering";

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

/** The record a new Send waits on, or retries: the newest one not handed over or refused. */
export const openRecord = (records: ReadonlyArray<SendRecord>): SendRecord | null =>
  records.findLast((record) => record.phase.kind === "sending" || record.phase.kind === "failed") ??
  null;

/**
 * The target for a pending comment in the slice it was written on: its lines when one hunk holds
 * them, else its file (the words then say which line, when it is on one), else the change as a
 * whole.
 */
export const commentTarget = (
  files: ReadonlyArray<ChangeFile>,
  comment: Pick<PendingComment, "path" | "line" | "endLine" | "body" | "anchor">,
): { readonly target: ReviewCommentTarget; readonly body: string } => {
  // Her reply under a Mend draft on the old side goes where the draft is: the base's lines.
  const side = comment.anchor?.side ?? null;
  const old = side === "old";
  const { line, endLine } = comment;
  const file = comment.path === null ? undefined : targetFileFor(files, comment.path, side);
  const hunk =
    line === null || endLine === null
      ? undefined
      : file?.hunks.find((candidate) => {
          const start = old ? candidate.oldStart : candidate.newStart;
          const lines = old ? candidate.oldLines : candidate.newLines;
          return lines > 0 && line >= start && endLine <= start + lines - 1;
        });
  if (file !== undefined && hunk !== undefined && line !== null && endLine !== null)
    return {
      target: {
        oldPath: file.oldPath,
        newPath: file.newPath,
        side: old ? "old" : "new",
        startLine: line,
        endLine,
        hunkContextHash: hunk.contextHash,
      },
      body: comment.body,
    };
  const where = line === null ? "" : `line ${line}: `;
  if (file !== undefined)
    return {
      target: {
        oldPath: file.oldPath,
        newPath: file.newPath,
        side: null,
        startLine: null,
        endLine: null,
        hunkContextHash: null,
      },
      body: `${where}${comment.body}`,
    };
  return {
    target: {
      oldPath: null,
      newPath: null,
      side: null,
      startLine: null,
      endLine: null,
      hunkContextHash: null,
    },
    body:
      comment.path === null
        ? comment.body
        : `${comment.path}${line === null ? "" : `:${line}`}: ${comment.body}`,
  };
};

/**
 * The comment a post in flight left on Mend, if it landed: one that was not there before the post,
 * not claimed by another item, written by her, with exactly the words and the target posted, on
 * the slice it was posted to. Mend trims the words it keeps.
 */
export const postedComment = (
  attempt: PostAttempt,
  sliceId: string,
  comments: ReadonlyArray<ServerComment>,
  claimed: ReadonlySet<string>,
): string | null => {
  const before = new Set(attempt.before);
  const { target } = attempt;
  return (
    comments.find(
      (comment) =>
        !before.has(comment.id) &&
        !claimed.has(comment.id) &&
        comment.author.kind === "reviewer" &&
        (attempt.author === null || comment.author.name === attempt.author) &&
        comment.body === attempt.body.trim() &&
        comment.anchor?.sliceId === sliceId &&
        comment.file === reviewTargetFile(target) &&
        comment.line === target.startLine &&
        comment.endLine === target.endLine,
    )?.id ?? null
  );
};

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
  // Another window sent these comments a moment ago: one review takes them, under one key.
  const onTheirWay = commentsOnTheirWay(review.sends);
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
