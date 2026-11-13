import type { BoatKey, NewBoatKey } from "@mend/db";
import { BoatKeyTakenError } from "@mend/db";
import type { OrganizationId, ProjectId } from "@mend/domain";
import type { AuditData, BoatKeyOwner } from "@mend/domain/workbench";
import {
  BoatAccountRefusal,
  type BoatAccountRefusalReason,
  type PlatformBoatAccount,
  SealantPlatformError,
} from "@mend/sealant";
import type { BoatAccountStandbys } from "@mend/sessions";
import { Deferred, Effect, Redacted } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { createTenancyApi } from "./tenancy-api.ts";

type Implement = NonNullable<NonNullable<Parameters<typeof createTenancyApi>[1]>["implement"]>;

/** What Core is asked, with the key unwrapped only here, to prove it went to Core and nowhere else. */
export interface CoreCall {
  readonly call: "create" | "list" | "rotate" | "remove";
  readonly label?: string;
  readonly key?: string;
  readonly boatAccountId?: string;
}

export const refusal = (
  reason: BoatAccountRefusalReason,
  counts: { liveRuns?: number; buildsInFlight?: number; unseen?: number } = {},
) =>
  new BoatAccountRefusal({
    reason,
    liveRuns: counts.liveRuns ?? null,
    buildsInFlight: counts.buildsInFlight ?? null,
    unseen: counts.unseen ?? null,
    message: `Core says ${reason}`,
  });

const ownerKey = (owner: BoatKeyOwner) => owner.organizationId;

/**
 * Boat keys in memory and Core's Boat accounts faked at `@mend/sealant`'s boundary (SLNT-790):
 * what a tenancy API needs to follow a Boat key request past authorization.
 */
export const makeBoatWorld = () => {
  const keys = new Map<string, BoatKey>();
  const accounts = new Map<string, PlatformBoatAccount>();
  const core: Array<CoreCall> = [];
  const audited: Array<{ action: string; subjectId: string; data: AuditData; actor: string }> = [];
  const reconciled: Array<ProjectId> = [];
  /**
   * The standbys Mend keeps in each Core Boat account (SLNT-803), what a key change drains, and
   * how many of them a drain still reports stopping.
   */
  const standbys = new Map<string, number>();
  const stopping = { count: 0 };
  /** What a removal did, in order: `drain <account>`, Core's `remove <account>`, `rewarm`. */
  const steps: Array<string> = [];
  /** The refusals Core answers the next calls with, in order. */
  const refusals: Array<BoatAccountRefusal | SealantPlatformError> = [];
  /** Core's answer to a removal while this is set, every time. */
  const holds: { refusal: BoatAccountRefusal | null } = { refusal: null };
  /** Holds Core's next removal until settled, for two at once. */
  const gate: { next: Deferred.Deferred<void> | null } = { next: null };
  /** Core does the next removal, then its answer never reaches Mend. */
  const lose = { next: false };
  const changes = Semaphore.makeUnsafe(1);
  const answer = <A>(value: () => A) =>
    Effect.suspend(() => {
      const refused = refusals.shift();
      return refused === undefined ? Effect.sync(value) : Effect.fail(refused);
    });
  const implement = {
    boatKeys: {
      byOwner: (owner) => Effect.sync(() => keys.get(ownerKey(owner)) ?? null),
      connect: (key: NewBoatKey) =>
        Effect.suspend(() => {
          if (keys.has(ownerKey(key.owner))) {
            return Effect.fail(new BoatKeyTakenError({ organizationId: key.owner.organizationId }));
          }
          const row: BoatKey = {
            ...key,
            connectedAt: new Date("2026-11-13T12:00:00.000Z"),
            keyReplacedAt: null,
          };
          keys.set(ownerKey(key.owner), row);
          return Effect.succeed(row);
        }),
      markReplaced: (owner) =>
        Effect.sync(() => {
          const row = keys.get(ownerKey(owner));
          if (row === undefined) return null;
          const replaced = { ...row, keyReplacedAt: new Date("2026-11-13T13:00:00.000Z") };
          keys.set(ownerKey(owner), replaced);
          return replaced;
        }),
      remove: (owner) =>
        Effect.sync(() => {
          const row = keys.get(ownerKey(owner)) ?? null;
          keys.delete(ownerKey(owner));
          return row;
        }),
    },
    boatAccounts: {
      createBoatAccount: (label, key) =>
        answer(() => {
          const boatAccountId = `core-boat-${accounts.size + 1}`;
          core.push({ call: "create", label, key: Redacted.value(key) });
          const account: PlatformBoatAccount = {
            boatAccountId,
            label,
            state: "active",
            createdAt: new Date("2026-11-13T12:00:00.000Z"),
            keyRotatedAt: null,
            report: null,
          };
          accounts.set(boatAccountId, account);
          return account;
        }),
      rotateBoatAccountKey: (boatAccountId, key) =>
        answer(() => {
          core.push({ call: "rotate", boatAccountId, key: Redacted.value(key) });
          const account = accounts.get(boatAccountId);
          if (account === undefined) throw new Error("rotated an unknown account");
          return account;
        }),
      removeBoatAccount: (boatAccountId) =>
        Effect.gen(function* () {
          steps.push(`remove ${boatAccountId}`);
          const waitFor = gate.next;
          gate.next = null;
          if (waitFor !== null) yield* Deferred.await(waitFor);
          if (holds.refusal !== null) return yield* holds.refusal;
          const removed = yield* answer(() => {
            core.push({ call: "remove", boatAccountId });
            const account = accounts.get(boatAccountId);
            if (account === undefined) throw new Error("removed an unknown account");
            accounts.delete(boatAccountId);
            return { ...account, state: "removing" as const };
          });
          if (lose.next) {
            lose.next = false;
            return yield* new SealantPlatformError({
              code: "HttpClientError",
              status: null,
              message: "socket hang up",
              cause: null,
            });
          }
          return removed;
        }),
      listBoatAccounts: () =>
        answer(() => {
          core.push({ call: "list" });
          return [...accounts.values()];
        }),
    },
    audit: {
      record: (event) =>
        Effect.sync(() => {
          audited.push({
            action: event.action,
            subjectId: event.subjectId,
            data: event.data ?? {},
            actor: event.actorUserId,
          });
        }),
    },
    engine: {
      launchUnderWay: () => false,
      reconcileHotSessions: (projectId) => Effect.sync(() => void reconciled.push(projectId)),
      // The engine's contract (SLNT-803): one change per organization at a time; a drained
      // account rewarms once the change ends, however it ends.
      changingBoatKey: <A, E, R>(
        _organizationId: OrganizationId,
        use: (standbys: BoatAccountStandbys) => Effect.Effect<A, E, R>,
      ) =>
        changes.withPermit(
          Effect.suspend(() => {
            let drained = 0;
            let held = false;
            return use({
              drain: (boatAccountId) =>
                Effect.sync(() => {
                  steps.push(`drain ${boatAccountId}`);
                  held = true;
                  drained += standbys.get(boatAccountId) ?? 0;
                  standbys.delete(boatAccountId);
                  return { drained, stopping: stopping.count };
                }),
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (held) steps.push("rewarm");
                }),
              ),
            );
          }),
        ),
    },
  } satisfies Implement;
  return {
    keys,
    accounts,
    core,
    audited,
    reconciled,
    standbys,
    stopping,
    steps,
    holds,
    gate,
    lose,
    implement,
    refuseNext: (...errors: ReadonlyArray<BoatAccountRefusal | SealantPlatformError>) => {
      refusals.push(...errors);
    },
    reset: () => {
      keys.clear();
      accounts.clear();
      core.length = 0;
      audited.length = 0;
      reconciled.length = 0;
      standbys.clear();
      stopping.count = 0;
      steps.length = 0;
      refusals.length = 0;
      holds.refusal = null;
      gate.next = null;
      lose.next = false;
    },
  };
};
