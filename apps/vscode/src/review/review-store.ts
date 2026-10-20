import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import type { EventPointer, MendClient } from "../client.js";
import { MendApiError } from "../mend-http.js";
import { displaySession } from "../session-lines.js";
import { accessChanged } from "../session-reads.js";
import type { Project, Session } from "../types.js";
import type { ChangeAddress } from "./change-content.js";
import type { ChangeRead } from "./change-rows.js";
import { samePlace, type KeptReviews, type ReviewPlace } from "./kept-reviews.js";
import {
  addPending,
  editPending,
  EMPTY_REVIEW,
  MAX_PENDING,
  removePending,
  type PendingComment,
  type SessionReview,
} from "./pending.js";
import type { ReviewClient } from "./review-client.js";
import type { ReviewMemory } from "./review-memory.js";
import {
  passStart,
  type ServerComment,
  type SliceDiff,
  type TranscriptEntry,
} from "./review-wire.js";
import {
  checkpointName,
  lastReviewHead,
  newerChoice,
  resolveSlice,
  type Slice,
  type SliceChoice,
} from "./slices.js";

/**
 * The review's one owner: which session's change the section follows, every read of it, what she
 * chose to read, and her pending comments. Surfaces map `state()` and `review()` and ask through
 * its methods; none of them reads Mend or keeps anything on this machine.
 */

export type Followed = { readonly project: Project; readonly session: Session };

export type ReviewState =
  | { readonly kind: "idle" }
  | { readonly kind: "reading"; readonly followed: Followed }
  | { readonly kind: "empty"; readonly followed: Followed; readonly words: string }
  | { readonly kind: "failed"; readonly followed: Followed; readonly words: string }
  | { readonly kind: "ready"; readonly followed: Followed; readonly read: ChangeRead };

/** A new pending comment, from the `+` on a line of the pinned slice. */
export interface NewComment {
  readonly at: ChangeAddress;
  readonly line: number;
  readonly endLine: number;
  readonly lineText: string;
  readonly body: string;
}

/** Whether a new comment was kept; when not, why, in Mend's words. */
export type Keeping = { readonly kept: true } | { readonly kept: false; readonly words: string };

/** A failure worth one toast: claimed across windows by `key` and `at`, as the notifier's are. */
export interface ReviewFailure {
  readonly key: string;
  readonly at: string;
  readonly words: string;
  /** The error behind it when a call failed; null when Mend answered the failure itself. */
  readonly cause: unknown;
}

/** A transcript Show record opens: the session whose record the evidence cites. */
export type ShownRecord =
  | {
      readonly kind: "found";
      readonly sessionId: string;
      readonly name: string;
      readonly entries: ReadonlyArray<TranscriptEntry>;
    }
  | { readonly kind: "not-found"; readonly words: string };

const TOO_MANY = `This session's review already holds ${MAX_PENDING} pending comments, so this one is not kept. Its words are still in the thread: send the review, or delete a comment, first.`;

/** Frames come in bursts while an agent works: the change is read again at most this often. */
const REREAD_MS = 1_500;

const errorWords = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Mend could not read this change.";

/** Frames after which anything read may be stale: the feed lost track, or access moved. */
const STALE_EVENTS: ReadonlySet<string> = new Set(["resync", "organization"]);

export class ReviewStore implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  readonly #failed = new vscode.EventEmitter<ReviewFailure>();
  /** What failed and helps her to know, in Mend's words: a toast, once (rule 14). */
  readonly onDidFail = this.#failed.event;
  #state: ReviewState = { kind: "idle" };
  /** What she chose to read, per session; the pinned slice until she picks another. */
  readonly #choices = new Map<string, SliceChoice>();
  #review: SessionReview = EMPTY_REVIEW;
  /** Where `#review` is kept: her account on the server, and the session. */
  #place: ReviewPlace | null = null;
  /** Who she is on each server, as Mend last said: a read that cannot say keeps her place. */
  readonly #viewers = new Map<string, string>();
  #you = "You";
  /**
   * The read of a change she asked for, until it ends: its failure toasts once. `before` is when
   * the pass Mend held before she asked started, by Mend's clock: a pass that started at another
   * time is hers.
   */
  #asked: { readonly changeId: string; readonly before: string | null } | null = null;
  #generation = 0;
  #reread: NodeJS.Timeout | null = null;
  /** One read in flight, and at most one after it for whatever asked meanwhile (as flow 2). */
  #reading = false;
  #again = false;
  #disposed = false;

  constructor(
    private readonly sessions: Pick<
      MendClient,
      "sessionDetail" | "connection" | "viewerId" | "memberNames" | "projectDetail"
    >,
    private readonly client: ReviewClient,
    /** The keys pinning each change's slice. */
    private readonly memory: ReviewMemory,
    /** Her pending comments, per person and session, shared by every window. */
    private readonly kept: KeptReviews,
  ) {}

  /** How many files a choice reads, for the picker, and whether Mend cut the listing. */
  async fileCount(choice: SliceChoice): Promise<{ files: number; cut: boolean } | null> {
    const read = this.ready();
    if (read === null) return null;
    const slice = resolveSlice(choice, read.pinned, read.chain.checkpoints);
    if (slice === null) return null;
    const diff =
      slice.choice.kind === "pinned"
        ? read.pinnedDiff
        : await this.client.rangeDiff(read.chain.worktreeId, slice.from.id, slice.to.id);
    return { files: diff.files.length, cut: diff.listingCut };
  }

  dispose(): void {
    this.#disposed = true;
    this.#generation++;
    if (this.#reread !== null) clearTimeout(this.#reread);
    this.#changed.dispose();
    this.#failed.dispose();
  }

  state(): ReviewState {
    return this.#state;
  }

  ready(): ChangeRead | null {
    return this.#state.kind === "ready" ? this.#state.read : null;
  }

  followed(): Followed | null {
    return this.#state.kind === "idle" ? null : this.#state.followed;
  }

  /** Her pending comments on the followed session. */
  review(): SessionReview {
    return this.#review;
  }

  /** Her name, as threads show it. */
  you(): string {
    return this.#you;
  }

  /** The session whose change the section shows; another session is read anew. */
  follow(project: Project, session: Session): void {
    if (this.followed()?.session.id === session.id) return;
    this.#generation++;
    this.#review = EMPTY_REVIEW;
    this.#place = null;
    this.#set({ kind: "reading", followed: { project, session } });
    this.#request();
  }

  /** First run took the view back (a sign-out, a refused token): the section follows nothing. */
  forget(): void {
    if (this.#state.kind === "idle") return;
    this.#generation++;
    this.#review = EMPTY_REVIEW;
    this.#place = null;
    this.#viewers.clear();
    this.#asked = null;
    this.#set({ kind: "idle" });
  }

  /**
   * A frame of the event stream: one about the followed change reads it again, and so does one
   * after which anything read may be stale (a reconnect's resync, an access change).
   */
  heard(event: EventPointer): void {
    const followed = this.followed();
    if (followed === null) return;
    const changeId = this.ready()?.changeId ?? null;
    const about =
      (event.changeId !== null && event.changeId === changeId) ||
      (event.sessionId === followed.session.id &&
        (event.type === "session" || event.type === "session-change")) ||
      (event.type === "project" && event.projectId === followed.project.id) ||
      STALE_EVENTS.has(event.type) ||
      accessChanged(event);
    if (about) this.#rereadSoon();
  }

  /** Read the followed change again now. */
  reread(): void {
    if (this.followed() !== null) this.#request();
  }

  /** Another window of this VS Code may have written her comments: read what it kept. */
  async reloadReview(): Promise<void> {
    const place = this.#place;
    if (place === null) return;
    const { review } = await this.kept.read(place);
    if (!samePlace(this.#place, place)) return;
    this.#review = review;
    this.#changed.fire();
  }

  /** She chose another part of the change to read (story d, step 5). */
  choose(sessionId: string, choice: SliceChoice): void {
    this.#choices.set(sessionId, choice);
    if (this.followed()?.session.id === sessionId) this.#request();
  }

  /** The newer read of since my last review or last turn, once newer checkpoints moved it. */
  readNewer(): void {
    const read = this.ready();
    if (read === null) return;
    const newer = newerChoice(read.slice.choice, {
      pinned: read.pinned,
      chain: read.chain.checkpoints,
      reviewedHead: read.reviewedHead,
    });
    if (newer !== null) this.choose(read.sessionId, newer);
  }

  /**
   * Review the newer change: a new key, so the next `reviews/open` pins the worktree as it is now.
   * The key is kept, so a reload shows the newer slice too.
   */
  async repin(): Promise<void> {
    const read = this.ready();
    if (read === null) return;
    const { url } = await this.sessions.connection();
    await this.memory.repin(url, read.changeId);
    this.#choices.delete(read.sessionId);
    this.reread();
  }

  /**
   * A pending comment on the pinned slice (story d, step 4): kept here, not sent. Says whether it
   * was kept, and why not in Mend's words, so her words are never dropped unseen.
   */
  async comment(comment: NewComment): Promise<Keeping> {
    const body = comment.body.trim();
    if (body === "")
      return { kept: false, words: "Your comment is empty: there is nothing to keep." };
    const read = this.ready();
    if (read === null)
      return {
        kept: false,
        words:
          "Mend has not finished reading this change, so your comment is not kept yet. Its words are still in the thread.",
      };
    if (comment.at.slice !== read.pinned.id)
      return {
        kept: false,
        words:
          "This line is on a slice Mend no longer shows, so your comment is not kept. Its words are still in the thread: copy them onto the slice the Change section shows now.",
      };
    const added: PendingComment = {
      id: randomUUID(),
      sliceId: read.pinned.id,
      headId: read.pinned.head.id,
      path: comment.at.path,
      line: comment.line,
      endLine: comment.endLine,
      lineText: comment.lineText,
      body,
      createdAt: new Date().toISOString(),
      origin: { kind: "own" },
    };
    let full = false;
    try {
      await this.#keepAt(this.#place, (review) => {
        full = review.pending.length >= MAX_PENDING;
        return full ? review : addPending(review, added);
      });
    } catch (cause) {
      return {
        kept: false,
        words: `VS Code could not keep your comment: ${errorWords(cause)} Its words are still in the thread.`,
      };
    }
    return full ? { kept: false, words: TOO_MANY } : { kept: true };
  }

  /** G1: a pending comment is hers to edit until Send review. */
  async edit(pendingId: string, body: string): Promise<void> {
    if (body.trim() === "") return;
    await this.#keepAt(this.#place, (review) => editPending(review, pendingId, body.trim()));
  }

  async remove(pendingId: string): Promise<void> {
    await this.#keepAt(this.#place, (review) => removePending(review, pendingId));
  }

  /**
   * Accept makes a Mend draft hers: pending like her own comments, with its evidence, until Send
   * review opens it on Mend. Words she typed under it are a comment of her own on the same lines.
   * A draft she already accepted, in this window or another, is accepted once.
   */
  async accept(draftId: string, reply: string): Promise<void> {
    const read = this.ready();
    const place = this.#place;
    const draft = read?.comments.find((comment) => comment.id === draftId);
    if (read === null || draft === undefined) return;
    const accepted = onDraft(read, draft, draft.body, {
      kind: "accepted",
      draftId,
      evidence: draft.evidence,
    });
    const own = onDraft(read, draft, reply.trim(), { kind: "own" });
    await this.#keepAt(place, (review) => {
      const already = review.pending.some(
        (comment) => comment.origin.kind === "accepted" && comment.origin.draftId === draftId,
      );
      if (already) return review;
      const next = addPending(review, accepted);
      return own.body === "" ? next : addPending(next, own);
    });
  }

  /** Dismiss removes a Mend draft, on Mend for everyone; words she typed stay as her own comment. */
  async dismiss(draftId: string, reply: string): Promise<void> {
    const read = this.ready();
    // Where her words go is decided now: she may follow another session before Mend answers.
    const place = this.#place;
    const draft = read?.comments.find((comment) => comment.id === draftId);
    if (read === null || draft === undefined) return;
    try {
      await this.client.setCommentState(read.changeId, draftId, "dismissed");
    } catch (cause) {
      this.#fail("error", cause);
      return;
    }
    if (reply.trim() !== "")
      await this.#keepAt(place, (review) =>
        addPending(review, onDraft(read, draft, reply.trim(), { kind: "own" })),
      );
    this.#rereadIfFollowed(read.sessionId);
  }

  /** Read this change: Mend reads it and writes drafts with their evidence, never a verdict. */
  async readChange(): Promise<void> {
    const read = this.ready();
    if (read === null) return;
    try {
      const before = passStart(await this.client.readPass(read.changeId));
      this.#asked = { changeId: read.changeId, before };
      await this.client.readChange(read.changeId);
    } catch (cause) {
      this.#asked = null;
      this.#fail("error", cause);
      return;
    }
    this.reread();
  }

  /**
   * Show record (G9: the whole transcript). From evidence, the transcript of the session whose run
   * the evidence cites, which need not be the session the section follows, since every session in
   * a worktree adds to its one change. Mend's transcript is per session, so a run no session
   * records now (one a later resume replaced) opens nothing, and says so. With no evidence (the
   * section's menu), the followed session's own.
   */
  async record(cited: { readonly runId: string | null } | null): Promise<ShownRecord | null> {
    const followed = this.followed();
    if (followed === null) return null;
    if (cited === null)
      return {
        kind: "found",
        sessionId: followed.session.id,
        name: displaySession(followed.session),
        entries: await this.client.transcript(followed.session.id),
      };
    const { runId } = cited;
    if (runId === null)
      return {
        kind: "not-found",
        words: "This evidence does not say which run recorded it, so Mend cannot open its record.",
      };
    const ofRun = (sessions: ReadonlyArray<Session>): Session | undefined =>
      sessions.find((candidate) => candidate.sealantRunId === runId);
    const session =
      ofRun([(await this.sessions.sessionDetail(followed.session.id)).session]) ??
      ofRun((await this.sessions.projectDetail(followed.project.id)).sessions);
    if (session === undefined)
      return {
        kind: "not-found",
        words: `No session of ${followed.project.name} is recorded by run ${runId} now: it may be an earlier run of a session that was resumed since. Mend keeps one transcript per session, so this record does not open.`,
      };
    return {
      kind: "found",
      sessionId: session.id,
      name: displaySession(session),
      entries: await this.client.transcript(session.id),
    };
  }

  #fail(what: string, cause: unknown): void {
    const at = new Date().toISOString();
    this.#failed.fire({ key: `review-${what}:${at}`, at, words: errorWords(cause), cause });
  }

  /**
   * Whether a failure still says something true when its toast is about to show: a read Mend has
   * begun again since is not failed any more.
   */
  stillFails(failure: ReviewFailure): boolean {
    return !(failure.key.startsWith("review-read:") && this.ready()?.pass?.kind === "reading");
  }

  #rereadIfFollowed(sessionId: string): void {
    if (this.followed()?.session.id === sessionId) this.reread();
  }

  /**
   * Applies `update` to the review kept at `place`, as it is kept now, so another window's writes
   * stay. The section shows what was kept only once it is kept, and only while it still shows
   * that place. With no place (the change is still being read), nothing is kept.
   */
  async #keepAt(
    place: ReviewPlace | null,
    update: (review: SessionReview) => SessionReview,
  ): Promise<SessionReview> {
    if (place === null) throw new Error("Mend has not finished reading this session.");
    const { review } = await this.kept.update(place, update);
    if (samePlace(this.#place, place)) {
      this.#review = review;
      this.#changed.fire();
    }
    return review;
  }

  #set(state: ReviewState): void {
    this.#state = state;
    this.#changed.fire();
  }

  #rereadSoon(): void {
    this.#reread ??= setTimeout(() => {
      this.#reread = null;
      this.reread();
    }, REREAD_MS);
  }

  #request(): void {
    if (this.#disposed) return;
    if (this.#reading) {
      this.#again = true;
      return;
    }
    this.#reading = true;
    void this.#read().finally(() => {
      this.#reading = false;
      if (!this.#again) return;
      this.#again = false;
      this.#request();
    });
  }

  async #read(): Promise<void> {
    const followed = this.followed();
    if (followed === null) return;
    const generation = ++this.#generation;
    try {
      const next = await this.#readChange(followed);
      if (generation !== this.#generation) return;
      this.#set(next);
      if (next.kind === "ready") this.#tellFailure(next.read);
    } catch (cause) {
      if (generation !== this.#generation) return;
      // Offline, what was read stays: the diff is readable from the last read (story d).
      const offline = cause instanceof MendApiError && cause.status === null;
      const kept = this.ready()?.sessionId === followed.session.id;
      if (offline && kept) this.#changed.fire();
      else this.#set({ kind: "failed", followed, words: errorWords(cause) });
    }
  }

  /** The read she asked for that Mend could not finish says why, once, in Mend's own words. */
  #tellFailure(read: ChangeRead): void {
    const asked = this.#asked;
    const pass = read.pass;
    if (asked === null || asked.changeId !== read.changeId || pass?.kind !== "failed") return;
    if (pass.startedAt === asked.before) return;
    this.#asked = null;
    this.#failed.fire({
      key: `review-read:${read.changeId}`,
      at: pass.at,
      words: `Mend could not read this change: ${pass.words}`,
      cause: null,
    });
  }

  async #readChange(followed: Followed): Promise<ReviewState> {
    const { session } = followed;
    const [detail, { url }, viewer] = await Promise.all([
      this.sessions.sessionDetail(session.id),
      this.sessions.connection(),
      this.sessions.viewerId(),
    ]);
    const worktreeId = detail.session.worktreeId;
    if (viewer !== null) this.#viewers.set(url, viewer);
    const place: ReviewPlace = {
      url,
      viewer: this.#viewers.get(url) ?? "unknown",
      sessionId: session.id,
    };
    // Only the followed session's own read loads its comments: a read of the one followed before,
    // landing late, must not put that session's comments under this one.
    if (this.followed()?.session.id === session.id && !samePlace(this.#place, place)) {
      const { review } = await this.kept.read(place);
      if (this.followed()?.session.id === session.id && !samePlace(this.#place, place)) {
        this.#place = place;
        this.#review = review;
      }
    }
    if (detail.changeId === null || worktreeId === undefined)
      return {
        kind: "empty",
        followed,
        words: `${displaySession(session)} has no change yet: nothing was written in its worktree.`,
      };
    const changeId = detail.changeId;
    const key = await this.memory.pinKey(url, changeId);
    let pinned;
    try {
      pinned = await this.client.openReview(changeId, key);
    } catch (cause) {
      // Mend says why there is nothing to pin yet, in its own words.
      if (cause instanceof MendApiError && cause.status === 422)
        return { kind: "empty", followed, words: cause.message };
      throw cause;
    }
    const [chain, pinnedDiff, comments, pass, members] = await Promise.all([
      this.client.chain(worktreeId),
      this.client.sliceDiff(changeId, pinned.id),
      this.client.comments(changeId),
      this.client.readPass(changeId),
      this.sessions.memberNames(),
    ]);
    // Mend writes her name on her comments, or her email when her name is empty.
    const name = members.find((member) => member.userId === viewer)?.name ?? "";
    this.#you = name === "" ? "You" : name;
    const reviewedHead = lastReviewHead(chain.checkpoints, comments, name === "" ? null : name, []);
    const newest = chain.checkpoints.at(-1) ?? pinned.head;
    const [shown, since] = await Promise.all([
      this.#readChosen(session.id, { worktreeId, chain, pinned, pinnedDiff }),
      newest.ordinal > pinned.head.ordinal
        ? this.client.rangeDiff(worktreeId, pinned.head.id, newest.id)
        : null,
    ]);
    const drift =
      since !== null && !since.listingCut && since.files.length > 0
        ? { files: since.files.length }
        : since?.listingCut === true || pinnedDiff.worktreeChangedSinceSnapshot
          ? { files: null }
          : null;
    return {
      kind: "ready",
      followed,
      read: {
        sessionId: session.id,
        sessionName: displaySession(detail.session),
        changeId,
        chain,
        pinned,
        pinnedDiff,
        slice: shown.slice,
        diff: shown.diff,
        comments,
        reviewedHead,
        drift,
        notice: shown.notice,
        pass,
        readAt: new Date().toISOString(),
      },
    };
  }

  /**
   * The slice she chose and its diff. One that cannot be read any more (its checkpoints left the
   * chain, or Mend has no such range) falls back to the pinned slice, saying why, and is forgotten
   * so Refresh does not ask for it again.
   */
  async #readChosen(
    sessionId: string,
    read: Pick<ChangeRead, "chain" | "pinned" | "pinnedDiff"> & { readonly worktreeId: string },
  ): Promise<{ slice: Slice; diff: SliceDiff; notice: string | null }> {
    const { chain, pinned, pinnedDiff } = read;
    const chosen = this.#choices.get(sessionId) ?? { kind: "pinned" };
    const main = resolveSlice({ kind: "pinned" }, pinned, chain.checkpoints);
    if (main === null) throw new Error("Mend returned a review slice it cannot resolve.");
    if (chosen.kind === "pinned") return { slice: main, diff: pinnedDiff, notice: null };
    const fallBack = (why: string): { slice: Slice; diff: SliceDiff; notice: string } => {
      if (this.#choices.get(sessionId) === chosen) this.#choices.delete(sessionId);
      return { slice: main, diff: pinnedDiff, notice: `${why} · showing ${chain.baseName} → now` };
    };
    const span = `${checkpointName(chosen.from, chain.baseName)} → ${checkpointName(chosen.to, chain.baseName)}`;
    const slice = resolveSlice(chosen, pinned, chain.checkpoints);
    if (slice === null) return fallBack(`${span} is no longer in this worktree's checkpoints`);
    try {
      return {
        slice,
        diff: await this.client.rangeDiff(read.worktreeId, slice.from.id, slice.to.id),
        notice: null,
      };
    } catch (cause) {
      if (cause instanceof MendApiError && cause.status === 404)
        return fallBack(`Mend could not read ${span}: ${cause.message}`);
      throw cause;
    }
  }
}

/** A pending comment on a Mend draft's place: its lines on the pinned slice, or the whole change. */
const onDraft = (
  read: ChangeRead,
  draft: ServerComment,
  body: string,
  origin: PendingComment["origin"],
): PendingComment => {
  const line = draft.file === null ? 1 : (draft.line ?? 1);
  return {
    id: randomUUID(),
    sliceId: read.pinned.id,
    headId: read.pinned.head.id,
    path: draft.file,
    line,
    endLine: draft.file === null ? 1 : Math.max(line, draft.endLine ?? line),
    lineText: "",
    body,
    createdAt: new Date().toISOString(),
    origin,
  };
};
