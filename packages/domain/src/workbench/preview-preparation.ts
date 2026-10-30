import type { Effect } from "effect";

import type { AgentTurnId, PreviewId, SessionId, WorktreeId } from "../ids.ts";
import type { AgentTurn } from "./agent-protocol.ts";
import {
  type Preview,
  type PreviewGatewayResolution,
  type PreviewPhase,
  type PreviewStatus,
} from "./preview.ts";
import type { ServiceStartProgress } from "./service-recipe.ts";
import type { ServiceTargetState } from "./service.ts";

export type PreviewPreparationNote = "recipe-changed" | "setup-inputs-changed";

export type PreviewPreparationDecision =
  | { readonly _tag: "Skipped"; readonly why: string }
  | { readonly _tag: "Superseded" }
  | { readonly _tag: "NoChange" }
  | { readonly _tag: "NotCaptured" }
  | { readonly _tag: "NoPreview" }
  | { readonly _tag: "SessionEnded" }
  | {
      readonly _tag: "Stopped";
      readonly service: string;
      readonly previewId: PreviewId | null;
    }
  | {
      readonly _tag: "NotApproved";
      readonly service: string;
      readonly previewId: PreviewId | null;
    }
  | {
      readonly _tag: "Refused";
      /** Null when the refusal came before any Service was chosen: an unreadable mend.toml. */
      readonly service: string | null;
      readonly previewId: PreviewId | null;
      readonly reason: string;
    }
  /** Already running: the turn started nothing. */
  | {
      readonly _tag: "Running";
      readonly service: string;
      readonly previewId: PreviewId | null;
      readonly note: PreviewPreparationNote | null;
    }
  /** The turn's start ran to its end and left the Service running. */
  | {
      readonly _tag: "Started";
      readonly service: string;
      readonly previewId: PreviewId | null;
      readonly note: PreviewPreparationNote | null;
    };

export interface PreviewPreparationStarting {
  readonly _tag: "Starting";
  readonly service: string;
  readonly previewId: PreviewId | null;
  readonly phase: PreviewPhase;
  readonly note: PreviewPreparationNote | null;
}

/** What `SessionEngine.preparePreview` answers once the start it began, or joined, ended. */
export type PreviewPrepared = Exclude<
  PreviewPreparationDecision,
  { readonly _tag: "Superseded" | "NoChange" | "NotCaptured" }
>;

/**
 * The preparation's claim, as the engine's start answers to it. `report` records the start's
 * phase durably; its first call takes the preview for this start, across sessions and API
 * processes. False: another start holds the preview, or this claim no longer does. `holds` is
 * read just before the Service's attempt is admitted.
 */
export interface PreviewPreparationHold {
  readonly report: (starting: PreviewPreparationStarting) => Effect.Effect<boolean>;
  readonly holds: Effect.Effect<boolean>;
}

export type PreviewPreparationState =
  | { readonly _tag: "Claimed" }
  | PreviewPreparationStarting
  | {
      readonly _tag: "Decided";
      readonly decision: PreviewPreparationDecision;
      readonly decidedAt: Date;
    };

export interface PreviewPreparation {
  readonly turnId: AgentTurnId;
  readonly sessionId: SessionId;
  readonly worktreeId: WorktreeId;
  readonly claimedAt: Date;
  readonly state: PreviewPreparationState;
}

export const previewTurnStartId = (turnId: AgentTurnId): string => `preview-turn:${turnId}`;

/** What a session's earlier turn left for the turn that decides: `Superseded` hands its change on. */
export type PreviewPreparationLeft = "superseded" | "decided";

/**
 * The turns `turn` decides for: itself and the run of earlier turns right before it that no
 * preparation decided, or that a later turn superseded. The run ends at the first turn decided
 * otherwise. Its first turn's start is the baseline the change is measured from, so a changed turn
 * followed by a question is never measured past its own edits.
 */
export const coveredTurns = (
  turns: ReadonlyArray<AgentTurn>,
  left: ReadonlyMap<AgentTurnId, PreviewPreparationLeft>,
  turn: AgentTurn,
): ReadonlyArray<AgentTurn> => {
  const earlier = turns
    .filter((other) => other.ordinal < turn.ordinal)
    .toSorted((a, b) => b.ordinal - a.ordinal);
  const covered: Array<AgentTurn> = [turn];
  for (const other of earlier) {
    if (left.get(other.id) === "decided") break;
    covered.unshift(other);
  }
  return covered;
};

export const previewPhaseOf = (progress: ServiceStartProgress): PreviewPhase | null => {
  const setup = progress.setup?.state;
  if (setup === "waiting" || setup === "running") return "setup";
  if (progress.state !== "running") return null;
  const starting = progress.steps.find((step) => step.state === "starting");
  if (starting === undefined) return null;
  return starting.name === progress.service ? "service" : "depends";
};

const serviceOf = (state: PreviewPreparationState): string | null => {
  switch (state._tag) {
    case "Claimed":
      return null;
    case "Starting":
      return state.service;
    case "Decided":
      return "service" in state.decision ? state.decision.service : null;
  }
};

const preparedFacts = (preparation: PreviewPreparation): ReadonlyArray<PreviewStatus> => {
  const { state } = preparation;
  if (state._tag === "Starting") {
    return [{ _tag: "Starting", service: state.service, phase: state.phase }];
  }
  if (state._tag !== "Decided") return [];
  const { decision } = state;
  switch (decision._tag) {
    case "NotCaptured":
      return [{ _tag: "NotPrepared", service: null, why: { _tag: "NotCaptured" } }];
    case "SessionEnded":
      return [{ _tag: "NotPrepared", service: null, why: { _tag: "SessionEnded" } }];
    case "NotApproved":
      return [{ _tag: "NotPrepared", service: decision.service, why: { _tag: "NotApproved" } }];
    case "Refused":
      return [
        {
          _tag: "NotPrepared",
          service: decision.service,
          why: { _tag: "Refused", words: decision.reason },
        },
      ];
    case "Skipped":
    case "Superseded":
    case "NoChange":
    case "NoPreview":
    case "Stopped":
    case "Running":
    case "Started":
      return [];
  }
};

const outlived = (state: PreviewPreparationState, attemptStartedAt: Date | null): boolean =>
  state._tag === "Decided" && attemptStartedAt !== null && attemptStartedAt > state.decidedAt;

const noteFacts = (
  service: string,
  note: PreviewPreparationNote | null,
): ReadonlyArray<PreviewStatus> =>
  note === "recipe-changed"
    ? [{ _tag: "RecipeChanged", service }]
    : note === "setup-inputs-changed"
      ? [{ _tag: "SetupInputsChanged" }]
      : [];

const noteForAttempt = (
  state: PreviewPreparationState,
  attemptStartedAt: Date | null,
): PreviewPreparationNote | null => {
  if (state._tag === "Starting") return state.note;
  if (state._tag !== "Decided" || outlived(state, attemptStartedAt)) return null;
  const { decision } = state;
  return decision._tag === "Running" || decision._tag === "Started" ? decision.note : null;
};

export interface PreviewFacts {
  readonly preview: Preview;
  readonly resolution: PreviewGatewayResolution | null;
  /** The latest observation of the Service it binds, while it binds one. */
  readonly observation: {
    readonly state: ServiceTargetState;
    readonly httpStatus: number | null;
    readonly lastObservedAt: Date;
  } | null;
  /** When the attempt the resolution names began: the bound, starting or dormant source one. */
  readonly attemptStartedAt: Date | null;
}

/**
 * A preview's status, most telling first, from what the gateway resolves now and what the
 * worktree's latest preparation recorded (`PreviewPreparationsRepo.latestForWorktree`). A
 * person's Stop and a live attempt are read now; a preparation speaks only for its own Service,
 * and only until an attempt of it begins after its decision.
 */
export const previewStatusesOf = (
  facts: PreviewFacts,
  preparation: PreviewPreparation | null,
): ReadonlyArray<PreviewStatus> => {
  const service = facts.preview.serviceName;
  const mine =
    preparation !== null && serviceOf(preparation.state) === service ? preparation : null;
  const { resolution, observation } = facts;
  switch (resolution?._tag) {
    case "Stopped":
      return [
        { _tag: "Stopped", service, by: { _tag: "Person", name: resolution.control.byName } },
      ];
    case "Starting":
      return [
        {
          _tag: "Starting",
          service,
          phase: mine?.state._tag === "Starting" ? mine.state.phase : "service",
        },
      ];
    case "Bound": {
      const observed: ReadonlyArray<PreviewStatus> =
        observation === null
          ? []
          : [
              {
                _tag: "Observed",
                service,
                reachable: observation.state === "reachable",
                httpStatus: observation.httpStatus,
                observedAt: observation.lastObservedAt,
              },
            ];
      return [
        ...observed,
        ...(mine === null
          ? []
          : noteFacts(service, noteForAttempt(mine.state, facts.attemptStartedAt))),
      ];
    }
    default:
      return mine === null || outlived(mine.state, facts.attemptStartedAt)
        ? []
        : preparedFacts(mine);
  }
};

/**
 * The worktree's own line: what its latest preparation recorded when it names no kept preview, as
 * a change that was not captured, or a recipe refused before any preview of it existed.
 */
export const unpreparedStatusOf = (
  previews: ReadonlyArray<Preview>,
  preparation: PreviewPreparation | null,
): PreviewStatus | null => {
  if (preparation === null) return null;
  const service = serviceOf(preparation.state);
  if (service !== null && previews.some((preview) => preview.serviceName === service)) return null;
  return preparedFacts(preparation)[0] ?? null;
};
