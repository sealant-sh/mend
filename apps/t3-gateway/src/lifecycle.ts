import type { MendTurn } from "./mend-workbench.ts";
import {
  isActiveRunStatus,
  latestOf,
  runsOf,
  threadUpdatedAtOf,
  type PendingRun,
  type ThreadSource,
} from "./shell.ts";
import type { ThreadLifecycle } from "./state.ts";

/**
 * Settle and snooze (`thread.settle`, `thread.unsettle`, `thread.snooze`, `thread.unsnooze`): the
 * person's own view of a thread, kept by the gateway as Mend has neither (ADR 0012), with the
 * rules t3code's own server applies (`Orchestrator.ts` at the pinned tag).
 *
 * The gateway keeps a snooze as set and wakes it early in one case only: something asked the
 * thread for work. Every other wake is the t3code client's own, read from the shell
 * (`threadSettled.ts` in its client runtime): the snooze's time passing, a pending approval or
 * question, a turn that failed or completed after the snooze. The shell carries what those read.
 */

/** Neither settled nor snoozed. */
export const NO_LIFECYCLE: ThreadLifecycle = {
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
};

const isAfter = (later: string | null, earlier: string | null): boolean =>
  later !== null && earlier !== null && Date.parse(later) > Date.parse(earlier);

/**
 * The person's settle and snooze as they stand now. A turn opened, or a message queued, after
 * either ends it, as a new run does on t3code's own server: the thread is no longer settled (nor
 * kept active by an unsettle) and is awake.
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
  return { ...settlement, ...snooze };
};

export const isLifecycleEmpty = (lifecycle: ThreadLifecycle): boolean =>
  lifecycle.settledOverride === null &&
  lifecycle.settledAt === null &&
  lifecycle.unsettledAt === null &&
  lifecycle.snoozedUntil === null &&
  lifecycle.snoozedAt === null;

export const sameLifecycle = (left: ThreadLifecycle, right: ThreadLifecycle): boolean =>
  left.settledOverride === right.settledOverride &&
  left.settledAt === right.settledAt &&
  left.unsettledAt === right.unsettledAt &&
  left.snoozedUntil === right.snoozedUntil &&
  left.snoozedAt === right.snoozedAt;

export type LifecycleChange =
  | { readonly kind: "settle" }
  | { readonly kind: "unsettle" }
  | { readonly kind: "snooze"; readonly until: string }
  | { readonly kind: "unsnooze" };

export type LifecycleChanged =
  | { readonly _tag: "Changed"; readonly lifecycle: ThreadLifecycle }
  | { readonly _tag: "Refused"; readonly reason: string };

const refused = (reason: string): LifecycleChanged => ({ _tag: "Refused", reason });
const changed = (lifecycle: ThreadLifecycle): LifecycleChanged => ({
  _tag: "Changed",
  lifecycle,
});

/**
 * The thread's settle and snooze after `change` at `now`, or why it is refused. Settling waits
 * for the thread's work: nothing running, queued or waiting on an answer. A snooze ends in the
 * future, and never hides a question the agent asked or a message still to be sent. Repeating a
 * settle or a snooze to the same time keeps when it was first set.
 */
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
  switch (change.kind) {
    case "settle": {
      if (asking) {
        return refused("The agent is waiting on an answer. Answer it, then settle the thread.");
      }
      if (runs.some((run) => run.status === "queued" || isActiveRunStatus(run.status))) {
        return refused(
          "The thread has a turn running or a message waiting. Settle it once they are done.",
        );
      }
      const already = current.settledOverride === "settled" && current.settledAt !== null;
      return changed({
        ...current,
        settledOverride: "settled",
        settledAt: already ? current.settledAt : at,
        unsettledAt: null,
      });
    }
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
      const snoozedUntil = new Date(until).toISOString();
      const same = current.snoozedUntil !== null && Date.parse(current.snoozedUntil) === until;
      return changed({
        ...current,
        snoozedUntil,
        snoozedAt: same ? (current.snoozedAt ?? at) : at,
      });
    }
    case "unsnooze":
      return changed({ ...current, snoozedUntil: null, snoozedAt: null });
  }
};
