import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  type SetupClaimRequest,
  SetupRunsRepo,
  SetupRunsRepoLive,
} from "../src/repos/setup-runs.ts";
import { uniqueViolationConstraint } from "../src/repos/unique-violation.ts";
import { postgresTestConfig } from "./postgres.ts";

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_setup_runs_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const reposLayer = SetupRunsRepoLive.pipe(
  Layer.provideMerge(
    MendDBLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl) }))),
  ),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, SetupRunsRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

let sites = 0;
const request = (overrides: Partial<SetupClaimRequest> = {}): SetupClaimRequest => ({
  siteKey: `host:/store/p/worktrees/wt-${(sites += 1)}`,
  fingerprint: "fp-a",
  runsAs: "alice",
  retryFailed: false,
  leaseMs: 60_000,
  ...overrides,
});

const failed = { state: "failed", exitCode: 1, outputTail: "ERR_PNPM_OUTDATED_LOCKFILE" } as const;
const done = { state: "done", exitCode: 0, outputTail: "" } as const;

describe.skipIf(postgres.skip)("setup_runs: the claim and stamp of a site's setup", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.forEach(
        Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
        ([, migration]) => migration,
        { discard: true },
      ),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("gives one of many concurrent claims the run, whatever fingerprint each read", async () => {
    const same = request();
    const results = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const sameFingerprint = yield* Effect.all(
          Array.from({ length: 8 }, () => repo.claim(same)),
          { concurrency: "unbounded" },
        );
        const site = request();
        const mixed = yield* Effect.all(
          ["fp-a", "fp-b", "fp-c", "fp-d"].map((fingerprint) =>
            repo.claim({ ...site, fingerprint }),
          ),
          { concurrency: "unbounded" },
        );
        return { sameFingerprint, mixed };
      }),
    );
    for (const claims of [results.sameFingerprint, results.mixed]) {
      expect(claims.filter((claim) => claim._tag === "Claimed")).toHaveLength(1);
      expect(claims.filter((claim) => claim._tag === "Busy")).toHaveLength(claims.length - 1);
    }
  });

  it("skips a done stamp, runs again once the fingerprint changes, and again on a return to an earlier one", async () => {
    const first = request();
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const claimed = yield* repo.claim(first);
        if (claimed._tag !== "Claimed") throw new Error(`claimed: ${claimed._tag}`);
        const stamped = yield* repo.finish(claimed.claimId, done);
        const again = yield* repo.claim(first);
        const changed = yield* repo.claim({ ...first, fingerprint: "fp-b" });
        if (changed._tag !== "Claimed") throw new Error(`changed: ${changed._tag}`);
        yield* repo.finish(changed.claimId, done);
        const back = yield* repo.claim(first);
        return { stamped, again: again._tag, changed: changed._tag, back: back._tag };
      }),
    );
    expect(result).toEqual({
      stamped: true,
      again: "Done",
      changed: "Claimed",
      back: "Claimed",
    });
  });

  it("never stamps a failure done: an automatic start is told, an explicit one runs it again", async () => {
    const site = request();
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const claimed = yield* repo.claim(site);
        if (claimed._tag !== "Claimed") throw new Error(`claimed: ${claimed._tag}`);
        yield* repo.finish(claimed.claimId, failed);
        const automatic = yield* repo.claim(site);
        const explicit = yield* repo.claim({ ...site, retryFailed: true });
        return { automatic, explicit: explicit._tag };
      }),
    );
    expect(result.automatic).toMatchObject({
      _tag: "Failed",
      exitCode: 1,
      outputTail: "ERR_PNPM_OUTDATED_LOCKFILE",
    });
    expect(result.explicit).toBe("Claimed");
  });

  it("lets an expired lease be claimed again, and leaves the old claimant nothing to stamp", async () => {
    const site = request({ leaseMs: 1 });
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const stale = yield* repo.claim(site);
        if (stale._tag !== "Claimed") throw new Error(`stale: ${stale._tag}`);
        yield* Effect.sleep("20 millis");
        const fresh = yield* repo.claim({ ...site, leaseMs: 60_000 });
        if (fresh._tag !== "Claimed") throw new Error(`fresh: ${fresh._tag}`);
        return {
          renewed: yield* repo.renew(stale.claimId, 60_000),
          stampedByStale: yield* repo.finish(stale.claimId, done),
          stillHeld: (yield* repo.claim(site))._tag,
        };
      }),
    );
    expect(result).toEqual({ renewed: false, stampedByStale: false, stillHeld: "Busy" });
  });

  it("keeps a renewed lease held, and frees the site on release with no stamp", async () => {
    const site = request({ leaseMs: 200 });
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const claimed = yield* repo.claim(site);
        if (claimed._tag !== "Claimed") throw new Error(`claimed: ${claimed._tag}`);
        yield* Effect.sleep("150 millis");
        const renewed = yield* repo.renew(claimed.claimId, 60_000);
        yield* Effect.sleep("100 millis");
        const whileHeld = (yield* repo.claim(site))._tag;
        yield* repo.release(claimed.claimId);
        const afterRelease = (yield* repo.claim(site))._tag;
        return { renewed, whileHeld, afterRelease };
      }),
    );
    expect(result).toEqual({ renewed: true, whileHeld: "Busy", afterRelease: "Claimed" });
  });

  it("holds at most one running row per site in the table itself", async () => {
    const site = request();
    const error = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const insert = (fingerprint: string) => sql`
          INSERT INTO setup_runs (site_key, fingerprint, state, claim_id, claimed_at, lease_until)
          VALUES (${site.siteKey}, ${fingerprint}, 'running', gen_random_uuid(), now(),
                  now() + interval '1 minute')`;
        yield* insert("fp-a");
        return yield* insert("fp-b").pipe(Effect.flip);
      }),
    );
    expect(uniqueViolationConstraint(error)).toBe("setup_runs_one_running_idx");
  });
});
