import type { OrchestrationV2Command, OrchestrationV2Run } from "@mend/t3-contracts";

import type { MendTurn, MendTurnSteer } from "./mend-workbench.ts";
import type { StoredEntry } from "./queue.ts";
import { harnessSteeringOf } from "./server-config.ts";
import { runIdOf, runsOf, type ThreadSource } from "./shell.ts";

/**
 * A native steer from a t3code client (ADR 0012, "Steering"), from the moment the gateway claims
 * it until Mend's answer settles it, and the one rule that moves it: `steerStep`. The hub only
 * carries a step out, under its lock.
 *
 * - `preparing`: claimed; its skills and images are being prepared.
 * - `posting`: its input is frozen and `POST /api/turns/:id/steer` is on its way, or its answer
 *   was lost.
 * - `observed`: Mend's receipt says `Sending`, or `Queued` into a turn that has not started.
 *
 * Once settled, a steer leaves the working set and only a `SentSteer` stays: what readback and
 * the projection need of it.
 *
 * A POST whose answer is lost is never taken as sent or as refused. Once a read that started
 * after it shows no receipt, the same input goes again under the same key: Mend answers the
 * receipt it already holds for that key, or admits the steer once. After `MAX_UNCONFIRMED`
 * such POSTs the steer fails where it stands, its words kept, and is never put back in the
 * queue, since Mend may have it.
 */
export interface SteerRecord {
  /**
   * New for every claim of the message: Mend's idempotency key for its POST, and what a worker
   * holds on to, so a worker whose claim was stopped never touches the claim after it.
   */
  readonly clientSteerId: string;
  readonly messageId: string;
  readonly runId: string;
  readonly targetTurnId: string;
  readonly targetRunId: string;
  readonly text: string;
  readonly imageIds: ReadonlyArray<string>;
  readonly requestedAt: string;
  readonly sender: string;
  readonly author: string;
  readonly intent: SteerIntent;
  readonly promotion: {
    readonly entry: StoredEntry;
    readonly successors: ReadonlyArray<string>;
  } | null;
  readonly phase:
    | { readonly kind: "preparing" }
    | {
        readonly kind: "posting";
        readonly input: string;
        readonly images: ReadonlyArray<{ readonly imageId: string; readonly path: string }>;
        readonly processId: string | null;
        /** How many of its POSTs went unanswered, or answered what cannot be its receipt. */
        readonly unconfirmed: number;
      }
    | {
        readonly kind: "observed";
        readonly input: string;
        readonly images: ReadonlyArray<{ readonly imageId: string; readonly path: string }>;
        readonly processId: string | null;
        readonly receipt: MendTurnSteer;
      };
}

export type SteerIntent = "steer" | "promoted_queued_to_steer";

/**
 * Where a settled steer's words show: in the target turn as Mend's receipt says (`sent`), as
 * their own turn (`queued`), in the target turn failed with why (`failed`), or nowhere, since
 * they went back to the person (`returned`).
 */
export type SteerOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "queued"; readonly turnId: string }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "returned" };

/** A settled steer, as kept for readback: its key, its words and where they show. */
export interface SentSteer {
  readonly clientSteerId: string;
  readonly messageId: string;
  readonly runId: string;
  readonly targetTurnId: string;
  readonly targetRunId: string;
  readonly text: string;
  readonly imageIds: ReadonlyArray<string>;
  readonly intent: SteerIntent;
  readonly requestedAt: string;
  readonly outcome: SteerOutcome;
}

/** What the thread shows of a steer, settled or still on its way (`pending`). */
export type ShownSteer = Omit<SentSteer, "outcome"> & {
  readonly outcome: SteerOutcome | { readonly kind: "pending" };
};

const sentOf = (record: SteerRecord, outcome: SteerOutcome): SentSteer => ({
  clientSteerId: record.clientSteerId,
  messageId: record.messageId,
  runId: record.runId,
  targetTurnId: record.targetTurnId,
  targetRunId: record.targetRunId,
  text: record.text,
  imageIds: record.imageIds,
  intent: record.intent,
  requestedAt: record.requestedAt,
  outcome,
});

export const queuedTurnOf = (record: SteerRecord): string | null =>
  record.phase.kind === "observed" && record.phase.receipt.delivery._tag === "Queued"
    ? record.phase.receipt.delivery.turnId
    : null;

export const shownOf = (record: SteerRecord): ShownSteer => {
  const words = sentOf(record, { kind: "sent" });
  if (record.phase.kind !== "observed") return { ...words, outcome: { kind: "pending" } };
  const turnId = queuedTurnOf(record);
  return turnId === null ? words : { ...words, outcome: { kind: "queued", turnId } };
};

const receiptNamesThisRequest = (
  record: SteerRecord,
  sessionId: string,
  receipt: MendTurnSteer,
  input: string,
): boolean =>
  receipt.sessionId === sessionId &&
  receipt.turnId === record.targetTurnId &&
  receipt.author === record.author &&
  receipt.clientSteerId === record.clientSteerId &&
  receipt.input === input;

const queuedIntoItsOwnTurn = (
  record: SteerRecord,
  sessionId: string,
  receipt: MendTurnSteer,
  input: string,
  turns: ReadonlyArray<MendTurn>,
): boolean => {
  const delivery = receipt.delivery;
  if (delivery._tag !== "Queued") return true;
  if (receipt.queuedTurnId !== delivery.turnId || delivery.turnId === record.targetTurnId)
    return false;
  const destination = turns.find((turn) => turn.id === delivery.turnId);
  return (
    destination === undefined ||
    (destination.sessionId === sessionId &&
      destination.fromSteer === receipt.id &&
      destination.author === record.author &&
      destination.input === input)
  );
};

export const receiptMatches = (
  record: SteerRecord,
  sessionId: string,
  receipt: MendTurnSteer,
  turns: ReadonlyArray<MendTurn>,
): boolean => {
  if (record.phase.kind !== "posting" && record.phase.kind !== "observed") return false;
  const input = record.phase.input;
  return (
    receiptNamesThisRequest(record, sessionId, receipt, input) &&
    queuedIntoItsOwnTurn(record, sessionId, receipt, input, turns)
  );
};

/**
 * Whether a receipt read now says more than the one kept. `Sending` moves on to anything Mend
 * settles; `Queued` moves on only to `NotSent`, Mend's withdrawal of a carry whose turn it could
 * not dispatch (`withdrawTurnSteer`). The rest are final.
 */
export const isLaterReceipt = (kept: MendTurnSteer, read: MendTurnSteer): boolean => {
  switch (kept.delivery._tag) {
    case "Sending":
      return Date.parse(read.updatedAt) >= Date.parse(kept.updatedAt);
    case "Queued":
      return read.delivery._tag === "NotSent";
    default:
      return false;
  }
};

const MAX_UNCONFIRMED = 3;

const UNCONFIRMED =
  "Mend never confirmed this message, so it may not have reached the agent. Look at the thread before sending it again.";

/** One more POST that settled nothing: posted again after a later read, or failed at the bound. */
const unconfirmed = (record: SteerRecord): SteerStep => {
  const phase = record.phase;
  if (phase.kind !== "posting" && phase.kind !== "observed") return UNCHANGED;
  const count = (phase.kind === "posting" ? phase.unconfirmed : 0) + 1;
  if (count >= MAX_UNCONFIRMED) return failed(record, UNCONFIRMED);
  return {
    kind: "changed",
    record: {
      ...record,
      phase: {
        kind: "posting",
        input: phase.input,
        images: phase.images,
        processId: phase.processId,
        unconfirmed: count,
      },
    },
  };
};

/**
 * The Mend turn a steer was queued into, once a read shows it is the steer's own: only then does
 * it carry the steer's t3code ids. Until a read shows it, the steer waits in its place.
 */
export const destinationOf = (
  record: SteerRecord,
  sessionId: string,
  turns: ReadonlyArray<MendTurn>,
): MendTurn | null => {
  if (record.phase.kind !== "observed") return null;
  const receipt = record.phase.receipt;
  const turnId = queuedTurnOf(record);
  const destination = turns.find((turn) => turn.id === turnId);
  return destination !== undefined &&
    receiptMatches(record, sessionId, receipt, turns) &&
    destination.fromSteer === receipt.id
    ? destination
    : null;
};

/** Turns Mend cancelled when it withdrew the steer it had queued them for: they never ran. */
export const withdrawnTurnIds = (turns: ReadonlyArray<MendTurn>): ReadonlySet<string> => {
  const withdrawn = new Set(
    turns.flatMap((turn) =>
      (turn.steers ?? [])
        .filter((receipt) => receipt.delivery._tag === "NotSent")
        .map((receipt) => receipt.id),
    ),
  );
  return new Set(
    turns
      .filter(
        (turn) =>
          turn.status === "cancelled" && turn.fromSteer != null && withdrawn.has(turn.fromSteer),
      )
      .map((turn) => turn.id),
  );
};

export const awaitsQueuedTurn = (record: SteerRecord, turns: ReadonlyArray<MendTurn>): boolean => {
  const turnId = queuedTurnOf(record);
  return turnId !== null && !turns.some((turn) => turn.id === turnId);
};

export const isUnsent = (record: SteerRecord): boolean =>
  record.phase.kind === "preparing" || record.phase.kind === "posting";

/** What Mend answered `POST /api/turns/:id/steer`. */
export type SteerAnswer =
  | { readonly kind: "receipt"; readonly receipt: MendTurnSteer }
  /** A definite refusal: Mend stored nothing. `notSender` is Mend's 403 for anyone but the sender. */
  | { readonly kind: "refused"; readonly reason: string; readonly notSender: boolean }
  /** No answer, or one that cannot be read: Mend may or may not have the steer. */
  | { readonly kind: "uncertain" };

export type SteerEvent =
  | {
      readonly kind: "prepared";
      readonly input: string;
      readonly images: ReadonlyArray<{ readonly imageId: string; readonly path: string }>;
      readonly processId: string | null;
    }
  | { readonly kind: "answered"; readonly answer: SteerAnswer }
  /**
   * A read of the session's turns from Mend. `checked`: no POST of it is on its way, and the read
   * started after its last one was answered.
   */
  | { readonly kind: "read"; readonly checked: boolean }
  /**
   * The gateway cannot carry it on: an interrupt, a stop, an archive, a preparation that failed,
   * a sender no longer paired. Before its POST, nothing reached Mend; after, it may have.
   */
  | { readonly kind: "stopped"; readonly reason: string };

export interface SteerFacts {
  readonly sessionId: string;
  /** The session's turns as last read, with their receipts. */
  readonly turns: ReadonlyArray<MendTurn>;
  /** A request is waiting on this claim's outcome, so a refusal can hand it the draft. */
  readonly caller: boolean;
}

export type SteerStep =
  | { readonly kind: "unchanged" }
  | { readonly kind: "changed"; readonly record: SteerRecord }
  /** Its input is frozen: POST it. */
  | { readonly kind: "post"; readonly record: SteerRecord }
  /**
   * It leaves the working set. `kept` is what stays for readback, `requeue` puts the words back in
   * the queue (a promotion in its place, a composer message as the sender's own turn), and
   * `refusal` is what a live caller is told; null is success.
   */
  | {
      readonly kind: "settled";
      readonly kept: SentSteer | null;
      readonly requeue: boolean;
      readonly refusal: string | null;
    };

const UNCHANGED: SteerStep = { kind: "unchanged" };

const NOT_SENT = "Mend did not send this message or queue a turn.";

const failed = (record: SteerRecord, reason: string): SteerStep => ({
  kind: "settled",
  kept: sentOf(record, { kind: "failed", reason }),
  requeue: false,
  refusal: null,
});

/**
 * Mend has not sent the words and never will. A promotion goes back to its place; a composer
 * message goes back to its live caller as a refusal, or stays in the thread, failed, when nobody
 * waits for it. `stored` is a NotSent receipt Mend keeps, which a returned message still hides.
 */
const notSent = (
  record: SteerRecord,
  reason: string,
  facts: SteerFacts,
  stored: boolean,
): SteerStep => {
  if (record.promotion === null && !facts.caller) return failed(record, reason);
  return {
    kind: "settled",
    kept: stored ? sentOf(record, { kind: "returned" }) : null,
    requeue: record.promotion !== null,
    refusal: reason,
  };
};

const sent = (record: SteerRecord, outcome: SteerOutcome): SteerStep => ({
  kind: "settled",
  kept: sentOf(record, outcome),
  requeue: false,
  refusal: null,
});

/**
 * A Queued steer settles once a read shows its own turn has left the queue, where Mend can no
 * longer withdraw it.
 */
const startedTurn = (record: SteerRecord, facts: SteerFacts): SteerStep | null => {
  const destination = destinationOf(record, facts.sessionId, facts.turns);
  return destination === null || destination.status === "queued"
    ? null
    : sent(record, { kind: "queued", turnId: destination.id });
};

/** Mend's receipt for this claim, answered or read: what it says decides the step. */
const receiptStep = (record: SteerRecord, receipt: MendTurnSteer, facts: SteerFacts): SteerStep => {
  const phase = record.phase;
  if (phase.kind === "preparing") return UNCHANGED;
  if (phase.kind === "observed" && !isLaterReceipt(phase.receipt, receipt))
    return startedTurn(record, facts) ?? UNCHANGED;
  const delivery = receipt.delivery;
  switch (delivery._tag) {
    case "NotSent":
      return notSent(
        record,
        facts.caller ? NOT_SENT : `${NOT_SENT.slice(0, -1)}: ${delivery.reason}.`,
        facts,
        true,
      );
    case "Accepted":
    case "Unknown":
      return sent(record, { kind: "sent" });
    case "Sending":
    case "Queued": {
      const next: SteerRecord = {
        ...record,
        phase: {
          kind: "observed",
          input: phase.input,
          images: phase.images,
          processId: phase.processId,
          receipt,
        },
      };
      return startedTurn(next, facts) ?? { kind: "changed", record: next };
    }
  }
};

const answered = (record: SteerRecord, answer: SteerAnswer, facts: SteerFacts): SteerStep => {
  switch (answer.kind) {
    case "uncertain":
      return record.phase.kind === "posting" ? unconfirmed(record) : UNCHANGED;
    case "refused":
      // A receipt already read is Mend's word; a refusal after it changes nothing.
      if (record.phase.kind !== "posting") return UNCHANGED;
      if (answer.notSender && record.promotion === null)
        return { kind: "settled", kept: null, requeue: true, refusal: null };
      return notSent(record, answer.reason, facts, false);
    case "receipt":
      if (receiptMatches(record, facts.sessionId, answer.receipt, facts.turns))
        return receiptStep(record, answer.receipt, facts);
      return record.phase.kind === "posting" ? unconfirmed(record) : UNCHANGED;
  }
};

const read = (record: SteerRecord, checked: boolean, facts: SteerFacts): SteerStep => {
  const phase = record.phase;
  if (phase.kind !== "posting" && phase.kind !== "observed") return UNCHANGED;
  const receipt = facts.turns
    .flatMap((turn) => turn.steers ?? [])
    .find((candidate) => receiptMatches(record, facts.sessionId, candidate, facts.turns));
  if (receipt !== undefined) return receiptStep(record, receipt, facts);
  if (phase.kind === "observed")
    return receiptMatches(record, facts.sessionId, phase.receipt, facts.turns)
      ? (startedTurn(record, facts) ?? UNCHANGED)
      : unconfirmed(record);
  return checked ? { kind: "post", record } : UNCHANGED;
};

/** The one rule a steer moves by: every path through the hub asks it, and carries out its step. */
export const steerStep = (record: SteerRecord, event: SteerEvent, facts: SteerFacts): SteerStep => {
  switch (event.kind) {
    case "prepared":
      if (record.phase.kind !== "preparing") return UNCHANGED;
      return {
        kind: "post",
        record: {
          ...record,
          phase: {
            kind: "posting",
            input: event.input,
            images: event.images,
            processId: event.processId,
            unconfirmed: 0,
          },
        },
      };
    case "answered":
      if (record.phase.kind !== "posting" && record.phase.kind !== "observed") return UNCHANGED;
      return answered(record, event.answer, facts);
    case "read":
      return read(record, event.checked, facts);
    case "stopped":
      if (record.phase.kind === "preparing") return notSent(record, event.reason, facts, false);
      return record.phase.kind === "posting" ? failed(record, event.reason) : UNCHANGED;
  }
};

// ─── Where a message goes ─────────────────────────────────────────────────────

type DispatchMessage = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
export type DispatchMode = DispatchMessage["dispatchMode"];
export type DeliveryIntent = DispatchMessage["deliveryIntent"];

export type DeliveryRequest =
  | {
      readonly kind: "message";
      readonly mode: DispatchMode;
      readonly intent: DeliveryIntent;
      readonly text: string;
      readonly imageIds: ReadonlyArray<string>;
    }
  | {
      readonly kind: "promotion";
      readonly targetRunId: string;
      readonly text: string;
      readonly imageIds: ReadonlyArray<string>;
    };

/** `queue`: an ordinary turn through the queue; for a promotion, it stays where it is. */
export type Delivery =
  | { readonly kind: "queue" }
  | { readonly kind: "steer"; readonly target: MendTurn; readonly targetRunId: string }
  | { readonly kind: "refuse"; readonly reason: string };

const QUEUE: Delivery = { kind: "queue" };
const refuse = (reason: string): Delivery => ({ kind: "refuse", reason });

const isMaintenance = (text: string, imageIds: ReadonlyArray<string>) =>
  imageIds.length === 0 && ["/compact", "/logout"].includes(text.trim().toLowerCase());
const isGoal = (text: string, imageIds: ReadonlyArray<string>) =>
  imageIds.length === 0 && /^\/goal(?:\s|$)/u.test(text.trim());

const ACTIVE_RUN: ReadonlySet<string> = new Set(["preparing", "starting", "running", "waiting"]);

/** Upstream's `resolveDeliveryIntent` (CommandPolicy.ts), on Mend's turns. */
const intendedMode = (
  source: ThreadSource,
  runs: ReadonlyArray<OrchestrationV2Run>,
  intent: NonNullable<DispatchMessage["deliveryIntent"]>,
): DispatchMessage["dispatchMode"] => {
  const active = runs.findLast((run) => ACTIVE_RUN.has(run.status));
  if (active === undefined) return { type: "start_immediately" };
  if (intent === "steer") return { type: "steer_active", targetRunId: active.id };
  if (intent === "restart") return { type: "restart_active", targetRunId: active.id };
  const turn = source.turns.find((candidate) => runIdOf(source, candidate) === active.id);
  if (active.status === "preparing" || active.status === "starting" || turn?.providerTurnId == null)
    return { type: "queue_after_active" };
  return harnessSteeringOf(source.session.harness).supportsActiveSteering
    ? { type: "steer_active", targetRunId: active.id }
    : { type: "queue_after_active" };
};

/**
 * Whether the run's Mend turn takes a steer from this person now. `strict` (an explicit steer or
 * restart) refuses a run with no running provider turn rather than queue behind it.
 */
const steerInto = (
  source: ThreadSource,
  runs: ReadonlyArray<OrchestrationV2Run>,
  targetRunId: string,
  facts: { readonly author: string; readonly stopped: ReadonlySet<string> },
  how: { readonly strict: boolean; readonly automatic: boolean; readonly promotion: boolean },
): Delivery => {
  const run = runs.find((candidate) => candidate.id === targetRunId);
  if (run === undefined) return refuse("That run is not in this thread.");
  const target = source.turns.find((turn) => runIdOf(source, turn) === targetRunId);
  // Compaction and sign-out take no steers; another person's message is their own turn.
  if (
    target !== undefined &&
    (isMaintenance(target.input, []) || target.steerSender !== facts.author)
  )
    return QUEUE;
  if (target !== undefined && facts.stopped.has(target.id))
    return how.automatic ? QUEUE : refuse("That run was stopped and cannot be steered.");
  if (
    target === undefined ||
    target.status !== "running" ||
    (how.strict && (run.status !== "running" || target.providerTurnId == null))
  )
    return how.promotion || (how.strict && run.status !== "completed")
      ? refuse("That run has no running provider turn to steer.")
      : QUEUE;
  return { kind: "steer", target, targetRunId };
};

const separateTurnRefusal = (text: string) =>
  refuse(
    text.trim().toLowerCase() === "/compact"
      ? "Context compaction must run as a separate turn. Queue it or wait for the active turn to finish."
      : text.trim().toLowerCase() === "/logout"
        ? "Signing out must run as a separate turn. Queue it or wait for the active turn to finish."
        : "Goal commands must run as a separate turn. Queue it or wait for the active turn to finish.",
  );

/**
 * Where a message goes, decided once, under the hub's lock, on the hub's own reads: a delivery
 * intent resolves as upstream's `message.dispatch` does, then Mend's rules for a steer apply.
 */
export const deliveryOf = (
  source: ThreadSource,
  request: DeliveryRequest,
  facts: { readonly author: string; readonly stopped: ReadonlySet<string> },
): Delivery => {
  const runs = runsOf(source);
  if (request.kind === "promotion") {
    if (isMaintenance(request.text, request.imageIds) || isGoal(request.text, request.imageIds))
      return separateTurnRefusal(request.text);
    return steerInto(source, runs, request.targetRunId, facts, {
      strict: true,
      automatic: false,
      promotion: true,
    });
  }
  const mode =
    request.intent === undefined ? request.mode : intendedMode(source, runs, request.intent);
  if (mode.type !== "steer_active" && mode.type !== "restart_active") return QUEUE;
  // A goal command never joins a running turn; it waits for its own.
  if (isGoal(request.text, request.imageIds)) return QUEUE;
  if (isMaintenance(request.text, request.imageIds)) return separateTurnRefusal(request.text);
  return steerInto(source, runs, mode.targetRunId, facts, {
    strict: request.intent !== undefined,
    automatic: request.intent === "auto",
    promotion: false,
  });
};
