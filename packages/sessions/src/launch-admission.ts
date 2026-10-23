import {
  agentProcessesOf,
  type LaunchAdmissionRule,
  LaunchMovedOnReason,
  SessionStatus,
  type SessionProcess,
} from "@mend/domain/workbench";
import { type Effect, Schema } from "effect";

import { LAUNCH_UNDER_WAY_WORDS } from "./launch-gate.ts";

/**
 * What a launch may launch over (SLNT-167). A client that read `failed` and sent Retry after
 * another client's resume had finished restarted the agent the other one had just brought up. The
 * API parses the request into one of these; the launch gate checks it before anything runs.
 */
export type LaunchOver =
  /**
   * The settled attempt the caller saw: `settledAt` as it read it (null: it read the session
   * unsettled with no agent, never launched).
   */
  | { readonly _tag: "Expected"; readonly settledAt: Date | null }
  /** Nothing named: a live or starting agent refuses the launch. */
  | { readonly _tag: "NoLiveAgent" }
  /** Replace a live agent (a PTY relaunch stops its workspace, as it always has). */
  | { readonly _tag: "Restart" };

/** A public launch's terms: what it may launch over, and what it does once admitted. */
export interface LaunchAdmission {
  readonly over: LaunchOver;
  /**
   * Runs once the launch is admitted, before it starts anything, and never for one refused: the
   * caller's writes about this launch (its model and effort, the session's naming).
   */
  readonly onAdmitted?: Effect.Effect<void>;
}

/**
 * The launcher's share of launches, which a hold takes once it is admitted (the API's per-account
 * launch slot): `take` answers null when none is free, and the hold settles in `refused`'s words.
 */
export interface LaunchSlot {
  readonly take: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A | null, E>;
  readonly refused: string;
}

export const Restart: LaunchOver = { _tag: "Restart" };
export const NoLiveAgent: LaunchOver = { _tag: "NoLiveAgent" };
export const Expected = (settledAt: Date | null): LaunchOver => ({ _tag: "Expected", settledAt });

/**
 * Whether an agent ever ran in the session, by its process rows of any status. The workbench shell
 * is not one: a launch may replace it.
 */
export const agentRanIn = (rows: ReadonlyArray<SessionProcess>): boolean =>
  agentProcessesOf(rows).some((row) => !(row.kind === "agent-pty" && row.harness === "shell"));

/** The session as the launch gate observed it. */
export interface LaunchObserved {
  readonly status: SessionStatus;
  readonly settledAt: Date | null;
  /** The engine's `agentIsLive`: shells, Services and the workbench shell are not an agent. */
  readonly agentLive: boolean;
  /** Another launch verb holds the gate. */
  readonly underWay: boolean;
  /** `agentRanIn` its process rows. */
  readonly agentRan: boolean;
}

export type LaunchRefusal =
  | {
      readonly _tag: "MovedOn";
      readonly status: SessionStatus;
      readonly settledAt: Date | null;
      readonly reason: LaunchMovedOnReason;
    }
  | {
      readonly _tag: "AgentLive";
      readonly status: SessionStatus;
      readonly settledAt: Date | null;
      readonly underWay: boolean;
    };

/** The answer while another launch verb holds the gate: every launch is refused. */
export const underWayRefusal = (over: LaunchOver, settledAt: Date | null): LaunchRefusal =>
  over._tag === "Expected"
    ? { _tag: "MovedOn", status: "starting", settledAt, reason: "underWay" }
    : { _tag: "AgentLive", status: "starting", settledAt, underWay: true };

const sameInstant = (a: Date | null, b: Date | null) =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

const movedOnFrom = (
  seenSettledAt: Date | null,
  observed: LaunchObserved,
): LaunchMovedOnReason | null => {
  if (observed.agentLive) return "agentLive";
  if (seenSettledAt === null && observed.agentRan) return "agentRan";
  return sameInstant(seenSettledAt, observed.settledAt) ? null : "settled";
};

export const LAUNCH_ADMISSION: LaunchAdmissionRule = "agentRan";

/** Null admits the launch; otherwise why it is refused. The whole policy. */
export const refusalOf = (over: LaunchOver, observed: LaunchObserved): LaunchRefusal | null => {
  if (observed.underWay) return underWayRefusal(over, observed.settledAt);
  const { status, settledAt } = observed;
  switch (over._tag) {
    case "Expected": {
      const reason = movedOnFrom(over.settledAt, observed);
      return reason === null ? null : { _tag: "MovedOn", status, settledAt, reason };
    }
    case "NoLiveAgent":
      return observed.agentLive ? { _tag: "AgentLive", status, settledAt, underWay: false } : null;
    case "Restart":
      return null;
  }
};

const refusalFields = {
  sessionId: Schema.String,
  status: SessionStatus,
  settledAt: Schema.NullOr(Schema.Date),
  message: Schema.String,
};

/** A launch over an attempt the session has moved on from: nothing launched. */
export class SessionMovedOnError extends Schema.TaggedError<SessionMovedOnError>()(
  "SessionMovedOnError",
  { ...refusalFields, reason: LaunchMovedOnReason },
) {}

/** A launch over a live or starting agent that did not ask to restart it: nothing restarted. */
export class SessionAgentLiveError extends Schema.TaggedError<SessionAgentLiveError>()(
  "SessionAgentLiveError",
  refusalFields,
) {}

export const refusalError = (
  sessionId: string,
  refusal: LaunchRefusal,
): SessionMovedOnError | SessionAgentLiveError => {
  const { status, settledAt } = refusal;
  switch (refusal._tag) {
    case "MovedOn":
      return new SessionMovedOnError({
        sessionId,
        status,
        settledAt,
        reason: refusal.reason,
        message:
          refusal.reason === "agentRan"
            ? `an agent already ran in this session · it reads ${status} · nothing launched again`
            : `the session moved on · it reads ${status}${
                settledAt === null ? "" : ` · settled ${settledAt.toISOString()}`
              } · nothing launched`,
      });
    case "AgentLive":
      return new SessionAgentLiveError({
        sessionId,
        status,
        settledAt,
        message: refusal.underWay
          ? LAUNCH_UNDER_WAY_WORDS
          : "the session's agent is live · nothing restarted · attach to it, or stop it and launch again",
      });
  }
};
