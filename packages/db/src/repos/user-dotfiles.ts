import { DotfilesRepository } from "@mend/domain";
import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userDotfiles } from "../schema/workbench.ts";

/**
 * Per-user dotfiles configuration. Dotfiles are identity, not instance settings: each account
 * carries its own repository knob here, and its own snapshot content in the dotfiles store (a
 * bare git repo per user under the store root — never in the database).
 */
export class UserDotfilesRepo extends Context.Service<
  UserDotfilesRepo,
  {
    /** The user's dotfiles repository config; null when none is set. */
    readonly repository: (userId: string) => Effect.Effect<DotfilesRepository | null>;
    readonly setRepository: (
      userId: string,
      repository: DotfilesRepository | null,
    ) => Effect.Effect<DotfilesRepository | null>;
  }
>()("@mend/db/UserDotfilesRepo") {}

const decodeRepository = Schema.decodeUnknownSync(DotfilesRepository);

export const UserDotfilesRepoLive: Layer.Layer<UserDotfilesRepo, never, MendDB> = Layer.effect(
  UserDotfilesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const repository = Effect.fn("UserDotfilesRepo.repository")(function* (userId: string) {
      const [row] = yield* db
        .select()
        .from(userDotfiles)
        .where(eq(userDotfiles.userId, userId))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined || row.repository === null) return null;
      return decodeRepository(row.repository);
    });

    const setRepository = Effect.fn("UserDotfilesRepo.setRepository")(function* (
      userId: string,
      value: DotfilesRepository | null,
    ) {
      yield* db
        .insert(userDotfiles)
        .values({ userId, repository: value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: userDotfiles.userId,
          set: { repository: value, updatedAt: new Date() },
        })
        .pipe(Effect.orDie);
      return value;
    });

    return { repository, setRepository };
  }),
);
