import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { sessionChannelTokens } from "../schema/workbench.ts";

/**
 * Per-session capability tokens for the network session channel (docs/KUBERNETES.md).
 *
 * Possession of `/run/mend/mend.sock` is what authorises a Docker workspace to operate on its
 * session. A Kubernetes workspace cannot mount a socket across nodes, so it holds a token that
 * grants EXACTLY the same scope — the closures pre-bound to that one session — and nothing
 * else: no user, no project, no other session. Only the sha256 of the token is stored, so a
 * Mend restart verifies deterministically and a database read never yields the secret.
 *
 * One token per launch — one physical executor, named by its create's idempotency key (cross-repo
 * decision 5, migration 0083): issued before the create (cold or hot-pool; the pooled id becomes
 * the session id at claim, so the token follows), revoked once that executor's end is observed.
 * A new launch never reuses or rotates another's token: an executor whose stop was kept for
 * recovery, or whose create was never answered, still ships with its own. A revoked row stays.
 */
export const hashSessionChannelToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** 32 random bytes, base64url: 43 characters, no padding, safe in env and headers. */
export const mintSessionChannelToken = (): string => randomBytes(32).toString("base64url");

const constantTimeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

export class SessionChannelTokensRepo extends Context.Service<
  SessionChannelTokensRepo,
  {
    /**
     * Mint and persist a fresh token for one physical executor of the session — its launch
     * (`launchId`, the create's idempotency key; cross-repo decision 5) — and return the plaintext
     * ONCE. Every other token stays as it is: an executor that may still need its own token is
     * never cut off by another launch's.
     */
    readonly issue: (sessionId: string, launchId: string) => Effect.Effect<string>;
    /**
     * The launch a live (unrevoked) token of that session was issued for, or null. The token is
     * verified before anything is resolved from it.
     */
    readonly verify: (sessionId: string, token: string) => Effect.Effect<string | null>;
    /**
     * The session and the launch a bare token belongs to, or null. sealantd's capture registrar
     * presents the token alone (ADR-0002 "Session channel routes": one token, two names); the hash
     * is the lookup key, so the secret never meets a comparison the database could time.
     */
    readonly resolve: (
      token: string,
    ) => Effect.Effect<{ readonly sessionId: string; readonly launchId: string } | null>;
    /** Revoke every token of the session. Idempotent. */
    readonly revoke: (sessionId: string) => Effect.Effect<void>;
    /** Revoke the tokens of one launch — its executor's end was observed. Idempotent. */
    readonly revokeLaunch: (launchId: string) => Effect.Effect<void>;
  }
>()("@mend/db/SessionChannelTokensRepo") {}

export const SessionChannelTokensRepoLive: Layer.Layer<SessionChannelTokensRepo, never, MendDB> =
  Layer.effect(
    SessionChannelTokensRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;

      const issue = Effect.fn("SessionChannelTokensRepo.issue")(function* (
        sessionId: string,
        launchId: string,
      ) {
        const token = mintSessionChannelToken();
        const tokenHash = hashSessionChannelToken(token);
        yield* db
          .insert(sessionChannelTokens)
          .values({ tokenHash, sessionId, launchId, createdAt: new Date(), revokedAt: null })
          .pipe(Effect.orDie);
        return token;
      });

      const liveRowOf = (token: string) =>
        db
          .select({
            sessionId: sessionChannelTokens.sessionId,
            launchId: sessionChannelTokens.launchId,
          })
          .from(sessionChannelTokens)
          .where(
            and(
              eq(sessionChannelTokens.tokenHash, hashSessionChannelToken(token)),
              isNull(sessionChannelTokens.revokedAt),
            ),
          )
          .limit(1)
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows[0] ?? null),
          );

      const verify = Effect.fn("SessionChannelTokensRepo.verify")(function* (
        sessionId: string,
        token: string,
      ) {
        const row = yield* liveRowOf(token);
        return row !== null && constantTimeEquals(row.sessionId, sessionId) ? row.launchId : null;
      });

      const resolve = Effect.fn("SessionChannelTokensRepo.resolve")(function* (token: string) {
        return yield* liveRowOf(token);
      });

      const revoke = Effect.fn("SessionChannelTokensRepo.revoke")(function* (sessionId: string) {
        yield* db
          .update(sessionChannelTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sessionChannelTokens.sessionId, sessionId),
              isNull(sessionChannelTokens.revokedAt),
            ),
          )
          .pipe(Effect.orDie);
      });

      const revokeLaunch = Effect.fn("SessionChannelTokensRepo.revokeLaunch")(function* (
        launchId: string,
      ) {
        yield* db
          .update(sessionChannelTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sessionChannelTokens.launchId, launchId),
              isNull(sessionChannelTokens.revokedAt),
            ),
          )
          .pipe(Effect.orDie);
      });

      return { issue, verify, resolve, revoke, revokeLaunch };
    }),
  );

/**
 * In-memory implementation with the same contract — for tests and for deployments that never
 * enable the network channel (no table traffic).
 */
export const SessionChannelTokensRepoMemory: Layer.Layer<SessionChannelTokensRepo> = Layer.sync(
  SessionChannelTokensRepo,
  () => {
    const rows = new Map<
      string,
      { readonly sessionId: string; readonly launchId: string; revoked: boolean }
    >();
    const liveRowOf = (token: string) => {
      const row = rows.get(hashSessionChannelToken(token));
      return row === undefined || row.revoked ? null : row;
    };
    const revokeWhere = (
      matches: (row: { readonly sessionId: string; readonly launchId: string }) => boolean,
    ) =>
      Effect.sync(() => {
        for (const row of rows.values()) if (matches(row)) row.revoked = true;
      });
    return {
      issue: (sessionId, launchId) =>
        Effect.sync(() => {
          const token = mintSessionChannelToken();
          rows.set(hashSessionChannelToken(token), { sessionId, launchId, revoked: false });
          return token;
        }),
      verify: (sessionId, token) =>
        Effect.sync(() => {
          const row = liveRowOf(token);
          return row !== null && row.sessionId === sessionId ? row.launchId : null;
        }),
      resolve: (token) =>
        Effect.sync(() => {
          const row = liveRowOf(token);
          return row === null ? null : { sessionId: row.sessionId, launchId: row.launchId };
        }),
      revoke: (sessionId) => revokeWhere((row) => row.sessionId === sessionId),
      revokeLaunch: (launchId) => revokeWhere((row) => row.launchId === launchId),
    };
  },
);
