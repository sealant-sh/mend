import { refusedSignIn } from "../error-toast.js";
import { MendApiError } from "../mend-http.js";
import type { SessionDetail } from "../types.js";
import type { PasteReview, Pasted } from "./agent-paste.js";
import { boundConnection, Unbound, type DriverReads } from "./binding.js";
import {
  admits,
  commentIds,
  commentLabel,
  commentTarget,
  needs,
  mayRetry,
  nextAction,
  postedComment,
  posts,
  step,
  stepReview,
  type FollowUpRead,
  type LiveAgent,
  type StopReason,
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

/** A toast a kept send says: the same in every window, so the one she looks at shows it once. */
export interface Told {
  readonly what: string;
  readonly words: string;
  readonly options: FailOptions;
}

/**
 * What a kept send leaves her to know: its failed delivery, named by when it failed, and every
 * notice a step kept with it, named by its kind and when it was kept.
 */
export const toldOf = (place: ReviewPlace, record: SendRecord): ReadonlyArray<Told> => {
  const retry = { place, key: record.key };
  const failed: ReadonlyArray<Told> =
    record.phase.kind === "failed"
      ? [
          {
            what: `delivery:${record.key}`,
            words: `Mend could not deliver the review: ${record.phase.words}`,
            options: { retry, at: record.phase.at },
          },
        ]
      : [];
  return [
    ...failed,
    ...record.notices.map(
      (notice): Told => ({
        what: `${notice.kind}:${record.key}`,
        words: notice.words,
        options: {
          at: notice.at,
          tone: notice.tone,
          retry: notice.retry ? retry : null,
          ...(notice.text ? { text: record.instruction } : {}),
        },
      }),
    ),
  ];
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

const driveId = (place: ReviewPlace, key: string): string =>
  JSON.stringify([place.url, place.viewer, place.sessionId, key]);

/** Runs `op` once every op queued before it under `id` has settled, so no two interleave. */
const queued = <T>(
  queue: Map<string, Promise<unknown>>,
  id: string,
  op: () => Promise<T>,
): Promise<T> => {
  const run = (queue.get(id) ?? Promise.resolve()).then(op);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queue.set(id, settled);
  void settled.finally(() => {
    if (queue.get(id) === settled) queue.delete(id);
  });
  return run;
};

/** What Retry's admission found: a drive to start, under the claim it kept, or its answer. */
type Admitted =
  | { readonly kind: "drive"; readonly context: SendContext }
  | { readonly kind: "answer"; readonly answer: Retried };

const answer = (words: string): Admitted => ({
  kind: "answer",
  answer: { retried: false, words: `Retry delivery sent nothing: ${words}` },
});

class DriveLost extends Error {}

/** The drive stops, for `why`; the send keeps why as it moves on. */
class Stopped extends Error {
  constructor(
    readonly why: StopReason,
    words = why.kind === "error"
      ? why.words
      : "VS Code connected to another Mend server or account",
  ) {
    super(words);
  }
}

const SWITCHED: StopReason = { kind: "switched" };
const CLOSED: StopReason = { kind: "closed" };

const LOOK_AGAIN_MS = 1_000;
/** How long a look that failed waits at most before the next: it doubles until then. */
const LOOK_AGAIN_MAX_MS = 30_000;
const backoff = (failures: number): number =>
  Math.min(LOOK_AGAIN_MS * 2 ** failures, LOOK_AGAIN_MAX_MS);

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

/** VS Code could not keep a step of the send: its own failure, never Mend's. */
class KeepFailed extends Error {
  constructor(cause: unknown) {
    super(`VS Code could not keep the review: ${errorWords(cause)}`);
  }
}

const writing = async <T>(call: Promise<T>): Promise<T> => {
  try {
    return await call;
  } catch (cause) {
    // A write the binding refused never left VS Code.
    throw cause instanceof Unbound ? cause : new WriteFailed(cause);
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
  /**
   * How many claims this window holds on each send's lease: a new send's, a Retry's, a recovery's.
   * Each claim is given back once by whoever made it, or by the drive it was handed to, and the
   * lease goes only with the last: a Retry that loses never takes the lease from the drive that won.
   */
  readonly #claims = new Map<string, number>();
  /** Claims and releases of each lease, one at a time. */
  readonly #leasing = new Map<string, Promise<unknown>>();
  /** Retries of each send, one at a time: the second reads what the first kept. */
  readonly #retrying = new Map<string, Promise<unknown>>();
  #disposed = false;

  constructor(
    private readonly kept: KeptReviews,
    private readonly client: ReviewClient,
    private readonly sessions: DriverReads,
    private readonly paste: PasteReview,
    private readonly host: DriverHost,
  ) {}

  dispose(): void {
    this.#disposed = true;
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
    const admitted = await queued(this.#retrying, driveId(target.place, target.key), () =>
      this.#admitRetry(target, author),
    );
    if (admitted.kind === "answer") return admitted.answer;
    await this.#drive(admitted.context, target.key);
    return { retried: true };
  }

  async #admitRetry(target: RetryTarget, author: string | null): Promise<Admitted> {
    const record = sendOf((await this.kept.read(target.place)).review, target.key);
    if (record === undefined) return answer("VS Code no longer keeps this review");
    const bind = () => boundConnection(this.sessions, target.place);
    let detail: SessionDetail;
    try {
      detail = await this.sessions.pinned(bind).sessionDetail(target.place.sessionId);
    } catch (cause) {
      if (!(cause instanceof Unbound)) throw cause;
      return answer(cause.message);
    }
    const viewer = target.place.viewer;
    const agent = liveAgent(detail, viewer);
    if (detail.changeId === null || !mayRetry(record, agent))
      return answer(`this review already reads ${commentLabel(record, null, agent)}`);
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
        mend = await this.#readFollowUp(this.client.pinned(bind), context, record);
      } catch (cause) {
        return answer(
          `Mend could not say whether it still holds this review: ${errorWords(cause)}`,
        );
      }
    const at = new Date().toISOString();
    let busy = false;
    const claimed = await this.#claimAndKeep(target.place, target.key, (review) => {
      const next = stepReview(review, target.key, { kind: "retry", at, agent, mend }, at);
      busy =
        startsDrive(sendOf(review, target.key), sendOf(next, target.key)) && !admits(review.sends);
      return busy ? review : next;
    });
    if (busy) return answer("Mend is still sending your last review");
    switch (claimed.kind) {
      case "elsewhere":
        return answer("another window of VS Code is delivering this review");
      case "unmoved":
        return answer(
          claimed.record === undefined
            ? "VS Code no longer keeps this review"
            : `this review already reads ${commentLabel(claimed.record, null, agent)}`,
        );
      case "kept":
        if (nextAction(claimed.record).kind !== "idle") return { kind: "drive", context };
        await this.#release(target.place, target.key);
        return { kind: "answer", answer: { retried: true } };
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
    if (!(await this.#claim(place, key))) return { kind: "elsewhere" };
    let moved = false;
    let review: SessionReview;
    try {
      review = await this.host.keepAt(place, (current) => {
        const next = update(current);
        moved = startsDrive(sendOf(current, key), sendOf(next, key));
        return next;
      });
    } catch (cause) {
      await this.#release(place, key).catch(() => undefined);
      throw cause;
    }
    const record = sendOf(review, key);
    if (moved && record !== undefined) return { kind: "kept", record };
    await this.#release(place, key);
    return { kind: "unmoved", record };
  }

  /** A claim of the send's lease, counted, so this window gives the lease back only with its last. */
  async #claim(place: ReviewPlace, key: string): Promise<boolean> {
    const id = driveId(place, key);
    return queued(this.#leasing, id, async () => {
      if (!(await this.kept.claimDrive(place, key))) return false;
      this.#claims.set(id, (this.#claims.get(id) ?? 0) + 1);
      return true;
    });
  }

  async #release(place: ReviewPlace, key: string): Promise<void> {
    const id = driveId(place, key);
    await queued(this.#leasing, id, async () => {
      const left = (this.#claims.get(id) ?? 1) - 1;
      if (left > 0) {
        this.#claims.set(id, left);
        return;
      }
      this.#claims.delete(id);
      await this.kept.releaseDrive(place, key);
    });
  }

  async recover(context: SendContext, review: SessionReview): Promise<void> {
    const left = review.sends.flatMap((record) => {
      const id = driveId(context.place, record.key);
      return needs(record) === "driver" &&
        !this.#driving.has(id) &&
        !this.#lookAgain.has(id) &&
        !this.kept.drives(context.place, record.key)
        ? [record.key]
        : [];
    });
    if (left.length === 0) return;
    await this.#load(context).catch(() => {
      for (const key of left) this.#lookAgainIn(context, key, backoff(1), 2);
    });
  }

  /**
   * Picks up every send at `context.place` the driver needs and no window drives, as stopped for
   * `stopped`: why this window's drive of that send stopped, when it could not keep why. Any
   * other was left by a window that closed. Throws when it could not look, so the look that asked
   * looks again.
   */
  async #load(
    context: SendContext,
    stopped: { readonly key: string; readonly why: StopReason } | null = null,
  ): Promise<void> {
    await boundConnection(this.sessions, context.place);
    const { place } = context;
    const now = new Date().toISOString();
    const undriven = new Set<string>();
    const drivenFor = new Map<string, number>();
    let loaded: SessionReview;
    try {
      loaded = await this.host.keepAt(place, async (review) => {
        for (const record of review.sends) {
          const id = driveId(context.place, record.key);
          if (needs(record) !== "driver" || this.#driving.has(id) || undriven.has(record.key))
            continue;
          if (this.kept.drives(place, record.key)) continue;
          const left = await this.kept.drivenFor(place, record.key);
          if (left !== null) drivenFor.set(record.key, left);
          // A stale lease is taken over before the send is stepped: the window that held it, if
          // it only slept, finds its next renewal refused and stops.
          else if (await this.#claim(place, record.key)) undriven.add(record.key);
          else drivenFor.set(record.key, LOOK_AGAIN_MS);
        }
        return {
          ...review,
          sends: review.sends.map((record) => {
            if (!undriven.has(record.key)) return record;
            const why = stopped?.key === record.key ? stopped.why : CLOSED;
            return step(record, { kind: "abandoned", why }, now);
          }),
        };
      });
    } catch (cause) {
      for (const key of undriven) await this.#release(place, key).catch(() => undefined);
      throw cause;
    }
    for (const record of loaded.sends) {
      if (!undriven.has(record.key)) continue;
      if (nextAction(record).kind !== "idle") void this.#drive(context, record.key);
      else await this.#release(place, record.key);
    }
    for (const [key, ms] of drivenFor) this.#lookAgainIn(context, key, ms);
  }

  /**
   * Looks at the send again in `ms`. A look that fails looks again later, each wait twice the
   * last up to `LOOK_AGAIN_MAX_MS`: only a look that ran drops it, having left the send done,
   * waiting on her, or driven by a live window, which looks again itself.
   */
  #lookAgainIn(
    context: SendContext,
    key: string,
    ms: number,
    failures = 0,
    why: StopReason | null = null,
  ): void {
    if (this.#disposed) return;
    const id = driveId(context.place, key);
    const armed = this.#lookAgain.get(id);
    if (armed !== undefined) clearTimeout(armed);
    const timer = setTimeout(() => {
      this.#lookAgain.delete(id);
      void this.#load(context, why === null ? null : { key, why }).catch(() =>
        this.#lookAgainIn(context, key, backoff(failures + 1), failures + 1, why),
      );
    }, ms);
    timer.unref();
    this.#lookAgain.set(id, timer);
  }

  async #step(context: SendContext, key: string, event: SendEvent): Promise<SendRecord | null> {
    if (
      this.#leased.has(driveId(context.place, key)) &&
      !(await this.kept.renewDrive(context.place, key))
    )
      throw new DriveLost();
    const now = new Date().toISOString();
    try {
      const next = await this.host.keepAt(context.place, (review) =>
        stepReview(review, key, event, now),
      );
      return sendOf(next, key) ?? null;
    } catch (cause) {
      throw new KeepFailed(cause);
    }
  }

  /** Drives the send under the claim its caller hands it, given back when the drive ends. */
  async #drive(context: SendContext, key: string): Promise<void> {
    const id = driveId(context.place, key);
    const before = this.#driving.get(id) ?? Promise.resolve();
    const run: Promise<void> = before
      .then(() => this.#driveOnce(context, key))
      // The drive stopped and could not keep why: it is looked at again soon, as stopped then.
      .catch((cause: unknown) => {
        const why = cause instanceof Stopped ? cause.why : stopsFor(cause);
        if (why.kind !== "switched") this.host.fail("error", errorWords(cause), { cause });
        this.#lookAgainIn(context, key, LOOK_AGAIN_MS, 0, why);
      })
      .finally(() => {
        if (this.#driving.get(id) === run) this.#driving.delete(id);
      });
    this.#driving.set(id, run);
    return run;
  }

  async #driveOnce(context: SendContext, key: string): Promise<void> {
    const id = driveId(context.place, key);
    this.#leased.add(id);
    try {
      await this.#run(context, key);
    } catch (cause) {
      if (cause instanceof DriveLost) return;
      await this.#stop(context, key, cause instanceof Stopped ? cause.why : stopsFor(cause));
    } finally {
      this.#leased.delete(id);
      await this.#release(context.place, key).catch(() => undefined);
    }
  }

  async #run(context: SendContext, key: string): Promise<void> {
    const { changeId } = context;
    const { sessionId } = context.place;
    // Every read and write of the drive, the paste's included, is made only while VS Code's
    // connection is the send's server and account; one that is not refuses before it goes out.
    const bind = () => boundConnection(this.sessions, context.place);
    const client = this.client.pinned(bind);
    const reads = this.sessions.pinned(bind);
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
      const record = sendOf((await this.kept.read(context.place)).review, key);
      if (record === undefined) return;
      const action = nextAction(record);
      try {
        switch (action.kind) {
          case "idle":
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
              if (cause instanceof Unbound) throw cause;
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
            const detail = await reads.sessionDetail(sessionId);
            await this.#step(context, key, {
              kind: "answered",
              status: answered.status,
              error: answered.error,
              agent: liveAgent(detail, context.viewer) ?? { kind: "other" },
            });
            break;
          }
          case "paste": {
            // Only a paste kept as started is made: one replaced since it was read pastes nothing.
            const started = await this.#step(context, key, { kind: "paste-started" });
            if (started?.phase.kind !== "in-terminal" || started.phase.paste.kind !== "pasting")
              break;
            let pasted: Pasted;
            try {
              pasted = await this.paste(sessionId, action.processId, action.text, reads);
            } catch (cause) {
              if (cause instanceof Unbound) {
                // Refused before anything reached the terminal: the paste is due again.
                await this.#step(context, key, { kind: "paste-unstarted" });
                throw cause;
              }
              await this.#step(context, key, {
                kind: "paste-failed",
                why: "interrupted",
                words: errorWords(cause),
              });
              break;
            }
            if (pasted === "pasted") {
              await this.#step(context, key, { kind: "pasted" });
              break;
            }
            await this.#step(context, key, { kind: "paste-failed", why: pasted });
            break;
          }
          case "skip-paste":
            await this.#step(context, key, { kind: "skipped", words: action.words });
            break;
          case "watch": {
            watches += 1;
            await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
            const read = await this.#readFollowUp(client, context, record);
            const agent =
              read.status === "pending"
                ? liveAgent(await reads.sessionDetail(sessionId), context.viewer)
                : null;
            await this.#step(context, key, { kind: "follow-up", ...read, agent });
            break;
          }
        }
      } catch (thrown) {
        if (thrown instanceof DriveLost || thrown instanceof Stopped) throw thrown;
        if (thrown instanceof Unbound) {
          if (thrown.why === "switched") throw new Stopped(SWITCHED);
          // Mend could not say whose VS Code's sign-in is: nothing more is sent until it can.
          await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
          continue;
        }
        // Mend holds the follow-up: what failed is VS Code's, and the paste step stops on it.
        if (record.phase.kind === "in-terminal") throw new Stopped(stopsFor(thrown));
        const retryable = !refuses(thrown);
        const cause = thrown instanceof WriteFailed ? thrown.failure : thrown;
        try {
          await this.#step(context, key, { kind: "failed", words: errorWords(cause), retryable });
        } catch (keeping) {
          if (keeping instanceof DriveLost) throw keeping;
          throw new Stopped(stopsFor(cause));
        }
        // A refused sign-in reads as it does on every surface, beside the send's own words.
        if (refusedSignIn(cause)) this.host.fail("error", errorWords(cause), { cause });
        this.host.settled(sessionId);
        return;
      }
    }
    const words = "Mend has not said the review was delivered";
    await this.#step(context, key, { kind: "failed", words, retryable: true });
    this.host.settled(sessionId);
  }

  /**
   * Keeps why the drive stopped in the send, under its lease, where every window reads it. A send still needing a drive (a launch being watched) is looked at again soon, unless VS Code
   * connected elsewhere: a read of its own server picks it up then.
   */
  async #stop(context: SendContext, key: string, why: StopReason): Promise<void> {
    let left: SendRecord | null;
    try {
      left = await this.#step(context, key, { kind: "abandoned", why });
    } catch (cause) {
      if (cause instanceof DriveLost) return;
      throw new Stopped(why, errorWords(cause));
    }
    if (left !== null && needs(left) === "driver" && why.kind !== "switched")
      throw new Stopped(why);
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
}

const stopsFor = (cause: unknown): StopReason => ({ kind: "error", words: errorWords(cause) });

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
