import { and, eq, lte, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { setupRuns } from "../schema/workbench.ts";

export type SetupClaim =
  | { readonly _tag: "Claimed"; readonly claimId: string }
  | { readonly _tag: "Done"; readonly finishedAt: Date }
  | {
      readonly _tag: "Failed";
      readonly exitCode: number | null;
      readonly outputTail: string | null;
      readonly finishedAt: Date;
    }
  | { readonly _tag: "Busy"; readonly fingerprint: string; readonly runsAs: string | null };

export interface SetupClaimRequest {
  readonly siteKey: string;
  readonly fingerprint: string;
  readonly runsAs: string | null;
  readonly retryFailed: boolean;
  readonly leaseMs: number;
}

/** Lease times are the database's clock, so two API processes' clocks never disagree about one. */
export class SetupRunsRepo extends Context.Service<
  SetupRunsRepo,
  {
    readonly claim: (request: SetupClaimRequest) => Effect.Effect<SetupClaim>;
    readonly renew: (claimId: string, leaseMs: number) => Effect.Effect<boolean>;
    readonly finish: (
      claimId: string,
      outcome: {
        readonly state: "done" | "failed";
        readonly exitCode: number | null;
        readonly outputTail: string;
      },
    ) => Effect.Effect<boolean>;
    readonly release: (claimId: string) => Effect.Effect<void>;
  }
>()("@mend/db/SetupRunsRepo") {}

const leaseEnd = (leaseMs: number) => sql`now() + ${leaseMs} * interval '1 millisecond'`;

const held = (claimId: string) =>
  and(eq(setupRuns.claimId, claimId), eq(setupRuns.state, "running"));

export const SetupRunsRepoLive: Layer.Layer<SetupRunsRepo, never, MendDB> = Layer.effect(
  SetupRunsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const claim = Effect.fn("SetupRunsRepo.claim")(function* (request: SetupClaimRequest) {
      const { siteKey, fingerprint } = request;
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`mend:setup:${siteKey}`}, 0))`,
          );
          yield* tx
            .delete(setupRuns)
            .where(
              and(
                eq(setupRuns.siteKey, siteKey),
                eq(setupRuns.state, "running"),
                lte(setupRuns.leaseUntil, sql`now()`),
              ),
            );
          const rows = yield* tx.select().from(setupRuns).where(eq(setupRuns.siteKey, siteKey));
          const running = rows.find((row) => row.state === "running");
          if (running !== undefined) {
            return {
              _tag: "Busy",
              fingerprint: running.fingerprint,
              runsAs: running.runsAs,
            } satisfies SetupClaim;
          }
          const stamp = rows.find((row) => row.fingerprint === fingerprint);
          if (stamp?.state === "done" && stamp.finishedAt !== null) {
            return { _tag: "Done", finishedAt: stamp.finishedAt } satisfies SetupClaim;
          }
          if (stamp?.state === "failed" && stamp.finishedAt !== null && !request.retryFailed) {
            return {
              _tag: "Failed",
              exitCode: stamp.exitCode,
              outputTail: stamp.outputTail,
              finishedAt: stamp.finishedAt,
            } satisfies SetupClaim;
          }
          // Once this run starts, no earlier run's stamp describes the directory.
          yield* tx.delete(setupRuns).where(eq(setupRuns.siteKey, siteKey));
          const claimId = crypto.randomUUID();
          const claimed = yield* tx
            .insert(setupRuns)
            .values({
              siteKey,
              fingerprint,
              state: "running",
              claimId,
              runsAs: request.runsAs,
              claimedAt: sql`now()`,
              leaseUntil: leaseEnd(request.leaseMs),
            })
            .onConflictDoNothing()
            .returning({ claimId: setupRuns.claimId });
          return claimed.length === 1
            ? ({ _tag: "Claimed", claimId } satisfies SetupClaim)
            : ({ _tag: "Busy", fingerprint, runsAs: null } satisfies SetupClaim);
        }),
      );
    }, Effect.orDie);

    const renew = Effect.fn("SetupRunsRepo.renew")(function* (claimId: string, leaseMs: number) {
      const rows = yield* db
        .update(setupRuns)
        .set({ leaseUntil: leaseEnd(leaseMs) })
        .where(held(claimId))
        .returning({ claimId: setupRuns.claimId });
      return rows.length === 1;
    }, Effect.orDie);

    const finish = Effect.fn("SetupRunsRepo.finish")(function* (
      claimId: string,
      outcome: {
        readonly state: "done" | "failed";
        readonly exitCode: number | null;
        readonly outputTail: string;
      },
    ) {
      const rows = yield* db
        .update(setupRuns)
        .set({
          state: outcome.state,
          finishedAt: sql`now()`,
          exitCode: outcome.exitCode,
          outputTail: outcome.outputTail,
        })
        .where(held(claimId))
        .returning({ claimId: setupRuns.claimId });
      return rows.length === 1;
    }, Effect.orDie);

    const release = Effect.fn("SetupRunsRepo.release")(function* (claimId: string) {
      yield* db.delete(setupRuns).where(held(claimId));
    }, Effect.orDie);

    return { claim, renew, finish, release };
  }),
);
