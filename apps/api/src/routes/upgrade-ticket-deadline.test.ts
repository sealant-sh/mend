import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { upgradeTicketExchangeGroup } from "@mend/api-contracts";
import {
  makeUpgradeTicketsMemory,
  MendDBLive,
  migrations,
  UpgradeTicketsRepo,
  UpgradeTicketsRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { Context, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import { TerminalProjects, UpgradeTicketExchangeGroupLive } from "./upgrade-tickets.ts";

const exchangeApi = HttpApiBuilder.layer(
  HttpApi.make("mend").add(upgradeTicketExchangeGroup).prefix("/api"),
).pipe(Layer.provide(UpgradeTicketExchangeGroupLive), Layer.provide(HttpServer.layerServices));
/** Every terminal here belongs to a listed project: these tests are about deadlines. */
const listedTerminals: TerminalProjects["Service"] = { listed: () => Effect.succeed(true) };
const send = (
  handler: (
    request: Request,
    context: Context.Context<UpgradeTicketsRepo | TerminalProjects>,
  ) => Promise<Response>,
  context: Context.Context<UpgradeTicketsRepo>,
  ticket: string,
) =>
  handler(
    new Request("http://localhost/api/upgrade-tickets/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, session: "s1" }),
    }),
    Context.add(context, TerminalProjects, listedTerminals),
  );
const ticketOf = (body: unknown, kind: "ticket" | "renew") => {
  if (body === null || typeof body !== "object") throw new Error("Missing exchange body");
  const value =
    kind === "ticket" && "ticket" in body
      ? body.ticket
      : kind === "renew" && "renew" in body
        ? body.renew
        : undefined;
  if (typeof value !== "string") throw new Error(`Missing ${kind}`);
  return value;
};

describe("absolute ticket deadline in memory", () => {
  it("honors an absolute deadline without restarting a default lifetime", async () => {
    let now = 1000;
    const tickets = makeUpgradeTicketsMemory(() => now);
    const minted = await Effect.runPromise(
      tickets.mint({
        userId: "alice",
        target: "tty-renew",
        scope: "session=s1",
        credential: null,
        expiresAt: new Date(2000),
      }),
    );
    expect(minted.expiresAt).toEqual(new Date(2000));
    const request = {
      ticket: minted.ticket,
      target: "tty-renew",
      scope: "session=s1",
      keep: true,
    } satisfies Parameters<typeof tickets.consume>[0];
    now = 1999;
    expect(await Effect.runPromise(tickets.consume(request))).toEqual({
      userId: "alice",
      credential: null,
      expiresAt: new Date(2000),
    });
    now = 2000;
    expect(await Effect.runPromise(tickets.consume(request))).toBeNull();
    now = 2001;
    expect(await Effect.runPromise(tickets.consume(request))).toBeNull();
  });

  it("does not admit a renewal whose original window ends while the initial consume returns", async () => {
    const mintedAt = 1000;
    let now = mintedAt;
    const tickets = makeUpgradeTicketsMemory(() => now);
    const minted = await Effect.runPromise(
      tickets.mint({ userId: "alice", target: "tty-embed", scope: "session=s1", credential: null }),
    );
    let consumedInitial = false;
    const delayed: UpgradeTicketsRepo["Service"] = {
      ...tickets,
      consume: (input) =>
        tickets.consume(input).pipe(
          Effect.tap((spent) =>
            Effect.sync(() => {
              if (input.target === "tty-embed" && spent !== null) {
                consumedInitial = true;
                now = mintedAt + 43_200_000 + 1;
              }
            }),
          ),
        ),
    };
    const { handler, dispose } = HttpRouter.toWebHandler(
      exchangeApi.pipe(Layer.provide(Layer.succeed(UpgradeTicketsRepo, delayed))),
      { disableLogger: true },
    );
    const context = Context.make(UpgradeTicketsRepo, delayed);
    try {
      const response = await send(handler, context, minted.ticket);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(consumedInitial).toBe(true);
      expect(
        await Effect.runPromise(
          tickets.consume({
            ticket: ticketOf(body, "renew"),
            target: "tty-renew",
            scope: "session=s1",
            keep: true,
          }),
        ),
      ).toBeNull();
      // Socket tickets still get thirty seconds from their own mint, as the exchange contract says.
      expect(
        await Effect.runPromise(
          tickets.consume({
            ticket: ticketOf(body, "ticket"),
            target: "tty",
            scope: "session=s1",
            keep: true,
          }),
        ),
      ).toEqual({ userId: "alice", credential: null, expiresAt: new Date(now + 30_000) });
    } finally {
      await dispose();
    }
  });

  it("types a TTL or an absolute deadline as distinct mint choices", () => {
    const tickets = makeUpgradeTicketsMemory();
    const input = {
      userId: "alice",
      target: "tty-renew",
      scope: "session=s1",
      credential: null,
    } satisfies Parameters<typeof tickets.mint>[0];
    expectTypeOf(tickets.mint({ ...input, expiresAt: new Date(2000) })).toEqualTypeOf<
      Effect.Effect<{ readonly ticket: string; readonly expiresAt: Date }>
    >();
    expectTypeOf(tickets.mint({ ...input, ttlMs: 1234 })).toEqualTypeOf<
      Effect.Effect<{ readonly ticket: string; readonly expiresAt: Date }>
    >();
    // @ts-expect-error An absolute deadline and a relative lifetime cannot both govern one mint.
    tickets.mint({ ...input, ttlMs: 1234, expiresAt: new Date(2000) });
  });
});

const postgres = postgresTestConfig();
const database = `mend_upgrade_deadline_${process.pid}_${Date.now()}`;
const scratch = new URL(postgres.adminUrl);
scratch.pathname = `/${database}`;
const runtime = ManagedRuntime.make(
  UpgradeTicketsRepoLive.pipe(
    Layer.provideMerge(
      MendDBLive.pipe(
        Layer.provideMerge(
          PgClient.layer({ url: Redacted.make(scratch.toString()), maxConnections: 2 }),
        ),
      ),
    ),
  ),
);
const admin = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    work.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );
let created = false;

describe.skipIf(postgres.skip)(
  "absolute ticket deadline with production exchange and PostgreSQL",
  () => {
    beforeAll(async () => {
      await admin(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)),
      );
      created = true;
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* Effect.forEach(
            Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
            ([, migration]) => migration,
          );
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES ('alice', 'Alice', 'deadline@example.invalid', now())`;
        }),
      );
    });
    afterAll(async () => {
      try {
        await runtime.dispose();
      } finally {
        if (created)
          await admin(
            Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`DROP DATABASE ${database}`)),
          );
      }
    });

    it("persists the explicit deadline, retains mint time and refuses at/after the cutoff", async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const tickets = yield* UpgradeTicketsRepo;
          const sql = yield* SqlClient.SqlClient;
          const now = new Date("2030-01-01T00:00:00.000Z");
          const deadline = new Date("2030-01-01T00:00:01.234Z");
          const minted = yield* tickets.mint({
            userId: "alice",
            target: "tty-renew",
            scope: "session=absolute",
            credential: null,
            now,
            expiresAt: deadline,
          });
          expect(minted.expiresAt).toEqual(deadline);
          const hash = createHash("sha256").update(minted.ticket).digest("hex");
          const rows = yield* sql<{
            created_at: Date;
            expires_at: Date;
          }>`SELECT created_at, expires_at FROM upgrade_tickets WHERE token_hash = ${hash}`;
          expect(rows).toEqual([{ created_at: now, expires_at: deadline }]);
          const request = {
            ticket: minted.ticket,
            target: "tty-renew",
            scope: "session=absolute",
            keep: true,
          } satisfies Parameters<typeof tickets.consume>[0];
          expect(
            yield* tickets.consume({ ...request, now: new Date(deadline.getTime() - 1) }),
          ).toEqual({ userId: "alice", credential: null, expiresAt: deadline });
          expect(yield* tickets.consume({ ...request, now: deadline })).toBeNull();
          expect(
            yield* tickets.consume({ ...request, now: new Date(deadline.getTime() + 1) }),
          ).toBeNull();
        }),
      );
    });

    it("cannot make a passed absolute deadline live by minting later", async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const tickets = yield* UpgradeTicketsRepo;
          const now = new Date("2030-02-01T00:00:00.000Z");
          const late = yield* tickets.mint({
            userId: "alice",
            target: "tty-renew",
            scope: "session=late",
            credential: null,
            now,
            expiresAt: new Date(now.getTime() - 1),
          });
          expect(late.expiresAt).toEqual(new Date(now.getTime() - 1));
          expect(
            yield* tickets.consume({
              ticket: late.ticket,
              target: "tty-renew",
              scope: "session=late",
              now,
            }),
          ).toBeNull();
          const ordinary = yield* tickets.mint({
            userId: "alice",
            target: "tty",
            scope: "session=ordinary",
            credential: null,
            now,
          });
          expect(ordinary.expiresAt).toEqual(new Date(now.getTime() + 30_000));
          expect(
            yield* tickets.consume({
              ticket: ordinary.ticket,
              target: "tty",
              scope: "session=ordinary",
              now,
            }),
          ).toEqual({ userId: "alice", credential: null, expiresAt: ordinary.expiresAt });
        }),
      );
    });

    it("preserves the original deadline in a delayed actual exchange and every later reuse", async () => {
      const context = await runtime.runPromise(Effect.context<UpgradeTicketsRepo>());
      const { handler, dispose } = HttpRouter.toWebHandler(
        exchangeApi.pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      );
      try {
        const mintedAt = new Date(Date.now() - 20_000);
        const original = await runtime.runPromise(
          Effect.flatMap(UpgradeTicketsRepo, (tickets) =>
            tickets.mint({
              userId: "alice",
              target: "tty-embed",
              scope: "session=s1",
              credential: null,
              now: mintedAt,
            }),
          ),
        );
        expect(original.expiresAt).toEqual(new Date(mintedAt.getTime() + 30_000));
        const exchangeStarted = Date.now();
        const response = await send(handler, context, original.ticket);
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        const renewal = ticketOf(body, "renew");
        const deadline = new Date(mintedAt.getTime() + 43_200_000);
        const inspect = (ticket: string) =>
          runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const hash = createHash("sha256").update(ticket).digest("hex");
              return yield* sql<{
                target: string;
                created_at: Date;
                expires_at: Date;
              }>`SELECT target, created_at, expires_at FROM upgrade_tickets WHERE token_hash = ${hash}`;
            }),
          );
        const rows = await inspect(renewal);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.expires_at).toEqual(deadline);
        expect(rows[0]?.created_at.getTime()).toBeGreaterThanOrEqual(exchangeStarted);
        const socket = await inspect(ticketOf(body, "ticket"));
        expect(socket).toHaveLength(1);
        expect(socket[0]?.target).toBe("tty");
        expect(
          (socket[0]?.expires_at.getTime() ?? 0) - (socket[0]?.created_at.getTime() ?? 0),
        ).toBe(30_000);
        const again = await send(handler, context, renewal);
        expect(again.status).toBe(200);
        expect(ticketOf(await again.json(), "renew")).toBe(renewal);
        expect(await inspect(renewal)).toEqual(rows);
        await runtime.runPromise(
          Effect.gen(function* () {
            const tickets = yield* UpgradeTicketsRepo;
            const request = {
              ticket: renewal,
              target: "tty-renew",
              scope: "session=s1",
              keep: true,
            } satisfies Parameters<typeof tickets.consume>[0];
            expect(
              yield* tickets.consume({ ...request, now: new Date(deadline.getTime() - 1) }),
            ).toEqual({ userId: "alice", credential: null, expiresAt: deadline });
            expect(yield* tickets.consume({ ...request, now: deadline })).toBeNull();
            expect(
              yield* tickets.consume({ ...request, now: new Date(deadline.getTime() + 1) }),
            ).toBeNull();
          }),
        );
      } finally {
        await dispose();
      }
    });
  },
);
