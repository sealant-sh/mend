import type { MendClient } from "../client.js";
import { MendApiError } from "../mend-http.js";
import type { SessionDetail } from "../types.js";
import type { Pasted } from "./agent-paste.js";
import {
  commentIds,
  commentLabel,
  commentTarget,
  DRAFT_GONE,
  draftsLeft,
  handedOver,
  holdsComments,
  mayRetry,
  nextAction,
  postedComment,
  posts,
  step,
  stepReview,
  type LiveAgent,
  type SendEvent,
  type SendRecord,
} from "./delivery.js";
import type { KeptReviews, ReviewPlace } from "./kept-reviews.js";
import type { SessionReview } from "./pending.js";
import type { ReviewClient } from "./review-client.js";
import type { ChangeFile } from "./review-wire.js";

/** A send record, by the person, server and session it is kept for, and its key. */
export interface RetryTarget {
  readonly place: ReviewPlace;
  readonly key: string;
}

/** Whether Retry delivery sent the review again; when not, what it found instead. */
export type Retried =
  | { readonly retried: true }
  | { readonly retried: false; readonly words: string };

/** What a send record's drive reads Mend with, whichever session the section follows. */
export interface SendContext {
  readonly place: ReviewPlace;
  readonly changeId: string;
  readonly viewer: string | null;
  readonly author: string | null;
}

export interface FailOptions {
  readonly cause?: unknown;
  readonly retry?: RetryTarget | null;
  readonly text?: string;
  readonly tone?: "error" | "warning";
}

/** What the driver asks of the store that shows the review. */
export interface DriverHost {
  /** Applies `update` to the review kept at `place`, as kept now, under the lock. */
  keepAt(
    place: ReviewPlace,
    update: (review: SessionReview) => SessionReview | Promise<SessionReview>,
  ): Promise<SessionReview>;
  /** A failure worth one toast. */
  fail(what: string, words: string, options?: FailOptions): void;
  /** A drive of this session ended: the section reads it again when it follows that session. */
  settled(sessionId: string): void;
  /** A lease another window held may have gone stale: load this place's kept reviews again. */
  loadAgain(place: ReviewPlace): void;
}

/** Whether a new record was kept and is now driven, and why not. */
export type Recorded =
  | { readonly kind: "recorded" }
  | { readonly kind: "not-recorded" }
  | { readonly kind: "failed"; readonly cause: unknown };

const driveId = (context: SendContext, key: string): string =>
  JSON.stringify([context.place.url, context.place.viewer, context.place.sessionId, key]);

/** Another window took over a send this window was driving: this one does nothing more for it. */
class DriveLost extends Error {}

const pasteWords = (pasted: Exclude<Pasted, "pasted">, agent: string): string =>
  pasted === "agent-gone"
    ? `${agent} exited before the review was pasted, so nothing was pasted. Mend holds the follow-up pending: Retry delivery sends it to the stopped session.`
    : `VS Code could not attach ${agent}'s terminal here, so nothing was pasted. Mend holds the follow-up pending: Retry delivery pastes it again.`;

/** How often a launch is watched, and for how many steps before it reads failed. */
const WATCH_MS = 3_000;
const MAX_TURNS = 400;

export const errorWords = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Mend could not read this change.";

/** A write of the review to Mend failed: a post, a comment's state, or the delivery. */
class WriteFailed extends Error {
  constructor(readonly failure: unknown) {
    super(errorWords(failure));
  }
}

const writing = async <T>(call: Promise<T>): Promise<T> => {
  try {
    return await call;
  } catch (cause) {
    throw new WriteFailed(cause);
  }
};

/** 4xx answers that ask for a sign-in or for later: they say nothing against the review. */
const NOT_A_REFUSAL: ReadonlySet<number> = new Set([401, 408, 429]);

/**
 * The one classifier: only Mend refusing a write of the review refuses it. A read that fails says
 * nothing about the review, and any other failure is worth a retry with the same key.
 */
const refuses = (thrown: unknown): boolean =>
  thrown instanceof WriteFailed &&
  thrown.failure instanceof MendApiError &&
  thrown.failure.status !== null &&
  thrown.failure.status >= 400 &&
  thrown.failure.status < 500 &&
  !NOT_A_REFUSAL.has(thrown.failure.status);

/**
 * Drives each send record until Mend answers: posts its comments, opens accepted drafts, delivers
 * the follow-up, pastes it into her agent's terminal, and watches a launch. One window drives a
 * record, under its lease; every step is kept through the host, under the lock.
 */
export class SendDriver {
  /** Each record's drive, by server, session and key: one at a time per record. */
  readonly #driving = new Map<string, Promise<void>>();
  /** The records this window holds the lease to drive, by drive. */
  readonly #leased = new Set<string>();
  /** When this window loads its kept reviews again, for a send another window's lease holds. */
  #loadAgain: NodeJS.Timeout | null = null;

  constructor(
    private readonly kept: KeptReviews,
    private readonly client: ReviewClient,
    private readonly sessions: Pick<MendClient, "sessionDetail" | "viewerId">,
    /** G12 fallback: the agent's terminal attached here, the text pasted into that process, no Enter. */
    private readonly paste: (sessionId: string, processId: string, text: string) => Promise<Pasted>,
    private readonly host: DriverHost,
  ) {}

  dispose(): void {
    if (this.#loadAgain !== null) clearTimeout(this.#loadAgain);
  }

  /**
   * Keeps a new record with `keep` and drives it. Its drive is claimed before the record is kept:
   * a window loading it then reads it driven here, never left behind by a window that closed.
   */
  async record(
    context: SendContext,
    key: string,
    keep: (review: SessionReview) => SessionReview,
  ): Promise<Recorded> {
    const { place } = context;
    let next: SessionReview;
    try {
      await this.kept.claimDrive(place, key);
      next = await this.host.keepAt(place, keep);
    } catch (cause) {
      await this.kept.releaseDrive(place, key).catch(() => undefined);
      return { kind: "failed", cause };
    }
    if (!next.sends.some((record) => record.key === key)) {
      await this.kept.releaseDrive(place, key);
      return { kind: "not-recorded" };
    }
    void this.#drive(context, key);
    return { kind: "recorded" };
  }

  /**
   * Retry delivery: the same key, the same text, the comments already on Mend kept. Only a record
   * of that session with that key, failed, or held pending by Mend once the session has no live
   * agent (the route then launches the stopped session on the review).
   */
  async retry(target: RetryTarget, author: string | null): Promise<Retried> {
    const record = (await this.kept.read(target.place)).review.sends.find(
      (candidate) => candidate.key === target.key,
    );
    if (record === undefined)
      return {
        retried: false,
        words: "Retry delivery sent nothing: VS Code no longer keeps this review",
      };
    const [detail, viewer] = await Promise.all([
      this.sessions.sessionDetail(target.place.sessionId),
      this.sessions.viewerId(),
    ]);
    const agent = liveAgent(detail, viewer);
    if (detail.changeId === null || !mayRetry(record, agent))
      return {
        retried: false,
        words: `Retry delivery sent nothing: this review already reads ${commentLabel(record, null, agent)}`,
      };
    const context: SendContext = {
      place: target.place,
      changeId: detail.changeId,
      viewer,
      author,
    };
    // Claimed before the record is sending again, as a new send is: a window loading it leaves it.
    if (!(await this.kept.claimDrive(target.place, target.key)))
      return {
        retried: false,
        words: "Retry delivery sent nothing: another window of VS Code is delivering this review",
      };
    const retried = await this.#step(context, target.key, {
      kind: "retry",
      at: new Date().toISOString(),
      agent,
    }).catch(async (cause: unknown) => {
      await this.kept.releaseDrive(target.place, target.key).catch(() => undefined);
      throw cause;
    });
    if (retried !== null && nextAction(retried).kind !== "idle")
      await this.#drive(context, target.key);
    else await this.kept.releaseDrive(target.place, target.key);
    return { retried: true };
  }

  /**
   * A window that loads a send it did not see end does not know it was sent: it says so, in what
   * it keeps. One Mend was launching goes on being watched, by reads only.
   */
  async load(context: SendContext): Promise<void> {
    const now = new Date().toISOString();
    // A send another window drives now is that window's: this one neither ends it nor drives it.
    // Its leases are read under the lock: a window claims a send's drive before it keeps the send,
    // so a send kept sending since, by a new Send or a Retry, reads driven here.
    const undriven = new Set<string>();
    /** How long each other window drives a send for, unless it renews its lease. */
    const drivenFor: Array<number> = [];
    const loaded = await this.host.keepAt(context.place, async (review) => {
      undriven.clear();
      drivenFor.length = 0;
      for (const record of review.sends) {
        if (!holdsComments(record) || this.#driving.has(driveId(context, record.key))) continue;
        const left = await this.kept.drivenFor(context.place, record.key);
        if (left === null) undriven.add(record.key);
        else drivenFor.push(left);
      }
      return {
        ...review,
        sends: review.sends.map((record) =>
          undriven.has(record.key) ? step(record, { kind: "loaded" }, now) : record,
        ),
      };
    });
    for (const record of loaded.sends)
      if (record.phase.kind === "delivering" && undriven.has(record.key))
        void this.#drive(context, record.key);
    // A window reloaded during a send left its lease behind: once that lease goes stale, nobody
    // drives the send, so this window loads it again then.
    if (drivenFor.length > 0) this.#loadAgainIn(context.place, Math.min(...drivenFor));
  }

  #loadAgainIn(place: ReviewPlace, ms: number): void {
    if (this.#loadAgain !== null) clearTimeout(this.#loadAgain);
    this.#loadAgain = setTimeout(() => {
      this.#loadAgain = null;
      this.host.loadAgain(place);
    }, ms);
    this.#loadAgain.unref();
  }

  /** A record's next step, kept for its own session whichever session the section follows. */
  async #step(context: SendContext, key: string, event: SendEvent): Promise<SendRecord | null> {
    if (
      this.#leased.has(driveId(context, key)) &&
      !(await this.kept.renewDrive(context.place, key))
    )
      throw new DriveLost();
    const now = new Date().toISOString();
    const next = await this.host.keepAt(context.place, (review) =>
      stepReview(review, key, event, now),
    );
    return next.sends.find((record) => record.key === key) ?? null;
  }

  /**
   * One drive per record, by server, session and key: a second Send or Retry while one runs goes
   * after it, so a record put back to sending is always driven.
   */
  async #drive(context: SendContext, key: string): Promise<void> {
    const id = driveId(context, key);
    const before = this.#driving.get(id) ?? Promise.resolve();
    const run: Promise<void> = before
      .then(() => this.#driveOnce(context, key))
      .catch((cause: unknown) => this.host.fail("error", errorWords(cause), { cause }))
      .finally(() => {
        if (this.#driving.get(id) === run) this.#driving.delete(id);
      });
    this.#driving.set(id, run);
    return run;
  }

  /** One window drives a send, so one key is posted and delivered once. */
  async #driveOnce(context: SendContext, key: string): Promise<void> {
    if (!(await this.kept.claimDrive(context.place, key))) return;
    const id = driveId(context, key);
    this.#leased.add(id);
    try {
      await this.#run(context, key);
    } catch (cause) {
      if (!(cause instanceof DriveLost)) throw cause;
    } finally {
      this.#leased.delete(id);
      await this.kept.releaseDrive(context.place, key).catch(() => undefined);
    }
  }

  async #run(context: SendContext, key: string): Promise<void> {
    const { changeId } = context;
    const { sessionId } = context.place;
    const retry: RetryTarget = { place: context.place, key };
    const files = new Map<string, ReadonlyArray<ChangeFile>>();
    const sliceFiles = async (sliceId: string): Promise<ReadonlyArray<ChangeFile>> => {
      const known = files.get(sliceId);
      if (known !== undefined) return known;
      const read = (await this.client.sliceDiff(changeId, sliceId)).files;
      files.set(sliceId, read);
      return read;
    };
    for (let turns = 0; turns < MAX_TURNS; turns += 1) {
      if (!(await this.kept.renewDrive(context.place, key))) return;
      const record = (await this.kept.read(context.place)).review.sends.find(
        (candidate) => candidate.key === key,
      );
      if (record === undefined) return;
      const action = nextAction(record);
      try {
        switch (action.kind) {
          case "idle":
            // A delivery Mend answered as failed (a launch it could not make) says so once.
            if (record.phase.kind === "failed")
              this.host.fail(
                `delivery:${key}`,
                `Mend could not deliver the review: ${record.phase.words}`,
                { retry },
              );
            this.host.settled(sessionId);
            return;
          case "reconcile": {
            const comments = await this.client.comments(changeId);
            const claimed = new Set(
              record.items.flatMap((item) =>
                posts(item) && item.post.kind === "posted" ? [item.post.commentId] : [],
              ),
            );
            for (const item of record.items) {
              if (!posts(item) || item.post.kind !== "posting") continue;
              const found = postedComment(item.post, item.pending.sliceId, comments, claimed);
              if (found !== null) claimed.add(found);
              await this.#step(
                context,
                key,
                found === null
                  ? { kind: "not-posted", pendingId: item.pending.id }
                  : { kind: "posted", pendingId: item.pending.id, commentId: found },
              );
            }
            break;
          }
          case "post": {
            const { pending } = action;
            const { target, body } = commentTarget(await sliceFiles(pending.sliceId), pending);
            const before = (await this.client.comments(changeId)).map((comment) => comment.id);
            await this.#step(context, key, {
              kind: "post-started",
              pendingId: pending.id,
              attempt: { body, target, author: context.author, before },
            });
            const posted = await writing(
              this.client.postComment(changeId, pending.sliceId, target, body),
            );
            await this.#step(context, key, {
              kind: "posted",
              pendingId: pending.id,
              commentId: posted.id,
            });
            break;
          }
          case "open": {
            // A draft dismissed since she accepted it, here or anywhere, is never opened again.
            const draft = (await this.client.comments(changeId)).find(
              (comment) => comment.id === action.draftId,
            );
            if (draft === undefined || draft.state === "dismissed") {
              await this.#step(context, key, { kind: "draft-gone", draftId: action.draftId });
              this.host.fail(
                `delivery:${key}`,
                `${DRAFT_GONE}. Send review composes it again without that draft, from your comments as they are now.`,
                { text: record.instruction, tone: "warning" },
              );
              this.host.settled(sessionId);
              return;
            }
            if (draft.state === "draft")
              await writing(this.client.setCommentState(changeId, action.draftId, "open"));
            await this.#step(context, key, { kind: "opened", draftId: action.draftId });
            break;
          }
          case "dismiss-draft": {
            // Her words are on Mend: a draft left beside them never holds the review back.
            try {
              const draft = (await this.client.comments(changeId)).find(
                (comment) => comment.id === action.draftId,
              );
              if (draft?.state === "draft")
                await this.client.setCommentState(changeId, action.draftId, "dismissed");
            } catch (cause) {
              await this.#step(context, key, {
                kind: "draft-left",
                draftId: action.draftId,
                words: errorWords(cause),
              });
              break;
            }
            await this.#step(context, key, { kind: "draft-dismissed", draftId: action.draftId });
            break;
          }
          case "deliver": {
            const detail = await this.sessions.sessionDetail(sessionId);
            const answered = await writing(this.client.deliver(sessionId, action.request));
            const next = await this.#step(context, key, {
              kind: "answered",
              status: answered.status,
              error: answered.error,
              agent: liveAgent(detail, context.viewer) ?? { kind: "other" },
            });
            const left = next !== null && handedOver(next) ? draftsLeft(next) : [];
            if (left.length > 0)
              this.host.fail(
                `draft-left:${key}`,
                `Mend sent the review. The Mend draft your words replace is still on Mend, because VS Code could not dismiss it: ${left.join(" ")}`,
                { tone: "warning" },
              );
            break;
          }
          case "paste": {
            const pasted = await this.paste(sessionId, action.processId, action.text);
            if (pasted === "pasted") {
              await this.#step(context, key, { kind: "pasted" });
              break;
            }
            await this.#step(context, key, { kind: "paste-failed", gone: pasted === "agent-gone" });
            const agent = record.phase.kind === "in-terminal" ? record.phase.agent : "the agent";
            this.host.fail(`paste:${key}`, pasteWords(pasted, agent), { retry });
            break;
          }
          case "skip-paste":
            await this.#step(context, key, { kind: "skipped" });
            this.host.fail(`paste:${key}`, action.words, { tone: "warning" });
            break;
          case "watch": {
            await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
            const [followUp, comments] = await Promise.all([
              this.client.followUp(sessionId),
              this.client.comments(changeId),
            ]);
            const ours = followUp !== null && followUp.key === key ? followUp : null;
            const ids = commentIds(record) ?? [];
            const sent =
              ids.length > 0 &&
              ids.every(
                (id) =>
                  comments.find((comment) => comment.id === id)?.sentToSessionId === sessionId,
              );
            await this.#step(context, key, {
              kind: "follow-up",
              status: ours?.status ?? null,
              error: ours?.error ?? null,
              others: followUp !== null && ours === null,
              sent,
            });
            break;
          }
        }
      } catch (thrown) {
        if (thrown instanceof DriveLost) throw thrown;
        const retryable = !refuses(thrown);
        const cause = thrown instanceof WriteFailed ? thrown.failure : thrown;
        await this.#step(context, key, { kind: "failed", words: errorWords(cause), retryable });
        this.host.fail(
          `delivery:${key}`,
          `Mend could not deliver the review: ${errorWords(cause)}`,
          {
            cause,
            retry: retryable ? retry : null,
          },
        );
        this.host.settled(sessionId);
        return;
      }
    }
    // Mend has not answered in all this time: the review reads failed, so Retry is offered.
    const words = "Mend has not said the review was delivered";
    await this.#step(context, key, { kind: "failed", words, retryable: true });
    this.host.fail(`delivery:${key}`, `${words}. Retry delivery asks again with the same key.`, {
      retry,
    });
    this.host.settled(sessionId);
  }
}

/** The session's live agent, when it is a terminal one: Mend holds its follow-ups pending. */
export const liveAgent = (detail: SessionDetail, viewer: string | null): LiveAgent | null => {
  const agent = detail.currentAgent;
  if (agent === null || agent.exitedAt !== null) return null;
  if (agent.kind !== "agent-pty") return { kind: "other" };
  return {
    kind: "terminal",
    name: agent.label ?? agent.harness ?? detail.session.harness,
    hers: viewer !== null && detail.session.ownerUserId === viewer,
    processId: agent.id,
  };
};
