import type { AgentTurnUsage } from "@mend/domain/workbench";

import type { AgentControlCheckpoint } from "./types.ts";

/**
 * Claude's logical turn: one Mend turn (or one Claude opened itself) across every result Claude
 * prints for it. A `priority: "now"` steer makes Claude end the running segment with a result and
 * open a continuation with a fresh `system init`; both stay inside the turn Mend sent.
 *
 * `foldClaudeTurn` is the only writer of this state and does no I/O, so the live adapter and a
 * rehydrate that replays the same lines and the same journaled controls reach the same state.
 */

export type ClaudeTurnStatus = "completed" | "interrupted" | "failed";

/** One result Claude printed inside a logical turn. */
export interface ClaudeSegment {
  /** The result line's `uuid`: a result seen twice is one segment, and its repeat ends nothing. */
  readonly resultId: string | null;
  readonly usage: AgentTurnUsage | null;
  readonly status: ClaudeTurnStatus;
  readonly error: string | null;
}

export type ClaudeTurnState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Running";
      readonly turnId: string;
      readonly segments: ReadonlyArray<ClaudeSegment>;
    }
  /** A person's interrupt was written: the next result ends the turn, and nothing steers it. */
  | {
      readonly _tag: "Stopping";
      readonly turnId: string;
      readonly segments: ReadonlyArray<ClaudeSegment>;
      /** A written steer the Stop did not consume: Claude may still answer it after the turn. */
      readonly steerId: string | null;
    }
  /** A steer was journaled: the next result closes a segment instead of the turn. */
  | {
      readonly _tag: "SteerArmed";
      readonly turnId: string;
      readonly controlId: string;
      readonly segments: ReadonlyArray<ClaudeSegment>;
    }
  /** A segment closed for a steer; the next `system init` opens its continuation. */
  | {
      readonly _tag: "AwaitingContinuation";
      readonly turnId: string;
      readonly controlId: string;
      readonly segments: ReadonlyArray<ClaudeSegment>;
    }
  /**
   * A Stop ended the turn while Claude may still answer a steer it was written: no turn is open,
   * and none is sent until Claude opens one for the steer or reports idle.
   */
  | { readonly _tag: "Draining"; readonly stoppedTurnId: string; readonly steerId: string };

export interface ClaudeTurns {
  readonly turn: ClaudeTurnState;
  /** Rehydrate: turns already started, in order, that later final results complete. */
  readonly replayQueue: ReadonlyArray<string>;
}

export type ClaudeTurnInput =
  /** A `system init`; `harnessTurnId` names the turn it opens when none is open. */
  | { readonly _tag: "Init"; readonly harnessTurnId: string | null }
  | {
      readonly _tag: "Result";
      readonly resultId: string | null;
      readonly status: ClaudeTurnStatus;
      readonly usage: AgentTurnUsage | null;
      readonly error: string | null;
    }
  | { readonly _tag: "OutputEnded" }
  /** Claude's `session_state_changed: idle`: it runs nothing and has nothing queued. */
  | { readonly _tag: "SessionIdle" }
  | { readonly _tag: "TurnSent"; readonly turnId: string }
  /** The turn's user frame failed to write: the turn never ran, unless output says it did. */
  | { readonly _tag: "TurnNotSent"; readonly turnId: string }
  | { readonly _tag: "Control"; readonly control: AgentControlCheckpoint };

export type ClaudeTurnEffect =
  | {
      readonly _tag: "TurnOpened";
      readonly turnId: string;
      readonly cause: "sent" | "harness" | "replay";
    }
  /** A steer closed a segment: requests it held will not be answered. */
  | { readonly _tag: "SegmentClosed"; readonly turnId: string }
  | {
      readonly _tag: "TurnCompleted";
      readonly turnId: string;
      readonly status: ClaudeTurnStatus;
      readonly usage: AgentTurnUsage | null;
      readonly error: string | null;
    };

export interface ClaudeTurnFold {
  readonly state: ClaudeTurns;
  readonly effects: ReadonlyArray<ClaudeTurnEffect>;
}

export const CLAUDE_OUTPUT_ENDED = "Claude process ended during the turn.";
export const CLAUDE_CONTINUATION_MISSING =
  "Claude process ended before the steered turn continued.";

export const initialClaudeTurns = (replayProviderTurnIds: ReadonlyArray<string>): ClaudeTurns => {
  const [first, ...rest] = replayProviderTurnIds;
  return {
    turn: first === undefined ? { _tag: "Idle" } : { _tag: "Running", turnId: first, segments: [] },
    replayQueue: rest,
  };
};

export const claudeTurnId = (turn: ClaudeTurnState): string | null =>
  turn._tag === "Idle" || turn._tag === "Draining" ? null : turn.turnId;

const unchanged = (state: ClaudeTurns): ClaudeTurnFold => ({ state, effects: [] });

type Counter = Exclude<keyof AgentTurnUsage, "contextWindow">;
const COUNTERS: ReadonlyArray<Counter> = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "totalTokens",
];

/**
 * A logical turn's usage: each additive counter summed over its segments, unknown when any
 * segment lacks it (a known subtotal is not a total); the context window is a capacity, so the
 * last one known.
 */
export const claudeTurnUsage = (segments: ReadonlyArray<ClaudeSegment>): AgentTurnUsage | null => {
  if (segments.length === 0) return null;
  const counter = (key: Counter): number | null =>
    segments.reduce<number | null>((sum, segment) => {
      const value = segment.usage?.[key] ?? null;
      return sum === null || value === null ? null : sum + value;
    }, 0);
  const contextWindow = segments.reduce<number | null>(
    (last, segment) => segment.usage?.contextWindow ?? last,
    null,
  );
  const usage: AgentTurnUsage = {
    inputTokens: counter("inputTokens"),
    outputTokens: counter("outputTokens"),
    cachedInputTokens: counter("cachedInputTokens"),
    totalTokens: counter("totalTokens"),
    contextWindow,
  };
  return COUNTERS.every((key) => usage[key] === null) && contextWindow === null ? null : usage;
};

/**
 * End the logical turn once, then open the next one a rehydrate already knows started, or drain
 * the steer `unanswered` names.
 */
const complete = (
  state: ClaudeTurns,
  turnId: string,
  segments: ReadonlyArray<ClaudeSegment>,
  status: ClaudeTurnStatus,
  error: string | null,
  unanswered: string | null = null,
): ClaudeTurnFold => {
  const completed: ClaudeTurnEffect = {
    _tag: "TurnCompleted",
    turnId,
    status,
    usage: claudeTurnUsage(segments),
    error,
  };
  const [next, ...rest] = state.replayQueue;
  if (next === undefined) {
    const turn: ClaudeTurnState =
      unanswered === null
        ? { _tag: "Idle" }
        : { _tag: "Draining", stoppedTurnId: turnId, steerId: unanswered };
    return { state: { ...state, turn }, effects: [completed] };
  }
  return {
    state: {
      turn: { _tag: "Running", turnId: next, segments: [] },
      replayQueue: rest,
    },
    effects: [completed, { _tag: "TurnOpened", turnId: next, cause: "replay" }],
  };
};

const foldControl = (state: ClaudeTurns, control: AgentControlCheckpoint): ClaudeTurnFold => {
  const turn = state.turn;
  if (claudeTurnId(turn) !== control.providerTurnId) return unchanged(state);
  switch (control.action) {
    case "steer-now":
      return turn._tag === "Running"
        ? {
            state: {
              ...state,
              turn: {
                _tag: "SteerArmed",
                turnId: turn.turnId,
                controlId: control.controlId,
                segments: turn.segments,
              },
            },
            effects: [],
          }
        : unchanged(state);
    case "not-written":
      return turn._tag === "SteerArmed" && turn.controlId === control.controlId
        ? {
            state: {
              ...state,
              turn: { _tag: "Running", turnId: turn.turnId, segments: turn.segments },
            },
            effects: [],
          }
        : unchanged(state);
    case "interrupt":
      switch (turn._tag) {
        // A person's Stop wins over a steer: the segment it ends is the turn's last, and a gap
        // between segments ends now rather than waiting for a continuation the Stop cancels.
        case "AwaitingContinuation":
          return complete(state, turn.turnId, turn.segments, "interrupted", null, turn.controlId);
        case "Running":
        case "SteerArmed":
          return {
            state: {
              ...state,
              turn: {
                _tag: "Stopping",
                turnId: turn.turnId,
                segments: turn.segments,
                steerId: turn._tag === "SteerArmed" ? turn.controlId : null,
              },
            },
            effects: [],
          };
        default:
          return unchanged(state);
      }
  }
};

export const foldClaudeTurn = (state: ClaudeTurns, input: ClaudeTurnInput): ClaudeTurnFold => {
  const turn = state.turn;
  switch (input._tag) {
    case "TurnSent":
      return turn._tag === "Idle"
        ? {
            state: { ...state, turn: { _tag: "Running", turnId: input.turnId, segments: [] } },
            effects: [{ _tag: "TurnOpened", turnId: input.turnId, cause: "sent" }],
          }
        : unchanged(state);
    case "TurnNotSent":
      return (turn._tag === "Running" || turn._tag === "Stopping") &&
        turn.turnId === input.turnId &&
        turn.segments.length === 0
        ? { state: { ...state, turn: { _tag: "Idle" } }, effects: [] }
        : unchanged(state);
    case "Init":
      if (turn._tag === "AwaitingContinuation") {
        return {
          state: {
            ...state,
            turn: { _tag: "Running", turnId: turn.turnId, segments: turn.segments },
          },
          effects: [],
        };
      }
      if ((turn._tag !== "Idle" && turn._tag !== "Draining") || input.harnessTurnId === null) {
        return unchanged(state);
      }
      return {
        state: { ...state, turn: { _tag: "Running", turnId: input.harnessTurnId, segments: [] } },
        effects: [{ _tag: "TurnOpened", turnId: input.harnessTurnId, cause: "harness" }],
      };
    case "Result": {
      if (turn._tag === "Idle" || turn._tag === "Draining") return unchanged(state);
      if (
        input.resultId !== null &&
        turn.segments.some((segment) => segment.resultId === input.resultId)
      )
        return unchanged(state);
      const segments = [
        ...turn.segments,
        {
          resultId: input.resultId,
          usage: input.usage,
          status: input.status,
          error: input.error,
        },
      ];
      if (turn._tag === "SteerArmed") {
        return {
          state: {
            ...state,
            turn: {
              _tag: "AwaitingContinuation",
              turnId: turn.turnId,
              controlId: turn.controlId,
              segments,
            },
          },
          effects: [{ _tag: "SegmentClosed", turnId: turn.turnId }],
        };
      }
      return complete(
        state,
        turn.turnId,
        segments,
        input.status,
        input.error,
        turn._tag === "Stopping" ? turn.steerId : null,
      );
    }
    case "SessionIdle": {
      if (turn._tag === "Draining")
        return { state: { ...state, turn: { _tag: "Idle" } }, effects: [] };
      if (turn._tag !== "AwaitingContinuation") return unchanged(state);
      // Claude went idle without continuing: the steer never reached it, or it took the words
      // into the segment that just ended. That segment was the turn's last.
      const last = turn.segments.at(-1);
      return complete(
        state,
        turn.turnId,
        turn.segments,
        last?.status ?? "completed",
        last?.error ?? null,
      );
    }
    case "OutputEnded":
      if (turn._tag === "Idle") return unchanged(state);
      if (turn._tag === "Draining")
        return { state: { turn: { _tag: "Idle" }, replayQueue: [] }, effects: [] };
      return {
        state: { turn: { _tag: "Idle" }, replayQueue: [] },
        effects: [
          {
            _tag: "TurnCompleted",
            turnId: turn.turnId,
            status: "failed",
            usage: claudeTurnUsage(turn.segments),
            error:
              turn._tag === "AwaitingContinuation"
                ? CLAUDE_CONTINUATION_MISSING
                : CLAUDE_OUTPUT_ENDED,
          },
        ],
      };
    case "Control":
      return foldControl(state, input.control);
  }
};
