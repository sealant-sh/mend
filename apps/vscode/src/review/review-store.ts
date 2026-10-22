import { randomUUID } from "node:crypto";

import { startsInTerminal } from "@mend/domain/workbench";
import * as vscode from "vscode";

import type { EventPointer, MendClient } from "../client.js";
import { MendApiError } from "../mend-http.js";
import { displaySession } from "../session-lines.js";
import { accessChanged } from "../session-reads.js";
import type { Project, Session, SessionDetail } from "../types.js";
import type { Pasted } from "./agent-paste.js";
import type { ChangeAddress } from "./change-content.js";
import type { ChangeRead } from "./change-rows.js";
import {
  awaitsRetry,
  commentIds,
  commentTarget,
  DRAFT_GONE,
  draftsLeft,
  handedOver,
  heldIds,
  holdsComments,
  mayRetry,
  nextAction,
  openRecord,
  postedComment,
  posts,
  commentLabel,
  retryRecord,
  sendGeneration,
  startSend,
  step,
  stepReview,
  type LiveAgent,
  type PastePlan,
  type SendEvent,
  type SendRecord,
  type SendSlice,
  terminalInput,
} from "./delivery.js";
import {
  addedText,
  composeAddition,
  composeInstruction,
  OFFLINE_WORDS,
  sendOffer,
  textToSend,
  type InstructionComment,
  type SendOffer,
} from "./instruction.js";
import { samePlace, type KeptReviews, type ReviewPlace } from "./kept-reviews.js";
import {
  acceptedDrafts,
  keepComposed,
  keepHeld,
  addPending,
  editPending,
  EMPTY_REVIEW,
  MAX_PENDING,
  removeDocument,
  removePending,
  saveDocument,
  type Composed,
  type DocumentSave,
  type PendingComment,
  type ReviewDocument,
  type SessionReview,
} from "./pending.js";
import type { ReviewClient } from "./review-client.js";
import type { ReviewMemory } from "./review-memory.js";
import {
  passStart,
  type ChangeFile,
  type Checkpoint,
  type ServerComment,
  type SliceDiff,
  type TranscriptEntry,
} from "./review-wire.js";
import {
  checkpointName,
  lastReviewHead,
  newerChoice,
  resolveSlice,
  type SentReview,
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
  /** The send record a failed delivery belongs to: its toast offers Retry delivery. */
  readonly retry: RetryTarget | null;
  /** The text of a review that was stopped: its toast offers to show it, so her words stay hers. */
  readonly text: string | null;
  /** An error, or something she needs to know that went as it should: nothing pasted, and why. */
  readonly tone: "error" | "warning";
}

/** A send record, by the person, server and session it is kept for, and its key. */
export interface RetryTarget {
  readonly place: ReviewPlace;
  readonly key: string;
}

export type Composition = Composed & { readonly text: string };

export interface DocumentRef {
  readonly place: ReviewPlace;
  readonly id: string;
}

/** Whether Retry delivery sent the review again; when not, what it found instead. */
export type Retried =
  | { readonly retried: true }
  | { readonly retried: false; readonly words: string };

/** Whether Send to session recorded the review; when not, why, in Mend's words. */
export type Sent = { readonly sent: true } | { readonly sent: false; readonly words: string };

/** What a send record's drive reads Mend with, whichever session the section follows. */
interface SendContext {
  readonly place: ReviewPlace;
  readonly changeId: string;
  readonly viewer: string | null;
  readonly author: string | null;
}

const driveId = (context: SendContext, key: string): string =>
  JSON.stringify([context.place.url, context.place.viewer, context.place.sessionId, key]);

/** Another window took over a send this window was driving: this one does nothing more for it. */
class DriveLost extends Error {}

/** The comments a review lists, each with its words, as one string to compare. */
const digestOf = (
  pending: ReadonlyArray<Pick<PendingComment, "id" | "body">>,
  open: ReadonlyArray<Pick<ServerComment, "id" | "body">>,
): string =>
  JSON.stringify([
    pending.map(({ id, body }) => [id, body]).toSorted(),
    open.map(({ id, body }) => [id, body]).toSorted(),
  ]);

/** A comment as the instruction lists it. */
const asListed = (comment: PendingComment | ServerComment): InstructionComment =>
  "origin" in comment
    ? {
        path: comment.path,
        line: comment.line,
        endLine: comment.endLine,
        body: comment.body,
        evidence: comment.origin.kind === "accepted" ? comment.origin.evidence : [],
        createdAt: comment.createdAt,
      }
    : {
        path: comment.file,
        line: comment.line,
        endLine: comment.endLine,
        body: comment.body,
        evidence: comment.evidence,
        createdAt: comment.createdAt,
      };

const pasteWords = (pasted: Exclude<Pasted, "pasted">, agent: string): string =>
  pasted === "agent-gone"
    ? `${agent} exited before the review was pasted, so nothing was pasted. Mend holds the follow-up pending: Retry delivery sends it to the stopped session.`
    : `VS Code could not attach ${agent}'s terminal here, so nothing was pasted. Mend holds the follow-up pending: Retry delivery pastes it again.`;

const TEXT_STAYS = "Your text stays in this editor.";

const COMMENTS_CHANGED = `Your comments changed since this review was composed, so nothing was sent. ${TEXT_STAYS} Close it and choose Send review again to compose the review with your comments as they are now.`;

const SAVED_SINCE = `Another window saved this review since this editor read it, so nothing was sent. ${TEXT_STAYS}`;

const NOT_KEPT = `This review was sent, or VS Code no longer keeps it, so nothing was sent. ${TEXT_STAYS}`;

const ANOTHER_WENT_OUT = `Another review of this session went out since this one was composed, so nothing was sent. ${TEXT_STAYS} Close it and choose Send review again to compose the review on top of the one sent.`;

const offerWords = (offer: SendOffer): string => {
  switch (offer.kind) {
    case "disabled":
    case "hidden":
      return offer.why;
    case "busy":
      return "Mend is still sending your last review";
    case "retry":
      return "Your last review was not delivered: Retry delivery sends it before another";
    case "nothing":
    case "ready":
      return "There is no comment to send";
  }
};

/** A transcript Show record opens: the session whose record the evidence cites. */
export type ShownRecord =
  | {
      readonly kind: "found";
      readonly sessionId: string;
      readonly name: string;
      readonly entries: ReadonlyArray<TranscriptEntry>;
    }
  | { readonly kind: "not-found"; readonly words: string };

const wordsStay = (reply: string): string =>
  reply.trim() === "" ? "" : " Your words are still in the thread.";

export const DRAFT_NOT_SHOWN =
  "The Change section no longer shows this Mend draft, so nothing was done.";

const NO_LONGER_A_DRAFT = "This Mend draft is no longer a draft on Mend, so nothing was done to it";

const draftGone = (reply: string): Keeping => ({
  kept: false,
  words: `${DRAFT_NOT_SHOWN}${wordsStay(reply)}`,
});

const TOO_MANY = `This session's review already holds ${MAX_PENDING} pending comments, so this one is not kept. Its words are still in the thread: send the review, or delete a comment, first.`;

/** Frames come in bursts while an agent works: the change is read again at most this often. */
const REREAD_MS = 1_500;

/** How often a launch is watched, and for how many steps before it reads failed. */
const WATCH_MS = 3_000;
const MAX_TURNS = 400;

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
  /** A re-pin after a sent review: since my last review opens from this head once Mend pins. */
  readonly #sinceAfterRepin = new Map<string, Checkpoint>();
  #review: SessionReview = EMPTY_REVIEW;
  /**
   * Her words under a Mend draft that VS Code could not write, by the place they belong to: shown
   * as not kept, never replaced by a newer reply, and kept by the next write to that place.
   */
  #held: ReadonlyArray<{ readonly place: ReviewPlace; readonly comment: PendingComment }> = [];
  /**
   * Every Mend draft a read showed, as last read, with the session it is in: her reply under one
   * whose thread was redrawn away, or whose session she left, still has a place to go.
   */
  readonly #drafts = new Map<string, SeenDraft>();
  /** Where `#review` is kept: her account on the server, and the session. */
  #place: ReviewPlace | null = null;
  /** Who she is on each server, as Mend last said: a read that cannot say keeps her place. */
  readonly #viewers = new Map<string, string>();
  #you = "You";
  /** Her name as Mend writes it on her comments; null when it is not known. */
  #author: string | null = null;
  /** A session whose kept reviews were read but not yet loaded: see `#load`. */
  #unloaded: ReviewPlace | null = null;
  /**
   * The read of a change she asked for, until it ends: its failure toasts once. `before` is when
   * the pass Mend held before she asked started, by Mend's clock: a pass that started at another
   * time is hers.
   */
  #asked: { readonly changeId: string; readonly before: string | null } | null = null;
  #generation = 0;
  #reread: NodeJS.Timeout | null = null;
  /** When this window loads its kept reviews again, for a send another window's lease holds. */
  #loadAgain: NodeJS.Timeout | null = null;
  /** One read in flight, and at most one after it for whatever asked meanwhile (as flow 2). */
  #reading = false;
  #again = false;
  #disposed = false;
  #offline = false;
  /** Each record's drive, by server, session and key: one at a time per record. */
  readonly #driving = new Map<string, Promise<void>>();
  /** The records this window holds the lease to drive, by drive. */
  readonly #leased = new Set<string>();

  constructor(
    private readonly sessions: Pick<
      MendClient,
      "sessionDetail" | "connection" | "viewerId" | "memberNames" | "projectDetail"
    >,
    private readonly client: ReviewClient,
    /** The keys pinning each change's slice. */
    private readonly memory: ReviewMemory,
    /** Her pending comments and the reviews she sent, per person and session, for every window. */
    private readonly kept: KeptReviews,
    /** G12 fallback: the agent's terminal attached here, the text pasted into that process, no Enter. */
    private readonly paste: (sessionId: string, processId: string, text: string) => Promise<Pasted>,
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
    if (this.#loadAgain !== null) clearTimeout(this.#loadAgain);
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

  /** Her words VS Code could not keep yet, for the followed session: see `#held`. */
  held(): ReadonlyArray<PendingComment> {
    return this.#heldAt(this.#place);
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
    if (await this.#keepHeld(place)) return;
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
   * The key is kept, so a reload shows the newer slice too. Offered after a review she sent, it
   * opens on since my last review: from the head she sent to the head now pinned.
   */
  async repin(sinceLastReview: boolean): Promise<void> {
    const read = this.ready();
    if (read === null) return;
    const { url } = await this.sessions.connection();
    await this.memory.repin(url, read.changeId);
    this.#choices.delete(read.sessionId);
    if (sinceLastReview) this.#sinceAfterRepin.set(read.sessionId, read.pinned.head);
    else this.#sinceAfterRepin.delete(read.sessionId);
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
      anchor: null,
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

  /**
   * G1: a pending comment is hers to edit until Send review. An edit to one another window sent or
   * deleted meanwhile is kept as a new pending comment where that one was; one VS Code could not
   * write is held by the store until it can.
   */
  async edit(pendingId: string, body: string): Promise<Keeping> {
    const words = body.trim();
    if (words === "")
      return { kept: false, words: "Your comment is empty: there is nothing to keep." };
    const place = this.#place;
    const before = this.#review;
    this.#held = this.#held.map((held) =>
      held.comment.id === pendingId ? { ...held, comment: { ...held.comment, body: words } } : held,
    );
    let anew: "sent" | "deleted" | null = null;
    let review: SessionReview;
    try {
      review = await this.#keepAt(place, (kept) => {
        anew = null;
        if (kept.pending.some((comment) => comment.id === pendingId))
          return editPending(kept, pendingId, words);
        const sent = takenBy(kept, pendingId);
        const edited = sent ?? before.pending.find((comment) => comment.id === pendingId);
        if (edited === undefined) return kept;
        anew = sent === undefined ? "deleted" : "sent";
        return addPending(kept, {
          ...edited,
          id: randomUUID(),
          body: words,
          createdAt: new Date().toISOString(),
          origin: { kind: "own" },
        });
      });
    } catch (cause) {
      const edited =
        this.#heldAt(place).find((comment) => comment.id === pendingId) ??
        before.pending.find((comment) => comment.id === pendingId) ??
        takenBy(before, pendingId);
      return {
        kept: false,
        words: `VS Code could not keep your edit: ${errorWords(cause)}${
          edited === undefined ? "" : this.#hold(place, { ...edited, body: words })
        }`,
      };
    }
    if (anew === "sent")
      return {
        kept: false,
        words:
          "This comment was already sent in a review, so your edit is kept as a new pending comment at the same place.",
      };
    if (anew === "deleted")
      return {
        kept: false,
        words:
          "This comment was deleted in another window, so your edit is kept as a new pending comment at the same place.",
      };
    if (review.pending.some((comment) => comment.id === pendingId)) return { kept: true };
    return {
      kept: false,
      words: "This comment was deleted in another window, so your edit is not kept.",
    };
  }

  async remove(pendingId: string): Promise<void> {
    if (this.#held.some((held) => held.comment.id === pendingId)) {
      this.#held = this.#held.filter((held) => held.comment.id !== pendingId);
      this.#changed.fire();
    }
    await this.#keepAt(this.#place, (review) => removePending(review, pendingId));
  }

  /**
   * Accept: the draft becomes hers, pending, and her reply under it a pending comment at its place.
   * A draft that is no longer one on Mend is not accepted, and her reply is kept all the same.
   */
  async accept(draftId: string, reply: string): Promise<Keeping> {
    const seen = this.#drafts.get(draftId);
    if (seen === undefined) return draftGone(reply);
    const { place, draft } = seen;
    const own = onDraft(seen, reply.trim(), { kind: "own" });
    if (draft.state !== "draft") return this.#keepReply(place, own);
    const accepted = onDraft(seen, draft.body, {
      kind: "accepted",
      draftId,
      evidence: draft.evidence,
      draftBody: draft.body,
    });
    try {
      await this.#keepAt(place, (review) => {
        const next = acceptedDrafts(review).has(draftId) ? review : addPending(review, accepted);
        return own.body === "" ? next : addPending(next, own);
      });
    } catch (cause) {
      return {
        kept: false,
        words: `VS Code could not keep the accepted draft: ${errorWords(cause)}${this.#hold(place, own)}`,
      };
    }
    return { kept: true };
  }

  async dismiss(draftId: string, reply: string): Promise<Keeping> {
    // Her words go to the draft's session: she may follow another before Mend answers.
    const seen = this.#drafts.get(draftId);
    if (seen === undefined) return draftGone(reply);
    const { place, draft } = seen;
    const own = onDraft(seen, reply.trim(), { kind: "own" });
    if (draft.state !== "draft") return this.#keepReply(place, own);
    if (own.body !== "") {
      try {
        await this.#keepAt(place, (review) => addPending(review, own));
      } catch (cause) {
        return {
          kept: false,
          words: `VS Code could not keep your words, so the draft is not dismissed: ${errorWords(cause)}${this.#hold(place, own)}`,
        };
      }
    }
    try {
      await this.client.setCommentState(seen.changeId, draftId, "dismissed");
    } catch (cause) {
      this.#fail("error", errorWords(cause), { cause });
      return { kept: true };
    }
    this.#rereadIfFollowed(place.sessionId);
    return { kept: true };
  }

  /** Her reply under a draft that is no longer one on Mend: a pending comment at its place. */
  async #keepReply(place: ReviewPlace, own: PendingComment): Promise<Keeping> {
    if (own.body === "") return { kept: false, words: `${NO_LONGER_A_DRAFT}.` };
    try {
      await this.#keepAt(place, (review) => addPending(review, own));
    } catch (cause) {
      return {
        kept: false,
        words: `${NO_LONGER_A_DRAFT}, and VS Code could not keep your words: ${errorWords(cause)}${this.#hold(place, own)}`,
      };
    }
    return {
      kept: false,
      words: `${NO_LONGER_A_DRAFT}. Your words are kept as a pending comment at its place.`,
    };
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
      this.#fail("error", errorWords(cause), { cause });
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

  /** The window's connection to Mend: offline, Send review waits and her comments stay. */
  setOffline(offline: boolean): void {
    if (offline === this.#offline) return;
    this.#offline = offline;
    this.#changed.fire();
  }

  /**
   * The comments on Mend that go out with the next review: open and never sent, unless a review
   * being sent or delivered holds them. One Mend holds pending goes too: a new key supersedes it.
   */
  #openOnMend(read: ChangeRead): ReadonlyArray<ServerComment> {
    const inRecords = new Set(
      this.#review.sends.flatMap((record) =>
        !holdsComments(record)
          ? []
          : record.items.flatMap((item) =>
              item.kind === "open"
                ? [item.commentId]
                : item.kind === "accepted"
                  ? [item.draftId]
                  : item.post.kind === "posted"
                    ? [item.post.commentId]
                    : [],
            ),
      ),
    );
    return read.comments.filter(
      (comment) =>
        comment.state === "open" && comment.sentToSessionId === null && !inRecords.has(comment.id),
    );
  }

  /** Whether Send review is offered here, and why not (story d, step 6 and its edge cases). */
  offer(): SendOffer {
    const read = this.ready();
    if (read === null) return { kind: "nothing" };
    const open = openRecord(this.#review.sends);
    const held = heldIds(this.#review.sends);
    const retry = retryRecord(this.#review.sends, read.facts.agent);
    return sendOffer({
      session: read.facts.session,
      viewer: read.facts.viewer,
      ownerName: read.facts.ownerName,
      agent: read.facts.agent,
      startsTerminal: read.facts.startsTerminal,
      offline: this.#offline,
      count:
        this.#review.pending.length +
        this.#openOnMend(read).filter((comment) => !held.has(comment.id)).length,
      open: open?.phase.kind === "sending" ? "sending" : retry === null ? null : "failed",
    });
  }

  /**
   * Send review: the instruction Mend will send, her comments in order with file and line, and
   * which comments it lists: Send to session sends exactly those. On top of a review already
   * pasted into the agent's terminal and not entered, it keeps that review's text as she sent it
   * and adds only the comments that are new.
   */
  compose(): Composition | null {
    const read = this.ready();
    if (read === null) return null;
    const open = this.#openOnMend(read);
    const listed = {
      documentId: randomUUID(),
      sessionId: read.sessionId,
      sessionName: read.sessionName,
      slice: sliceOf(read),
      pending: this.#review.pending.map((pending) => pending.id),
      open: open.map((comment) => comment.id),
      digest: digestOf(this.#review.pending, open),
      generation: sendGeneration(this.#review.sends),
    };
    const base = terminalInput(this.#review.sends, read.facts.agent);
    if (base !== null) {
      const inTerminal = new Set(base.input.ids);
      return {
        ...listed,
        base,
        text: composeAddition({
          sessionName: read.sessionName,
          sent: base.input.text,
          sentCount: base.input.ids.length,
          files: read.pinnedDiff.files,
          comments: [
            ...this.#review.pending,
            ...open.filter((comment) => !inTerminal.has(comment.id)),
          ].map(asListed),
        }),
      };
    }
    return {
      ...listed,
      base: null,
      text: composeInstruction({
        sessionName: read.sessionName,
        baseName: read.chain.baseName,
        headOrdinal: read.pinned.head.ordinal,
        files: read.pinnedDiff.files,
        comments: [...this.#review.pending, ...open].map(asListed),
      }),
    };
  }

  /**
   * Send to session: the review's text as kept at `revision`, the one her editor saved or read,
   * with exactly the comments it was composed with, under one new idempotency key kept in the
   * record; the record is then driven until Mend answers. A revision another window saved since is
   * not sent. Says whether the send was recorded, and why not in Mend's words.
   */
  async send(ref: DocumentRef, revision: number): Promise<Sent> {
    const read = this.ready();
    const place = this.#place;
    if (read === null || place === null || !samePlace(place, ref.place))
      return {
        sent: false,
        words: `The Change section no longer shows this review's session, so nothing was sent. ${TEXT_STAYS}`,
      };
    const ofRef = (review: SessionReview): ReviewDocument | undefined =>
      review.document?.composed.documentId === ref.id ? review.document : undefined;
    const document = ofRef((await this.kept.read(place)).review);
    if (document === undefined) return { sent: false, words: NOT_KEPT };
    if (document.revision !== revision) return { sent: false, words: SAVED_SINCE };
    const { composed } = document;
    const offer = this.offer();
    if (offer.kind !== "ready")
      return { sent: false, words: `${offerWords(offer)}. ${TEXT_STAYS}` };
    const open = this.#openOnMend(read);
    if (digestOf(this.#review.pending, open) !== composed.digest)
      return { sent: false, words: COMMENTS_CHANGED };
    const instruction = textToSend(document.text, read.sessionName);
    const paste: PastePlan =
      composed.base === null ? { kind: "all" } : addedText(instruction, composed.base);
    const key = `vscode-follow-up:${read.changeId}:${randomUUID()}`;
    let next: SessionReview;
    let stale = false;
    let saved: "gone" | "newer" | null = null;
    try {
      // Its drive is claimed before the record is kept: a window loading it then reads it driven
      // here, never left behind by a window that closed.
      await this.kept.claimDrive(place, key);
      // Checked again as kept, under the lock: another window may have sent these comments.
      next = await this.#keepAt(place, (review) => {
        const kept = ofRef(review);
        saved = kept === undefined ? "gone" : kept.revision === revision ? null : "newer";
        stale = sendGeneration(review.sends) !== composed.generation;
        if (saved !== null || stale || digestOf(review.pending, open) !== composed.digest)
          return review;
        const started = startSend(review, {
          key,
          slice: sliceOf(read),
          instruction,
          paste,
          pending: composed.pending,
          open: composed.open,
          now: new Date().toISOString(),
        });
        return started === null ? review : removeDocument(started, composed.documentId);
      });
    } catch (cause) {
      await this.kept.releaseDrive(place, key).catch(() => undefined);
      return {
        sent: false,
        words: `VS Code could not keep the review: ${errorWords(cause)} ${TEXT_STAYS}`,
      };
    }
    if (!next.sends.some((record) => record.key === key)) {
      await this.kept.releaseDrive(place, key);
      if (saved === "gone") return { sent: false, words: NOT_KEPT };
      if (saved === "newer") return { sent: false, words: SAVED_SINCE };
      return { sent: false, words: stale ? ANOTHER_WENT_OUT : COMMENTS_CHANGED };
    }
    void this.#drive(this.#context(read, place), key);
    return { sent: true };
  }

  /**
   * The session's one review for Send review: the one kept while it is still current, else this
   * composition. `carried` says the text she saved in the one it replaced follows the composition,
   * kept in the same write, so nothing she wrote goes.
   */
  async keepDocument(composition: Composition): Promise<{
    readonly ref: DocumentRef;
    readonly document: ReviewDocument;
    readonly carried: boolean;
  }> {
    const place = this.#place;
    if (place === null) throw new Error("Mend has not finished reading this session.");
    const { text, ...composed } = composition;
    let carried = false;
    const { document } = await this.#keepAt(place, (review) => {
      const next = keepComposed(review, composed, text);
      carried = next.carried;
      return next.review;
    });
    if (document === null) throw new Error("VS Code did not keep the review.");
    return { ref: { place, id: document.composed.documentId }, document, carried };
  }

  async document(ref: DocumentRef): Promise<ReviewDocument | null> {
    const { document } = (await this.kept.read(ref.place)).review;
    return document?.composed.documentId === ref.id ? document : null;
  }

  async saveDocument(ref: DocumentRef, revision: number, text: string): Promise<DocumentSave> {
    let saved: DocumentSave | null = null;
    await this.#keepAt(ref.place, (review) => {
      saved = saveDocument(review, ref.id, revision, text);
      return saved.kind === "saved" ? saved.review : review;
    });
    return saved ?? { kind: "gone" };
  }

  /** The review of the followed session that offers Retry delivery from the title, if any. */
  retryTarget(): RetryTarget | null {
    const place = this.#place;
    const read = this.ready();
    const record = read === null ? null : retryRecord(this.#review.sends, read.facts.agent);
    return place === null || record === null ? null : { place, key: record.key };
  }

  /** The followed session's review a thread's Retry delivery names, by its key. */
  retryOf(key: string): RetryTarget | null {
    const place = this.#place;
    return place === null ? null : { place, key };
  }

  /**
   * Retry delivery: the same key, the same text, the comments already on Mend kept. Only a record
   * of that session with that key, failed, or held pending by Mend once the session has no live
   * agent (the route then launches the stopped session on the review).
   */
  async retry(target: RetryTarget): Promise<Retried> {
    if (this.#offline)
      return { retried: false, words: `Retry delivery sent nothing: ${OFFLINE_WORDS}` };
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
      author: this.#author,
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

  /** Addressed or Reopen (story d, step 7): her call on a sent comment, never Mend's. */
  async mark(commentId: string, state: "addressed" | "open"): Promise<void> {
    const read = this.ready();
    if (read === null) return;
    try {
      await this.client.setCommentState(read.changeId, commentId, state);
    } catch (cause) {
      this.#fail("error", errorWords(cause), { cause });
      return;
    }
    this.reread();
  }

  /**
   * The reviews she sent from this VS Code, by the head each was pinned to and when: with her
   * comments Mend reads back as sent, where since my last review starts.
   */
  #sentReviews(): ReadonlyArray<SentReview> {
    return this.#review.sends
      .filter(handedOver)
      .map((record) => ({ headId: record.headId, at: record.createdAt }));
  }

  /**
   * A window that loads a send it did not see end does not know it was sent: it says so, in what
   * it keeps. One Mend was launching goes on being watched, by reads only.
   */
  async #load(context: SendContext): Promise<void> {
    const now = new Date().toISOString();
    // A send another window drives now is that window's: this one neither ends it nor drives it.
    // Its leases are read under the lock: a window claims a send's drive before it keeps the send,
    // so a send kept sending since, by a new Send or a Retry, reads driven here.
    const undriven = new Set<string>();
    /** How long each other window drives a send for, unless it renews its lease. */
    const drivenFor: Array<number> = [];
    const loaded = await this.#keepAt(context.place, async (review) => {
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
      if (this.#place === null || !samePlace(this.#place, place)) return;
      this.#unloaded = this.#place;
      this.#request();
    }, ms);
    this.#loadAgain.unref();
  }

  #context(read: ChangeRead, place: ReviewPlace): SendContext {
    return {
      place,
      changeId: read.changeId,
      viewer: read.facts.viewer,
      author: this.#author,
    };
  }

  /** A record's next step, kept for its own session whichever session the section follows. */
  async #step(context: SendContext, key: string, event: SendEvent): Promise<SendRecord | null> {
    if (
      this.#leased.has(driveId(context, key)) &&
      !(await this.kept.renewDrive(context.place, key))
    )
      throw new DriveLost();
    const now = new Date().toISOString();
    const next = await this.#keepAt(context.place, (review) => stepReview(review, key, event, now));
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
      .catch((cause: unknown) => this.#fail("error", errorWords(cause), { cause }))
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
      let failing = "Mend could not deliver the review";
      try {
        switch (action.kind) {
          case "idle":
            // A delivery Mend answered as failed (a launch it could not make) says so once.
            if (record.phase.kind === "failed")
              this.#fail(
                `delivery:${key}`,
                `Mend could not deliver the review: ${record.phase.words}`,
                { retry },
              );
            this.#rereadIfFollowed(sessionId);
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
            const posted = await this.client.postComment(changeId, pending.sliceId, target, body);
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
              this.#fail(
                `delivery:${key}`,
                `${DRAFT_GONE}. Send review composes it again without that draft, from your comments as they are now.`,
                { text: record.instruction, tone: "warning" },
              );
              this.#rereadIfFollowed(sessionId);
              return;
            }
            if (draft.state === "draft")
              await this.client.setCommentState(changeId, action.draftId, "open");
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
            const answered = await this.client.deliver(sessionId, action.request);
            const next = await this.#step(context, key, {
              kind: "answered",
              status: answered.status,
              error: answered.error,
              agent: liveAgent(detail, context.viewer) ?? { kind: "other" },
            });
            const left = next !== null && handedOver(next) ? draftsLeft(next) : [];
            if (left.length > 0)
              this.#fail(
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
            this.#fail(`paste:${key}`, pasteWords(pasted, agent), { retry });
            break;
          }
          case "skip-paste":
            await this.#step(context, key, { kind: "skipped" });
            this.#fail(`paste:${key}`, action.words, { tone: "warning" });
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
      } catch (cause) {
        if (cause instanceof DriveLost) throw cause;
        // Unreachable or failing on Mend's side is worth a retry with the same key; a refusal is not.
        const retryable =
          !(cause instanceof MendApiError) || cause.status === null || cause.status >= 500;
        await this.#step(context, key, { kind: "failed", words: errorWords(cause), retryable });
        this.#fail(`delivery:${key}`, `${failing}: ${errorWords(cause)}`, {
          cause,
          retry: retryable ? retry : null,
        });
        this.#rereadIfFollowed(sessionId);
        return;
      }
    }
    // Mend has not answered in all this time: the review reads failed, so Retry is offered.
    const words = "Mend has not said the review was delivered";
    await this.#step(context, key, { kind: "failed", words, retryable: true });
    this.#fail(`delivery:${key}`, `${words}. Retry delivery asks again with the same key.`, {
      retry,
    });
    this.#rereadIfFollowed(sessionId);
  }

  #rereadIfFollowed(sessionId: string): void {
    if (this.followed()?.session.id === sessionId) this.reread();
  }

  #fail(
    what: string,
    words: string,
    options: {
      readonly cause?: unknown;
      readonly retry?: RetryTarget | null;
      readonly text?: string;
      readonly tone?: "error" | "warning";
    } = {},
  ): void {
    const at = new Date().toISOString();
    this.#failed.fire({
      key: `review-${what}:${at}`,
      at,
      words,
      cause: options.cause ?? null,
      retry: options.retry ?? null,
      text: options.text ?? null,
      tone: options.tone ?? "error",
    });
  }

  /**
   * Whether a failure still says something true when its toast is about to show: a read Mend has
   * begun again since, or a delivery that was retried meanwhile, in this window or another, is not
   * failed any more.
   */
  async stillFails(failure: ReviewFailure): Promise<boolean> {
    if (failure.key.startsWith("review-read:")) return this.ready()?.pass?.kind !== "reading";
    const { retry } = failure;
    if (retry === null) return true;
    void this.reloadReview();
    return (await this.kept.read(retry.place)).review.sends.some(
      (record) => record.key === retry.key && awaitsRetry(record),
    );
  }

  /**
   * Applies `update` to the review kept at `place`, as it is kept now, so another window's writes
   * stay. The section shows what was kept only once it is kept, and only while it still shows
   * that place. With no place (the change is still being read), nothing is kept.
   */
  async #keepAt(
    place: ReviewPlace | null,
    update: (review: SessionReview) => SessionReview | Promise<SessionReview>,
  ): Promise<SessionReview> {
    if (place === null) throw new Error("Mend has not finished reading this session.");
    const held = this.#heldAt(place);
    let taken: ReadonlyArray<PendingComment> = [];
    const { review } = await this.kept.update(place, async (current) => {
      const next = keepHeld(await update(current), held, randomUUID);
      taken = next.kept;
      return next.review;
    });
    this.#held = this.#held.filter((entry) => !taken.includes(entry.comment));
    if (samePlace(this.#place, place)) {
      this.#review = review;
      this.#changed.fire();
    }
    return review;
  }

  /** Keeps the words held for `place`, if any: whether the review was written. */
  async #keepHeld(place: ReviewPlace): Promise<boolean> {
    if (this.#heldAt(place).length === 0) return false;
    try {
      await this.#keepAt(place, (review) => review);
      return true;
    } catch {
      return false;
    }
  }

  #heldAt(place: ReviewPlace | null): ReadonlyArray<PendingComment> {
    return place === null
      ? []
      : this.#held.flatMap((entry) => (samePlace(entry.place, place) ? [entry.comment] : []));
  }

  /** Her words that were not written: held until a write to their place keeps them. */
  #hold(place: ReviewPlace | null, comment: PendingComment): string {
    if (place === null || comment.body === "") return "";
    this.#held = [
      ...this.#held.filter(
        (entry) => entry.comment.id !== comment.id || !samePlace(entry.place, place),
      ),
      { place, comment },
    ];
    this.#changed.fire();
    return " Your words stay in this window, marked not kept, and VS Code keeps them when this window next reads this session's review.";
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
      if (next.kind === "ready") {
        this.#see(next.read);
        if (this.#place !== null) await this.#keepHeld(this.#place);
        this.#tellFailure(next.read);
        const unloaded = this.#unloaded;
        if (unloaded !== null && unloaded === this.#place) {
          this.#unloaded = null;
          await this.#load(this.#context(next.read, unloaded));
        }
      }
    } catch (cause) {
      if (generation !== this.#generation) return;
      // Offline, what was read stays: the diff is readable from the last read (story d).
      const offline = cause instanceof MendApiError && cause.status === null;
      const kept = this.ready()?.sessionId === followed.session.id;
      if (offline && kept) this.#changed.fire();
      else this.#set({ kind: "failed", followed, words: errorWords(cause) });
    }
  }

  #see(read: ChangeRead): void {
    const place = this.#place;
    if (place === null) return;
    for (const draft of read.comments)
      if (draft.state === "draft" || this.#drafts.has(draft.id))
        this.#drafts.set(draft.id, { place, changeId: read.changeId, pinned: read.pinned, draft });
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
      retry: null,
      text: null,
      tone: "error",
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
        this.#unloaded = place;
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
    const name = members.find((member) => member.userId === viewer)?.name ?? "";
    this.#you = name === "" ? "You" : name;
    // Mend writes her name on her comments, or her email when her name is empty.
    this.#author = name === "" ? null : name;
    const reviewedHead = lastReviewHead(
      chain.checkpoints,
      comments,
      this.#author,
      this.#sentReviews(),
    );
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
    const owner = detail.session.ownerUserId;
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
        facts: {
          session: detail.session,
          viewer,
          ownerName: members.find((member) => member.userId === owner)?.name ?? "its owner",
          agent: liveAgent(detail, viewer),
          startsTerminal: startsInTerminal(detail.currentAgent?.kind ?? null),
        },
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
    const from = this.#sinceAfterRepin.get(sessionId);
    if (from !== undefined && from.ordinal < pinned.head.ordinal) {
      this.#sinceAfterRepin.delete(sessionId);
      this.#choices.set(sessionId, { kind: "since-last-review", from, to: pinned.head });
    }
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

/** The session's live agent, when it is a terminal one: Mend holds its follow-ups pending. */
const liveAgent = (detail: SessionDetail, viewer: string | null): LiveAgent | null => {
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

/** A Mend draft as a read showed it, and where her words under it are kept. */
interface SeenDraft {
  readonly place: ReviewPlace;
  readonly changeId: string;
  readonly pinned: ChangeRead["pinned"];
  readonly draft: ServerComment;
}

/** The pending comment a review in the record took with this id. */
const takenBy = (review: SessionReview, pendingId: string): PendingComment | undefined =>
  review.sends
    .flatMap((record) =>
      record.items.flatMap((item) => (item.kind === "open" ? [] : [item.pending])),
    )
    .find((comment) => comment.id === pendingId);

const sliceOf = (read: ChangeRead): SendSlice => ({
  id: read.pinned.id,
  baseId: read.pinned.base.id,
  headId: read.pinned.head.id,
  diffDigest: read.pinned.diffDigest,
});

/**
 * A pending comment on a Mend draft's place: the slice it was written on, and its lines, its whole
 * file or the whole change, as the draft has them.
 */
const onDraft = (
  { draft, pinned }: Pick<SeenDraft, "draft" | "pinned">,
  body: string,
  origin: PendingComment["origin"],
): PendingComment => {
  const line = draft.file === null ? null : draft.line;
  return {
    id: randomUUID(),
    sliceId: draft.anchor?.sliceId ?? pinned.id,
    headId: draft.anchor?.headId ?? pinned.head.id,
    path: draft.file,
    line,
    endLine: line === null ? null : Math.max(line, draft.endLine ?? line),
    lineText: "",
    body,
    createdAt: new Date().toISOString(),
    origin,
    anchor: draft.anchor,
  };
};
