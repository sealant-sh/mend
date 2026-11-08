import type { ChangeId } from "@mend/domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { MendDatabase } from "../client.ts";
import { worktreeChanges } from "../schema/workbench.ts";
import { isForeignKeyViolation } from "./unique-violation.ts";

/** Discard a late write only when its foreign-key failure belongs to a deleted change. */
export const ignoreDeletedChange =
  (db: MendDatabase, changeId: ChangeId) =>
  <A, E, R>(write: Effect.Effect<A, E, R>): Effect.Effect<A | undefined, E, R> =>
    write.pipe(
      Effect.catch((cause) => {
        if (!isForeignKeyViolation(cause)) return Effect.fail(cause);
        return db
          .select({ id: worktreeChanges.id })
          .from(worktreeChanges)
          .where(eq(worktreeChanges.id, changeId))
          .limit(1)
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) =>
              rows.length === 0 ? Effect.succeed(undefined) : Effect.fail(cause),
            ),
          );
      }),
    );
