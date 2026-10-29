import type { WorktreeId } from "@mend/domain";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { setupRuns } from "../schema/workbench.ts";

/**
 * When a site's earlier result runs it again: an automatic start `never` does, a person's
 * start after a failure, and a start that asks for setup `always`.
 */
export type SetupRunAgain = "never" | "after-failure" | "always";

export interface SetupClaimRequest {
  readonly siteKey: string;
  readonly worktreeId: WorktreeId;
  /** The workspace this claimant's run starts its processes in. */
  readonly workspaceId: string;
  readonly fingerprint: string;
  readonly runsAs: string | null;
  readonly runAgain: SetupRunAgain;
  readonly leaseMs: number;
  /** A lapsed claim whose processes this claimant has stopped (`Stale`): it holds nothing now. */
  readonly fenced: string | null;
}

export type SetupClaim =
  | { readonly _tag: "Claimed"; readonly claimId: string }
  | { readonly _tag: "Done"; readonly finishedAt: Date }
  | {
      readonly _tag: "Failed";
      readonly exitCode: number | null;
      readonly outputTail: string | null;
      readonly finishedAt: Date;
    }
  /** A run whose lease holds is under way here. */
  | { readonly _tag: "Busy" }
  /**
   * A run whose lease lapsed, which nobody has confirmed stopped: stop its processes, or learn its
   * workspace is gone, then claim again naming it in `fenced`. It is never taken over without
   * that, however long ago it lapsed: a lease cannot stop a command still running.
   */
  | { readonly _tag: "Stale"; readonly claimId: string; readonly workspaceId: string };

export interface SetupRunRow {
  readonly fingerprint: string;
  readonly state: "running" | "done" | "failed";
  readonly claimId: string;
  readonly workspaceId: string;
  /** How long ago its lease ran out, by the store's clock: negative while it holds. */
  readonly lapsedMs: number;
  readonly finishedAt: Date | null;
  readonly exitCode: number | null;
  readonly outputTail: string | null;
}

/**
 * What a claim of `request` gets from the site's rows, or `Claim`: replace every row of the site
 * with a running one of the claimant's.
 */
export const decideSetupClaim = (
  rows: ReadonlyArray<SetupRunRow>,
  request: SetupClaimRequest,
): Exclude<SetupClaim, { readonly _tag: "Claimed" }> | { readonly _tag: "Claim" } => {
  const running = rows.find((row) => row.state === "running");
  if (running !== undefined) {
    if (running.lapsedMs < 0) return { _tag: "Busy" };
    if (running.claimId !== request.fenced) {
      return { _tag: "Stale", claimId: running.claimId, workspaceId: running.workspaceId };
    }
  }
  const stamp = rows.find((row) => row.fingerprint === request.fingerprint);
  if (stamp?.state === "done" && stamp.finishedAt !== null && request.runAgain !== "always") {
    return { _tag: "Done", finishedAt: stamp.finishedAt };
  }
  if (stamp?.state === "failed" && stamp.finishedAt !== null && request.runAgain === "never") {
    return {
      _tag: "Failed",
      exitCode: stamp.exitCode,
      outputTail: stamp.outputTail,
      finishedAt: stamp.finishedAt,
    };
  }
  return { _tag: "Claim" };
};

export interface SetupOutcome {
  readonly state: "done" | "failed";
  readonly exitCode: number | null;
  readonly outputTail: string;
}

/**
 * Lease times are the database's clock, so two API processes' clocks never disagree about one.
 * A claim is held while its row is running under it and its lease has not lapsed: `renew` and
 * `finish` answer false once it is not.
 */
export class SetupRunsRepo extends Context.Service<
  SetupRunsRepo,
  {
    readonly claim: (request: SetupClaimRequest) => Effect.Effect<SetupClaim>;
    /** Whether a run whose lease holds is under way at the site. */
    readonly busy: (siteKey: string) => Effect.Effect<boolean>;
    /** How many runs whose leases hold have their processes in the workspace. */
    readonly runningIn: (workspaceId: string) => Effect.Effect<number>;
    readonly renew: (claimId: string, leaseMs: number) => Effect.Effect<boolean>;
    readonly finish: (claimId: string, outcome: SetupOutcome) => Effect.Effect<boolean>;
    readonly release: (claimId: string) => Effect.Effect<void>;
  }
>()("@mend/db/SetupRunsRepo") {}

const leaseEnd = (leaseMs: number) => sql`now() + ${leaseMs} * interval '1 millisecond'`;

const running = eq(setupRuns.state, "running");
const leaseHolds = gt(setupRuns.leaseUntil, sql`now()`);
const held = (claimId: string) => and(eq(setupRuns.claimId, claimId), running, leaseHolds);

export const SetupRunsRepoLive: Layer.Layer<SetupRunsRepo, never, MendDB> = Layer.effect(
  SetupRunsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const claim = Effect.fn("SetupRunsRepo.claim")(function* (request: SetupClaimRequest) {
      const { siteKey } = request;
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`mend:setup:${siteKey}`}, 0))`,
          );
          const rows = yield* tx
            .select({
              fingerprint: setupRuns.fingerprint,
              state: setupRuns.state,
              claimId: setupRuns.claimId,
              workspaceId: setupRuns.workspaceId,
              lapsedMs: sql`extract(epoch from now() - ${setupRuns.leaseUntil}) * 1000`.mapWith(
                Number,
              ),
              finishedAt: setupRuns.finishedAt,
              exitCode: setupRuns.exitCode,
              outputTail: setupRuns.outputTail,
            })
            .from(setupRuns)
            .where(eq(setupRuns.siteKey, siteKey));
          const decided = decideSetupClaim(rows, request);
          if (decided._tag !== "Claim") return decided;
          // Once this run starts, no earlier run's stamp describes the directory.
          yield* tx.delete(setupRuns).where(eq(setupRuns.siteKey, siteKey));
          const claimId = crypto.randomUUID();
          yield* tx.insert(setupRuns).values({
            siteKey,
            fingerprint: request.fingerprint,
            worktreeId: request.worktreeId,
            state: "running",
            claimId,
            workspaceId: request.workspaceId,
            runsAs: request.runsAs,
            claimedAt: sql`now()`,
            leaseUntil: leaseEnd(request.leaseMs),
          });
          return { _tag: "Claimed", claimId } satisfies SetupClaim;
        }),
      );
    }, Effect.orDie);

    const busy = Effect.fn("SetupRunsRepo.busy")(function* (siteKey: string) {
      const rows = yield* db
        .select({ claimId: setupRuns.claimId })
        .from(setupRuns)
        .where(and(eq(setupRuns.siteKey, siteKey), running, leaseHolds))
        .limit(1);
      return rows.length > 0;
    }, Effect.orDie);

    const runningIn = Effect.fn("SetupRunsRepo.runningIn")(function* (workspaceId: string) {
      const [row] = yield* db
        .select({ n: count() })
        .from(setupRuns)
        .where(and(eq(setupRuns.workspaceId, workspaceId), running, leaseHolds));
      return row?.n ?? 0;
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
      outcome: SetupOutcome,
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
      yield* db.delete(setupRuns).where(and(eq(setupRuns.claimId, claimId), running));
    }, Effect.orDie);

    return { claim, busy, runningIn, renew, finish, release };
  }),
);
