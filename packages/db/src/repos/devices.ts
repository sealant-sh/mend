import { PgClient } from "@effect/sql-pg";
import { Timestamp } from "@mend/domain";
import { and, desc, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { cliAuthRequests, deviceTokens, pairingCodes } from "../schema/workbench.ts";

/**
 * How long an expired pairing code is kept before minting sweeps it away. Long
 * enough that a code someone reads off a stale screen still answers "expired"
 * rather than "no such code".
 */
export const PAIRING_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/** A device paired to one user. The token itself is never read back — only its sha256 is stored. */
export class PairedDevice extends Schema.Class<PairedDevice>("PairedDevice")({
  id: Schema.String,
  name: Schema.String,
  platform: Schema.String,
  createdAt: Timestamp,
  lastUsedAt: Schema.NullOr(Timestamp),
}) {}

/** A pairing code as minted: the code and the moment it stops being claimable. */
export class PairingCode extends Schema.Class<PairingCode>("PairingCode")({
  code: Schema.String,
  expiresAt: Timestamp,
}) {}

/** The account a device is paired to — better-auth's `user` row, read as plain SQL. */
export class DeviceOwner extends Schema.Class<DeviceOwner>("DeviceOwner")({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
}) {}

/** What a claim produced: the code's owner and the device row it minted. */
export class ClaimedPairing extends Schema.Class<ClaimedPairing>("ClaimedPairing")({
  user: DeviceOwner,
  device: PairedDevice,
}) {}

/** No pairing code with that value exists. */
export class PairingCodeUnknownError extends Schema.TaggedErrorClass<PairingCodeUnknownError>()(
  "PairingCodeUnknownError",
  {},
) {}

/** The code exists but is spent: past its expiry, or already claimed. */
export class PairingCodeSpentError extends Schema.TaggedErrorClass<PairingCodeSpentError>()(
  "PairingCodeSpentError",
  {},
) {}

/** No such device for this user. */
export class DeviceNotFoundError extends Schema.TaggedErrorClass<DeviceNotFoundError>()(
  "DeviceNotFoundError",
  { id: Schema.String },
) {}

/**
 * One CLI authorize request as the browser sees it: what asked, when, and how
 * long the code stays approvable. The device code never appears — only its
 * hash is stored, and only the CLI that minted it can poll with it.
 */
export class CliAuthRequest extends Schema.Class<CliAuthRequest>("CliAuthRequest")({
  userCode: Schema.String,
  name: Schema.String,
  createdAt: Timestamp,
  expiresAt: Timestamp,
}) {}

/** No CLI authorize request with that code or device code exists. */
export class CliAuthUnknownError extends Schema.TaggedErrorClass<CliAuthUnknownError>()(
  "CliAuthUnknownError",
  {},
) {}

/** The request exists but is spent: expired, already approved, or already collected. */
export class CliAuthSpentError extends Schema.TaggedErrorClass<CliAuthSpentError>()(
  "CliAuthSpentError",
  {},
) {}

/** The request exists and nobody has decided yet — the CLI should keep polling. */
export class CliAuthPendingError extends Schema.TaggedErrorClass<CliAuthPendingError>()(
  "CliAuthPendingError",
  {},
) {}

/** A signed-in user looked at the request and said no. */
export class CliAuthDeniedError extends Schema.TaggedErrorClass<CliAuthDeniedError>()(
  "CliAuthDeniedError",
  {},
) {}

/**
 * Device pairing: a signed-in user mints a short-lived code, a phone claims it
 * once, and the claim mints a bearer token whose hash is all that is kept.
 */
export class DevicesRepo extends Context.Service<
  DevicesRepo,
  {
    readonly createPairing: (input: {
      readonly userId: string;
      readonly code: string;
      readonly expiresAt: Date;
    }) => Effect.Effect<PairingCode>;
    readonly claim: (input: {
      readonly code: string;
      readonly name: string;
      readonly platform: string;
      readonly tokenHash: string;
    }) => Effect.Effect<ClaimedPairing, PairingCodeUnknownError | PairingCodeSpentError>;
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<PairedDevice>>;
    readonly revoke: (
      userId: string,
      id: string,
    ) => Effect.Effect<PairedDevice, DeviceNotFoundError>;
    readonly createCliAuth: (input: {
      readonly deviceCodeHash: string;
      readonly userCode: string;
      readonly name: string;
      readonly expiresAt: Date;
    }) => Effect.Effect<CliAuthRequest>;
    readonly getCliAuth: (
      userCode: string,
    ) => Effect.Effect<CliAuthRequest, CliAuthUnknownError | CliAuthSpentError>;
    readonly approveCliAuth: (input: {
      readonly userCode: string;
      readonly userId: string;
    }) => Effect.Effect<CliAuthRequest, CliAuthUnknownError | CliAuthSpentError>;
    readonly denyCliAuth: (
      userCode: string,
    ) => Effect.Effect<CliAuthRequest, CliAuthUnknownError | CliAuthSpentError>;
    readonly collectCliAuth: (input: {
      readonly deviceCodeHash: string;
      readonly platform: string;
      readonly tokenHash: string;
    }) => Effect.Effect<
      ClaimedPairing,
      CliAuthUnknownError | CliAuthSpentError | CliAuthPendingError | CliAuthDeniedError
    >;
  }
>()("@mend/db/DevicesRepo") {}

const selectedDevice = {
  id: deviceTokens.id,
  name: deviceTokens.name,
  platform: deviceTokens.platform,
  createdAt: deviceTokens.createdAt,
  lastUsedAt: deviceTokens.lastUsedAt,
};

export const DevicesRepoLive: Layer.Layer<DevicesRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    DevicesRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      // better-auth owns the `user` schema, so the owner lookup stays plain SQL.
      const sql = yield* PgClient.PgClient;

      // Minting sweeps codes long past their expiry. The day of grace is what
      // makes the difference between "expired" and "not found" legible: a code
      // deleted at the expiry boundary reads back as a typo, so a recently
      // expired row is kept around to answer for itself.
      const createPairing = Effect.fn("DevicesRepo.createPairing")(function* (input: {
        readonly userId: string;
        readonly code: string;
        readonly expiresAt: Date;
      }) {
        yield* db
          .delete(pairingCodes)
          .where(lt(pairingCodes.expiresAt, new Date(Date.now() - PAIRING_SWEEP_GRACE_MS)))
          .pipe(Effect.orDie);
        const [row] = yield* db
          .insert(pairingCodes)
          .values({
            id: crypto.randomUUID(),
            userId: input.userId,
            code: input.code,
            expiresAt: input.expiresAt,
          })
          .returning({ code: pairingCodes.code, expiresAt: pairingCodes.expiresAt })
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("pairing code insert returned no row");
        return new PairingCode(row);
      });

      // better-auth's `user` row for whoever a code or request resolved to.
      const ownerOf = Effect.fn("DevicesRepo.ownerOf")(function* (userId: string) {
        const ownerRows = yield* sql`
        SELECT id, email, name FROM "user" WHERE id = ${userId} LIMIT 1`.pipe(Effect.orDie);
        const owner = ownerRows[0] as
          | { readonly id: string; readonly email: string; readonly name: string }
          | undefined;
        if (owner === undefined) return yield* Effect.die("token grant has no owner");
        return new DeviceOwner({ id: owner.id, name: owner.name, email: owner.email });
      });

      // The one place a device row is born — pairing claims and CLI collections both end here.
      const insertDeviceToken = Effect.fn("DevicesRepo.insertDeviceToken")(function* (input: {
        readonly userId: string;
        readonly name: string;
        readonly platform: string;
        readonly tokenHash: string;
      }) {
        const [device] = yield* db
          .insert(deviceTokens)
          .values({
            id: crypto.randomUUID(),
            userId: input.userId,
            name: input.name,
            platform: input.platform,
            tokenHash: input.tokenHash,
          })
          .returning(selectedDevice)
          .pipe(Effect.orDie);
        if (device === undefined) return yield* Effect.die("device token insert returned no row");
        yield* notifyEvent(sql, { type: "user", userId: input.userId, facet: "devices" });
        return new PairedDevice(device);
      });

      // Single use is the UPDATE's own WHERE clause: two claimants racing the
      // same code produce exactly one winner, and the loser reads as spent.
      const claim = Effect.fn("DevicesRepo.claim")(function* (input: {
        readonly code: string;
        readonly name: string;
        readonly platform: string;
        readonly tokenHash: string;
      }) {
        const now = new Date();
        const [claimedCode] = yield* db
          .update(pairingCodes)
          .set({ claimedAt: now })
          .where(
            and(
              eq(pairingCodes.code, input.code),
              isNull(pairingCodes.claimedAt),
              gt(pairingCodes.expiresAt, now),
            ),
          )
          .returning({ userId: pairingCodes.userId })
          .pipe(Effect.orDie);

        if (claimedCode === undefined) {
          const [existing] = yield* db
            .select({ id: pairingCodes.id })
            .from(pairingCodes)
            .where(eq(pairingCodes.code, input.code))
            .pipe(Effect.orDie);
          return yield* existing === undefined
            ? Effect.fail(new PairingCodeUnknownError())
            : Effect.fail(new PairingCodeSpentError());
        }

        const user = yield* ownerOf(claimedCode.userId);
        const device = yield* insertDeviceToken({
          userId: claimedCode.userId,
          name: input.name,
          platform: input.platform,
          tokenHash: input.tokenHash,
        });
        return new ClaimedPairing({ user, device });
      });

      const list = Effect.fn("DevicesRepo.list")(function* (userId: string) {
        const rows = yield* db
          .select(selectedDevice)
          .from(deviceTokens)
          .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)))
          .orderBy(desc(deviceTokens.createdAt))
          .pipe(Effect.orDie);
        return rows.map((row) => new PairedDevice(row));
      });

      // Revoking is idempotent: a device already revoked still answers as itself.
      const revoke = Effect.fn("DevicesRepo.revoke")(function* (userId: string, id: string) {
        const [row] = yield* db
          .update(deviceTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(deviceTokens.id, id), eq(deviceTokens.userId, userId)))
          .returning(selectedDevice)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.fail(new DeviceNotFoundError({ id }));
        yield* notifyEvent(sql, { type: "user", userId, facet: "devices" });
        return new PairedDevice(row);
      });

      const selectedCliAuth = {
        userCode: cliAuthRequests.userCode,
        name: cliAuthRequests.name,
        createdAt: cliAuthRequests.createdAt,
        expiresAt: cliAuthRequests.expiresAt,
      };

      // Unknown or spent, told apart the same way a pairing code is: a row
      // that exists but cannot be acted on answers as itself.
      const cliAuthMiss = Effect.fn("DevicesRepo.cliAuthMiss")(function* (userCode: string) {
        const [existing] = yield* db
          .select({ id: cliAuthRequests.id })
          .from(cliAuthRequests)
          .where(eq(cliAuthRequests.userCode, userCode))
          .pipe(Effect.orDie);
        return yield* existing === undefined
          ? Effect.fail(new CliAuthUnknownError())
          : Effect.fail(new CliAuthSpentError());
      });

      const createCliAuth = Effect.fn("DevicesRepo.createCliAuth")(function* (input: {
        readonly deviceCodeHash: string;
        readonly userCode: string;
        readonly name: string;
        readonly expiresAt: Date;
      }) {
        yield* db
          .delete(cliAuthRequests)
          .where(lt(cliAuthRequests.expiresAt, new Date(Date.now() - PAIRING_SWEEP_GRACE_MS)))
          .pipe(Effect.orDie);
        const [row] = yield* db
          .insert(cliAuthRequests)
          .values({
            id: crypto.randomUUID(),
            deviceCodeHash: input.deviceCodeHash,
            userCode: input.userCode,
            name: input.name,
            expiresAt: input.expiresAt,
          })
          .returning(selectedCliAuth)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("cli auth insert returned no row");
        return new CliAuthRequest(row);
      });

      // The approve page reads only requests still waiting on a decision — a
      // reloaded page after approval answers "spent", never the request again.
      const getCliAuth = Effect.fn("DevicesRepo.getCliAuth")(function* (userCode: string) {
        const [row] = yield* db
          .select(selectedCliAuth)
          .from(cliAuthRequests)
          .where(
            and(
              eq(cliAuthRequests.userCode, userCode),
              isNull(cliAuthRequests.approvedBy),
              isNull(cliAuthRequests.deniedAt),
              gt(cliAuthRequests.expiresAt, new Date()),
            ),
          )
          .pipe(Effect.orDie);
        if (row === undefined) return yield* cliAuthMiss(userCode);
        return new CliAuthRequest(row);
      });

      const approveCliAuth = Effect.fn("DevicesRepo.approveCliAuth")(function* (input: {
        readonly userCode: string;
        readonly userId: string;
      }) {
        const [row] = yield* db
          .update(cliAuthRequests)
          .set({ approvedBy: input.userId })
          .where(
            and(
              eq(cliAuthRequests.userCode, input.userCode),
              isNull(cliAuthRequests.approvedBy),
              isNull(cliAuthRequests.deniedAt),
              gt(cliAuthRequests.expiresAt, new Date()),
            ),
          )
          .returning(selectedCliAuth)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* cliAuthMiss(input.userCode);
        return new CliAuthRequest(row);
      });

      const denyCliAuth = Effect.fn("DevicesRepo.denyCliAuth")(function* (userCode: string) {
        const [row] = yield* db
          .update(cliAuthRequests)
          .set({ deniedAt: new Date() })
          .where(
            and(
              eq(cliAuthRequests.userCode, userCode),
              isNull(cliAuthRequests.approvedBy),
              isNull(cliAuthRequests.deniedAt),
              gt(cliAuthRequests.expiresAt, new Date()),
            ),
          )
          .returning(selectedCliAuth)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* cliAuthMiss(userCode);
        return new CliAuthRequest(row);
      });

      // The token is born here, at collection — approval stores only who said
      // yes, so no credential ever waits in this table. Single collection is
      // the UPDATE's WHERE clause, like a pairing claim.
      const collectCliAuth = Effect.fn("DevicesRepo.collectCliAuth")(function* (input: {
        readonly deviceCodeHash: string;
        readonly platform: string;
        readonly tokenHash: string;
      }) {
        const now = new Date();
        const [request] = yield* db
          .update(cliAuthRequests)
          .set({ collectedAt: now })
          .where(
            and(
              eq(cliAuthRequests.deviceCodeHash, input.deviceCodeHash),
              isNotNull(cliAuthRequests.approvedBy),
              isNull(cliAuthRequests.collectedAt),
              isNull(cliAuthRequests.deniedAt),
              gt(cliAuthRequests.expiresAt, now),
            ),
          )
          .returning({ name: cliAuthRequests.name, approvedBy: cliAuthRequests.approvedBy })
          .pipe(Effect.orDie);

        if (request === undefined || request.approvedBy === null) {
          const [existing] = yield* db
            .select({
              approvedBy: cliAuthRequests.approvedBy,
              deniedAt: cliAuthRequests.deniedAt,
              collectedAt: cliAuthRequests.collectedAt,
              expiresAt: cliAuthRequests.expiresAt,
            })
            .from(cliAuthRequests)
            .where(eq(cliAuthRequests.deviceCodeHash, input.deviceCodeHash))
            .pipe(Effect.orDie);
          if (existing === undefined) return yield* Effect.fail(new CliAuthUnknownError());
          if (existing.deniedAt !== null) return yield* Effect.fail(new CliAuthDeniedError());
          if (existing.collectedAt !== null || existing.expiresAt <= now) {
            return yield* Effect.fail(new CliAuthSpentError());
          }
          return yield* Effect.fail(new CliAuthPendingError());
        }

        const user = yield* ownerOf(request.approvedBy);
        const device = yield* insertDeviceToken({
          userId: request.approvedBy,
          name: request.name,
          platform: input.platform,
          tokenHash: input.tokenHash,
        });
        return new ClaimedPairing({ user, device });
      });

      return {
        createPairing,
        claim,
        list,
        revoke,
        createCliAuth,
        getCliAuth,
        approveCliAuth,
        denyCliAuth,
        collectCliAuth,
      };
    }),
  );
