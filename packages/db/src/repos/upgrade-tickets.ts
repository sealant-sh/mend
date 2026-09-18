import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, lt, sql, type SQLWrapper } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { upgradeTickets } from "../schema/workbench.ts";

/**
 * Upgrade tickets (docs/adr/0004-access-without-a-private-network.md, "Upgrade tickets"; MEND-08).
 *
 * A browser cannot set a header on a WebSocket and a WebView cannot set one on a page load, so a
 * credential has to ride those URLs. A ticket is that credential made worthless anywhere else:
 * single use, thirty seconds to live, bound to one account, one target, that target's exact
 * parameters, and the sign-in or paired device that minted it. Only its sha256 is stored, and the
 * hash is the lookup key, so the secret never meets a comparison the database could time.
 */
export const UPGRADE_TICKET_TTL_MS = 30_000;

/**
 * How long an embed page may keep reconnecting without going back to the app for a new URL,
 * counted from the moment the app minted that URL's ticket. A renewal ticket lives only in that
 * page's memory and is sent only in a request body; it is the one ticket that is not single use
 * (a lost reply would otherwise strand the page), and it ends at this deadline, however often it
 * was used, or when the credential that minted it goes, whichever is first.
 */
export const UPGRADE_RENEWAL_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * What a ticket opens. `tty-embed` opens the embed page, which exchanges it for a `tty` ticket and
 * a `tty-renew` ticket; `tty-renew` is exchanged the same way when the page reconnects.
 */
export const UPGRADE_TICKET_TARGETS = [
  "tty",
  "service-tunnel",
  "keys-bridge",
  "tty-embed",
  "tty-renew",
] as const;
export type UpgradeTicketTarget = (typeof UPGRADE_TICKET_TARGETS)[number];

export const hashUpgradeTicket = (ticket: string): string =>
  createHash("sha256").update(ticket, "utf8").digest("hex");

/** `mut_` + 32 random bytes, base64url: recognisable in a log, and never a session or device token. */
export const mintUpgradeTicket = (): string => `mut_${randomBytes(32).toString("base64url")}`;

/**
 * The parameters a ticket is bound to, as one string: sorted `key=value` pairs of the addressing
 * parameters only. The route builds the same string from its own query and the two must be equal,
 * so a ticket minted for one session or service opens no other.
 */
export const upgradeTicketScope = (params: Readonly<Record<string, string | null | undefined>>) =>
  Object.entries(params)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .toSorted()
    .join("&");

/** The credential that minted a ticket, as stored: a sign-in (`session:<id>`) or a paired device. */
export type TicketCredential = `session:${string}` | `device:${string}`;

export const isTicketCredential = (value: string | null | undefined): value is TicketCredential =>
  typeof value === "string" && /^(session|device):.+$/.test(value);

/** A spent (or, for a renewal, shown) ticket: whose it was and what it inherits. */
export interface SpentUpgradeTicket {
  readonly userId: string;
  readonly credential: TicketCredential | null;
  readonly expiresAt: Date;
}

export class UpgradeTicketsRepo extends Context.Service<
  UpgradeTicketsRepo,
  {
    /** Mint and persist a ticket; returns the plaintext ONCE. */
    readonly mint: (input: {
      readonly userId: string;
      readonly target: UpgradeTicketTarget;
      readonly scope: string;
      /** The sign-in or device that asked. Null only for a credential with no row (the dev token). */
      readonly credential: TicketCredential | null;
      /** Thirty seconds unless stated; only a renewal ticket states otherwise. */
      readonly ttlMs?: number;
      readonly now?: Date;
    }) => Effect.Effect<{ readonly ticket: string; readonly expiresAt: Date }>;
    /**
     * Spend a ticket, or null. One statement deletes it only when it is unexpired, for exactly
     * this target and scope, and minted by a credential that still stands (the sign-in exists and
     * has not expired; the device is not revoked). Two requests racing the same ticket cannot both
     * win, and a wrong guess spends nothing. `keep` answers the same question without deleting:
     * how a renewal ticket is shown.
     */
    readonly consume: (input: {
      readonly ticket: string;
      readonly target: UpgradeTicketTarget;
      readonly scope: string;
      readonly keep?: boolean;
      readonly now?: Date;
    }) => Effect.Effect<SpentUpgradeTicket | null>;
    /** Whether the credential a ticket was minted by still stands. Null always does. */
    readonly credentialStands: (credential: TicketCredential | null) => Effect.Effect<boolean>;
  }
>()("@mend/db/UpgradeTicketsRepo") {}

/** True while the credential in `column` still stands, judged by the database at `now`. */
const stands = (column: SQLWrapper, now: Date) => sql<boolean>`(
  ${column} IS NULL
  OR (${column} LIKE 'session:%' AND EXISTS (
    SELECT 1 FROM "session" s
     WHERE s."id" = substr(${column}, 9) AND s."expiresAt" > ${now.toISOString()}::timestamptz))
  OR (${column} LIKE 'device:%' AND EXISTS (
    SELECT 1 FROM device_tokens d
     WHERE d.id = substr(${column}, 8) AND d.revoked_at IS NULL))
)`;

export const UpgradeTicketsRepoLive: Layer.Layer<UpgradeTicketsRepo, never, MendDB> = Layer.effect(
  UpgradeTicketsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const mint = Effect.fn("UpgradeTicketsRepo.mint")(function* (input: {
      readonly userId: string;
      readonly target: UpgradeTicketTarget;
      readonly scope: string;
      readonly credential: TicketCredential | null;
      readonly ttlMs?: number;
      readonly now?: Date;
    }) {
      const now = input.now ?? new Date();
      // Expired rows are dead weight, and minting is the only thing that grows the table.
      yield* db.delete(upgradeTickets).where(lt(upgradeTickets.expiresAt, now)).pipe(Effect.orDie);
      const ticket = mintUpgradeTicket();
      const expiresAt = new Date(now.getTime() + (input.ttlMs ?? UPGRADE_TICKET_TTL_MS));
      yield* db
        .insert(upgradeTickets)
        .values({
          tokenHash: hashUpgradeTicket(ticket),
          userId: input.userId,
          target: input.target,
          scope: input.scope,
          credential: input.credential,
          expiresAt,
          createdAt: now,
        })
        .pipe(Effect.orDie);
      return { ticket, expiresAt };
    });

    const consume = Effect.fn("UpgradeTicketsRepo.consume")(function* (input: {
      readonly ticket: string;
      readonly target: UpgradeTicketTarget;
      readonly scope: string;
      readonly keep?: boolean;
      readonly now?: Date;
    }) {
      const now = input.now ?? new Date();
      const live = and(
        eq(upgradeTickets.tokenHash, hashUpgradeTicket(input.ticket)),
        eq(upgradeTickets.target, input.target),
        eq(upgradeTickets.scope, input.scope),
        gt(upgradeTickets.expiresAt, now),
        stands(upgradeTickets.credential, now),
      );
      const answer = {
        userId: upgradeTickets.userId,
        credential: upgradeTickets.credential,
        expiresAt: upgradeTickets.expiresAt,
      };
      const rows =
        input.keep === true
          ? yield* db.select(answer).from(upgradeTickets).where(live).pipe(Effect.orDie)
          : yield* db.delete(upgradeTickets).where(live).returning(answer).pipe(Effect.orDie);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        userId: row.userId,
        credential: isTicketCredential(row.credential) ? row.credential : null,
        expiresAt: row.expiresAt,
      };
    });

    const credentialStands = Effect.fn("UpgradeTicketsRepo.credentialStands")(function* (
      credential: TicketCredential | null,
    ) {
      if (credential === null) return true;
      const rows = yield* db
        .execute<{ readonly stands: boolean }>(
          sql`SELECT ${stands(sql`${credential}::text`, new Date())} AS stands`,
        )
        .pipe(Effect.orDie);
      return rows[0]?.stands === true;
    });

    return { mint, consume, credentialStands };
  }),
);

/**
 * The same semantics held in memory, for route tests: an expiry, one target, one scope, and a
 * credential that can be struck. `clock` lets a test walk past the expiry; `revoked` is the set of
 * credentials that no longer stand.
 */
export const makeUpgradeTicketsMemory = (
  clock: () => number = Date.now,
  revoked: ReadonlySet<string> = new Set(),
): UpgradeTicketsRepo["Service"] => {
  const rows = new Map<
    string,
    {
      readonly userId: string;
      readonly target: UpgradeTicketTarget;
      readonly scope: string;
      readonly credential: TicketCredential | null;
      readonly expiresAt: number;
    }
  >();
  const standing = (credential: TicketCredential | null) =>
    credential === null || !revoked.has(credential);
  return {
    mint: (input) =>
      Effect.sync(() => {
        const ticket = mintUpgradeTicket();
        const expiresAt = clock() + (input.ttlMs ?? UPGRADE_TICKET_TTL_MS);
        rows.set(hashUpgradeTicket(ticket), {
          userId: input.userId,
          target: input.target,
          scope: input.scope,
          credential: input.credential,
          expiresAt,
        });
        return { ticket, expiresAt: new Date(expiresAt) };
      }),
    consume: (input) =>
      Effect.sync(() => {
        const key = hashUpgradeTicket(input.ticket);
        const row = rows.get(key);
        if (
          row === undefined ||
          row.expiresAt <= clock() ||
          row.target !== input.target ||
          row.scope !== input.scope ||
          !standing(row.credential)
        ) {
          return null;
        }
        if (input.keep !== true) rows.delete(key);
        return {
          userId: row.userId,
          credential: row.credential,
          expiresAt: new Date(row.expiresAt),
        };
      }),
    credentialStands: (credential) => Effect.sync(() => standing(credential)),
  };
};

export const UpgradeTicketsRepoMemory: Layer.Layer<UpgradeTicketsRepo> = Layer.sync(
  UpgradeTicketsRepo,
  () => makeUpgradeTicketsMemory(),
);
