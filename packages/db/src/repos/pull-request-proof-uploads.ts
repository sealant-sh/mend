import type { ChangeId, ProofArtifactId } from "@mend/domain";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { MendDB } from "../client.ts";
import { proofArtifacts, pullRequestProofUploads } from "../schema/workbench.ts";

/** A GitHub attachment belongs to the repository, and can be reused by later PR bodies. */
export type PullRequestProofUpload = typeof pullRequestProofUploads.$inferSelect;

export class PullRequestProofStorageError extends Schema.TaggedError<PullRequestProofStorageError>()(
  "PullRequestProofStorageError",
  { cause: Schema.Defect() },
) {}

export class PullRequestProofUploadsRepo extends Context.Service<
  PullRequestProofUploadsRepo,
  {
    readonly listForChange: (
      changeId: ChangeId,
      repository: string,
    ) => Effect.Effect<ReadonlyArray<PullRequestProofUpload>, PullRequestProofStorageError>;
    readonly record: (input: {
      readonly artifactId: ProofArtifactId;
      readonly repository: string;
      readonly url: string;
      readonly pullRequest: number;
      readonly uploadedBy: string;
    }) => Effect.Effect<void, PullRequestProofStorageError>;
  }
>()("@mend/db/PullRequestProofUploadsRepo") {}

export const PullRequestProofUploadsRepoLive: Layer.Layer<
  PullRequestProofUploadsRepo,
  never,
  MendDB
> = Layer.effect(
  PullRequestProofUploadsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const listForChange = Effect.fn("PullRequestProofUploadsRepo.listForChange")(
      function* (changeId: ChangeId, repository: string) {
        return yield* db
          .select({ upload: pullRequestProofUploads })
          .from(pullRequestProofUploads)
          .innerJoin(proofArtifacts, eq(proofArtifacts.id, pullRequestProofUploads.artifactId))
          .where(
            and(
              eq(proofArtifacts.changeId, changeId),
              eq(pullRequestProofUploads.repository, repository.toLowerCase()),
            ),
          )
          .pipe(Effect.map((rows) => rows.map((row) => row.upload)));
      },
      Effect.mapError((cause) => new PullRequestProofStorageError({ cause })),
    );
    const record = Effect.fn("PullRequestProofUploadsRepo.record")(
      function* (input: Parameters<typeof PullRequestProofUploadsRepo.Service.record>[0]) {
        yield* db
          .insert(pullRequestProofUploads)
          .values({ ...input, repository: input.repository.toLowerCase() })
          .onConflictDoNothing();
      },
      Effect.mapError((cause) => new PullRequestProofStorageError({ cause })),
    );
    return { listForChange, record };
  }),
);
