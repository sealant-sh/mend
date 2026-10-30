import { PgClient } from "@effect/sql-pg";
import { WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  type SetupClaim,
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

const PROJECT = "setup-runs-project";
const WORKTREE = WorktreeId.make("setup-runs-worktree");
const OTHER_WORKTREE = WorktreeId.make("setup-runs-other");

let sites = 0;
const request = (overrides: Partial<SetupClaimRequest> = {}): SetupClaimRequest => ({
  siteKey: `host:wt-${(sites += 1)}`,
  worktreeId: WORKTREE,
  workspaceId: "ws-1",
  fingerprint: "fp-a",
  runsAs: "alice",
  runAgain: "never",
  leaseMs: 60_000,
  fenced: null,
  ...overrides,
});

const claimed = (claim: SetupClaim) => {
  if (claim._tag !== "Claimed") throw new Error(`not claimed: ${claim._tag}`);
  return claim.claimId;
};

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
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'setup', '/store/p/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        for (const id of [WORKTREE, OTHER_WORKTREE]) {
          yield* sql`
            INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
            VALUES (${id}, ${PROJECT}, ${id}, ${id}, ${`mend/${id}`}, 'abc')`;
        }
      }),
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

  it("skips a done stamp, runs again once the fingerprint changes, on a return to an earlier one, and when asked to", async () => {
    const first = request();
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const stamped = yield* repo.finish(claimed(yield* repo.claim(first)), done);
        const again = yield* repo.claim(first);
        const changed = yield* repo.claim({ ...first, fingerprint: "fp-b" });
        yield* repo.finish(claimed(changed), done);
        const back = yield* repo.claim(first);
        yield* repo.finish(claimed(back), done);
        const asked = yield* repo.claim({ ...first, runAgain: "always" });
        return {
          stamped,
          again: again._tag,
          changed: changed._tag,
          back: back._tag,
          asked: asked._tag,
        };
      }),
    );
    expect(result).toEqual({
      stamped: true,
      again: "Done",
      changed: "Claimed",
      back: "Claimed",
      asked: "Claimed",
    });
  });

  it("never stamps a failure done: an automatic start is told, a person's runs it again", async () => {
    const site = request();
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        yield* repo.finish(claimed(yield* repo.claim(site)), failed);
        const automatic = yield* repo.claim(site);
        const person = yield* repo.claim({ ...site, runAgain: "after-failure" });
        return { automatic, person: person._tag };
      }),
    );
    expect(result.automatic).toMatchObject({
      _tag: "Failed",
      exitCode: 1,
      outputTail: "ERR_PNPM_OUTDATED_LOCKFILE",
    });
    expect(result.person).toBe("Claimed");
  });

  it("hands a lapsed claim's id and workspace to the next claimant, which claims once it has stopped that run", async () => {
    const site = request({ leaseMs: 300 });
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const lapsed = claimed(yield* repo.claim(site));
        yield* Effect.sleep("350 millis");
        const next = { ...site, workspaceId: "ws-2" };
        const unfenced = yield* repo.claim(next);
        const fenced = yield* repo.claim({ ...next, fenced: lapsed });
        return {
          lapsed,
          unfenced,
          fenced: fenced._tag,
          renewed: yield* repo.renew(lapsed, 60_000),
          stampedByLapsed: yield* repo.finish(lapsed, done),
          stillHeld: (yield* repo.claim(next))._tag,
        };
      }),
    );
    expect(result.unfenced).toEqual({ _tag: "Stale", claimId: result.lapsed, workspaceId: "ws-1" });
    expect(result).toMatchObject({
      fenced: "Claimed",
      renewed: false,
      stampedByLapsed: false,
      stillHeld: "Busy",
    });
  });

  it("never takes a lapsed claim over without its stop, however long ago it lapsed", async () => {
    const site = request({ leaseMs: 100 });
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        claimed(yield* repo.claim(site));
        yield* Effect.sleep("250 millis");
        return (yield* repo.claim({ ...site, workspaceId: "ws-2" }))._tag;
      }),
    );
    expect(result).toBe("Stale");
  });

  it("refuses a lapsed claim its stamp and its renewal even when nobody has claimed since", async () => {
    const site = request({ leaseMs: 100 });
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const claimId = claimed(yield* repo.claim(site));
        yield* Effect.sleep("150 millis");
        return {
          renewed: yield* repo.renew(claimId, 60_000),
          stamped: yield* repo.finish(claimId, done),
        };
      }),
    );
    expect(result).toEqual({ renewed: false, stamped: false });
  });

  it("keeps a renewed lease held, counts it in its workspace, and frees the site on release with no stamp", async () => {
    const site = request({ leaseMs: 2_000, workspaceId: "ws-counted" });
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const claimId = claimed(yield* repo.claim(site));
        // Renewed well inside the first lease, then read past it: a slow runner cannot let it
        // lapse before the renewal, and the read shows the renewal, not the first lease.
        const renewed = yield* repo.renew(claimId, 60_000);
        yield* Effect.sleep("2500 millis");
        const whileHeld = {
          claim: (yield* repo.claim(site))._tag,
          busy: yield* repo.busy(site.siteKey),
          inWorkspace: yield* repo.runningIn("ws-counted"),
        };
        yield* repo.release(claimId);
        const afterRelease = {
          busy: yield* repo.busy(site.siteKey),
          inWorkspace: yield* repo.runningIn("ws-counted"),
          claim: (yield* repo.claim(site))._tag,
        };
        return { renewed, whileHeld, afterRelease };
      }),
    );
    expect(result).toEqual({
      renewed: true,
      whileHeld: { claim: "Busy", busy: true, inWorkspace: 1 },
      afterRelease: { busy: false, inWorkspace: 0, claim: "Claimed" },
    });
  });

  it("takes back a claim's done stamp on discard, and only that claim's", async () => {
    const site = request();
    const other = request();
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const claimId = claimed(yield* repo.claim(site));
        yield* repo.finish(claimId, done);
        yield* repo.finish(claimed(yield* repo.claim(other)), done);
        yield* repo.discard(claimId);
        return { site: (yield* repo.claim(site))._tag, other: (yield* repo.claim(other))._tag };
      }),
    );
    expect(result).toEqual({ site: "Claimed", other: "Done" });
  });

  it("forgets a worktree's stamps when the worktree is removed", async () => {
    const site = request({ worktreeId: OTHER_WORKTREE });
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* SetupRunsRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* repo.finish(claimed(yield* repo.claim(site)), done);
        const before = (yield* repo.claim(site))._tag;
        yield* sql`DELETE FROM worktrees WHERE id = ${OTHER_WORKTREE}`;
        const rows = yield* sql`SELECT 1 FROM setup_runs WHERE site_key = ${site.siteKey}`;
        return { before, left: rows.length };
      }),
    );
    expect(result).toEqual({ before: "Done", left: 0 });
  });

  it("holds at most one running row per site in the table itself", async () => {
    const site = request();
    const error = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const insert = (fingerprint: string) => sql`
          INSERT INTO setup_runs (site_key, fingerprint, worktree_id, state, claim_id,
                                  workspace_id, claimed_at, lease_until)
          VALUES (${site.siteKey}, ${fingerprint}, ${WORKTREE}, 'running', gen_random_uuid(),
                  'ws-1', now(), now() + interval '1 minute')`;
        yield* insert("fp-a");
        return yield* insert("fp-b").pipe(Effect.flip);
      }),
    );
    expect(uniqueViolationConstraint(error)).toBe("setup_runs_one_running_idx");
  });
});
