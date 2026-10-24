import { DEFAULT_SERVER_SETTINGS } from "@mend/t3-contracts";
import { backgroundWorkHoldsCompletion } from "@mend/t3-contracts/pending-background-work";
import * as DateTime from "effect/DateTime";

import type { MendTurn } from "./mend-workbench.ts";
import {
  isActiveRunStatus,
  latestOf,
  runsOf,
  type SettlementCandidate,
  threadUpdatedAtOf,
  type PendingRun,
  type ThreadSource,
} from "./shell.ts";
import type { ThreadLifecycle } from "./state.ts";

/**
 * Settle, snooze, pin and order (`thread.settle`, `thread.unsettle`, `thread.snooze`,
 * `thread.unsnooze`, `thread.pin`, `thread.unpin`, `thread.pin.reorder`, `thread.active.reorder`,
 * `thread.auto-settle.set`): the person's own view of a thread, kept by the gateway as Mend has
 * none of them (ADR 0012), with the rules t3code's own server applies (`Orchestrator.ts` at the
 * pinned tag). The order keys are the client's fractional keys (`threadSort.ts` in its client
 * runtime), kept as sent, as t3code's server keeps them.
 *
 * The gateway keeps a snooze as set and wakes it early in one case only: something asked the
 * thread for work. Every other wake is the t3code client's own, read from the shell
 * (`threadSettled.ts` in its client runtime): the snooze's time passing, a pending request, a turn
 * that failed after the snooze. A turn that completes leaves the snooze as it is. The shell
 * carries what those read.
 */

export const NO_LIFECYCLE: ThreadLifecycle = {
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  lastSnoozeWakeAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  autoSettleDisabledAt: null,
};

export const MAX_ORDER_KEY_LENGTH = 1_024;

const isAfter = (later: string | null, earlier: string | null): boolean =>
  later !== null && earlier !== null && Date.parse(later) > Date.parse(earlier);

/**
 * The person's settle, snooze, pin and order as they stand now. A turn opened, or a message
 * queued, after a settle or a snooze ends it, as a new run does on t3code's own server: the thread
 * is no longer settled (nor kept active by an unsettle) and is awake.
 */
export const lifecycleOf = (
  kept: ThreadLifecycle | undefined,
  thread: {
    readonly turns: ReadonlyArray<Pick<MendTurn, "createdAt">>;
    readonly pending: ReadonlyArray<Pick<PendingRun, "state" | "requestedAt">>;
  },
): ThreadLifecycle => {
  if (kept === undefined) return NO_LIFECYCLE;
  const asked = latestOf([
    ...thread.turns.map((turn) => turn.createdAt),
    ...thread.pending
      .filter((entry) => entry.state !== "cancelled")
      .map((entry) => entry.requestedAt),
  ]);
  const overrideAt =
    kept.settledOverride === "settled"
      ? kept.settledAt
      : kept.settledOverride === "active"
        ? kept.unsettledAt
        : null;
  const settlement = isAfter(asked, overrideAt)
    ? {
        settledOverride: null,
        settledAt: null,
        unsettledAt: kept.settledOverride === "settled" ? asked : kept.unsettledAt,
      }
    : {
        settledOverride: kept.settledOverride,
        settledAt: kept.settledAt,
        unsettledAt: kept.unsettledAt,
      };
  const snooze = isAfter(asked, kept.snoozedAt)
    ? { snoozedUntil: null, snoozedAt: null }
    : { snoozedUntil: kept.snoozedUntil, snoozedAt: kept.snoozedAt };
  return { ...kept, ...settlement, ...snooze };
};

const LIFECYCLE_FIELDS = Object.keys(NO_LIFECYCLE).filter(
  (key): key is keyof ThreadLifecycle => key in NO_LIFECYCLE,
);

export const sameLifecycle = (left: ThreadLifecycle, right: ThreadLifecycle): boolean =>
  LIFECYCLE_FIELDS.every((field) => left[field] === right[field]);

export const isLifecycleEmpty = (lifecycle: ThreadLifecycle): boolean =>
  sameLifecycle(lifecycle, NO_LIFECYCLE);

export type LifecycleChange =
  | { readonly kind: "settle" }
  | { readonly kind: "unsettle" }
  | { readonly kind: "snooze"; readonly until: string }
  | { readonly kind: "unsnooze" }
  | { readonly kind: "pin"; readonly orderKey: string | undefined }
  | { readonly kind: "unpin" }
  | { readonly kind: "reorder-pinned"; readonly orderKey: string }
  | { readonly kind: "reorder-active"; readonly orderKey: string }
  | { readonly kind: "auto-settle-set"; readonly enabled: boolean }
  | { readonly kind: "auto-settle"; readonly settledAt: string };

export type LifecycleChanged =
  | { readonly _tag: "Changed"; readonly lifecycle: ThreadLifecycle }
  | { readonly _tag: "Refused"; readonly reason: string };

const refused = (reason: string): LifecycleChanged => ({ _tag: "Refused", reason });
const changed = (lifecycle: ThreadLifecycle): LifecycleChanged => ({
  _tag: "Changed",
  lifecycle,
});

const orderKeyRefusal = (orderKey: string | undefined): LifecycleChanged | null =>
  orderKey !== undefined && orderKey.length > MAX_ORDER_KEY_LENGTH
    ? refused(`An order key is at most ${MAX_ORDER_KEY_LENGTH} characters.`)
    : null;

export const changeLifecycle = (
  source: ThreadSource,
  change: LifecycleChange,
  now: Date,
): LifecycleChanged => {
  const current = source.lifecycle;
  // Never before the latest time Mend gave the thread: a mark is compared with Mend's times
  // (`lifecycleOf`, and the client's wakes), and Mend's clock may run ahead of the gateway's.
  const at = latestOf([now.toISOString(), threadUpdatedAtOf(source)]) ?? now.toISOString();
  const runs = runsOf(source);
  const asking = source.requests.some((request) => request.status === "pending");
  const working = runs.some((run) => run.status === "queued" || isActiveRunStatus(run.status));
  const settled = (settledAt: string): ThreadLifecycle => ({
    ...current,
    settledOverride: "settled",
    settledAt,
    unsettledAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    snoozedUntil: null,
    snoozedAt: null,
  });
  // A snooze ended by hand restarts the quiet clock, as t3code's own server dates it.
  const woken = {
    snoozedUntil: null,
    snoozedAt: null,
    lastSnoozeWakeAt: current.snoozedUntil === null ? current.lastSnoozeWakeAt : at,
  };
  switch (change.kind) {
    case "settle": {
      if (asking) {
        return refused("The agent is waiting on an answer. Answer it, then settle the thread.");
      }
      if (working) {
        return refused(
          "The thread has a turn running or a message waiting. Settle it once they are done.",
        );
      }
      const already =
        current.settledOverride === "settled" && current.pinnedAt === null
          ? current.settledAt
          : null;
      return changed(settled(already ?? at));
    }
    case "auto-settle":
      return asking || working
        ? refused("The thread has work in hand, so it does not settle on its own.")
        : changed(settled(change.settledAt));
    case "unsettle": {
      const already = current.settledOverride === "active";
      return changed({
        ...current,
        settledOverride: "active",
        settledAt: null,
        unsettledAt: already ? current.unsettledAt : at,
      });
    }
    case "snooze": {
      const until = Date.parse(change.until);
      if (Number.isNaN(until) || until <= now.getTime()) {
        return refused(`A snooze ends in the future; ${change.until} is not.`);
      }
      if (asking) {
        return refused(
          "The agent is waiting on an answer, which a snooze would hide. Answer it first.",
        );
      }
      if (
        runs.some(
          (run) =>
            run.status === "queued" || run.status === "preparing" || run.status === "starting",
        )
      ) {
        return refused("A message is waiting to be sent, which a snooze would hide.");
      }
      // Stamped again for the same time too: snoozing a thread that woke says "seen, not now".
      return changed({ ...current, snoozedUntil: new Date(until).toISOString(), snoozedAt: at });
    }
    case "unsnooze":
      return changed({ ...current, ...woken });
    case "pin": {
      const tooLong = orderKeyRefusal(change.orderKey);
      if (tooLong !== null) return tooLong;
      if (current.pinnedAt !== null) return changed({ ...current, ...woken });
      const wasSettled = current.settledOverride === "settled";
      return changed({
        ...current,
        pinnedAt: at,
        pinOrderKey: change.orderKey ?? current.pinOrderKey,
        settledOverride: wasSettled ? "active" : current.settledOverride,
        settledAt: wasSettled ? null : current.settledAt,
        unsettledAt: wasSettled ? at : current.unsettledAt,
        ...woken,
      });
    }
    case "unpin":
      return changed({ ...current, pinnedAt: null, pinOrderKey: null });
    case "reorder-pinned": {
      if (current.pinnedAt === null) {
        return refused("The thread is not pinned, so it has no place among the pins.");
      }
      return (
        orderKeyRefusal(change.orderKey) ?? changed({ ...current, pinOrderKey: change.orderKey })
      );
    }
    case "reorder-active": {
      if (current.pinnedAt !== null || current.settledOverride === "settled") {
        return refused("The thread is not in Active, so it has no place there.");
      }
      return (
        orderKeyRefusal(change.orderKey) ?? changed({ ...current, activeOrderKey: change.orderKey })
      );
    }
    case "auto-settle-set":
      return changed({
        ...current,
        autoSettleDisabledAt: change.enabled ? null : (current.autoSettleDisabledAt ?? at),
      });
  }
};

const DAY_MS = 24 * 60 * 60 * 1_000;
/** t3code's `QUEUED_TURN_START_GRACE_MS`. */
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/** t3code's default: the gateway serves t3code's default settings and refuses changes to them. */
export const AUTO_SETTLE_AFTER_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays;

const millisOf = (value: DateTime.Utc | null | undefined): number | null =>
  value == null ? null : DateTime.toEpochMillis(value);

const latestMillis = (values: ReadonlyArray<number | null>): number | null =>
  values.reduce<number | null>(
    (latest, value) => (value !== null && (latest === null || value > latest) ? value : latest),
    null,
  );

/** t3code's `threadHasQueuedTurnStart`. */
const hasQueuedTurnStart = (thread: SettlementCandidate, nowMs: number): boolean => {
  const messageAtMs = millisOf(thread.latestUserMessageAt);
  if (messageAtMs === null || thread.status === "failed") return false;
  const age = nowMs - messageAtMs;
  if (Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestRunId === null) return true;
  return [
    millisOf(thread.latestRunRequestedAt),
    millisOf(thread.latestRunStartedAt),
    millisOf(thread.latestRunCompletedAt),
  ].every((value) => value === null || value < messageAtMs);
};

/** t3code's `isAutoSettlementCandidate`. */
const isAutoSettlementCandidate = (thread: SettlementCandidate, nowMs: number): boolean => {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.pinnedAt != null || thread.autoSettleDisabledAt != null) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  if (thread.activityRunStatus != null) return false;
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return false;
  if (hasQueuedTurnStart(thread, nowMs)) return false;
  const snoozedUntilMs = millisOf(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return true;
  const snoozedAtMs = millisOf(thread.snoozedAt);
  const completedAtMs = millisOf(thread.latestRunCompletedAt);
  return (
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs))
  );
};

/** When the thread last saw a message or a turn (epoch ms); null when it never has. */
export const activityAtOf = (thread: SettlementCandidate): number | null =>
  latestMillis([
    millisOf(thread.latestUserMessageAt),
    millisOf(thread.latestRunRequestedAt),
    millisOf(thread.latestRunStartedAt),
    millisOf(thread.latestRunCompletedAt),
  ]);

/** t3code's `resolveAutoSettlementAt` without a pull request. */
export const autoSettledAt = (thread: SettlementCandidate, nowMs: number): string | null => {
  if (AUTO_SETTLE_AFTER_DAYS === null || !isAutoSettlementCandidate(thread, nowMs)) return null;
  const activityAtMs = activityAtOf(thread) ?? DateTime.toEpochMillis(thread.createdAt);
  const snoozedUntilMs = millisOf(thread.snoozedUntil);
  const timerWakeAtMs = snoozedUntilMs !== null && snoozedUntilMs <= nowMs ? snoozedUntilMs : null;
  const quietSinceMs =
    latestMillis([activityAtMs, millisOf(thread.lastSnoozeWakeAt), timerWakeAtMs]) ?? activityAtMs;
  return quietSinceMs < nowMs - AUTO_SETTLE_AFTER_DAYS * DAY_MS
    ? new Date(quietSinceMs).toISOString()
    : null;
};
