import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userGitAccess } from "../schema/workbench.ts";

/** The user-level git access choice: the mode new projects adopt with. */
export type GitAccessMode = "mend-key" | "bridge";

/**
 * Per-user git access default (docs/GIT-ACCESS.md). Identity, not instance settings: each
 * account decides whether its remotes sign with its Mend key on the server or with its own
 * machine's agent through the bridge.
 */
export class UserGitAccessRepo extends Context.Service<
  UserGitAccessRepo,
  {
    /** The user's choice; null when they never chose (callers treat that as mend-key). */
    readonly mode: (userId: string) => Effect.Effect<GitAccessMode | null>;
    readonly setMode: (userId: string, mode: GitAccessMode) => Effect.Effect<GitAccessMode>;
  }
>()("@mend/db/UserGitAccessRepo") {}

export const UserGitAccessRepoLive: Layer.Layer<UserGitAccessRepo, never, MendDB> = Layer.effect(
  UserGitAccessRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const mode = Effect.fn("UserGitAccessRepo.mode")(function* (userId: string) {
      const [row] = yield* db
        .select()
        .from(userGitAccess)
        .where(eq(userGitAccess.userId, userId))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : row.mode;
    });

    const setMode = Effect.fn("UserGitAccessRepo.setMode")(function* (
      userId: string,
      value: GitAccessMode,
    ) {
      yield* db
        .insert(userGitAccess)
        .values({ userId, mode: value })
        .onConflictDoUpdate({
          target: userGitAccess.userId,
          set: { mode: value, updatedAt: new Date() },
        })
        .pipe(Effect.orDie);
      return value;
    });

    return { mode, setMode };
  }),
);
