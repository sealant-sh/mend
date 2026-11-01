import type { AgentTurnUsage } from "@mend/domain/workbench";

import type { AgentControlCheckpoint } from "./types.ts";

/**
 * Claude's logical turn: one Mend turn (or one Claude opened itself) across every result Claude
 * prints for it. A `priority: "now"` steer makes Claude end the running segment with a result and
 * open a continuation with a fresh `system init`; both stay inside the turn Mend sent.
 */

export type ClaudeTurnStatus = "completed" | "interrupted" | "failed";

export interface ClaudeSegment {
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
  | {
      readonly _tag: "Stopping";
      readonly turnId: string;
      readonly segments: ReadonlyArray<ClaudeSegment>;
      readonly steerId: string | null;
    }
  | {
      readonly _tag: "SteerArmed";
      readonly turnId: string;
      readonly controlId: string;
      readonly segments: ReadonlyArray<ClaudeSegment>;
    }
  | {
      readonly _tag: "AwaitingContinuation";
      readonly turnId: string;
      readonly controlId: string;
      readonly segments: ReadonlyArray<ClaudeSegment>;
    }
  | { readonly _tag: "Draining"; readonly stoppedTurnId: string };

export interface ClaudeTurns {
  readonly turn: ClaudeTurnState;
  readonly replayQueue: ReadonlyArray<string>;
}

export type ClaudeTurnInput =
  | { readonly _tag: "Init"; readonly harnessTurnId: string | null }
  | {
      readonly _tag: "Result";
      readonly resultId: string | null;
      readonly status: ClaudeTurnStatus;
      readonly usage: AgentTurnUsage | null;
      readonly error: string | null;
    }
  | { readonly _tag: "OutputEnded" }
  | { readonly _tag: "SessionIdle" }
  | { readonly _tag: "TurnSent"; readonly turnId: string }
  | { readonly _tag: "TurnNotSent"; readonly turnId: string }
  | { readonly _tag: "Control"; readonly control: AgentControlCheckpoint };

export type ClaudeTurnEffect =
  | {
      readonly _tag: "TurnOpened";
      readonly turnId: string;
      readonly cause: "sent" | "harness" | "replay";
    }
  | { readonly _tag: "SegmentClosed"; readonly turnId: string }
  | { readonly _tag: "DrainEnded" }
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

const complete = (
  state: ClaudeTurns,
  turnId: string,
  segments: ReadonlyArray<ClaudeSegment>,
  status: ClaudeTurnStatus,
  error: string | null,
  then: "idle" | "draining",
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
      then === "draining" ? { _tag: "Draining", stoppedTurnId: turnId } : { _tag: "Idle" };
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
        case "AwaitingContinuation":
          return complete(state, turn.turnId, turn.segments, "interrupted", null, "draining");
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
  const folded = foldTurn(state, input);
  return state.turn._tag === "Draining" && folded.state.turn._tag !== "Draining"
    ? { state: folded.state, effects: [{ _tag: "DrainEnded" }, ...folded.effects] }
    : folded;
};

const foldTurn = (state: ClaudeTurns, input: ClaudeTurnInput): ClaudeTurnFold => {
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
        turn._tag === "Stopping" && turn.steerId !== null ? "draining" : "idle",
      );
    }
    case "SessionIdle": {
      if (turn._tag === "Draining")
        return { state: { ...state, turn: { _tag: "Idle" } }, effects: [] };
      if (turn._tag !== "AwaitingContinuation") return unchanged(state);
      const last = turn.segments.at(-1);
      // A priority-now steer aborts Claude's current segment before its continuation starts.
      // Session-state events can report idle in that gap; the person's turn is still running.
      if (last?.status === "interrupted") return unchanged(state);
      return complete(
        state,
        turn.turnId,
        turn.segments,
        last?.status ?? "completed",
        last?.error ?? null,
        "idle",
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
