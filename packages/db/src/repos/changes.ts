import { Change, ChangeId, type IssueId, type Sha } from "@mend/domain";
import { eq, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { changes } from "../schema/workbench.ts";

export class ChangeNotFoundError extends Schema.TaggedError<ChangeNotFoundError>()(
  "ChangeNotFoundError",
  {
    id: Schema.String,
  },
) {}

/**
 * The change is one per issue (ARCHITECTURE.md §3): one branch, at most one PR
 * carrying it. It appears with the first completed run and is the anchor the
 * living brief hangs off.
 */
export class ChangesRepo extends Context.Service<
  ChangesRepo,
  {
    /**
     * The issue's change, created on first call. Head facts are refreshed on
     * every call — each completed run moves the head the evidence describes.
     */
    readonly ensureForIssue: (
      issueId: IssueId,
      facts: {
        readonly branch: string;
        readonly baseSha: Sha | null;
        readonly headSha: Sha | null;
      },
    ) => Effect.Effect<Change>;
    readonly byId: (id: ChangeId) => Effect.Effect<Change, ChangeNotFoundError>;
    readonly byIssue: (issueId: IssueId) => Effect.Effect<Change, ChangeNotFoundError>;
  }
>()("@mend/db/ChangesRepo") {}

const toChange = (row: typeof changes.$inferSelect): Change => new Change(row);

export const ChangesRepoLive: Layer.Layer<ChangesRepo, never, MendDB> = Layer.effect(
  ChangesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const ensureForIssue = Effect.fn("ChangesRepo.ensureForIssue")(function* (
      issueId: IssueId,
      facts: {
        readonly branch: string;
        readonly baseSha: Sha | null;
        readonly headSha: Sha | null;
      },
    ) {
      const [row] = yield* db
        .insert(changes)
        .values({ id: ChangeId.make(crypto.randomUUID()), issueId, ...facts })
        .onConflictDoUpdate({
          target: changes.issueId,
          set: {
            branch: sql`CASE WHEN ${facts.branch} = '' THEN ${changes.branch} ELSE ${facts.branch} END`,
            baseSha: sql`COALESCE(${changes.baseSha}, ${facts.baseSha})`,
            headSha: sql`COALESCE(${facts.headSha}, ${changes.headSha})`,
            updatedAt: yield* DateTime.nowAsDate,
          },
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("change upsert returned no row");
      return toChange(row);
    });

    const byId = Effect.fn("ChangesRepo.byId")(function* (id: ChangeId) {
      const [row] = yield* db
        .select()
        .from(changes)
        .where(eq(changes.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new ChangeNotFoundError({ id });
      return toChange(row);
    });

    const byIssue = Effect.fn("ChangesRepo.byIssue")(function* (issueId: IssueId) {
      const [row] = yield* db
        .select()
        .from(changes)
        .where(eq(changes.issueId, issueId))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new ChangeNotFoundError({ id: issueId });
      return toChange(row);
    });

    return { ensureForIssue, byId, byIssue };
  }),
);
