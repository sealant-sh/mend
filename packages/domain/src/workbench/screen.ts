import { Schema } from "effect";

import {
  AgentItemId,
  AgentTurnId,
  CheckpointId,
  ScreenFrameId,
  ScreenId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  ViewerConnectionId,
} from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/** ADR 0020's D7 and D13 defaults. */
export const SCREEN_LIMITS = {
  width: 1280,
  height: 800,
  idleStopMs: 15 * 60_000,
  pausedTimeoutMs: 2 * 60_000,
  heartbeatMs: 10_000,
  batchActions: 20,
  typeChars: 2_000,
  waitMs: 5_000,
  batchMs: 60_000,
  scrollSteps: 20,
  keyComboChars: 64,
  frameBytesPerScreen: 500_000_000,
  frameBytesPerOrganization: 20_000_000_000,
} as const;

const intBetween = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The X display `:<n>` a session keeps from its first launch until it ends. */
export const DisplayNumber = intBetween(10, 99).pipe(Schema.brand("DisplayNumber"));
export type DisplayNumber = typeof DisplayNumber.Type;

export const ScreenPoint = Schema.Struct({
  x: intBetween(0, SCREEN_LIMITS.width - 1),
  y: intBetween(0, SCREEN_LIMITS.height - 1),
});
export type ScreenPoint = typeof ScreenPoint.Type;

const scrollSteps = intBetween(-SCREEN_LIMITS.scrollSteps, SCREEN_LIMITS.scrollSteps);
const Click = Schema.Struct({
  kind: Schema.Literal("click"),
  at: ScreenPoint,
  button: Schema.optionalKey(Schema.Literals(["left", "middle", "right"])),
  count: Schema.optionalKey(intBetween(1, 3)),
});
const Move = Schema.Struct({ kind: Schema.Literal("move"), to: ScreenPoint });
const Drag = Schema.Struct({ kind: Schema.Literal("drag"), from: ScreenPoint, to: ScreenPoint });
const Scroll = Schema.Struct({
  kind: Schema.Literal("scroll"),
  at: ScreenPoint,
  dx: scrollSteps,
  dy: scrollSteps,
});
const Type = Schema.Struct({
  kind: Schema.Literal("type"),
  text: Schema.String.check(Schema.isBetweenLength(1, SCREEN_LIMITS.typeChars)),
});
const Key = Schema.Struct({
  kind: Schema.Literal("key"),
  combo: Schema.String.check(
    Schema.isMaxLength(SCREEN_LIMITS.keyComboChars),
    Schema.isPattern(/^[^+\s]+(\+[^+\s]+)*$/),
  ),
});
const Wait = Schema.Struct({
  kind: Schema.Literal("wait"),
  ms: intBetween(1, SCREEN_LIMITS.waitMs),
});

export const ScreenAction = Schema.Union([Click, Move, Drag, Scroll, Type, Key, Wait]);
export type ScreenAction = typeof ScreenAction.Type;

export const ScreenActParams = Schema.Struct({
  actions: Schema.Array(ScreenAction).check(Schema.isBetweenLength(1, SCREEN_LIMITS.batchActions)),
});
export type ScreenActParams = typeof ScreenActParams.Type;

export const ScreenActionResult = Schema.Literals([
  "done",
  "skipped: taken over",
  "skipped: time limit",
]);
export type ScreenActionResult = typeof ScreenActionResult.Type;

const TypedLength = Schema.Struct({ kind: Schema.Literal("type"), length: Count });
export const ScreenActionNote = Schema.Struct({
  action: Schema.Union([Click, Move, Drag, Scroll, TypedLength, Key, Wait]),
  result: ScreenActionResult,
});
export type ScreenActionNote = typeof ScreenActionNote.Type;

export const screenActionNote = (
  action: ScreenAction,
  result: ScreenActionResult,
): ScreenActionNote => ({
  action: action.kind === "type" ? { kind: "type", length: action.text.length } : action,
  result,
});

export const ScreenLapse = Schema.Literals(["lease-lapsed", "disconnected", "revoked", "restart"]);
export type ScreenLapse = typeof ScreenLapse.Type;
export const ScreenDegraded = Schema.Literals(["client-failed", "decoder-refused"]);
export type ScreenDegraded = typeof ScreenDegraded.Type;
export const ScreenEndReason = Schema.Literals([
  "idle",
  "session-stopped",
  "process-exited",
  "workspace-ended",
]);
export type ScreenEndReason = typeof ScreenEndReason.Type;

/** Who may put input on the screen. Every change of holder bumps `epoch`. */
export const ScreenInput = Schema.Union([
  Schema.TaggedStruct("Agent", { epoch: Count }),
  Schema.TaggedStruct("Fencing", {
    epoch: Count,
    by: Schema.String,
    to: Schema.Union([
      Schema.TaggedStruct("Person", { connection: ViewerConnectionId }),
      Schema.TaggedStruct("AwaitingAgent", {}),
    ]),
  }),
  Schema.TaggedStruct("Person", {
    epoch: Count,
    userId: Schema.String,
    connection: ViewerConnectionId,
  }),
  Schema.TaggedStruct("Paused", { epoch: Count, reason: ScreenLapse, since: Timestamp }),
  Schema.TaggedStruct("AwaitingAgent", { epoch: Count }),
]);
export type ScreenInput = typeof ScreenInput.Type;

export const SCREEN_INPUT_INITIAL: ScreenInput = { _tag: "AwaitingAgent", epoch: 0 };

export const ScreenLife = Schema.Union([
  Schema.TaggedStruct("Starting", {}),
  Schema.TaggedStruct("Live", { degraded: Schema.NullOr(ScreenDegraded) }),
  Schema.TaggedStruct("Ended", { reason: ScreenEndReason }),
]);
export type ScreenLife = typeof ScreenLife.Type;

export const Screen = Schema.Struct({
  id: ScreenId,
  sessionId: SessionId,
  workspaceId: SealantWorkspaceId,
  display: DisplayNumber,
  processId: Schema.NullOr(SessionProcessId),
  life: ScreenLife,
  input: ScreenInput,
});
export type Screen = typeof Screen.Type;

export const ScreenActor = Schema.Union([
  Schema.TaggedStruct("Person", { userId: Schema.String }),
  Schema.TaggedStruct("Mend", {}),
  Schema.TaggedStruct("Agent", {
    processId: SessionProcessId,
    turnId: Schema.NullOr(AgentTurnId),
    callKey: Schema.String,
    toolCall: Schema.Union([
      Schema.TaggedStruct("Item", { itemId: AgentItemId }),
      Schema.TaggedStruct("Native", {}),
      Schema.TaggedStruct("Pending", {}),
      Schema.TaggedStruct("Gap", {}),
    ]),
  }),
]);
export type ScreenActor = typeof ScreenActor.Type;

export const ScreenLogBody = Schema.Union([
  Schema.TaggedStruct("Started", {}),
  Schema.TaggedStruct("Looked", {}),
  Schema.TaggedStruct("Acted", { notes: Schema.Array(ScreenActionNote) }),
  Schema.TaggedStruct("Taken", { epoch: Count }),
  Schema.TaggedStruct("HandedBack", { epoch: Count }),
  Schema.TaggedStruct("PersonInput", { clicks: Count, keys: Count, pastes: Count }),
  Schema.TaggedStruct("Paused", { reason: ScreenLapse }),
  Schema.TaggedStruct("FramesNotKept", { budget: Schema.Literals(["screen", "organization"]) }),
  Schema.TaggedStruct("Degraded", { reason: ScreenDegraded }),
  Schema.TaggedStruct("Ended", { reason: ScreenEndReason }),
]);
export type ScreenLogBody = typeof ScreenLogBody.Type;

export const FrameDigest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("FrameDigest"),
);
export type FrameDigest = typeof FrameDigest.Type;

export const ScreenLogEntry = Schema.Struct({
  screenId: ScreenId,
  seq: Count,
  at: Timestamp,
  actor: ScreenActor,
  body: ScreenLogBody,
  frame: Schema.NullOr(
    Schema.Struct({
      id: ScreenFrameId,
      digest: FrameDigest,
      state: Schema.Literals(["stored", "expired", "missing"]),
    }),
  ),
  checkpoint: Schema.NullOr(Schema.TaggedStruct("ObservedAfter", { checkpointId: CheckpointId })),
});
export type ScreenLogEntry = typeof ScreenLogEntry.Type;

export const ScreenMoment = Schema.Struct({ screenId: ScreenId, seq: Count });
export type ScreenMoment = typeof ScreenMoment.Type;

export const ScreenSpan = Schema.Struct({ screenId: ScreenId, fromSeq: Count, toSeq: Count }).check(
  Schema.makeFilter((span) => span.fromSeq <= span.toSeq),
);
export type ScreenSpan = typeof ScreenSpan.Type;

/** The `screen` record item: one screen's span of one turn, never its frames. */
export const ScreenEpisode = Schema.Struct({
  span: ScreenSpan,
  actions: Count,
  frames: Count,
  coverFrameId: Schema.NullOr(ScreenFrameId),
  personHeld: Schema.Boolean,
});
export type ScreenEpisode = typeof ScreenEpisode.Type;

export type ScreenInputEvent =
  | { readonly _tag: "Take"; readonly by: string; readonly connection: ViewerConnectionId }
  | { readonly _tag: "Fenced"; readonly epoch: number }
  | {
      readonly _tag: "Lapse";
      readonly connection: ViewerConnectionId;
      readonly reason: Exclude<ScreenLapse, "restart">;
      readonly at: Date;
    }
  | { readonly _tag: "HandBack"; readonly by: string }
  | { readonly _tag: "PausedTimeout"; readonly at: Date }
  | { readonly _tag: "AgentLooked" }
  | { readonly _tag: "AgentActed" }
  | { readonly _tag: "Boot"; readonly at: Date }
  | { readonly _tag: "Ended" };

export interface ScreenInputLog {
  readonly actor: Extract<ScreenActor, { readonly _tag: "Person" | "Mend" }>;
  readonly body: Extract<ScreenLogBody, { readonly _tag: "Taken" | "HandedBack" | "Paused" }>;
}

/**
 * `Changed`: store `next`; when `releases`, the hand sends a key-up and a button-up for everything
 * the former holder holds before anything behind it; append `log` when present.
 */
export type ScreenInputTransition =
  | {
      readonly _tag: "Changed";
      readonly next: ScreenInput;
      readonly releases: boolean;
      readonly log: ScreenInputLog | null;
    }
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Refused"; readonly why: "owner-only" | "held" | "look-first" };

const UNCHANGED: ScreenInputTransition = { _tag: "Unchanged" };

const changed = (
  next: ScreenInput,
  releases: boolean,
  log: ScreenInputLog | null = null,
): ScreenInputTransition => ({ _tag: "Changed", next, releases, log });

const handedBack = (epoch: number, actor: ScreenInputLog["actor"]): ScreenInputTransition =>
  changed({ _tag: "AwaitingAgent", epoch }, false, { actor, body: { _tag: "HandedBack", epoch } });

const holderConnection = (input: ScreenInput): ViewerConnectionId | null => {
  if (input._tag === "Person") return input.connection;
  return input._tag === "Fencing" && input.to._tag === "Person" ? input.to.connection : null;
};

/** ADR 0020's table of who holds the input, applied under the screen row's lock. */
export const transitionInput = (
  input: ScreenInput,
  event: ScreenInputEvent,
  owner: string | null,
): ScreenInputTransition => {
  const epoch = input.epoch + 1;
  const pause = (reason: ScreenLapse, since: Date, releases: boolean): ScreenInputTransition =>
    changed({ _tag: "Paused", epoch, reason, since }, releases, {
      actor: { _tag: "Mend" },
      body: { _tag: "Paused", reason },
    });
  switch (event._tag) {
    case "Take":
      if (owner === null || event.by !== owner) return { _tag: "Refused", why: "owner-only" };
      if (holderConnection(input) === event.connection) return UNCHANGED;
      return changed(
        {
          _tag: "Fencing",
          epoch,
          by: event.by,
          to: { _tag: "Person", connection: event.connection },
        },
        input._tag === "Agent" || input._tag === "Person",
      );
    case "Fenced": {
      if (input._tag !== "Fencing" || input.epoch !== event.epoch) return UNCHANGED;
      const actor: ScreenInputLog["actor"] = { _tag: "Person", userId: input.by };
      if (input.to._tag === "AwaitingAgent") return handedBack(input.epoch, actor);
      return changed(
        { _tag: "Person", epoch: input.epoch, userId: input.by, connection: input.to.connection },
        false,
        { actor, body: { _tag: "Taken", epoch: input.epoch } },
      );
    }
    case "Lapse":
      return holderConnection(input) === event.connection
        ? pause(event.reason, event.at, input._tag === "Person")
        : UNCHANGED;
    case "HandBack":
      if (owner === null || event.by !== owner) return { _tag: "Refused", why: "owner-only" };
      if (input._tag === "Paused") return handedBack(epoch, { _tag: "Person", userId: event.by });
      if (input._tag === "Person" || (input._tag === "Fencing" && input.to._tag === "Person")) {
        return changed(
          { _tag: "Fencing", epoch, by: event.by, to: { _tag: "AwaitingAgent" } },
          input._tag === "Person",
        );
      }
      return UNCHANGED;
    case "PausedTimeout":
      return input._tag === "Paused" &&
        event.at.getTime() - input.since.getTime() >= SCREEN_LIMITS.pausedTimeoutMs
        ? handedBack(epoch, { _tag: "Mend" })
        : UNCHANGED;
    case "AgentLooked":
      if (input._tag === "Agent") return UNCHANGED;
      return input._tag === "AwaitingAgent"
        ? changed({ _tag: "Agent", epoch }, false)
        : { _tag: "Refused", why: "held" };
    case "AgentActed":
      if (input._tag === "Agent") return UNCHANGED;
      return { _tag: "Refused", why: input._tag === "AwaitingAgent" ? "look-first" : "held" };
    case "Boot":
      if (input._tag === "Agent") return changed({ _tag: "AwaitingAgent", epoch }, false);
      return input._tag === "Fencing" || input._tag === "Person"
        ? pause("restart", event.at, false)
        : UNCHANGED;
    case "Ended":
      return input._tag === "AwaitingAgent"
        ? UNCHANGED
        : changed({ _tag: "AwaitingAgent", epoch }, false);
  }
};
