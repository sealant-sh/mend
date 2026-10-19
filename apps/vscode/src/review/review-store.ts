import * as vscode from "vscode";

import type { EventPointer, MendClient } from "../client.js";
import { MendApiError } from "../mend-http.js";
import { displaySession } from "../session-lines.js";
import type { Project, Session } from "../types.js";
import type { ChangeRead } from "./change-rows.js";
import type { ReviewClient } from "./review-client.js";
import type { ReviewMemory } from "./review-memory.js";
import { resolveSlice, type SliceChoice } from "./slices.js";

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

export class ReviewStore implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  #state: ReviewState = { kind: "idle" };
  /** What she chose to read, per session; the pinned slice until she picks another. */
  readonly #choices = new Map<string, SliceChoice>();
  #generation = 0;
  #reread: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessions: Pick<MendClient, "sessionDetail" | "connection">,
    private readonly client: ReviewClient,
    private readonly memory: ReviewMemory,
  ) {}

  /** How many files a choice reads, for the picker; null when it reads nothing. */
  async fileCount(choice: SliceChoice): Promise<number | null> {
    const read = this.ready();
    if (read === null) return null;
    const slice = resolveSlice(choice, read.pinned, read.chain.checkpoints);
    if (slice === null) return null;
    if (slice.choice.kind === "pinned") return read.pinnedDiff.files.length;
    return (await this.client.rangeDiff(read.chain.worktreeId, slice.from.id, slice.to.id)).files
      .length;
  }

  dispose(): void {
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
    this.#set({ kind: "reading", followed: { project, session } });
    void this.#read();
  }

  /** A frame of the event stream: one about the followed change reads it again. */
  heard(event: EventPointer): void {
    const followed = this.followed();
    if (followed === null) return;
    const changeId = this.ready()?.changeId ?? null;
    const about =
      (event.changeId !== null && event.changeId === changeId) ||
      (event.sessionId === followed.session.id &&
        (event.type === "session" || event.type === "session-change"));
    if (about) this.#rereadSoon();
  }

  /** Read the followed change again now. */
  reread(): void {
    if (this.followed() !== null) void this.#read();
  }

  /** She chose another part of the change to read (story d, step 5). */
  choose(sessionId: string, choice: SliceChoice): void {
    this.#choices.set(sessionId, choice);
    if (this.followed()?.session.id === sessionId) void this.#read();
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
    const [chain, pinnedDiff, comments] = await Promise.all([
      this.client.chain(worktreeId),
      this.client.sliceDiff(changeId, pinned.id),
      this.client.comments(changeId),
    ]);
    const chosen = this.#choices.get(session.id) ?? { kind: "pinned" };
    const slice =
      resolveSlice(chosen, pinned, chain.checkpoints) ??
      resolveSlice({ kind: "pinned" }, pinned, chain.checkpoints);
    if (slice === null) throw new Error("Mend returned a review slice it cannot resolve.");
    const diff =
      slice.choice.kind === "pinned"
        ? pinnedDiff
        : await this.client.rangeDiff(worktreeId, slice.from.id, slice.to.id);
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
        slice,
        diff,
        comments,
        readAt: new Date().toISOString(),
      },
    };
  }
}
