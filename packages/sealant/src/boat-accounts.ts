import {
  BoatFailure,
  type BoatKeyBilling,
  type BoatKeyNotObserved,
  type BoatKeyProof,
  BoatKeyReport,
  type BoatUnreachable,
  type BoatWallet,
} from "@mend/domain/workbench";
import type {
  BoatFailure as CoreBoatFailure,
  BoatKeyBilling as CoreBoatKeyBilling,
  BoatKeyNotObserved as CoreBoatKeyNotObserved,
  BoatKeyProof as CoreBoatKeyProof,
  BoatKeyReport as CoreBoatKeyReport,
  BoatWallet as CoreBoatWallet,
  Sealant,
} from "@sealant/sdk";
import { SealantApiError } from "@sealant/sdk";
import { Effect, Redacted, Schema } from "effect";

import type { SealantPlatformError } from "./errors.ts";

/** The SDK's `BoatAccount`, which its index does not export. */
type BoatAccount = Awaited<ReturnType<Sealant["boatAccounts"]["create"]>>;
/** The SDK's `BoatUnreachable`, which its index does not export either. */
type CoreBoatUnreachable = NonNullable<BoatAccount["unreachable"]>;

/**
 * A Boat account sealant keeps beside its default one (`sealant.boatAccounts`), as sealant reports it:
 * never its key. `report` is Boat's own answer about the key the last time sealant checked it (who it
 * is, the wallet it bills, its permissions and expiry; SLNT-781), or null when sealant has not.
 */
export interface PlatformBoatAccount {
  readonly boatAccountId: string;
  readonly label: string;
  /** `active`: workspaces may run in it. `removing`: its removal was asked; none may. */
  readonly state: "active" | "removing";
  readonly createdAt: Date;
  readonly keyRotatedAt: Date | null;
  readonly report: BoatKeyReport | null;
  /** The last full check of the key (SLNT-784); only `list` reads it, the other calls answer null. */
  readonly lastProof: BoatKeyProof | null;
  /**
   * The wallet every request of the account names (sealant#641): a Boat organization's id, or
   * `personal`. Null: a Boat organization's key, which has one wallet, or a key sealant has not
   * pinned yet.
   */
  readonly organization: string | null;
  /** What the account made in Boat that sealant cannot reach in any wallet the key can bill. */
  readonly unreachable: BoatUnreachable | null;
}

/** The server's own Boat key as sealant reports it: never the key. */
export interface BoatInstallKeyReading {
  readonly report: BoatKeyReport | null;
  /** What the key made in Boat that sealant cannot reach in any wallet it can bill. */
  readonly unreachable: BoatUnreachable | null;
}

/** Why sealant refused a Boat account call, from its typed error. */
export const BoatAccountRefusalReason = Schema.Literals([
  /** Boat answered that the key is not valid. Nothing was stored or changed. */
  "key-refused",
  /** Boat did not answer whether the key is valid. Nothing was stored or changed. */
  "key-unverified",
  /** The key provably lacks Boat permissions sealant needs (`missingPermissions`). Nothing changed. */
  "missing-permissions",
  /** A removal while VMs Boat may hold (`liveRuns`) or image builds (`buildsInFlight`) remain. */
  "in-use",
  /** A replacement key that cannot see `unseen` of the VMs or saved images the account has. */
  "cannot-see",
  /** The account's removal was asked already. */
  "removing",
  /** Another replacement won; read and try again. */
  "changed",
  /**
   * A full check of the account is running, or what it made is not yet removed: a second one, a
   * replacement and a removal wait. sealant's message names what Boat may still hold.
   */
  "proof-running",
  "not-found",
  /** sealant serves no Boat, or keeps no credentials. */
  "unavailable",
  "bad-request",
  /** A wallet was chosen for a Boat organization's key, which bills that organization only. */
  "key-organization",
  /** The server's own key, which is set in its environment, not through sealant's API. */
  "environment",
  /** A key sealant has not pinned to a wallet yet: nothing new starts with it until it has. */
  "wallet-unresolved",
]);
export type BoatAccountRefusalReason = typeof BoatAccountRefusalReason.Type;

export class BoatAccountRefusal extends Schema.TaggedError<BoatAccountRefusal>()(
  "BoatAccountRefusal",
  {
    reason: BoatAccountRefusalReason,
    liveRuns: Schema.NullOr(Schema.Number),
    buildsInFlight: Schema.NullOr(Schema.Number),
    unseen: Schema.NullOr(Schema.Number),
    /** `missing-permissions`: the Boat permissions sealant needs that the key lacks, as sealant names them. */
    missingPermissions: Schema.NullOr(Schema.Array(Schema.String)),
    /** Why Boat refused the key, or did not answer, when sealant said. */
    boat: Schema.NullOr(BoatFailure),
    /** What sealant's check observed of a key it refused for missing permissions. */
    report: Schema.NullOr(BoatKeyReport),
    /** sealant's words, which never name the key. */
    message: Schema.String,
  },
) {}

/**
 * sealant's Boat accounts, with the service key (install-scoped). A key goes in as `Redacted` and
 * never comes out. A typed sealant refusal is a `BoatAccountRefusal`; anything else (sealant
 * unreachable, a refusal this SDK does not know) stays a `SealantPlatformError`.
 */
export interface BoatAccountsApi {
  readonly create: (
    label: string,
    key: Redacted.Redacted,
  ) => Effect.Effect<PlatformBoatAccount, BoatAccountRefusal | SealantPlatformError>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<PlatformBoatAccount>,
    BoatAccountRefusal | SealantPlatformError
  >;
  readonly rotateKey: (
    boatAccountId: string,
    key: Redacted.Redacted,
  ) => Effect.Effect<PlatformBoatAccount, BoatAccountRefusal | SealantPlatformError>;
  readonly remove: (
    boatAccountId: string,
  ) => Effect.Effect<PlatformBoatAccount, BoatAccountRefusal | SealantPlatformError>;
  /**
   * Checks the account's key with Boat again (read-only) and answers it with the new report. A
   * key Boat now refuses is reported, not refused; Boat not answering is `key-unverified`, and
   * sealant keeps the last report.
   */
  readonly check: (
    boatAccountId: string,
  ) => Effect.Effect<PlatformBoatAccount, BoatAccountRefusal | SealantPlatformError>;
  /**
   * A full check of the account's key: sealant starts a throwaway VM, uses it as a session would and
   * deletes it, synchronously (about a minute against Boat). sealant keeps the result as the
   * account's `lastProof`.
   */
  readonly prove: (
    boatAccountId: string,
  ) => Effect.Effect<BoatKeyProof, BoatAccountRefusal | SealantPlatformError>;
  /**
   * The install's own Boat key (its environment's) as sealant last checked it: null when the install
   * has none, which sealant answers as unavailable. Never the key.
   */
  readonly installKey: () => Effect.Effect<
    BoatInstallKeyReading | null,
    BoatAccountRefusal | SealantPlatformError
  >;
}

const REASONS_BY_TAG: Readonly<Record<string, BoatAccountRefusalReason>> = {
  BoatAccountNotFoundError: "not-found",
  BoatAccountServiceUnavailableError: "unavailable",
  BoatAccountBadRequestError: "bad-request",
};

const REASONS_BY_CODE: Readonly<Record<string, BoatAccountRefusalReason>> = {
  "boat-key-refused": "key-refused",
  "boat-key-unverified": "key-unverified",
  "boat-key-missing-permissions": "missing-permissions",
  "boat-account-in-use": "in-use",
  "boat-key-cannot-see": "cannot-see",
  "boat-account-removing": "removing",
  "boat-account-changed": "changed",
  "boat-proof-running": "proof-running",
  "boat-key-organization": "key-organization",
  "boat-account-environment": "environment",
  "boat-account-wallet-unresolved": "wallet-unresolved",
};

/** The SDK keeps sealant's decoded error as the `SealantApiError`'s cause: its counts are there. */
const countOf = (body: unknown, field: string): number | null => {
  if (typeof body !== "object" || body === null || !(field in body)) return null;
  const value: unknown = Reflect.get(body, field);
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

/** The refusal a sealant Boat account failure carries, or null when it carries none. */
export const boatAccountRefusalOf = (cause: unknown): BoatAccountRefusal | null => {
  if (!(cause instanceof SealantApiError)) return null;
  const reason =
    (cause.reason === undefined ? undefined : REASONS_BY_CODE[cause.reason]) ??
    REASONS_BY_TAG[cause.code];
  if (reason === undefined) return null;
  return new BoatAccountRefusal({
    reason,
    liveRuns: countOf(cause.cause, "liveRuns"),
    buildsInFlight: countOf(cause.cause, "buildsInFlight"),
    unseen: countOf(cause.cause, "unseen"),
    missingPermissions: cause.missingPermissions ?? null,
    boat: cause.boat === undefined ? null : boatFailureOf(cause.boat),
    report: cause.boatKeyReport === undefined ? null : boatKeyReportOf(cause.boatKeyReport),
    message: cause.message,
  });
};

const dateOf = (iso: string): Date => new Date(iso);
const dateOrNull = (iso: string | undefined | null): Date | null =>
  iso === undefined || iso === null ? null : dateOf(iso);

/** sealant's failure in Mend's shape: nulls for what Boat did not say. */
export const boatFailureOf = (failure: CoreBoatFailure): BoatFailure => ({
  kind: failure.kind,
  retryable: failure.retryable,
  operation: failure.operation ?? null,
  status: failure.status ?? null,
  code: failure.code ?? null,
  message: failure.message ?? null,
  requestId: failure.requestId ?? null,
  permission: failure.permission ?? null,
  retryAfterSeconds: failure.retryAfterSeconds ?? null,
  retryAt: dateOrNull(failure.retryAt),
  billingUrl: failure.billingUrl ?? null,
});

const notObserved = (fact: CoreBoatKeyNotObserved): BoatKeyNotObserved => ({
  observed: false,
  reason: fact.reason,
  boat: fact.boat === undefined ? null : boatFailureOf(fact.boat),
});

const walletOf = (wallet: CoreBoatWallet): BoatWallet => ({
  kind: wallet.kind,
  organizationId: wallet.organizationId ?? null,
  organizationName: wallet.organizationName ?? null,
  role: wallet.role ?? null,
});

const billingOf = (billing: CoreBoatKeyBilling): BoatKeyBilling => {
  switch (billing.mode) {
    case "pinned":
      return { mode: "pinned", organization: billing.organization };
    case "key-organization":
      return { mode: "key-organization" };
    case "active-wallet":
      return {
        mode: "active-wallet",
        walletChanged:
          billing.walletChanged === undefined
            ? null
            : {
                from: walletOf(billing.walletChanged.from),
                observedAt: dateOf(billing.walletChanged.observedAt),
              },
      };
  }
};

/** What sealant cannot reach, or null when it names nothing. */
export const boatUnreachableOf = (
  unreachable: CoreBoatUnreachable | null | undefined,
): BoatUnreachable | null => {
  if (unreachable === null || unreachable === undefined) return null;
  const known: BoatUnreachable = {
    savedImages: [...unreachable.savedImages],
    runs: [...(unreachable.runs ?? [])],
    builds: [...(unreachable.builds ?? [])],
  };
  return known.savedImages.length + known.runs.length + known.builds.length === 0 ? null : known;
};

/** sealant's report on a key in Mend's shape (`BoatKeyReport`): dates, and nulls for absent facts. */
export const boatKeyReportOf = (report: CoreBoatKeyReport): BoatKeyReport => {
  const { identity, keyKind, wallet, wallets, billing, permissions, expiry, start, snapshots } =
    report;
  return {
    observedAt: dateOf(report.observedAt),
    organization: report.organization,
    identity: identity.observed
      ? {
          observed: true,
          accountId: identity.accountId ?? null,
          login: identity.login ?? null,
          displayName: identity.displayName ?? null,
          serviceAccount: identity.serviceAccount ?? null,
          accountStatus: identity.accountStatus,
        }
      : notObserved(identity),
    keyKind: keyKind.observed ? { observed: true, kind: keyKind.kind } : notObserved(keyKind),
    wallet: wallet.observed ? { observed: true, ...walletOf(wallet) } : notObserved(wallet),
    // A report from before sealant#641 has neither.
    wallets:
      wallets === undefined
        ? null
        : wallets.observed
          ? {
              observed: true,
              choices: wallets.choices.map((choice) => ({
                id: choice.id,
                kind: choice.kind,
                name: choice.name ?? null,
                role: choice.role ?? null,
                active: choice.active,
              })),
            }
          : notObserved(wallets),
    billing: billing === undefined ? null : billingOf(billing),
    requiredPermissions: report.requiredPermissions,
    permissions: permissions.observed
      ? {
          observed: true,
          held: permissions.held,
          missing: permissions.missing,
          limitedToSandboxes: permissions.limitedToSandboxes,
        }
      : notObserved(permissions),
    expiry: expiry.observed
      ? {
          observed: true,
          expiresAt: dateOrNull(expiry.expiresAt),
          expired: expiry.expired,
          expiringSoon: expiry.expiringSoon,
        }
      : notObserved(expiry),
    start: start.observed
      ? {
          observed: true,
          canStart: start.canStart,
          blockedReason: start.blockedReason ?? null,
          billingStatus: start.billingStatus ?? null,
          runningVms: start.runningVms,
          allowedVms: start.allowedVms,
        }
      : notObserved(start),
    snapshots: snapshots.observed
      ? { observed: true, used: snapshots.used, included: snapshots.included }
      : notObserved(snapshots),
  };
};

/** sealant's full check in Mend's shape: dates, and nulls for what Boat did not say. */
export const boatKeyProofOf = (proof: CoreBoatKeyProof): BoatKeyProof => ({
  proofId: proof.proofId,
  startedAt: dateOf(proof.startedAt),
  finishedAt: dateOf(proof.finishedAt),
  outcome: proof.outcome,
  steps: proof.steps.map((step) => ({
    step: step.step,
    outcome: step.outcome,
    boat: step.boat === undefined ? null : boatFailureOf(step.boat),
  })),
  starts: proof.starts,
  leftBehind: {
    vm: proof.leftBehind.vm,
    snapshot: proof.leftBehind.snapshot,
    removalConfirmed: proof.leftBehind.removalConfirmed,
  },
});

const toPlatformBoatAccount = (account: BoatAccount): PlatformBoatAccount => ({
  boatAccountId: account.boatAccountId,
  label: account.label,
  state: account.state,
  createdAt: dateOf(account.createdAt),
  keyRotatedAt: dateOrNull(account.keyRotatedAt),
  // A control plane from before the report (0.40.0-next.870) answers without it.
  report:
    account.report === null || account.report === undefined
      ? null
      : boatKeyReportOf(account.report),
  // A control plane from before the full check (0.40.0-next.872) answers without it.
  lastProof:
    account.lastProof === null || account.lastProof === undefined
      ? null
      : boatKeyProofOf(account.lastProof),
  organization: account.organization,
  // A control plane from before wallets were recorded (sealant#641) answers without it.
  unreachable: boatUnreachableOf(account.unreachable),
});

export const makeBoatAccountsApi = (
  admin: Sealant,
  toPlatformError: (cause: unknown) => SealantPlatformError,
): BoatAccountsApi => {
  const call = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause): BoatAccountRefusal | SealantPlatformError =>
        boatAccountRefusalOf(cause) ?? toPlatformError(cause),
    });
  return {
    create: (label, key) =>
      call(() => admin.boatAccounts.create({ label, apiKey: Redacted.value(key) })).pipe(
        Effect.map(toPlatformBoatAccount),
      ),
    list: () =>
      call(() => admin.boatAccounts.list()).pipe(
        Effect.map((accounts) => accounts.map(toPlatformBoatAccount)),
      ),
    rotateKey: (boatAccountId, key) =>
      call(() => admin.boatAccounts.rotateKey(boatAccountId, Redacted.value(key))).pipe(
        Effect.map(toPlatformBoatAccount),
      ),
    remove: (boatAccountId) =>
      call(() => admin.boatAccounts.remove(boatAccountId)).pipe(Effect.map(toPlatformBoatAccount)),
    check: (boatAccountId) =>
      call(() => admin.boatAccounts.check(boatAccountId)).pipe(Effect.map(toPlatformBoatAccount)),
    prove: (boatAccountId) =>
      call(() => admin.boatAccounts.prove(boatAccountId)).pipe(Effect.map(boatKeyProofOf)),
    // sealant answers 503 both without a key of its own and without Boat at all: either way, none.
    installKey: () =>
      call(() => admin.boatAccounts.installKey()).pipe(
        Effect.map(
          (key): BoatInstallKeyReading => ({
            report: key.report === null ? null : boatKeyReportOf(key.report),
            unreachable: boatUnreachableOf(key.unreachable),
          }),
        ),
        Effect.catchIf(
          (error) => error._tag === "BoatAccountRefusal" && error.reason === "unavailable",
          () => Effect.succeed(null),
        ),
      ),
  };
};
