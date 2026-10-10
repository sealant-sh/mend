import {
  SessionChannelTokensRepo,
  SessionChannelTokensRepoMemory,
  WRITE_TOKEN_TTL_MS,
  hashSessionChannelToken,
  mintSessionChannelToken,
} from "@mend/db";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("session channel tokens", () => {
  it("mints url-safe tokens and hashes them deterministically", () => {
    const token = mintSessionChannelToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashSessionChannelToken(token)).toBe(hashSessionChannelToken(token));
    expect(hashSessionChannelToken(token)).toHaveLength(64);
    expect(mintSessionChannelToken()).not.toBe(token);
  });

  it("scopes verification to the session, answers the launch, and revocation is final", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionChannelTokensRepo;
        const a = yield* repo.issue("sess-a", "launch-a1");
        const b = yield* repo.issue("sess-b", "launch-b1");
        expect(yield* repo.verify("sess-a", a)).toBe("launch-a1");
        expect(yield* repo.verify("sess-a", b)).toBeNull();
        expect(yield* repo.verify("sess-b", a)).toBeNull();
        expect(yield* repo.verify("sess-c", a)).toBeNull();
        expect(yield* repo.resolve(b)).toEqual({
          sessionId: "sess-b",
          launchId: "launch-b1",
          accountId: null,
          writeOnly: false,
        });
        yield* repo.revoke("sess-a");
        expect(yield* repo.verify("sess-a", a)).toBeNull();
        const a2 = yield* repo.issue("sess-a", "launch-a2");
        expect(yield* repo.verify("sess-a", a)).toBeNull();
        expect(yield* repo.verify("sess-a", a2)).toBe("launch-a2");
      }).pipe(Effect.provide(SessionChannelTokensRepoMemory)),
    );
  });

  it("a new launch never rotates another's token; each launch's tokens end with it (review 3 #5)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionChannelTokensRepo;
        const first = yield* repo.issue("sess-a", "launch-1");
        // The same create asked again under its key: a second token for that launch.
        const retried = yield* repo.issue("sess-a", "launch-1");
        const next = yield* repo.issue("sess-a", "launch-2");
        expect(yield* repo.resolve(first)).toEqual({
          sessionId: "sess-a",
          launchId: "launch-1",
          accountId: null,
          writeOnly: false,
        });
        expect(yield* repo.resolve(retried)).toEqual({
          sessionId: "sess-a",
          launchId: "launch-1",
          accountId: null,
          writeOnly: false,
        });
        expect(yield* repo.resolve(next)).toEqual({
          sessionId: "sess-a",
          launchId: "launch-2",
          accountId: null,
          writeOnly: false,
        });
        yield* repo.revokeLaunch("launch-1");
        expect(yield* repo.resolve(first)).toBeNull();
        expect(yield* repo.resolve(retried)).toBeNull();
        expect(yield* repo.resolve(next)).toEqual({
          sessionId: "sess-a",
          launchId: "launch-2",
          accountId: null,
          writeOnly: false,
        });
      }).pipe(Effect.provide(SessionChannelTokensRepoMemory)),
    );
  });

  describe("a one-off write's token (mend#615 review 3)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves as its person's, write-only, and nothing that revokes their tokens in bulk reaches it", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SessionChannelTokensRepo;
          const own = yield* repo.issuePerson("launch-1", "user-maria");
          const paste = yield* repo.issueWrite("launch-1", "user-maria");
          const other = yield* repo.issueWrite("launch-1", "user-maria");
          expect(yield* repo.resolve(paste)).toEqual({
            sessionId: "person-write:user-maria",
            launchId: "launch-1",
            accountId: "user-maria",
            writeOnly: true,
          });
          expect((yield* repo.resolve(own))?.writeOnly).toBe(false);
          // Her last process ended: her tokens go, her pastes' stay.
          yield* repo.revokePerson("launch-1", "user-maria", new Date(Date.now() + 1000));
          expect(yield* repo.resolve(own)).toBeNull();
          expect((yield* repo.resolve(paste))?.accountId).toBe("user-maria");
          // Its own write's end revokes it alone.
          yield* repo.revokeToken(paste);
          expect(yield* repo.resolve(paste)).toBeNull();
          expect((yield* repo.resolve(other))?.accountId).toBe("user-maria");
          // The launch's end takes every token of it.
          yield* repo.revokeLaunch("launch-1");
          expect(yield* repo.resolve(other)).toBeNull();
        }).pipe(Effect.provide(SessionChannelTokensRepoMemory)),
      );
    });

    it("lapses once its time is up, whatever became of its write", async () => {
      vi.useFakeTimers();
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SessionChannelTokensRepo;
          const paste = yield* repo.issueWrite("launch-1", "user-maria");
          const own = yield* repo.issuePerson("launch-1", "user-maria");
          vi.advanceTimersByTime(WRITE_TOKEN_TTL_MS - 1);
          expect((yield* repo.resolve(paste))?.writeOnly).toBe(true);
          vi.advanceTimersByTime(1);
          expect(yield* repo.resolve(paste)).toBeNull();
          // A person's own token has no such time.
          expect((yield* repo.resolve(own))?.accountId).toBe("user-maria");
        }).pipe(Effect.provide(SessionChannelTokensRepoMemory)),
      );
    });
  });
});
