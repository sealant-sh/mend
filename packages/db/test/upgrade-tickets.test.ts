import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  hashUpgradeTicket,
  mintUpgradeTicket,
  UPGRADE_TICKET_TTL_MS,
  UpgradeTicketsRepo,
  UpgradeTicketsRepoLive,
  UpgradeTicketsRepoMemory,
  upgradeTicketScope,
} from "../src/repos/upgrade-tickets.ts";

describe("upgrade tickets", () => {
  it("mints recognisable, url-safe tickets and stores only a hash", () => {
    const ticket = mintUpgradeTicket();
    expect(ticket).toMatch(/^mut_[A-Za-z0-9_-]{43}$/);
    expect(hashUpgradeTicket(ticket)).toHaveLength(64);
    expect(hashUpgradeTicket(ticket)).not.toContain(ticket);
    expect(mintUpgradeTicket()).not.toBe(ticket);
  });

  it("writes a scope the same way whatever order the parameters came in", () => {
    expect(upgradeTicketScope({ session: "s1", process: undefined })).toBe("session=s1");
    expect(upgradeTicketScope({ b: "2", a: "1" })).toBe(upgradeTicketScope({ a: "1", b: "2" }));
    expect(upgradeTicketScope({ host: "my laptop&x=1" })).toBe("host=my%20laptop%26x%3D1");
    expect(upgradeTicketScope({ session: "", process: null })).toBe("");
  });

  it("is single use, and bound to its target, scope and thirty seconds (memory)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const tickets = yield* UpgradeTicketsRepo;
        const { ticket } = yield* tickets.mint({
          userId: "alice",
          target: "tty",
          scope: "session=s1",
          credential: null,
        });
        expect(yield* tickets.consume({ ticket, target: "tty", scope: "session=s2" })).toBeNull();
        expect(
          yield* tickets.consume({ ticket, target: "service-tunnel", scope: "session=s1" }),
        ).toBeNull();
        expect(
          yield* tickets.consume({ ticket, target: "tty", scope: "session=s1" }),
        ).toMatchObject({ userId: "alice", credential: null });
        expect(yield* tickets.consume({ ticket, target: "tty", scope: "session=s1" })).toBeNull();
      }).pipe(Effect.provide(UpgradeTicketsRepoMemory)),
    );
  });
});

/**
 * The real statement against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway database.
 * Without one reachable these skip rather than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_upgrade_tickets_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = UpgradeTicketsRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<A, E, UpgradeTicketsRepo | SqlClient.SqlClient | PgClient.PgClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

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

describe.skipIf(!reachable)("upgrade tickets in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(ORDERED, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
            ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z')`;
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

  it("stores the hash, never the ticket", async () => {
    const stored = await run(
      Effect.gen(function* () {
        const tickets = yield* UpgradeTicketsRepo;
        const sql = yield* SqlClient.SqlClient;
        const { ticket } = yield* tickets.mint({
          userId: "alice",
          target: "tty",
          scope: "session=s1",
          credential: null,
        });
        const rows = yield* sql<{ token_hash: string }>`SELECT token_hash FROM upgrade_tickets`;
        return { ticket, hashes: rows.map((row) => row.token_hash) };
      }),
    );
    expect(stored.hashes).toContain(hashUpgradeTicket(stored.ticket));
    expect(stored.hashes).not.toContain(stored.ticket);
  });

  it("lets exactly one of many racing requests spend a ticket", async () => {
    const winners = await run(
      Effect.gen(function* () {
        const tickets = yield* UpgradeTicketsRepo;
        const { ticket } = yield* tickets.mint({
          userId: "alice",
          target: "tty",
          scope: "session=s1",
          credential: null,
        });
        const outcomes = yield* Effect.all(
          Array.from({ length: 16 }, () =>
            tickets.consume({ ticket, target: "tty", scope: "session=s1" }),
          ),
          { concurrency: "unbounded" },
        );
        return outcomes.flatMap((spent) => (spent === null ? [] : [spent.userId]));
      }),
    );
    expect(winners).toEqual(["alice"]);
  });

  it("refuses the wrong target, the wrong scope and an expired ticket without spending it", async () => {
    await run(
      Effect.gen(function* () {
        const tickets = yield* UpgradeTicketsRepo;
        const now = new Date("2026-09-17T10:00:00.000Z");
        const { ticket } = yield* tickets.mint({
          userId: "alice",
          target: "tty",
          scope: "session=s1",
          credential: null,
          now,
        });
        const at = (ms: number) => new Date(now.getTime() + ms);
        expect(
          yield* tickets.consume({
            ticket,
            target: "keys-bridge",
            scope: "session=s1",
            now: at(1),
          }),
        ).toBeNull();
        expect(
          yield* tickets.consume({ ticket, target: "tty", scope: "session=s2", now: at(1) }),
        ).toBeNull();
        expect(
          yield* tickets.consume({
            ticket,
            target: "tty",
            scope: "session=s1",
            now: at(UPGRADE_TICKET_TTL_MS),
          }),
        ).toBeNull();
        expect(
          yield* tickets.consume({
            ticket,
            target: "tty",
            scope: "session=s1",
            now: at(UPGRADE_TICKET_TTL_MS - 1),
          }),
        ).toMatchObject({ userId: "alice" });
      }),
    );
  });

  it("is worth nothing once the sign-in or the device that minted it is gone", async () => {
    await run(
      Effect.gen(function* () {
        const tickets = yield* UpgradeTicketsRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES
            ('auth-live', now() + interval '1 day', 'tok-live', now(), now(), 'alice'),
            ('auth-expired', now() - interval '1 minute', 'tok-expired', now(), now(), 'alice')`;
        yield* sql`
          INSERT INTO device_tokens (id, user_id, name, platform, token_hash) VALUES
            ('dev-live', 'alice', 'phone', 'ios', 'hash-live'),
            ('dev-gone', 'alice', 'old phone', 'ios', 'hash-gone')`;
        const mintAs = (credential: `session:${string}` | `device:${string}`) =>
          tickets
            .mint({ userId: "alice", target: "tty-renew", scope: "session=s1", credential })
            .pipe(Effect.map((minted) => minted.ticket));
        const show = (ticket: string) =>
          tickets.consume({ ticket, target: "tty-renew", scope: "session=s1", keep: true });

        const bySignIn = yield* mintAs("session:auth-live");
        const byDevice = yield* mintAs("device:dev-gone");
        const byExpired = yield* mintAs("session:auth-expired");
        // Shown, not spent: a renewal can be shown again.
        expect(yield* show(bySignIn)).toMatchObject({ credential: "session:auth-live" });
        expect(yield* show(bySignIn)).toMatchObject({ userId: "alice" });
        expect(yield* show(byDevice)).not.toBeNull();
        expect(yield* show(byExpired)).toBeNull();
        expect(yield* tickets.credentialStands("session:auth-live")).toBe(true);
        expect(yield* tickets.credentialStands("session:auth-expired")).toBe(false);
        expect(yield* tickets.credentialStands(null)).toBe(true);

        // Signing out deletes the row; revoking a device stamps it.
        yield* sql`DELETE FROM "session" WHERE "id" = 'auth-live'`;
        yield* sql`UPDATE device_tokens SET revoked_at = now() WHERE id = 'dev-gone'`;
        expect(yield* show(bySignIn)).toBeNull();
        expect(yield* show(byDevice)).toBeNull();
        expect(yield* tickets.credentialStands("session:auth-live")).toBe(false);
        expect(yield* tickets.credentialStands("device:dev-gone")).toBe(false);
        expect(yield* tickets.credentialStands("device:dev-live")).toBe(true);
      }),
    );
  });

  it("sweeps expired tickets when the next one is minted", async () => {
    const remaining = await run(
      Effect.gen(function* () {
        const tickets = yield* UpgradeTicketsRepo;
        const sql = yield* SqlClient.SqlClient;
        const long_ago = new Date("2020-01-01T00:00:00.000Z");
        yield* tickets.mint({
          userId: "alice",
          target: "tty",
          scope: "session=old",
          credential: null,
          now: long_ago,
        });
        yield* tickets.mint({
          userId: "alice",
          target: "tty",
          scope: "session=new",
          credential: null,
        });
        const rows = yield* sql<{ scope: string }>`SELECT scope FROM upgrade_tickets`;
        return rows.map((row) => row.scope);
      }),
    );
    expect(remaining).not.toContain("session=old");
    expect(remaining).toContain("session=new");
  });
});
