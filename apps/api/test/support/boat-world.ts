import type { BoatKey, NewBoatKey } from "@mend/db";
import { BoatKeyTakenError } from "@mend/db";
import type { ProjectId } from "@mend/domain";
import type { AuditData, BoatKeyOwner } from "@mend/domain/workbench";
import {
  BoatAccountRefusal,
  type BoatAccountRefusalReason,
  type PlatformBoatAccount,
  type SealantPlatformError,
} from "@mend/sealant";
import { Effect, Redacted } from "effect";

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
  /** The refusal Core answers the next call with, if any. */
  let refuseNext: BoatAccountRefusal | SealantPlatformError | null = null;
  const answer = <A>(value: () => A) =>
    Effect.suspend(() => {
      const refused = refuseNext;
      refuseNext = null;
      return refused === null ? Effect.sync(value) : Effect.fail(refused);
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
        answer(() => {
          core.push({ call: "remove", boatAccountId });
          const account = accounts.get(boatAccountId);
          if (account === undefined) throw new Error("removed an unknown account");
          accounts.delete(boatAccountId);
          return { ...account, state: "removing" as const };
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
    },
  } satisfies Implement;
  return {
    keys,
    accounts,
    core,
    audited,
    reconciled,
    implement,
    refuseNext: (error: BoatAccountRefusal | SealantPlatformError) => {
      refuseNext = error;
    },
    reset: () => {
      keys.clear();
      accounts.clear();
      core.length = 0;
      audited.length = 0;
      reconciled.length = 0;
      refuseNext = null;
    },
  };
};
