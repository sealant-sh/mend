import {
  SessionChannelTokensRepo,
  SessionChannelTokensRepoMemory,
  hashSessionChannelToken,
  mintSessionChannelToken,
} from "@mend/db";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

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
        expect(yield* repo.resolve(b)).toEqual({ sessionId: "sess-b", launchId: "launch-b1" });
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
        expect(yield* repo.resolve(first)).toEqual({ sessionId: "sess-a", launchId: "launch-1" });
        expect(yield* repo.resolve(retried)).toEqual({ sessionId: "sess-a", launchId: "launch-1" });
        expect(yield* repo.resolve(next)).toEqual({ sessionId: "sess-a", launchId: "launch-2" });
        yield* repo.revokeLaunch("launch-1");
        expect(yield* repo.resolve(first)).toBeNull();
        expect(yield* repo.resolve(retried)).toBeNull();
        expect(yield* repo.resolve(next)).toEqual({ sessionId: "sess-a", launchId: "launch-2" });
      }).pipe(Effect.provide(SessionChannelTokensRepoMemory)),
    );
  });
});
