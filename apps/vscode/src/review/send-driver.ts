import type { MendClient } from "../client.js";
import type { MendConnection } from "../config.js";
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
  needs,
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
  /** When it happened; now, unless every window must name it alike. */
  readonly at?: string;
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
}

/**
 * A failed delivery's toast, named by its record and when it failed: the same in every window, so
 * whichever window she focuses shows it, once.
 */
export const failedDelivery = (
  place: ReviewPlace,
  record: SendRecord,
): { readonly what: string; readonly words: string; readonly options: FailOptions } | null =>
  record.phase.kind !== "failed"
    ? null
    : {
        what: `delivery:${record.key}`,
        words: `Mend could not deliver the review: ${record.phase.words}`,
        options: { retry: { place, key: record.key }, at: record.phase.at },
      };

/** Whether a new record was kept and is now driven, and why not. */
export type Recorded =
  | { readonly kind: "recorded" }
  | { readonly kind: "not-recorded" }
  | { readonly kind: "failed"; readonly cause: unknown };

const driveId = (context: SendContext, key: string): string =>
  JSON.stringify([context.place.url, context.place.viewer, context.place.sessionId, key]);

/** Another window took over a send this window was driving: this one does nothing more for it. */
class DriveLost extends Error {}

/**
 * VS Code is connected to another server or account than the send's: this window sends nothing
 * more of it, and leaves it as kept for a window connected to its own to pick up.
 */
class Suspended extends Error {}

const SWITCHED = "VS Code connected to another Mend server or account before Mend answered";

const pasteWords = (pasted: Exclude<Pasted, "pasted">, agent: string): string =>
  pasted === "agent-gone"
    ? `${agent} exited before the review was pasted, so nothing was pasted. Mend holds the follow-up pending: Retry delivery sends it to the stopped session.`
    : `VS Code could not attach ${agent}'s terminal here, so nothing was pasted. Mend holds the follow-up pending: Retry delivery pastes it again.`;

/** Mend holds the follow-up pending, and the paste may be in the agent's input, in part or whole. */
const cutShortWords = (why: string, agent: string): string =>
  `${why}, so some or all of it may be in ${agent}'s input. Mend holds the follow-up pending: check ${agent}'s input before Retry delivery pastes it again.`;

/** What a record a window left mid-paste reads, said once by the window that finds it. */
const abandonedPasteWords = (record: SendRecord): string | null => {
  const { phase } = record;
  if (phase.kind !== "in-terminal" || phase.paste.kind !== "failed") return null;
  return phase.paste.mayHaveLanded
    ? cutShortWords(
        `VS Code closed while it pasted the review into ${phase.agent}'s terminal`,
        phase.agent,
      )
    : `VS Code closed before it pasted the review into ${phase.agent}'s terminal, so nothing was pasted. Mend holds the follow-up pending: Retry delivery pastes it.`;
};

const CLOSED = "VS Code closed before Mend answered";

/** How soon a window looks again at a send its own drive left, when the drive failed. */
const LOOK_AGAIN_MS = 1_000;

/**
 * How often a launch is watched, and how many times before it reads failed. Only watching counts:
 * posting her comments and dismissing drafts end on their own, however many there are.
 */
const WATCH_MS = 3_000;
const MAX_WATCHES = 400;

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
  /**
   * When this window looks again at a send no drive here moves on: when another window's lease on
   * it goes stale, or soon after this window's own drive of it failed. By drive.
   */
  readonly #lookAgain = new Map<string, NodeJS.Timeout>();
  /** What a send this window stopped driving reads once a window finds it left, by drive. */
  readonly #stopped = new Map<string, string>();

  constructor(
    private readonly kept: KeptReviews,
    private readonly client: ReviewClient,
    private readonly sessions: Pick<MendClient, "sessionDetail" | "viewerId" | "connection">,
    /** G12 fallback: the agent's terminal attached here, the text pasted into that process, no Enter. */
    private readonly paste: (sessionId: string, processId: string, text: string) => Promise<Pasted>,
    private readonly host: DriverHost,
  ) {}

  dispose(): void {
    for (const timer of this.#lookAgain.values()) clearTimeout(timer);
    this.#lookAgain.clear();
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
    if ((await this.#bind(target.place)) === null)
      return {
        retried: false,
        words:
          "Retry delivery sent nothing: VS Code is connected to another Mend server or account than this review's",
      };
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
    const at = new Date().toISOString();
    const ofKey = (review: SessionReview): SendRecord | undefined =>
      review.sends.find((candidate) => candidate.key === target.key);
    // Checked again as kept, under the lock: another window may have moved it since it was read.
    let moved = false;
    const retried = await this.host
      .keepAt(target.place, (review) => {
        const next = stepReview(review, target.key, { kind: "retry", at, agent }, at);
        const before = ofKey(review);
        const after = ofKey(next);
        moved =
          before !== undefined &&
          after !== undefined &&
          JSON.stringify(before.phase) !== JSON.stringify(after.phase);
        return next;
      })
      .catch(async (cause: unknown) => {
        await this.kept.releaseDrive(target.place, target.key).catch(() => undefined);
        throw cause;
      });
    const after = ofKey(retried);
    if (!moved || after === undefined) {
      await this.kept.releaseDrive(target.place, target.key);
      return {
        retried: false,
        words:
          after === undefined
            ? "Retry delivery sent nothing: VS Code no longer keeps this review"
            : `Retry delivery sent nothing: this review already reads ${commentLabel(after, null, agent)}`,
      };
    }
    if (nextAction(after).kind !== "idle") await this.#drive(context, target.key);
    else await this.kept.releaseDrive(target.place, target.key);
    return { retried: true };
  }

  /**
   * Run on every read of the kept review at `context.place`: a send the driver needs that no window
   * drives is picked up here, whichever window left it and whenever this window started following
   * the session. Only a send no drive here moves on and no look again is due for costs the lock.
   */
  async recover(context: SendContext, review: SessionReview): Promise<void> {
    const left = review.sends.some((record) => {
      const id = driveId(context, record.key);
      return needs(record) === "driver" && !this.#driving.has(id) && !this.#lookAgain.has(id);
    });
    if (left) await this.#load(context);
  }

  /**
   * A window that finds a send it did not see end does not know it was sent: it says so, in what
   * it keeps. One Mend was launching goes on being watched, by reads only.
   */
  async #load(context: SendContext): Promise<void> {
    if ((await this.#bind(context.place)) === null) return;
    const now = new Date().toISOString();
    // A send another window drives now is that window's: this one neither ends it nor drives it.
    // Its leases are read under the lock: a window claims a send's drive before it keeps the send,
    // so a send kept sending since, by a new Send or a Retry, reads driven here.
    const undriven = new Set<string>();
    /** How long another window drives each send for, unless it renews its lease. */
    const drivenFor = new Map<string, number>();
    const loaded = await this.host.keepAt(context.place, async (review) => {
      undriven.clear();
      drivenFor.clear();
      for (const record of review.sends) {
        if (needs(record) !== "driver" || this.#driving.has(driveId(context, record.key))) continue;
        if (this.kept.drives(context.place, record.key)) continue;
        const left = await this.kept.drivenFor(context.place, record.key);
        if (left === null) undriven.add(record.key);
        else drivenFor.set(record.key, left);
      }
      return {
        ...review,
        sends: review.sends.map((record) => {
          if (!undriven.has(record.key)) return record;
          const words = this.#stopped.get(driveId(context, record.key)) ?? CLOSED;
          return step(record, { kind: "abandoned", words }, now);
        }),
      };
    });
    for (const key of undriven) this.#stopped.delete(driveId(context, key));
    for (const record of loaded.sends) {
      if (!undriven.has(record.key)) continue;
      if (nextAction(record).kind !== "idle") void this.#drive(context, record.key);
      const words = abandonedPasteWords(record);
      if (words !== null)
        this.host.fail(`paste:${record.key}`, words, {
          retry: { place: context.place, key: record.key },
        });
    }
    // A window reloaded during a send left its lease behind: once that lease goes stale, nobody
    // drives the send, so this window looks again then.
    for (const [key, ms] of drivenFor) this.#lookAgainIn(context, key, ms);
  }

  #lookAgainIn(context: SendContext, key: string, ms: number): void {
    const id = driveId(context, key);
    const armed = this.#lookAgain.get(id);
    if (armed !== undefined) clearTimeout(armed);
    const timer = setTimeout(() => {
      this.#lookAgain.delete(id);
      // A look that fails waits for the next read of the kept review, which looks again.
      void this.#load(context).catch(() => undefined);
    }, ms);
    timer.unref();
    this.#lookAgain.set(id, timer);
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
      .catch((cause: unknown) => {
        this.host.fail("error", errorWords(cause), { cause });
        // The drive could not keep where the send is: it is left, and looked at again soon.
        this.#lookAgainIn(context, key, LOOK_AGAIN_MS);
      })
      .finally(() => {
        if (this.#driving.get(id) === run) this.#driving.delete(id);
      });
    this.#driving.set(id, run);
    return run;
  }

  /**
   * The connection a drive of a send kept at `place` talks to Mend through, whatever VS Code connects
   * to later; null when VS Code is connected to another server or account now.
   */
  async #bind(place: ReviewPlace): Promise<MendConnection | null> {
    const connection = await this.sessions.connection();
    if (connection.url !== place.url) return null;
    const viewer = await this.sessions.viewerId();
    return viewer === null || viewer === place.viewer ? connection : null;
  }

  /** Throws `Suspended` once VS Code no longer connects through `bound`. */
  async #still(bound: MendConnection): Promise<void> {
    const now = await this.sessions.connection();
    if (now.url !== bound.url || now.token !== bound.token) throw new Suspended();
  }

  /** One window drives a send, so one key is posted and delivered once. */
  async #driveOnce(context: SendContext, key: string): Promise<void> {
    if (!(await this.kept.claimDrive(context.place, key))) return;
    const id = driveId(context, key);
    this.#leased.add(id);
    try {
      const bound = await this.#bind(context.place);
      if (bound === null) throw new Suspended();
      await this.#run(context, key, bound);
    } catch (cause) {
      if (cause instanceof Suspended) this.#stopped.set(id, SWITCHED);
      else if (!(cause instanceof DriveLost)) throw cause;
    } finally {
      this.#leased.delete(id);
      await this.kept.releaseDrive(context.place, key).catch(() => undefined);
    }
  }

  async #run(context: SendContext, key: string, bound: MendConnection): Promise<void> {
    const client = this.client.pinned(bound);
    const { changeId } = context;
    const { sessionId } = context.place;
    const retry: RetryTarget = { place: context.place, key };
    const files = new Map<string, ReadonlyArray<ChangeFile>>();
    const sliceFiles = async (sliceId: string): Promise<ReadonlyArray<ChangeFile>> => {
      const known = files.get(sliceId);
      if (known !== undefined) return known;
      const read = (await client.sliceDiff(changeId, sliceId)).files;
      files.set(sliceId, read);
      return read;
    };
    let watches = 0;
    while (watches < MAX_WATCHES) {
      if (!(await this.kept.renewDrive(context.place, key))) return;
      await this.#still(bound);
      const record = (await this.kept.read(context.place)).review.sends.find(
        (candidate) => candidate.key === key,
      );
      if (record === undefined) return;
      const action = nextAction(record);
      try {
        switch (action.kind) {
          case "idle":
            // A delivery Mend answered as failed (a launch it could not make) says so once.
            this.#sayFailed(context.place, record);
            this.host.settled(sessionId);
            return;
          case "reconcile": {
            const comments = await client.comments(changeId);
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
            const before = (await client.comments(changeId)).map((comment) => comment.id);
            await this.#step(context, key, {
              kind: "post-started",
              pendingId: pending.id,
              attempt: { body, target, author: context.author, before },
            });
            const posted = await writing(
              client.postComment(changeId, pending.sliceId, target, body),
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
            const draft = (await client.comments(changeId)).find(
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
              await writing(client.setCommentState(changeId, action.draftId, "open"));
            await this.#step(context, key, { kind: "opened", draftId: action.draftId });
            break;
          }
          case "dismiss-draft": {
            // Her words are on Mend: a draft left beside them never holds the review back.
            try {
              const draft = (await client.comments(changeId)).find(
                (comment) => comment.id === action.draftId,
              );
              if (draft?.state === "draft")
                await client.setCommentState(changeId, action.draftId, "dismissed");
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
            const answered = await writing(client.deliver(sessionId, action.request));
            // Read once Mend answered: an agent that started meanwhile is where Mend holds it.
            await this.#still(bound);
            const detail = await this.sessions.sessionDetail(sessionId);
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
            const agent = record.phase.kind === "in-terminal" ? record.phase.agent : "the agent";
            await this.#step(context, key, { kind: "paste-started" });
            let pasted: Pasted;
            try {
              pasted = await this.paste(sessionId, action.processId, action.text);
            } catch (cause) {
              await this.#step(context, key, { kind: "paste-failed", why: "interrupted" });
              this.host.fail(
                `paste:${key}`,
                cutShortWords(
                  `VS Code could not finish pasting the review into ${agent}'s terminal: ${errorWords(cause)}`,
                  agent,
                ),
                { cause, retry },
              );
              break;
            }
            if (pasted === "pasted") {
              await this.#step(context, key, { kind: "pasted" });
              break;
            }
            await this.#step(context, key, { kind: "paste-failed", why: pasted });
            this.host.fail(`paste:${key}`, pasteWords(pasted, agent), { retry });
            break;
          }
          case "skip-paste":
            await this.#step(context, key, { kind: "skipped" });
            this.host.fail(`paste:${key}`, action.words, { tone: "warning" });
            break;
          case "watch": {
            watches += 1;
            await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
            const [followUp, comments] = await Promise.all([
              client.followUp(sessionId),
              client.comments(changeId),
            ]);
            const ours = followUp !== null && followUp.key === key ? followUp : null;
            if (ours?.status === "pending") await this.#still(bound);
            const agent =
              ours?.status === "pending"
                ? liveAgent(await this.sessions.sessionDetail(sessionId), context.viewer)
                : null;
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
              agent,
            });
            break;
          }
        }
      } catch (thrown) {
        if (thrown instanceof DriveLost || thrown instanceof Suspended) throw thrown;
        const retryable = !refuses(thrown);
        const cause = thrown instanceof WriteFailed ? thrown.failure : thrown;
        const id = driveId(context, key);
        // Should this step not be kept either, the window that finds the send left says why.
        this.#stopped.set(id, errorWords(cause));
        const failed = await this.#step(context, key, {
          kind: "failed",
          words: errorWords(cause),
          retryable,
        });
        this.#stopped.delete(id);
        if (!this.#sayFailed(context.place, failed, cause))
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
    this.#sayFailed(
      context.place,
      await this.#step(context, key, { kind: "failed", words, retryable: true }),
    );
    this.host.settled(sessionId);
  }

  /** Says a failed record failed, by the name every window gives it: whether it was failed. */
  #sayFailed(place: ReviewPlace, record: SendRecord | null, cause?: unknown): boolean {
    const failed = record === null ? null : failedDelivery(place, record);
    if (failed === null) return false;
    this.host.fail(failed.what, failed.words, { ...failed.options, cause });
    return true;
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
