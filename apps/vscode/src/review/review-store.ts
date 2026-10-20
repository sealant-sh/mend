import * as vscode from "vscode";

import type { EventPointer, MendClient } from "../client.js";
import { MendApiError } from "../mend-http.js";
import { displaySession } from "../session-lines.js";
import { accessChanged } from "../session-reads.js";
import type { Project, Session } from "../types.js";
import type { ChangeRead } from "./change-rows.js";
import type { ReviewClient } from "./review-client.js";
import type { ReviewMemory } from "./review-memory.js";
import type { SliceDiff } from "./review-wire.js";
import {
  checkpointName,
  lastReviewHead,
  newerChoice,
  resolveSlice,
  type Slice,
  type SliceChoice,
} from "./slices.js";

/**
 * The review's one owner: which session's change the section follows, every read of it, and what
 * she chose to read. Surfaces map `state()` and ask through its methods; none of them reads Mend.
 */

export type Followed = { readonly project: Project; readonly session: Session };

export type ReviewState =
  | { readonly kind: "idle" }
  | { readonly kind: "reading"; readonly followed: Followed }
  | { readonly kind: "empty"; readonly followed: Followed; readonly words: string }
  | { readonly kind: "failed"; readonly followed: Followed; readonly words: string }
  | { readonly kind: "ready"; readonly followed: Followed; readonly read: ChangeRead };

/** Frames come in bursts while an agent works: the change is read again at most this often. */
const REREAD_MS = 1_500;

const errorWords = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Mend could not read this change.";

/** Frames after which anything read may be stale: the feed lost track, or access moved. */
const STALE_EVENTS: ReadonlySet<string> = new Set(["resync", "organization"]);

export class ReviewStore implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  #state: ReviewState = { kind: "idle" };
  /** What she chose to read, per session; the pinned slice until she picks another. */
  readonly #choices = new Map<string, SliceChoice>();
  #generation = 0;
  #reread: NodeJS.Timeout | null = null;
  /** One read in flight, and at most one after it for whatever asked meanwhile (as flow 2). */
  #reading = false;
  #again = false;
  #disposed = false;

  constructor(
    private readonly sessions: Pick<
      MendClient,
      "sessionDetail" | "connection" | "viewerId" | "memberNames"
    >,
    private readonly client: ReviewClient,
    private readonly memory: ReviewMemory,
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

  /** The session whose change the section shows; another session is read anew. */
  follow(project: Project, session: Session): void {
    if (this.followed()?.session.id === session.id) return;
    this.#generation++;
    this.#set({ kind: "reading", followed: { project, session } });
    this.#request();
  }

  /** First run took the view back (a sign-out, a refused token): the section follows nothing. */
  forget(): void {
    if (this.#state.kind === "idle") return;
    this.#generation++;
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
      if (generation === this.#generation) this.#set(next);
    } catch (cause) {
      if (generation !== this.#generation) return;
      // Offline, what was read stays: the diff is readable from the last read (story d).
      const offline = cause instanceof MendApiError && cause.status === null;
      const kept = this.ready()?.sessionId === followed.session.id;
      if (offline && kept) this.#changed.fire();
      else this.#set({ kind: "failed", followed, words: errorWords(cause) });
    }
  }

  async #readChange(followed: Followed): Promise<ReviewState> {
    const { session } = followed;
    const detail = await this.sessions.sessionDetail(session.id);
    const worktreeId = detail.session.worktreeId;
    if (detail.changeId === null || worktreeId === undefined)
      return {
        kind: "empty",
        followed,
        words: `${displaySession(session)} has no change yet: nothing was written in its worktree.`,
      };
    const changeId = detail.changeId;
    const { url } = await this.sessions.connection();
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
    const [chain, pinnedDiff, comments, viewer, members] = await Promise.all([
      this.client.chain(worktreeId),
      this.client.sliceDiff(changeId, pinned.id),
      this.client.comments(changeId),
      this.sessions.viewerId(),
      this.sessions.memberNames(),
    ]);
    // Mend writes her name on her comments, or her email when her name is empty.
    const name = members.find((member) => member.userId === viewer)?.name ?? "";
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
