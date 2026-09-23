import type {
  AgentTurn,
  NotLandedReason,
  RequestIntentReading,
  SessionOrigin,
} from "@mend/domain/workbench";

/**
 * When a completed turn lands (docs/adr/0007-landing.md, "Automatic landing"): the checks Mend
 * runs, in the ADR's order, once a turn has ended. They are split where the worker has to read
 * something first: the change (is it empty, is it new since the last landing), then the
 * request's intent. Everything here is pure; the worker supplies what it read.
 *
 * 1. The turn completed. A turn that failed, was interrupted or was cancelled never lands.
 * 2. The agent is not waiting on a question or an approval, and no later turn is on its way.
 * 3. The turn was sent by the owner, or it is the session's opening request, which is theirs.
 * 4. The change is not empty, and not what the last landing already pushed.
 * 5. The request asked for a change.
 *
 * With automatic landing off, a turn is still recorded as not landed when the owner would want
 * to hear it: the request said `autopr=false`, or the session came from Slack, whose thread
 * offers the button. A session someone runs from the web or the CLI says nothing: they are
 * watching the change, and the Land panel is right there.
 */

/** What the worker knows about an ended turn before it reads the change. */
export interface EndedTurnFacts {
  readonly turn: Pick<AgentTurn, "status" | "author" | "ordinal" | "intent" | "intentSource">;
  /** The session's owner; a session with none has nobody to land as. */
  readonly ownerUserId: string | null;
  readonly origin: SessionOrigin;
  /** Whether automatic landing resolves on for the session (`resolveAutoLand`). */
  readonly on: boolean;
  /** The agent waits on a question or an approval. */
  readonly pending: boolean;
  /** Another turn follows this one in the session: its end decides instead. */
  readonly later: boolean;
  /** This is the session's first turn: the request that started it. */
  readonly opening: boolean;
}

/**
 * The first half of the checks. `skipped` says nothing about landing. `check-change` goes on to
 * read the change; when it is empty or already landed the turn is `skipped` too, and otherwise
 * it is not landed for `next`'s reason, or its intent is read.
 */
export type BeforeTheChange =
  | { readonly _tag: "skipped" }
  | { readonly _tag: "check-change"; readonly next: NotLandedReason | "read-intent" };

const SKIPPED: BeforeTheChange = { _tag: "skipped" };

/** The request's `autopr=false`, recorded as its intent. */
const saidNoPullRequest = (turn: EndedTurnFacts["turn"]): boolean =>
  turn.intentSource === "option" && turn.intent === "question";

export const beforeTheChange = (facts: EndedTurnFacts): BeforeTheChange => {
  const { turn } = facts;
  if (turn.status !== "completed") return SKIPPED;
  if (facts.pending || facts.later) return SKIPPED;
  if (facts.ownerUserId === null) return SKIPPED;
  if (!facts.on) {
    if (saidNoPullRequest(turn)) return { _tag: "check-change", next: "option" };
    return facts.origin === "slack" ? { _tag: "check-change", next: "off" } : SKIPPED;
  }
  const owners = turn.author === facts.ownerUserId || (turn.author === null && facts.opening);
  if (!owners) return { _tag: "check-change", next: "not-owner" };
  return { _tag: "check-change", next: "read-intent" };
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
 * The last check. A request that read as a question does not land; one that was not read is
 * treated as a change, and the prompt and the change checks guard it instead.
 */
export const afterTheIntent = (
  reading: RequestIntentReading,
): { readonly _tag: "land" } | { readonly _tag: "not-landed"; readonly reason: NotLandedReason } =>
  reading.intent === "question"
    ? { _tag: "not-landed", reason: reading.source === "option" ? "option" : "question" }
    : { _tag: "land" };
