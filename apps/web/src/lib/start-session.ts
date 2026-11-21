import type { TurnSelection } from "@mend/domain/workbench";

import type { SessionDto } from "./api.ts";
import { launchFields, type StartSpec, type WorktreeTarget } from "./new-session.ts";
import {
  type MessageScope,
  moveMessages,
  type OutboxMessage,
  readOutbox,
  takeWritten,
} from "./outbox.ts";
import { beginStart, endStart, type RefusedStart, startCreated } from "./pending-starts.ts";
import { failureWords } from "./refusal.ts";

/** The server calls a start makes; the browser's are in `api.ts`. */
export interface StartCalls {
  /** A new worktree from the project's default branch, with the session in it. */
  readonly create: (
    projectId: string,
    agent: string,
    autoLand: boolean | null,
  ) => Promise<Pick<SessionDto, "id">>;
  /** A new session in an existing worktree. */
  readonly createInWorktree: (
    worktreeId: string,
    agent: string,
    autoLand: boolean | null,
  ) => Promise<Pick<SessionDto, "id">>;
  readonly launch: (
    sessionId: string,
    agent: string,
    fields: ReturnType<typeof launchFields>,
  ) => Promise<unknown>;
}

/** Make the session, in a new worktree or the one picked; answers its id. */
const makeSession = async (
  calls: StartCalls,
  projectId: string,
  target: WorktreeTarget,
  spec: StartSpec,
): Promise<string> =>
  (target._tag === "new"
    ? await calls.create(projectId, spec.agent, spec.autoLand)
    : await calls.createInWorktree(target.id, spec.agent, spec.autoLand)
  ).id;

/**
 * Start the session's agent on the first message. Not awaited: a launch that fails is the session
 * page's to show (the session records it).
 */
const launchMade = (calls: StartCalls, sessionId: string, spec: StartSpec) => {
  void calls.launch(sessionId, spec.agent, launchFields(spec)).catch(() => undefined);
};

/**
 * Start a session: make it, in a new worktree or the one picked, then start its agent on the
 * first message. Answers the session's id once it exists; the agent keeps starting after that, and
 * a launch that fails is the session page's to show (the session records it), so it is not
 * awaited here. A failure to make the session is the caller's to show.
 */
export const startSession = async (
  calls: StartCalls,
  projectId: string,
  target: WorktreeTarget,
  spec: StartSpec,
): Promise<string> => {
  const sessionId = await makeSession(calls, projectId, target, spec);
  launchMade(calls, sessionId, spec);
  return sessionId;
};

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
  /** Make the session; answers its id. */
  readonly make: () => Promise<string>;
  /** Start its agent. Not awaited: a launch that fails is the session's page to show. */
  readonly launch: (sessionId: string) => Promise<unknown>;
  /** What a refusal says first: "The session didn't start." unless the start says otherwise. */
  readonly failure?: string;
  readonly now?: Date;
}

/**
 * What a start's turns run with, as the session's own composer reads it once made
 * (`currentSelection`); null for an agent with no choice per turn.
 */
export const selectionOf = (spec: StartSpec): TurnSelection | null =>
  spec.agent === "claude" || spec.agent === "codex"
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
): Pick<InstantStart, "harness" | "prompt" | "selection" | "make" | "launch"> => ({
  harness: spec.agent,
  prompt: spec.prompt,
  selection: selectionOf(spec),
  make: () => makeSession(calls, projectId, target, spec),
  launch: (sessionId) => calls.launch(sessionId, spec.agent, launchFields(spec)),
});

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
  const draft: MessageScope = { userId: start.userId, sessionId: start.draftId };
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
    sessionId = await start.make();
  } catch (cause) {
    const written = [start.prompt, ...takeWritten(draft)];
    endStart(start.draftId);
    place.refuse({
      draftId: start.draftId,
      prompt: written.filter((words) => words.trim() !== "").join("\n\n"),
      words: refusalWords(start.failure ?? "The session didn't start.", cause),
    });
    return;
  }
  // The launch records the first message as the session's opening turn (SLNT-1237); what was
  // written meanwhile goes to Mend right behind it, which keeps it for the agent's first process.
  void start.launch(sessionId).catch(() => undefined);
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
