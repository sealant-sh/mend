import { randomUUID } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  hashUpgradeTicket,
  makeUpgradeTicketsMemory,
  mintUpgradeTicket,
  type TicketCredential,
  UPGRADE_TICKET_TTL_MS,
  UpgradeTicketsRepo,
  UpgradeTicketsRepoLive,
  upgradeTicketScope,
} from "../src/repos/upgrade-tickets.ts";
import { postgresTestConfig } from "./postgres.ts";

interface TicketFixture {
  readonly tickets: UpgradeTicketsRepo["Service"];
  readonly signIn: TicketCredential;
  readonly device: TicketCredential;
  readonly revoke: (credential: TicketCredential) => Effect.Effect<void>;
}

const ticketContract = (
  runFixture: (work: (fixture: TicketFixture) => Effect.Effect<void>) => Promise<void>,
) => {
  // These are product lifetimes, independent of the implementation's constants.
  for (const duration of [
    { label: "default thirty seconds", target: "tty", ttlMs: undefined, expectedMs: 30_000 },
    { label: "custom short TTL", target: "keys-bridge", ttlMs: 1234, expectedMs: 1234 },
    { label: "custom renewal TTL", target: "tty-renew", ttlMs: 43_200_000, expectedMs: 43_200_000 },
  ] satisfies ReadonlyArray<{
    label: string;
    target: "tty" | "keys-bridge" | "tty-renew";
    ttlMs: number | undefined;
    expectedMs: number;
  }>) {
    for (const offset of [-1, 0, 1]) {
      it(`${duration.label}: accepts only before expiry, offset ${offset}ms`, async () =>
        runFixture(({ tickets }) =>
          Effect.gen(function* () {
            const now = new Date("2030-01-01T00:00:00.000Z");
            const expectedExpiry = new Date(now.getTime() + duration.expectedMs);
            const minted = yield* tickets.mint({
              userId: "alice",
              target: duration.target,
              scope: "session=s1",
              credential: null,
              ...(duration.ttlMs === undefined ? {} : { ttlMs: duration.ttlMs }),
              now,
            });
            expect(minted.expiresAt).toEqual(expectedExpiry);
            const spent = yield* tickets.consume({
              ticket: minted.ticket,
              target: duration.target,
              scope: "session=s1",
              now: new Date(expectedExpiry.getTime() + offset),
            });
            expect(spent).toEqual(
              offset < 0 ? { userId: "alice", credential: null, expiresAt: expectedExpiry } : null,
            );
            if (offset < 0)
              expect(
                yield* tickets.consume({
                  ticket: minted.ticket,
                  target: duration.target,
                  scope: "session=s1",
                  now,
                }),
              ).toBeNull();
          }),
        ));
    }
  }

  it("wrong target, wrong scope and unknown ticket do not spend the correct ticket", async () =>
    runFixture(({ tickets }) =>
      Effect.gen(function* () {
        const now = new Date("2030-02-01T00:00:00.000Z");
        const minted = yield* tickets.mint({
          userId: "alice",
          target: "tty",
          scope: "session=s1",
          credential: null,
          now,
        });
        const request = {
          ticket: minted.ticket,
          target: "tty",
          scope: "session=s1",
          now,
        } satisfies Parameters<typeof tickets.consume>[0];
        expect(yield* tickets.consume({ ...request, target: "service-tunnel" })).toBeNull();
        expect(yield* tickets.consume({ ...request, scope: "session=s2" })).toBeNull();
        expect(yield* tickets.consume({ ...request, ticket: "mut_unknown" })).toBeNull();
        expect(yield* tickets.consume(request)).toEqual({
          userId: "alice",
          credential: null,
          expiresAt: new Date("2030-02-01T00:00:30.000Z"),
        });
        expect(yield* tickets.consume(request)).toBeNull();
      }),
    ));

  it("keep preserves the original deadline and permits a later ordinary spend", async () =>
    runFixture(({ tickets }) =>
      Effect.gen(function* () {
        const now = new Date("2030-03-01T00:00:00.000Z");
        const minted = yield* tickets.mint({
          userId: "alice",
          target: "tty-renew",
          scope: "session=s1",
          credential: null,
          ttlMs: 1234,
          now,
        });
        const expected = {
          userId: "alice",
          credential: null,
          expiresAt: new Date("2030-03-01T00:00:01.234Z"),
        };
        const request = {
          ticket: minted.ticket,
          target: "tty-renew",
          scope: "session=s1",
          keep: true,
        } satisfies Parameters<typeof tickets.consume>[0];
        expect(yield* tickets.consume({ ...request, now })).toEqual(expected);
        expect(
          yield* tickets.consume({ ...request, now: new Date("2030-03-01T00:00:01.233Z") }),
        ).toEqual(expected);
        expect(yield* tickets.consume({ ...request, now: expected.expiresAt })).toBeNull();
        // A refused observation did not delete it; explicit time is a query input, not a clock update.
        expect(
          yield* tickets.consume({
            ...request,
            keep: false,
            now: new Date("2030-03-01T00:00:01.233Z"),
          }),
        ).toEqual(expected);
        expect(yield* tickets.consume({ ...request, now })).toBeNull();
      }),
    ));

  for (const kind of ["signIn", "device"] satisfies ReadonlyArray<"signIn" | "device">)
    it(`${kind} revocation ends an otherwise live reusable ticket`, async () =>
      runFixture(({ tickets, revoke, ...credentials }) =>
        Effect.gen(function* () {
          const credential = credentials[kind];
          const now = new Date("2030-04-01T00:00:00.000Z");
          const minted = yield* tickets.mint({
            userId: "alice",
            target: "tty-renew",
            scope: "session=s1",
            credential,
            ttlMs: 43_200_000,
            now,
          });
          const request = {
            ticket: minted.ticket,
            target: "tty-renew",
            scope: "session=s1",
            keep: true,
            now,
          } satisfies Parameters<typeof tickets.consume>[0];
          const expected = {
            userId: "alice",
            credential,
            expiresAt: new Date("2030-04-01T12:00:00.000Z"),
          };
          expect(yield* tickets.credentialStands(credential)).toBe(true);
          expect(yield* tickets.consume(request)).toEqual(expected);
          expect(yield* tickets.consume(request)).toEqual(expected);
          yield* revoke(credential);
          expect(yield* tickets.credentialStands(credential)).toBe(false);
          expect(yield* tickets.consume(request)).toBeNull();
          expect(yield* tickets.consume({ ...request, keep: false })).toBeNull();
          expect(yield* tickets.credentialStands(null)).toBe(true);
        }),
      ));
};

const runMemoryContract = (work: (fixture: TicketFixture) => Effect.Effect<void>) => {
  const revoked = new Set<string>();
  return Effect.runPromise(
    work({
      tickets: makeUpgradeTicketsMemory(() => 1000, revoked),
      signIn: "session:contract-sign-in",
      device: "device:contract-device",
      revoke: (credential) =>
        Effect.sync(() => {
          revoked.add(credential);
        }),
    }),
  );
};

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

  describe("memory shared contract", () => ticketContract(runMemoryContract));

  it("uses the injected clock only when explicit now is absent", async () => {
    let now = 1000;
    const tickets = makeUpgradeTicketsMemory(() => now);
    const minted = await Effect.runPromise(
      tickets.mint({ userId: "alice", target: "tty", scope: "session=s1", credential: null }),
    );
    expect(minted.expiresAt).toEqual(new Date(31_000));
    now = 30_999;
    const request = {
      ticket: minted.ticket,
      target: "tty",
      scope: "session=s1",
      keep: true,
    } satisfies Parameters<typeof tickets.consume>[0];
    expect(await Effect.runPromise(tickets.consume(request))).toEqual({
      userId: "alice",
      credential: null,
      expiresAt: new Date(31_000),
    });
    now = 31_000;
    expect(await Effect.runPromise(tickets.consume(request))).toBeNull();
    now = 31_001;
    expect(await Effect.runPromise(tickets.consume(request))).toBeNull();
    // An explicit observation before expiry wins even while the injected clock is beyond it.
    expect(
      await Effect.runPromise(tickets.consume({ ...request, now: new Date(30_999) })),
    ).not.toBeNull();
  });
});

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
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

const ORDERED = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
let scratchCreated = false;

const runPostgresContract = (work: (fixture: TicketFixture) => Effect.Effect<void>) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tickets = yield* UpgradeTicketsRepo;
      const signInId = `contract-sign-in-${randomUUID()}`;
      const deviceId = `contract-device-${randomUUID()}`;
      yield* sql`INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
      VALUES (${signInId}, '2100-01-01T00:00:00Z', ${`token-${signInId}`}, now(), now(), 'alice')`;
      yield* sql`INSERT INTO device_tokens (id, user_id, name, platform, token_hash)
      VALUES (${deviceId}, 'alice', 'contract device', 'ios', ${`hash-${deviceId}`})`;
      const signIn: TicketCredential = `session:${signInId}`;
      const device: TicketCredential = `device:${deviceId}`;
      yield* work({
        tickets,
        signIn,
        device,
        revoke: (credential) =>
          credential === signIn
            ? sql`DELETE FROM "session" WHERE id = ${signInId}`.pipe(Effect.orDie, Effect.asVoid)
            : sql`UPDATE device_tokens SET revoked_at = now() WHERE id = ${deviceId}`.pipe(
                Effect.orDie,
                Effect.asVoid,
              ),
      });
    }),
  );

describe.skipIf(postgres.skip)("upgrade tickets in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
        scratchCreated = true;
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
    if (!scratchCreated) return;
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  describe("live shared contract", () => ticketContract(runPostgresContract));

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
