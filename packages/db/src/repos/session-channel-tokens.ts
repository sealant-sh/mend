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
 * Lifecycle: issued at provision (cold or hot-pool; the pooled id becomes the session id at
 * claim, so the token follows), revoked on stop, replacement and drain. A revoked row stays as
 * a tombstone until the next issue for that session overwrites it.
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
    /** Mint and persist a fresh token for the session; returns the plaintext ONCE. */
    readonly issue: (sessionId: string) => Effect.Effect<string>;
    /** True when the presented token matches the live (unrevoked) token for that session. */
    readonly verify: (sessionId: string, token: string) => Effect.Effect<boolean>;
    /** Revoke the session's token. Idempotent. */
    readonly revoke: (sessionId: string) => Effect.Effect<void>;
  }
>()("@mend/db/SessionChannelTokensRepo") {}

export const SessionChannelTokensRepoLive: Layer.Layer<SessionChannelTokensRepo, never, MendDB> =
  Layer.effect(
    SessionChannelTokensRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;

      const issue = Effect.fn("SessionChannelTokensRepo.issue")(function* (sessionId: string) {
        const token = mintSessionChannelToken();
        const tokenHash = hashSessionChannelToken(token);
        yield* db
          .insert(sessionChannelTokens)
          .values({ sessionId, tokenHash, createdAt: new Date(), revokedAt: null })
          .onConflictDoUpdate({
            target: sessionChannelTokens.sessionId,
            set: { tokenHash, createdAt: new Date(), revokedAt: null },
          })
          .pipe(Effect.orDie);
        return token;
      });

      const verify = Effect.fn("SessionChannelTokensRepo.verify")(function* (
        sessionId: string,
        token: string,
      ) {
        const rows = yield* db
          .select({ tokenHash: sessionChannelTokens.tokenHash })
          .from(sessionChannelTokens)
          .where(
            and(
              eq(sessionChannelTokens.sessionId, sessionId),
              isNull(sessionChannelTokens.revokedAt),
            ),
          )
          .limit(1)
          .pipe(Effect.orDie);
        const row = rows[0];
        if (row === undefined) return false;
        return constantTimeEquals(row.tokenHash, hashSessionChannelToken(token));
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

      return { issue, verify, revoke };
    }),
  );

/**
 * In-memory implementation with the same contract — for tests and for deployments that never
 * enable the network channel (no table traffic).
 */
export const SessionChannelTokensRepoMemory: Layer.Layer<SessionChannelTokensRepo> = Layer.sync(
  SessionChannelTokensRepo,
  () => {
    const hashes = new Map<string, string>();
    return {
      issue: (sessionId) =>
        Effect.sync(() => {
          const token = mintSessionChannelToken();
          hashes.set(sessionId, hashSessionChannelToken(token));
          return token;
        }),
      verify: (sessionId, token) =>
        Effect.sync(() => {
          const hash = hashes.get(sessionId);
          return hash !== undefined && constantTimeEquals(hash, hashSessionChannelToken(token));
        }),
      revoke: (sessionId) =>
        Effect.sync(() => {
          hashes.delete(sessionId);
        }),
    };
  },
);
