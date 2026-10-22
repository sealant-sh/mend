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
  type FollowUpRead,
  type LiveAgent,
  type SendEvent,
  type SendRecord,
} from "./delivery.js";
import type { KeptReviews, ReviewPlace } from "./kept-reviews.js";
import type { SessionReview } from "./pending.js";
import type { ReviewClient } from "./review-client.js";
import type { ChangeFile } from "./review-wire.js";

export interface RetryTarget {
  readonly place: ReviewPlace;
  readonly key: string;
}

export type Retried =
  | { readonly retried: true }
  | { readonly retried: false; readonly words: string };

export interface SendContext {
  readonly place: ReviewPlace;
  readonly changeId: string;
  readonly viewer: string | null;
  readonly author: string | null;
}

export interface FailOptions {
  readonly at?: string;
  readonly cause?: unknown;
  readonly retry?: RetryTarget | null;
  readonly text?: string;
  readonly tone?: "error" | "warning";
}

export interface DriverHost {
  keepAt(
    place: ReviewPlace,
    update: (review: SessionReview) => SessionReview | Promise<SessionReview>,
  ): Promise<SessionReview>;
  fail(what: string, words: string, options?: FailOptions): void;
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

const sendOf = (review: SessionReview, key: string): SendRecord | undefined =>
  review.sends.find((record) => record.key === key);

/** A keep that leaves the send needing its drive when it did not before: a new send, or a Retry. */
const startsDrive = (before: SendRecord | undefined, after: SendRecord | undefined): boolean =>
  after !== undefined &&
  needs(after) === "driver" &&
  (before === undefined || needs(before) !== "driver");

/**
 * What a claimed keep did: kept the send needing its drive, under this window's lease; left it as
 * it reads, the lease given back; or found another window driving it.
 */
type Claimed =
  | { readonly kind: "kept"; readonly record: SendRecord }
  | { readonly kind: "unmoved"; readonly record: SendRecord | undefined }
  | { readonly kind: "elsewhere" };

const driveId = (context: SendContext, key: string): string =>
  JSON.stringify([context.place.url, context.place.viewer, context.place.sessionId, key]);

class DriveLost extends Error {}

class Suspended extends Error {}

const SWITCHED = "VS Code connected to another Mend server or account before Mend answered";

const pasteWords = (pasted: Exclude<Pasted, "pasted">, agent: string): string =>
  pasted === "agent-gone"
    ? `${agent} exited before the review was pasted, so nothing was pasted. Mend holds the follow-up pending: Retry delivery sends it to the stopped session.`
    : `VS Code could not attach ${agent}'s terminal here, so nothing was pasted. Mend holds the follow-up pending: Retry delivery pastes it again.`;

const cutShortWords = (why: string, agent: string): string =>
  `${why}, so some or all of it may be in ${agent}'s input. Mend holds the follow-up pending: check ${agent}'s input before Retry delivery pastes it again.`;

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

const LOOK_AGAIN_MS = 1_000;

/**
 * How often a launch is watched, and how many times before it reads failed. Only watching counts:
 * posting her comments and dismissing drafts end on their own, however many there are.
 */
const WATCH_MS = 3_000;
const MAX_WATCHES = 400;

export const errorWords = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Mend could not read this change.";

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

const refuses = (thrown: unknown): boolean =>
  thrown instanceof WriteFailed &&
  thrown.failure instanceof MendApiError &&
  thrown.failure.status !== null &&
  thrown.failure.status >= 400 &&
  thrown.failure.status < 500 &&
  !NOT_A_REFUSAL.has(thrown.failure.status);

export class SendDriver {
  readonly #driving = new Map<string, Promise<void>>();
  readonly #leased = new Set<string>();
  readonly #lookAgain = new Map<string, NodeJS.Timeout>();
  readonly #stopped = new Map<string, string>();

  constructor(
    private readonly kept: KeptReviews,
    private readonly client: ReviewClient,
    private readonly sessions: Pick<MendClient, "sessionDetail" | "viewerId" | "connection">,
    private readonly paste: (sessionId: string, processId: string, text: string) => Promise<Pasted>,
    private readonly host: DriverHost,
  ) {}

  dispose(): void {
    for (const timer of this.#lookAgain.values()) clearTimeout(timer);
    this.#lookAgain.clear();
  }

  async record(
    context: SendContext,
    key: string,
    keep: (review: SessionReview) => SessionReview,
  ): Promise<Recorded> {
    let claimed: Claimed;
    try {
      claimed = await this.#claimAndKeep(context.place, key, keep);
    } catch (cause) {
      return { kind: "failed", cause };
    }
    if (claimed.kind !== "kept") return { kind: "not-recorded" };
    void this.#drive(context, key);
    return { kind: "recorded" };
  }

  async retry(target: RetryTarget, author: string | null): Promise<Retried> {
    const bound = await this.#bind(target.place);
    if (bound === null)
      return {
        retried: false,
        words:
          "Retry delivery sent nothing: VS Code is connected to another Mend server or account than this review's",
      };
    const record = sendOf((await this.kept.read(target.place)).review, target.key);
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
    // A retry that pastes asks Mend first: another client may have delivered the key, or sent a
    // newer review, since this window kept it held.
    let mend: FollowUpRead | null = null;
    if (record.phase.kind !== "failed" && agent?.kind === "terminal")
      try {
        mend = await this.#readFollowUp(this.client.pinned(bound), context, record);
      } catch (cause) {
        return {
          retried: false,
          words: `Retry delivery sent nothing: Mend could not say whether it still holds this review: ${errorWords(cause)}`,
        };
      }
    const at = new Date().toISOString();
    const claimed = await this.#claimAndKeep(target.place, target.key, (review) =>
      stepReview(review, target.key, { kind: "retry", at, agent, mend }, at),
    );
    switch (claimed.kind) {
      case "elsewhere":
        return {
          retried: false,
          words: "Retry delivery sent nothing: another window of VS Code is delivering this review",
        };
      case "unmoved":
        return {
          retried: false,
          words:
            claimed.record === undefined
              ? "Retry delivery sent nothing: VS Code no longer keeps this review"
              : `Retry delivery sent nothing: this review already reads ${commentLabel(claimed.record, null, agent)}`,
        };
      case "kept":
        if (nextAction(claimed.record).kind !== "idle") await this.#drive(context, target.key);
        else await this.kept.releaseDrive(target.place, target.key);
        return { retried: true };
    }
  }

  /**
   * Keeps `update` to the send with this key, its drive claimed first: a window loading the review
   * between this keep and the drive reads the send driven here, so it never fails it as one a
   * closed window left. The claim is given back when the keep fails, or when the send does not
   * need its drive after it.
   */
  async #claimAndKeep(
    place: ReviewPlace,
    key: string,
    update: (review: SessionReview) => SessionReview,
  ): Promise<Claimed> {
    if (!(await this.kept.claimDrive(place, key))) return { kind: "elsewhere" };
    let moved = false;
    let review: SessionReview;
    try {
      review = await this.host.keepAt(place, (current) => {
        const next = update(current);
        moved = startsDrive(sendOf(current, key), sendOf(next, key));
        return next;
      });
    } catch (cause) {
      await this.kept.releaseDrive(place, key).catch(() => undefined);
      throw cause;
    }
    const record = sendOf(review, key);
    if (moved && record !== undefined) return { kind: "kept", record };
    await this.kept.releaseDrive(place, key);
    return { kind: "unmoved", record };
  }

  async recover(context: SendContext, review: SessionReview): Promise<void> {
    const left = review.sends.some((record) => {
      const id = driveId(context, record.key);
      return needs(record) === "driver" && !this.#driving.has(id) && !this.#lookAgain.has(id);
    });
    if (left) await this.#load(context);
  }

  async #load(context: SendContext): Promise<void> {
    if ((await this.#bind(context.place)) === null) return;
    const now = new Date().toISOString();
    const undriven = new Set<string>();
    const drivenFor = new Map<string, number>();
    const loaded = await this.host.keepAt(context.place, async (review) => {
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
    for (const [key, ms] of drivenFor) this.#lookAgainIn(context, key, ms);
  }

  #lookAgainIn(context: SendContext, key: string, ms: number): void {
    const id = driveId(context, key);
    const armed = this.#lookAgain.get(id);
    if (armed !== undefined) clearTimeout(armed);
    const timer = setTimeout(() => {
      this.#lookAgain.delete(id);
      void this.#load(context).catch(() => undefined);
    }, ms);
    timer.unref();
    this.#lookAgain.set(id, timer);
  }

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
    return sendOf(next, key) ?? null;
  }

  async #drive(context: SendContext, key: string): Promise<void> {
    const id = driveId(context, key);
    const before = this.#driving.get(id) ?? Promise.resolve();
    const run: Promise<void> = before
      .then(() => this.#driveOnce(context, key))
      .catch((cause: unknown) => {
        this.host.fail("error", errorWords(cause), { cause });
        this.#lookAgainIn(context, key, LOOK_AGAIN_MS);
      })
      .finally(() => {
        if (this.#driving.get(id) === run) this.#driving.delete(id);
      });
    this.#driving.set(id, run);
    return run;
  }

  async #bind(place: ReviewPlace): Promise<MendConnection | null> {
    const connection = await this.sessions.connection();
    if (connection.url !== place.url) return null;
    const viewer = await this.sessions.viewerId();
    return viewer === null || viewer === place.viewer ? connection : null;
  }

  async #still(bound: MendConnection): Promise<void> {
    const now = await this.sessions.connection();
    if (now.url !== bound.url || now.token !== bound.token) throw new Suspended();
  }

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
      const record = sendOf((await this.kept.read(context.place)).review, key);
      if (record === undefined) return;
      const action = nextAction(record);
      try {
        switch (action.kind) {
          case "idle":
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
            // Only a paste kept as started is made: one replaced since it was read pastes nothing.
            const started = await this.#step(context, key, { kind: "paste-started" });
            if (started?.phase.kind !== "in-terminal" || started.phase.paste.kind !== "pasting")
              break;
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
            const read = await this.#readFollowUp(client, context, record);
            if (read.status === "pending") await this.#still(bound);
            const agent =
              read.status === "pending"
                ? liveAgent(await this.sessions.sessionDetail(sessionId), context.viewer)
                : null;
            await this.#step(context, key, { kind: "follow-up", ...read, agent });
            break;
          }
        }
      } catch (thrown) {
        if (thrown instanceof DriveLost || thrown instanceof Suspended) throw thrown;
        const retryable = !refuses(thrown);
        const cause = thrown instanceof WriteFailed ? thrown.failure : thrown;
        const id = driveId(context, key);
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
    const words = "Mend has not said the review was delivered";
    this.#sayFailed(
      context.place,
      await this.#step(context, key, { kind: "failed", words, retryable: true }),
    );
    this.host.settled(sessionId);
  }

  /** What Mend reads now about the record's key and its comments. */
  async #readFollowUp(
    client: ReviewClient,
    context: SendContext,
    record: SendRecord,
  ): Promise<FollowUpRead> {
    const { sessionId } = context.place;
    const [followUp, comments] = await Promise.all([
      client.followUp(sessionId),
      client.comments(context.changeId),
    ]);
    const ours = followUp !== null && followUp.key === record.key ? followUp : null;
    const ids = commentIds(record) ?? [];
    return {
      status: ours?.status ?? null,
      error: ours?.error ?? null,
      others: followUp !== null && ours === null,
      sent:
        ids.length > 0 &&
        ids.every(
          (id) => comments.find((comment) => comment.id === id)?.sentToSessionId === sessionId,
        ),
    };
  }

  #sayFailed(place: ReviewPlace, record: SendRecord | null, cause?: unknown): boolean {
    const failed = record === null ? null : failedDelivery(place, record);
    if (failed === null) return false;
    this.host.fail(failed.what, failed.words, { ...failed.options, cause });
    return true;
  }
}

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
