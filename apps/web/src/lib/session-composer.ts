import { type AgentTurnSteerDto, isOpenTurn } from "@mend/agent-conversation";
import {
  CONVERSATION_HARNESSES,
  isSelectableHarness,
  type PermissionMode,
  runsInTerminal,
  type SessionMode,
  takesReviewFollowUp,
  type TurnSelection,
} from "@mend/domain/workbench";

import type { SessionStatusDto } from "./api.ts";
import type { TurnView } from "./conversation.ts";
import { takesFirstMessage } from "./first-message.ts";

/**
 * What the composer under a session's conversation is, for this viewer:
 * - `first-message`: an imported conversation waits for its first message, which starts the agent;
 * - `conversation`: messages go to the agent; `resumes` when the session is stopped and the next
 *   message brings it back;
 * - `to-terminal`: the agent runs in a terminal and the viewer is the one who types there: messages
 *   are typed into it at its next turn boundary, and wait until then (SLNT-1235);
 * - `terminal`: the agent runs in a terminal, which takes the words instead;
 * - `starting-conversation`: the session is starting a conversation and its agent isn't running
 *   yet: messages go to Mend, which keeps them for the agent and sends them once it runs
 *   (SLNT-1237);
 * - `starting`: nothing can take a message until the agent runs;
 * - `not-running`: the agent isn't running and a message can't bring it back here;
 * - `no-control`: the viewer doesn't steer this session.
 *
 * How the agent runs is the session's recorded mode (`SessionMode`), never read off its newest
 * agent process: a session no agent was launched in yet has none.
 */
export type ComposerMode =
  | { readonly _tag: "first-message" }
  | { readonly _tag: "conversation"; readonly resumes: boolean }
  | { readonly _tag: "to-terminal" }
  | { readonly _tag: "terminal" }
  | { readonly _tag: "starting-conversation" }
  | { readonly _tag: "starting" }
  | { readonly _tag: "not-running" }
  | { readonly _tag: "no-control" };

export const composerMode = ({
  session,
  currentAgent,
  steer,
  terminalInput,
  agentLive,
}: {
  readonly session: {
    readonly status: SessionStatusDto;
    readonly harness: string;
    readonly importedConversationWaiting: boolean;
    readonly mode?: SessionMode | null | undefined;
  };
  readonly currentAgent: { readonly kind: string } | null;
  /** The server's word on whether this viewer sends the session turns. */
  readonly steer: boolean;
  /** The server's word on whether this viewer types in the session's terminal (its owner). */
  readonly terminalInput: boolean;
  /** The agent runs now; a shell keeping the workspace up doesn't count. */
  readonly agentLive: boolean;
}): ComposerMode => {
  if (!steer) return { _tag: "no-control" };
  if (takesFirstMessage(session, currentAgent, steer)) return { _tag: "first-message" };
  // The owner's composer types into a Claude Code or Codex terminal; anyone else's, and any other
  // agent's, says to type there.
  const inTerminal: ComposerMode =
    terminalInput && CONVERSATION_HARNESSES.has(session.harness)
      ? { _tag: "to-terminal" }
      : { _tag: "terminal" };
  if (session.status === "starting" && currentAgent === null)
    return session.mode === "conversation"
      ? { _tag: "starting-conversation" }
      : agentLive
        ? inTerminal
        : { _tag: "starting" };
  if (agentLive)
    return runsInTerminal(session.mode) ? inTerminal : { _tag: "conversation", resumes: false };
  // A stopped conversation the next message brings back: it ran as a conversation, on an agent's
  // harness, and the session isn't starting or saving.
  if (
    !runsInTerminal(session.mode) &&
    takesReviewFollowUp(session.harness) &&
    session.status !== "starting" &&
    session.status !== "stopping"
  )
    return { _tag: "conversation", resumes: true };
  return { _tag: "not-running" };
};

/**
 * Why the viewer's message waits for the agent's terminal rather than being typed there now
 * (SLNT-1235, the server's `terminalHoldOf`): the agent is in a turn, it asks something there, or
 * its turn ended and someone typed there without sending it. `waiting` is the kind of the terminal
 * agent's recorded wait, null while it works.
 */
export const terminalWaitWords = (
  agent: string,
  waiting: "permission" | "question" | "prompt" | null,
): string =>
  waiting === null
    ? `Waits for ${agent} to finish its turn in the terminal, then goes there.`
    : waiting !== "prompt"
      ? `Waits while ${agent} asks something in the terminal. Answer it there, and this goes next.`
      : "Waits: something is typed in the terminal and not sent. Send or clear it there, and this goes next.";

/** Who a turn is: the person who sent it, else whose login it runs on (the server's rule). */
const senderOf = (turn: TurnView): string | null => turn.author ?? turn.billedUserId ?? null;

/**
 * The turn of the viewer's own that runs now: a message goes into it (the server steers your own
 * running turn), and Stop turn stops it. Null while none runs, or while only someone else's does,
 * when a message waits for it to finish.
 */
export const ownRunningTurn = (turns: ReadonlyArray<TurnView>, viewerId: string): TurnView | null =>
  turns.findLast((turn) => turn.status === "running" && senderOf(turn) === viewerId) ?? null;

/** Someone else's turn that runs or waits now, which a message from the viewer waits behind. */
export const othersOpenTurn = (turns: ReadonlyArray<TurnView>, viewerId: string): TurnView | null =>
  turns.findLast((turn) => isOpenTurn(turn) && senderOf(turn) !== viewerId) ?? null;

/**
 * The model, thinking, speed and permission the session's next turn runs with unless the person
 * picks others: what its newest turn was sent with, else what its agent was launched with. Null
 * for an agent with no choice per turn (Claude Code, Codex and Antigravity take one).
 */
export const currentSelection = (
  turns: ReadonlyArray<TurnView>,
  session: {
    readonly harness: string;
    readonly model: string | null;
    readonly effort: TurnSelection["effort"];
  },
  launched: {
    readonly model: string | null;
    readonly effort: TurnSelection["effort"];
    readonly permissionMode: PermissionMode;
  } | null,
): TurnSelection | null => {
  const { harness } = session;
  if (!isSelectableHarness(harness)) return null;
  const newest = turns.findLast((turn) => turn.selection != null)?.selection;
  if (newest != null && newest.harness === harness) return newest;
  return {
    harness,
    model: launched?.model ?? session.model,
    effort: launched?.effort ?? session.effort,
    interactionMode: "default",
    permissionMode: launched?.permissionMode ?? "bypass",
  };
};

/** Whether two choices run a turn the same way: what a message needs to send at all. */
export const sameSelection = (a: TurnSelection, b: TurnSelection): boolean =>
  a.harness === b.harness &&
  a.model === b.model &&
  a.effort === b.effort &&
  a.interactionMode === b.interactionMode &&
  (a.speed ?? "standard") === (b.speed ?? "standard") &&
  (a.permissionMode ?? "bypass") === (b.permissionMode ?? "bypass");

/**
 * The status word the session's own tab shows. The server reads a live conversation as running
 * between turns; once the person stopped its newest turn and nothing else runs, it is Idle.
 */
export const shownStatus = (
  status: SessionStatusDto,
  turns: ReadonlyArray<TurnView> | undefined,
): SessionStatusDto => {
  if (status !== "running" || turns === undefined) return status;
  const newest = turns.at(-1);
  return newest !== undefined && newest.status === "interrupted" && !turns.some(isOpenTurn)
    ? "idle"
    : status;
};

/**
 * What the byline under a message sent into a running turn says of it: that it went into the
 * turn and when the agent reads it, nothing once the agent took it (it reads as any sent message),
 * or why it didn't get there. `turnOpen` is whether that turn still runs.
 */
export const steerNote = (
  steer: Pick<AgentTurnSteerDto, "delivery" | "takenAt">,
  agent: string,
  turnOpen: boolean,
): { readonly words: string | null; readonly pending: boolean } => {
  const { delivery } = steer;
  const waiting = {
    words: `Sent into this turn. ${agent} reads it when its current step finishes.`,
    pending: true,
  };
  // The harness showed the agent taking the words: whatever the send's own answer said.
  if (steer.takenAt != null && delivery._tag !== "Queued" && delivery._tag !== "NotSent")
    return { words: null, pending: false };
  switch (delivery._tag) {
    case "Sending":
      return waiting;
    case "Accepted":
      return turnOpen ? waiting : { words: `${agent} read this during its turn`, pending: false };
    case "Queued":
      return { words: "The turn ended first. This goes as the next turn.", pending: false };
    case "NotSent":
      return { words: "Not sent", pending: false };
    case "Unknown":
      return { words: "Mend didn't confirm this reached the turn", pending: false };
  }
};
