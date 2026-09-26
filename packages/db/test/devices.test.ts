import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { DevicesRepo, DevicesRepoLive } from "../src/repos/devices.ts";

/**
 * Device pairing against the dev Postgres (`compose.dev.yaml`, :5434) in a
 * throwaway database. Without one reachable these skip rather than pretend;
 * set MEND_TEST_DATABASE_URL to point elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_devices_test_${process.pid}_${Date.now()}`;

const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));

const scratchDatabaseLayer = MendDBLive.pipe(Layer.provideMerge(scratchLayer));
const scratchDevicesLayer = DevicesRepoLive.pipe(Layer.provideMerge(scratchDatabaseLayer));

const withDevices = <A, E>(
  effect: Effect.Effect<A, E, DevicesRepo | SqlClient.SqlClient | PgClient.PgClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(scratchDevicesLayer), Effect.scoped));

// The layer itself fails to build when nothing listens, so the guard sits outside the Effect.
const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
    return true;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);

const ORDERED = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** The exact lookup packages/auth performs for a device bearer token. */
const resolveBearer = (token: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`
      SELECT d.id AS device_id, u.id AS user_id, u.email
        FROM device_tokens d
        JOIN "user" u ON u.id = d.user_id
       WHERE d.token_hash = ${hash(token)} AND d.revoked_at IS NULL
       LIMIT 1`;
  });

describe.skipIf(!reachable)("device pairing", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await withDevices(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(ORDERED, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email")
          VALUES ('user-1', 'Operator', 'operator@example.com'),
                 ('user-2', 'Other', 'other@example.com')`;
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("claims a code once, and reports the second attempt as spent", async () => {
    const result = await withDevices(
      Effect.gen(function* () {
        const devices = yield* DevicesRepo;
        yield* devices.createPairing({
          userId: "user-1",
          code: "ABCDEFGH",
          expiresAt: new Date(Date.now() + 600_000),
        });
        const claimed = yield* devices.claim({
          code: "ABCDEFGH",
          name: "iPhone",
          platform: "ios",
          tokenHash: hash("mdt_first"),
        });
        const second = yield* devices
          .claim({
            code: "ABCDEFGH",
            name: "iPhone again",
            platform: "ios",
            tokenHash: hash("mdt_second"),
          })
          .pipe(Effect.flip);
        return { claimed, secondTag: second._tag };
      }),
    );

    expect(result.claimed.user.id).toBe("user-1");
    expect(result.claimed.user.email).toBe("operator@example.com");
    expect(result.claimed.device.name).toBe("iPhone");
    expect(result.claimed.device.lastUsedAt).toBeNull();
    expect(result.secondTag).toBe("PairingCodeSpentError");
  });

  it("separates an unknown code from an expired one", async () => {
    const tags = await withDevices(
      Effect.gen(function* () {
        const devices = yield* DevicesRepo;
        const sql = yield* SqlClient.SqlClient;
        const unknown = yield* devices
          .claim({ code: "NOSUCHCO", name: "x", platform: "ios", tokenHash: hash("mdt_a") })
          .pipe(Effect.flip);
        // Written directly: minting mints, it does not expire rows for us.
        yield* sql`
          INSERT INTO pairing_codes (id, user_id, code, expires_at)
          VALUES ('pc-expired', 'user-1', 'EXPIREDX', now() - interval '1 minute')`;
        const expired = yield* devices
          .claim({ code: "EXPIREDX", name: "x", platform: "ios", tokenHash: hash("mdt_b") })
          .pipe(Effect.flip);
        return { unknown: unknown._tag, expired: expired._tag };
      }),
    );

    expect(tags.unknown).toBe("PairingCodeUnknownError");
    expect(tags.expired).toBe("PairingCodeSpentError");
  });

  it("keeps a recently expired code, and sweeps only the ones long past", async () => {
    const tags = await withDevices(
      Effect.gen(function* () {
        const devices = yield* DevicesRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO pairing_codes (id, user_id, code, expires_at)
          VALUES ('pc-recent', 'user-1', 'RECENTXX', now() - interval '1 minute'),
                 ('pc-ancient', 'user-1', 'ANCIENTX', now() - interval '2 days')`;
        // Minting is what sweeps: the recent row has to survive it, or a code
        // read off a stale screen comes back as "not found" instead of expired.
        yield* devices.createPairing({
          userId: "user-1",
          code: "SWEEPERS",
          expiresAt: new Date(Date.now() + 600_000),
        });
        const recent = yield* devices
          .claim({ code: "RECENTXX", name: "x", platform: "ios", tokenHash: hash("mdt_c") })
          .pipe(Effect.flip);
        const ancient = yield* devices
          .claim({ code: "ANCIENTX", name: "x", platform: "ios", tokenHash: hash("mdt_d") })
          .pipe(Effect.flip);
        return { recent: recent._tag, ancient: ancient._tag };
      }),
    );

    expect(tags.recent).toBe("PairingCodeSpentError");
    expect(tags.ancient).toBe("PairingCodeUnknownError");
  });

  it("resolves a device bearer token until the device is revoked", async () => {
    const result = await withDevices(
      Effect.gen(function* () {
        const devices = yield* DevicesRepo;
        yield* devices.createPairing({
          userId: "user-1",
          code: "BEARERAB",
          expiresAt: new Date(Date.now() + 600_000),
        });
        const claimed = yield* devices.claim({
          code: "BEARERAB",
          name: "Pixel",
          platform: "android",
          tokenHash: hash("mdt_bearer"),
        });
        const before = yield* resolveBearer("mdt_bearer");
        const wrongToken = yield* resolveBearer("mdt_not-a-token");
        const listedBefore = yield* devices.list("user-1");
        yield* devices.revoke("user-1", claimed.device.id);
        const after = yield* resolveBearer("mdt_bearer");
        const listedAfter = yield* devices.list("user-1");
        return {
          before: before.length,
          beforeUser: before[0],
          wrongToken: wrongToken.length,
          after: after.length,
          listedBefore: listedBefore.map((device) => device.id),
          listedAfter: listedAfter.map((device) => device.id),
          deviceId: claimed.device.id,
        };
      }),
    );

    expect(result.before).toBe(1);
    expect(result.beforeUser).toMatchObject({ user_id: "user-1" });
    expect(result.wrongToken).toBe(0);
    expect(result.after).toBe(0);
    expect(result.listedBefore).toContain(result.deviceId);
    expect(result.listedAfter).not.toContain(result.deviceId);
  });

  it("mints a device by hand, with no code, that lists and revokes like a paired one", async () => {
    const result = await withDevices(
      Effect.gen(function* () {
        const devices = yield* DevicesRepo;
        const device = yield* devices.create({
          userId: "user-1",
          name: "App Review iPhone",
          platform: "other",
          tokenHash: hash("mdt_by-hand"),
        });
        const before = yield* resolveBearer("mdt_by-hand");
        const listed = yield* devices.list("user-1");
        yield* devices.revoke("user-1", device.id);
        const after = yield* resolveBearer("mdt_by-hand");
        return {
          name: device.name,
          before: before.length,
          listed: listed.map((row) => row.id),
          after: after.length,
          deviceId: device.id,
        };
      }),
    );

    expect(result.name).toBe("App Review iPhone");
    expect(result.before).toBe(1);
    expect(result.listed).toContain(result.deviceId);
    expect(result.after).toBe(0);
  });

  it("refuses to revoke a device that belongs to someone else", async () => {
    const tag = await withDevices(
      Effect.gen(function* () {
        const devices = yield* DevicesRepo;
        yield* devices.createPairing({
          userId: "user-1",
          code: "MINEONLY",
          expiresAt: new Date(Date.now() + 600_000),
        });
        const claimed = yield* devices.claim({
          code: "MINEONLY",
          name: "Laptop",
          platform: "desktop",
          tokenHash: hash("mdt_mine"),
        });
        const denied = yield* devices.revoke("user-2", claimed.device.id).pipe(Effect.flip);
        return denied._tag;
      }),
    );

    expect(tag).toBe("DeviceNotFoundError");
  });
});
