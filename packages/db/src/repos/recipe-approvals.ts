import type { WorktreeId } from "@mend/domain";
import { type RecipeApproval, RecipeSpec } from "@mend/domain/workbench";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { recipeApprovals } from "../schema/workbench.ts";

export type NewRecipeApproval = Omit<RecipeApproval, "approvedAt">;

export class RecipeApprovalsRepo extends Context.Service<
  RecipeApprovalsRepo,
  {
    readonly approve: (
      worktreeId: WorktreeId,
      approvals: ReadonlyArray<NewRecipeApproval>,
    ) => Effect.Effect<void>;
    readonly forWorktree: (
      worktreeId: WorktreeId,
      approvedBy: string,
    ) => Effect.Effect<ReadonlyMap<string, RecipeApproval>>;
  }
>()("@mend/db/RecipeApprovalsRepo") {}

const encodeSpec = Schema.encodeSync(RecipeSpec);
const decodeSpec = Schema.decodeUnknownSync(RecipeSpec);

export const RecipeApprovalsRepoLive: Layer.Layer<RecipeApprovalsRepo, never, MendDB> =
  Layer.effect(
    RecipeApprovalsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;

      const approve = Effect.fn("RecipeApprovalsRepo.approve")(function* (
        worktreeId: WorktreeId,
        approvals: ReadonlyArray<NewRecipeApproval>,
      ) {
        if (approvals.length === 0) return;
        yield* db
          .insert(recipeApprovals)
          .values(
            approvals.map((approval) => ({
              worktreeId,
              serviceName: approval.serviceName,
              digest: approval.digest,
              approvedBy: approval.approvedBy,
              approvedAt: sql`now()`,
              spec: encodeSpec(approval.spec),
            })),
          )
          .onConflictDoUpdate({
            target: [
              recipeApprovals.worktreeId,
              recipeApprovals.serviceName,
              recipeApprovals.approvedBy,
            ],
            set: {
              digest: sql`excluded.digest`,
              approvedAt: sql`excluded.approved_at`,
              spec: sql`excluded.spec`,
            },
          });
      }, Effect.orDie);

      const forWorktree = Effect.fn("RecipeApprovalsRepo.forWorktree")(function* (
        worktreeId: WorktreeId,
        approvedBy: string,
      ) {
        const rows = yield* db
          .select()
          .from(recipeApprovals)
          .where(
            and(
              eq(recipeApprovals.worktreeId, worktreeId),
              eq(recipeApprovals.approvedBy, approvedBy),
            ),
          );
        return new Map(
          rows.map((row) => [
            row.serviceName,
            {
              serviceName: row.serviceName,
              digest: row.digest,
              approvedBy: row.approvedBy,
              approvedAt: row.approvedAt,
              spec: decodeSpec(row.spec),
            },
          ]),
        );
      }, Effect.orDie);

      return { approve, forWorktree };
    }),
  );
