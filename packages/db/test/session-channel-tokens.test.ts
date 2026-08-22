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

  it("scopes verification to the session, and revocation is final until re-issue", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionChannelTokensRepo;
        const a = yield* repo.issue("sess-a");
        const b = yield* repo.issue("sess-b");
        expect(yield* repo.verify("sess-a", a)).toBe(true);
        expect(yield* repo.verify("sess-a", b)).toBe(false);
        expect(yield* repo.verify("sess-b", a)).toBe(false);
        expect(yield* repo.verify("sess-c", a)).toBe(false);
        yield* repo.revoke("sess-a");
        expect(yield* repo.verify("sess-a", a)).toBe(false);
        const a2 = yield* repo.issue("sess-a");
        expect(yield* repo.verify("sess-a", a)).toBe(false);
        expect(yield* repo.verify("sess-a", a2)).toBe(true);
      }).pipe(Effect.provide(SessionChannelTokensRepoMemory)),
    );
  });
});
