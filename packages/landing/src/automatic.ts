import type {
  AgentTurn,
  NotLandedReason,
  RequestIntentReading,
  SessionOrigin,
} from "@mend/domain/workbench";

/**
 * When a completed turn lands (docs/adr/0007-landing.md, "Automatic landing"): the checks Mend
 * runs, in the ADR's order, once a turn has ended. They are split where the worker has to read
 * something first: the request's intent, then the change (is it empty, is it new since the last
 * landing, did the executor's captures catch up with the turn). Everything here is pure; the
 * worker supplies what it read.
 *
 * 1. The turn completed. A turn that failed, was interrupted or was cancelled never lands.
 * 2. The agent is not waiting on a question or an approval, and no later turn is on its way.
 * 3. The change's owner sent the turn, in a session they own. A turn with no recorded sender is
 *    never theirs, and neither is one in a session a teammate started in their worktree.
 * 4. The request asked for a change, or asked to land the change as it stands (`land`).
 * 5. The change is captured, not empty, and not what the last landing already pushed.
 *
 * Every turn that does not land records why. A reason that leaves nothing to land (a question
 * that changed nothing, automatic landing off with nothing new) is `skipped` and says nothing;
 * one the owner would want to hear is stated (`not landed · the change was not captured`).
 *
 * With automatic landing off, a turn is still recorded as not landed when the owner would want
 * to hear it: the request said `autopr=false`, or the session came from Slack, whose thread
 * offers the button, and where the owner's request to land is read and lands. A session someone
 * runs from the web or the CLI says nothing: they are watching the change, the Land panel is
 * right there, and the agent can run `mend land` when they ask it to.
 */

/** What the worker knows about an ended turn before it reads the change. */
export interface EndedTurnFacts {
  readonly turn: Pick<AgentTurn, "status" | "author" | "ordinal" | "intent" | "intentSource">;
  /**
   * The change's owner (`changeOwnerOf`), whose key pushes and who speaks on GitHub; a change
   * with none has nobody to land as.
   */
  readonly changeOwnerUserId: string | null;
  /** The owner of the session the turn ran in. */
  readonly sessionOwnerUserId: string | null;
  readonly origin: SessionOrigin;
  /** Whether automatic landing resolves on for the session (`resolveAutoLand`). */
  readonly on: boolean;
  /** The agent waits on a question or an approval. */
  readonly pending: boolean;
  /** Another turn follows this one in the session: its end decides instead. */
  readonly later: boolean;
}

/** Why a turn says nothing about landing, for the worker's log. */
export type SkippedWhy =
  | "not completed"
  | "waiting on the owner"
  | "a later turn decides"
  | "no owner"
  | "automatic landing is off"
  | "ended long ago"
  | "nothing to land";

/** A reason known before the intent is read: it holds whatever the request asked for. */
export type KnownReason = Extract<NotLandedReason, "option" | "off" | "not-owner">;

/**
 * The first half of the checks. `skipped` says nothing about landing. `not-landed` is stated
 * only when the change holds new work. `read-intent` goes on to read what the request asked for.
 */
export type TurnPlan =
  | { readonly _tag: "skipped"; readonly why: SkippedWhy }
  | { readonly _tag: "not-landed"; readonly reason: KnownReason }
  | { readonly _tag: "read-intent"; readonly on: boolean };

const skipped = (why: SkippedWhy) => ({ _tag: "skipped" as const, why });

/** The request's `autopr=false`, recorded as its intent. */
const saidNoPullRequest = (turn: EndedTurnFacts["turn"]): boolean =>
  turn.intentSource === "option" && turn.intent === "question";

export const planTurn = (facts: EndedTurnFacts): TurnPlan => {
  const { turn } = facts;
  if (turn.status !== "completed") return skipped("not completed");
  if (facts.pending) return skipped("waiting on the owner");
  if (facts.later) return skipped("a later turn decides");
  const owner = facts.changeOwnerUserId;
  if (owner === null) return skipped("no owner");
  // Landing speaks as the change's owner: only a turn they sent, in a session of theirs, does.
  const owners =
    turn.author !== null && turn.author === owner && facts.sessionOwnerUserId === owner;
  if (!facts.on) {
    if (saidNoPullRequest(turn)) return { _tag: "not-landed", reason: "option" };
    if (facts.origin !== "slack") return skipped("automatic landing is off");
    // A Slack thread has no Land panel: the owner's request to land is read, and lands.
    return owners ? { _tag: "read-intent", on: false } : { _tag: "not-landed", reason: "off" };
  }
  if (!owners) return { _tag: "not-landed", reason: "not-owner" };
  return { _tag: "read-intent", on: true };
};

/** The recorded intent of a turn, when something already read it: an option, Slack's reading. */
export const recordedIntent = (
  turn: Pick<AgentTurn, "intent" | "intentSource">,
): RequestIntentReading | null => {
  switch (turn.intentSource) {
    case "read":
    case "option":
      return turn.intent === null ? null : { intent: turn.intent, source: turn.intentSource };
    case "unread":
      return { intent: null, source: "unread" };
    case null:
      return null;
  }
};

/**
 * What the request's intent leaves. `land` goes on to the change: `requested` when the request
 * asked to land it as it stands, which lands even with automatic landing off and even when the
 * turn itself changed nothing. A question does not land. A request that was not read is treated
 * as a change, and the prompt and the change checks guard it instead.
 */
export type IntentStep =
  | { readonly _tag: "land"; readonly requested: boolean }
  | {
      readonly _tag: "not-landed";
      readonly reason: Extract<NotLandedReason, "question" | "option" | "off">;
    };

export const afterTheIntent = (reading: RequestIntentReading, on: boolean): IntentStep => {
  if (reading.intent === "land") return { _tag: "land", requested: true };
  if (reading.intent === "question") {
    return { _tag: "not-landed", reason: reading.source === "option" ? "option" : "question" };
  }
  return on ? { _tag: "land", requested: false } : { _tag: "not-landed", reason: "off" };
};

/** What the change held, as far as the worker could read it once the turn ended. */
export interface ChangeFacts {
  /**
   * The executor's captures caught up with the turn (`capture.flush` completed, or nothing holds
   * the worktree). Always true where the worktree sits beside Mend.
   */
  readonly captured: boolean;
  /** The worktree's tree is its base's. */
  readonly empty: boolean;
  /** The worktree holds work the change's last landing did not push; true when none has. */
  readonly newSinceLanding: boolean;
}

export type TurnDecision =
  | { readonly _tag: "land"; readonly requested: boolean }
  | { readonly _tag: "not-landed"; readonly reason: NotLandedReason }
  | { readonly _tag: "skipped"; readonly why: SkippedWhy };

/** A turn that does not land: the reason it states, or nothing to say. */
export type HeldBack = Exclude<TurnDecision, { readonly _tag: "land" }>;

/**
 * A reason that holds the change back is stated only when there is something to land: a
 * question that changed nothing, or left only what already landed, says nothing.
 */
export const heldBack = (reason: NotLandedReason, change: ChangeFacts): HeldBack =>
  !change.empty && change.newSinceLanding
    ? { _tag: "not-landed", reason }
    : skipped("nothing to land");

/**
 * The last check before a landing. It waits for the captures: a stale head is neither landed
 * nor called empty. A request to land goes on even when nothing is new, since the landing itself
 * knows whether its last pull request step still has to finish.
 */
export const withTheChange = (
  step: Extract<IntentStep, { readonly _tag: "land" }>,
  change: ChangeFacts,
): TurnDecision => {
  if (!change.captured) return { _tag: "not-landed", reason: "not-captured" };
  if (change.empty) return { _tag: "not-landed", reason: "no-change" };
  if (!change.newSinceLanding && !step.requested) {
    return { _tag: "not-landed", reason: "nothing-new" };
  }
  return { _tag: "land", requested: step.requested };
};
