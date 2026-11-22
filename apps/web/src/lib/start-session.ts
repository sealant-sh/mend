import { isSelectableHarness, type TurnSelection } from "@mend/domain/workbench";

import type { SessionDto, SessionStartReadDto, StartTarget } from "./api.ts";
import { launchFields, type StartSpec, type WorktreeTarget } from "./new-session.ts";
import {
  type MessageScope,
  moveMessages,
  type OutboxMessage,
  readOutbox,
  takeWritten,
} from "./outbox.ts";
import {
  beginStart,
  endStart,
  keyOfDraft,
  type PendingStart,
  type RefusedStart,
  restoreStart,
  startCreated,
} from "./pending-starts.ts";
import { failureWords } from "./refusal.ts";

/** The server call a start makes; the browser's is `startSessionNow` in `api.ts`. */
export interface StartCalls {
  /**
   * Make the session and launch its agent, in one request named by `key` (SLNT-1239): once it
   * has left, Mend does both whatever becomes of this page.
   */
  readonly start: (
    key: string,
    target: StartTarget,
    harness: string,
    launch: ReturnType<typeof launchFields>,
  ) => Promise<Pick<SessionDto, "id">>;
}

/** Where a composer's start makes its session: a new worktree, or the one picked. */
const targetOf = (projectId: string, target: WorktreeTarget, spec: StartSpec): StartTarget =>
  target._tag === "new"
    ? { _tag: "project", projectId, autoLand: spec.autoLand }
    : { _tag: "worktree", worktreeId: target.id, autoLand: spec.autoLand };

/** Where an instant start shows, and what it does around the server. */
export interface StartPlace {
  /** The start's own page (or tab) opens, before Mend answers. */
  readonly show: (draftId: string) => unknown;
  /** Mend made the session and its page is read: show the session in the start's place. */
  readonly settle: (sessionId: string) => unknown;
  /** Mend refused: back where the start came from, with everything written and Mend's words. */
  readonly refuse: (refused: RefusedStart) => unknown;
  /**
   * Read what the session's page shows first, so it paints at once; a failure is fine. With
   * `opening`, the read waits a moment for the conversation to hold the first message, which Mend
   * records as the launch is admitted (SLNT-1237), so the page never shows the start without it.
   */
  readonly prefetch: (sessionId: string, opening: boolean) => Promise<unknown>;
  /** Send what the person wrote on the start's page before Mend made the session, in order. */
  readonly sendWritten: (sessionId: string, written: ReadonlyArray<OutboxMessage>) => void;
  /** The server moved: read the sessions again. */
  readonly moved: () => void;
}

export interface InstantStart {
  readonly draftId: string;
  readonly userId: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly harness: string;
  /** The first message; empty for a start with none (a menu's, a setup session's). */
  readonly prompt: string;
  readonly selection: TurnSelection | null;
  /**
   * Make the session and launch its agent, in one request named by `key`; answers the session's
   * id. A launch that fails is the session's page to show (the session records it).
   */
  readonly start: (key: string) => Promise<string>;
  /** What a refusal says first: "The session didn't start." unless the start says otherwise. */
  readonly failure?: string;
  readonly now?: Date;
}

/**
 * What a start's turns run with, as the session's own composer reads it once made
 * (`currentSelection`); null for an agent with no choice per turn.
 */
export const selectionOf = (spec: StartSpec): TurnSelection | null =>
  isSelectableHarness(spec.agent)
    ? {
        harness: spec.agent,
        model: spec.model,
        effort: spec.effort,
        interactionMode: "default",
        permissionMode: spec.permission ?? "bypass",
      }
    : null;

/** Why a start didn't happen: what it says first, then Mend's words. */
const refusalWords = (failure: string, cause: unknown): string =>
  `${failure} ${failureWords(cause, "Try again.")}`;

/**
 * What a composer's start makes and launches: the session in a new worktree or the one picked,
 * its agent on the first message.
 */
export const composerStart = (
  calls: StartCalls,
  projectId: string,
  target: WorktreeTarget,
  spec: StartSpec,
): Pick<InstantStart, "harness" | "prompt" | "selection" | "start"> => ({
  harness: spec.agent,
  prompt: spec.prompt,
  selection: selectionOf(spec),
  start: async (key) =>
    (await calls.start(key, targetOf(projectId, target, spec), spec.agent, launchFields(spec))).id,
});

/** A start that made no session: it goes, and the person gets back every word written for it. */
const refuseStart = (
  place: Pick<StartPlace, "refuse">,
  start: Pick<PendingStart, "draftId" | "userId" | "prompt">,
  words: string,
) => {
  const draft: MessageScope = { userId: start.userId, sessionId: start.draftId };
  const written = [start.prompt, ...takeWritten(draft)];
  endStart(start.draftId);
  place.refuse({
    draftId: start.draftId,
    prompt: written.filter((each) => each.trim() !== "").join("\n\n"),
    words,
  });
};

/**
 * Mend made the start's session, and launches it (SLNT-1239): what was written meanwhile goes
 * after the first message, which the launch records, and the session takes the start's place once
 * its page is read.
 */
const settleStart = async (
  place: StartPlace,
  start: Pick<PendingStart, "draftId" | "userId" | "prompt">,
  sessionId: string,
) => {
  const draft: MessageScope = { userId: start.userId, sessionId: start.draftId };
  // What was written so far moves onto the session, and from the same moment the start's page
  // writes there (`writingAddressOf`), before anything is awaited: the page stays on screen while
  // the session's is read, and words written meanwhile were left under the start's address,
  // never shown or sent again (SLNT-1232).
  const written = readOutbox(draft);
  moveMessages(draft, { userId: start.userId, sessionId });
  startCreated(start.draftId, sessionId);
  if (written.length > 0) place.sendWritten(sessionId, written);
  place.moved();
  await place.prefetch(sessionId, start.prompt.trim() !== "").catch(() => undefined);
  place.settle(sessionId);
};

/**
 * Start a session without waiting for Mend (SLNT-1196), from wherever one starts. Its page opens
 * at once at the start's own address (or in the tab that started it), with the first message and
 * a starting row in the sidebar (`lib/pending-starts`). Once Mend has made the session, its agent
 * starts, its page is read, and only then does the session take the start's place, so the page
 * never blanks. What the person wrote while it started moves with it. A refusal ends the start:
 * `place.refuse` takes the person back, with everything they wrote and Mend's words.
 */
export const startInstantly = async (place: StartPlace, start: InstantStart): Promise<void> => {
  const sentAt = start.now ?? new Date();
  beginStart({
    draftId: start.draftId,
    userId: start.userId,
    project: start.project,
    harness: start.harness,
    prompt: start.prompt,
    selection: start.selection,
    sentAt,
  });
  place.show(start.draftId);
  let sessionId: string;
  try {
    sessionId = await start.start(keyOfDraft(start.draftId));
  } catch (cause) {
    refuseStart(place, start, refusalWords(start.failure ?? "The session didn't start.", cause));
    return;
  }
  await settleStart(place, start, sessionId);
};

/** How often a page reloaded during a start reads it, and how long Mend may not know its key. */
export const RECOVERY_READ_MS = 500;
export const RECOVERY_UNKNOWN_MS = 20_000;
/** How long Mend may take to make the session once it has the start. */
export const RECOVERY_MAKING_MS = 120_000;

/** What a start reloaded before Mend answered says when Mend never got it. */
export const START_NEVER_ARRIVED =
  "The session didn't start: the page reloaded before Mend got the start. Start it again.";
/** What it says when Mend is still making the session after `RECOVERY_MAKING_MS`. */
export const START_STILL_MAKING =
  "Mend is still making this session. It shows in your sessions once it's made.";

/** How a recovery reads Mend and waits; the browser's, or a test's. */
export interface RecoveryReads {
  readonly read: (key: string) => Promise<SessionStartReadDto>;
  readonly wait: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/**
 * A start this tab kept from before a reload (SLNT-1239): its page shows again, and Mend is read by
 * the start's key until it says which session it made, then that session takes the start's place
 * as if Mend had answered the page. A start Mend refused, or never got, ends as a refused start
 * does: the composer takes back every word, with the reason.
 */
export const recoverStart = async (
  place: StartPlace,
  start: PendingStart,
  reads: RecoveryReads,
): Promise<void> => {
  restoreStart(start);
  if (start.sessionId !== null) {
    await settleStart(place, start, start.sessionId);
    return;
  }
  const key = keyOfDraft(start.draftId);
  const from = reads.now();
  for (;;) {
    const answer = await reads.read(key).catch(() => null);
    if (answer?.state === "made" && answer.sessionId !== null) {
      await settleStart(place, start, answer.sessionId);
      return;
    }
    if (answer?.state === "failed") {
      refuseStart(place, start, `The session didn't start. ${answer.failure ?? "Try again."}`);
      return;
    }
    const waited = reads.now() - from;
    if (answer?.state !== "making" && waited > RECOVERY_UNKNOWN_MS) {
      refuseStart(place, start, START_NEVER_ARRIVED);
      return;
    }
    if (waited > RECOVERY_MAKING_MS) {
      refuseStart(place, start, START_STILL_MAKING);
      return;
    }
    await reads.wait(RECOVERY_READ_MS);
  }
};
