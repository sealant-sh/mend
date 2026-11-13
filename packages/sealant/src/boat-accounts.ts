import type { Sealant } from "@sealant/sdk";
import { SealantApiError } from "@sealant/sdk";
import { Effect, Redacted, Schema } from "effect";

import type { SealantPlatformError } from "./errors.ts";

/** The SDK's `BoatAccount`, which its index does not export. */
type BoatAccount = Awaited<ReturnType<Sealant["boatAccounts"]["create"]>>;

/**
 * A Boat account Core keeps beside its default one (`sealant.boatAccounts`), as Core reports it:
 * never its key. `report` is where Boat's own answer about the key goes (who it is, the wallet it
 * bills, its permissions and expiry) once Core returns one (SLNT-781); until then it is null.
 */
export interface PlatformBoatAccount {
  readonly boatAccountId: string;
  readonly label: string;
  /** `active`: workspaces may run in it. `removing`: its removal was asked; none may. */
  readonly state: "active" | "removing";
  readonly createdAt: Date;
  readonly keyRotatedAt: Date | null;
  readonly report: null;
}

/** Why Core refused a Boat account call, from its typed error. */
export const BoatAccountRefusalReason = Schema.Literals([
  /** Boat answered that the key is not valid. Nothing was stored or changed. */
  "key-refused",
  /** Boat did not answer whether the key is valid. Nothing was stored or changed. */
  "key-unverified",
  /** The key provably lacks Boat permissions Core needs (`missingPermissions`). Nothing changed. */
  "missing-permissions",
  /** A removal while VMs Boat may hold (`liveRuns`) or image builds (`buildsInFlight`) remain. */
  "in-use",
  /** A replacement key that cannot see `unseen` of the VMs or saved images the account has. */
  "cannot-see",
  /** The account's removal was asked already. */
  "removing",
  /** Another replacement won; read and try again. */
  "changed",
  "not-found",
  /** Core serves no Boat, or keeps no credentials. */
  "unavailable",
  "bad-request",
]);
export type BoatAccountRefusalReason = typeof BoatAccountRefusalReason.Type;

export class BoatAccountRefusal extends Schema.TaggedError<BoatAccountRefusal>()(
  "BoatAccountRefusal",
  {
    reason: BoatAccountRefusalReason,
    liveRuns: Schema.NullOr(Schema.Number),
    buildsInFlight: Schema.NullOr(Schema.Number),
    unseen: Schema.NullOr(Schema.Number),
    /** `missing-permissions`: the Boat permissions Core needs that the key lacks, as Core names them. */
    missingPermissions: Schema.NullOr(Schema.Array(Schema.String)),
    /** Core's words, which never name the key. */
    message: Schema.String,
  },
) {}

/**
 * Core's Boat accounts, with the service key (install-scoped). A key goes in as `Redacted` and
 * never comes out. A typed Core refusal is a `BoatAccountRefusal`; anything else (Core
 * unreachable, a refusal this SDK does not know) stays a `SealantPlatformError`.
 */
export interface BoatAccountsApi {
  readonly create: (
    label: string,
    key: Redacted.Redacted<string>,
  ) => Effect.Effect<PlatformBoatAccount, BoatAccountRefusal | SealantPlatformError>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<PlatformBoatAccount>,
    BoatAccountRefusal | SealantPlatformError
  >;
  readonly rotateKey: (
    boatAccountId: string,
    key: Redacted.Redacted<string>,
  ) => Effect.Effect<PlatformBoatAccount, BoatAccountRefusal | SealantPlatformError>;
  readonly remove: (
    boatAccountId: string,
  ) => Effect.Effect<PlatformBoatAccount, BoatAccountRefusal | SealantPlatformError>;
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
};

/** The SDK keeps Core's decoded error as the `SealantApiError`'s cause: its counts are there. */
const countOf = (body: unknown, field: string): number | null => {
  if (typeof body !== "object" || body === null || !(field in body)) return null;
  const value: unknown = Reflect.get(body, field);
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

/** The refusal a Core Boat account failure carries, or null when it carries none. */
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
    message: cause.message,
  });
};

const toPlatformBoatAccount = (account: BoatAccount): PlatformBoatAccount => ({
  boatAccountId: account.boatAccountId,
  label: account.label,
  state: account.state,
  createdAt: new Date(account.createdAt),
  keyRotatedAt: account.keyRotatedAt === null ? null : new Date(account.keyRotatedAt),
  report: null,
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
  };
};
