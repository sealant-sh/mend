import { PgClient } from "@effect/sql-pg";
import { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { Deferred, Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import {
  isRemovalFenced,
  isRemovalStopped,
  RemovalFencesRepo,
  RemovalFencesRepoLive,
} from "../src/repos/removal-fences.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_removal_fences_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = RemovalFencesRepoLive.pipe(Layer.provideMerge(scratchLayer));

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, RemovalFencesRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));

const PROJECT = ProjectId.make("p-1");
const WORKTREE = WorktreeId.make("w-1");
const worktreeRow = { kind: "worktree", id: WORKTREE } as const;
const projectRow = { kind: "project", id: PROJECT } as const;

const insertSession = (id: string, owner: string | null, worktree = "w-1") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO agent_sessions
        (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id)
      VALUES (${id}, 'p-1', ${worktree}, 'claude', ${worktree}, 'mend/fix', 'abc', ${owner})`;
  });

const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => Exit.isFailure(exit) && isRemovalFenced(exit.cause)),
  );

/** What a start refused by a mark was told: a removal at work, or one that stopped partway. */
const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? "admitted"
        : isRemovalStopped(exit.cause)
          ? "stopped"
          : isRemovalFenced(exit.cause)
            ? "under way"
            : "failed",
    ),
  );

const changeOwner = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly owner: string | null }>`
    SELECT change_owner_user_id AS owner FROM worktrees WHERE id = 'w-1'`;
  return row?.owner ?? null;
});

const ownerRecord = (worktree: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      readonly owner: string | null;
      readonly recorded: boolean;
      readonly proven: boolean;
    }>`
      SELECT change_owner_user_id AS owner, change_owner_recorded AS recorded,
             change_owner_proven AS proven
      FROM worktrees WHERE id = ${worktree}`;
    return row;
  });

/** Migration 0164's lease, as `removal_fence_fresh` holds it. */
const LEASE_SECONDS = 120;
const secondsAgo = (seconds: number) => `${seconds} seconds`;
const age = (table: "worktrees" | "projects", id: string, seconds: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE ${sql(table)} SET removal_since = now() - ${secondsAgo(seconds)}::interval
      WHERE id = ${id}`;
  });

describe.skipIf(postgres.skip)("removal fences (migration 0164)", () => {
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
  beforeEach(async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM projects`;
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-1', 'Acme') ON CONFLICT DO NOTHING`;
        yield* sql`
          INSERT INTO projects (id, name, organization_id, store_path, default_branch)
          VALUES ('p-1', 'api', 'org-1', '/store/api/repo.git', 'main')`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('w-1', 'p-1', 'fix', 'fix', 'mend/fix', 'abc'),
                 ('w-2', 'p-1', 'other', 'other', 'mend/other', 'abc')`;
      }),
    );
  });

  it("gives the change to the first session's owner and keeps it when that session goes", async () => {
    const owners = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const before = yield* changeOwner;
        yield* insertSession("s-1", "anna");
        yield* insertSession("s-2", "kostas");
        yield* sql`DELETE FROM agent_sessions WHERE id = 's-1'`;
        yield* insertSession("s-3", "kostas");
        return { before, after: yield* changeOwner };
      }),
    );
    expect(owners).toEqual({ before: null, after: "anna" });
  });

  it("gives an ownerless first session's change to nobody", async () => {
    const owner = await run(
      Effect.gen(function* () {
        yield* insertSession("s-1", null);
        yield* insertSession("s-2", "kostas");
        return yield* changeOwner;
      }),
    );
    expect(owner).toBeNull();
  });

  it("refuses a session start while a removal checks, and admits it once the removal is refused", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const fences = yield* RemovalFencesRepo;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        const whileChecking = yield* refused(insertSession("s-1", "anna"));
        const admitted = yield* fences.admitsStart({ projectId: PROJECT, worktreeId: WORKTREE });
        const otherWorktree = yield* refused(insertSession("s-2", "anna", "w-2"));
        yield* fences.release(worktreeRow, taken.id);
        const afterRelease = yield* refused(insertSession("s-1", "anna"));
        return { whileChecking, admitted, otherWorktree, afterRelease };
      }),
    );
    expect(outcome).toEqual({
      whileChecking: true,
      admitted: false,
      otherWorktree: false,
      afterRelease: false,
    });
  });

  it("refuses a resumed session and a new worktree in a project being removed", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        yield* insertSession("s-1", "anna");
        yield* sql`UPDATE agent_sessions SET status = 'completed' WHERE id = 's-1'`;
        yield* insertSession("s-2", "anna", "w-2");
        const taken = yield* fences.take(projectRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        const resumed = yield* refused(
          sql`UPDATE agent_sessions SET status = 'running' WHERE id = 's-1'`,
        );
        const liveKeepsGoing = yield* refused(
          sql`UPDATE agent_sessions SET status = 'idle' WHERE id = 's-2'`,
        );
        const newWorktree = yield* refused(sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('w-3', 'p-1', 'new', 'new', 'mend/new', 'abc')`);
        const stops = yield* refused(
          sql`UPDATE agent_sessions SET status = 'stopping' WHERE id = 's-2'`,
        );
        return { resumed, liveKeepsGoing, newWorktree, stops };
      }),
    );
    expect(outcome).toEqual({
      resumed: true,
      liveKeepsGoing: false,
      newWorktree: true,
      stops: false,
    });
  });

  it("lets one removal hold the mark, finishes a stopped deletion, and takes over a quiet check", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        const first = yield* fences.take(worktreeRow);
        if (first._tag !== "held") return yield* Effect.die("fence not taken");
        const second = yield* fences.take(worktreeRow);
        const ago = `${LEASE_SECONDS + 5} seconds`;
        yield* sql`UPDATE worktrees SET removal_since = now() - ${ago}::interval WHERE id = 'w-1'`;
        const takeover = yield* fences.take(worktreeRow);
        if (takeover._tag !== "held") return yield* Effect.die("stale check not taken over");
        const lateCommit = yield* fences.commit(worktreeRow, first.id);
        yield* fences.release(worktreeRow, first.id);
        const stillHeld = !(yield* fences.admitsStart({
          projectId: PROJECT,
          worktreeId: WORKTREE,
        }));
        const committed = yield* fences.commit(worktreeRow, takeover.id);
        yield* sql`UPDATE worktrees SET removal_since = now() - ${ago}::interval WHERE id = 'w-1'`;
        const deletingStillRefuses = yield* refused(insertSession("s-1", "anna"));
        const resumed = yield* fences.take(worktreeRow);
        const gone = yield* fences.take({ kind: "worktree", id: WorktreeId.make("w-missing") });
        return {
          second: second._tag,
          lateCommit,
          stillHeld,
          committed,
          deletingStillRefuses,
          resumed: resumed._tag === "finish" && resumed.id !== takeover.id,
          gone: gone._tag,
        };
      }),
    );
    expect(outcome).toEqual({
      second: "underway",
      lateCommit: false,
      stillHeld: true,
      committed: true,
      deletingStillRefuses: true,
      resumed: true,
      gone: "gone",
    });
  });

  it("hands a deletion that failed partway to the next removal at once, still refusing starts", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const fences = yield* RemovalFencesRepo;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        yield* fences.commit(worktreeRow, taken.id);
        const beforeHandOver = yield* fences.take(worktreeRow);
        yield* fences.handOver(worktreeRow, taken.id);
        const startRefused = yield* refused(insertSession("s-1", "anna"));
        const next = yield* fences.take(worktreeRow);
        return {
          beforeHandOver: beforeHandOver._tag,
          startRefused,
          next: next._tag === "finish" && next.id !== taken.id,
        };
      }),
    );
    expect(outcome).toEqual({ beforeHandOver: "underway", startRefused: true, next: true });
  });

  it("makes a removal that comes during a session insert wait for it, then see it", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        const inserted = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const start = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* insertSession("s-1", "anna");
              yield* Deferred.succeed(inserted, undefined);
              yield* Deferred.await(finish);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(inserted);
        const removal = yield* fences.take(worktreeRow).pipe(Effect.forkChild);
        yield* Effect.sleep("300 millis");
        const waited = removal.pollUnsafe() === undefined;
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(start);
        const taken = yield* Fiber.join(removal);
        const [seen] = yield* sql<{ readonly status: string }>`
          SELECT status FROM agent_sessions WHERE id = 's-1'`;
        return { waited, taken: taken._tag, seen: seen?.status };
      }),
    );
    expect(outcome).toEqual({ waited: true, taken: "held", seen: "starting" });
  });

  it("records an ownerless first session's owner as nobody, which no later session claims", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertSession("s-1", null);
        yield* sql`DELETE FROM agent_sessions WHERE id = 's-1'`;
        yield* insertSession("s-2", "kostas");
        return yield* ownerRecord("w-1");
      }),
    );
    expect(outcome).toEqual({ owner: null, recorded: true, proven: false });
  });

  it("proves a new worktree's first owner, and never rewrites a recorded one", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertSession("s-1", "anna");
        const rewrite = yield* sql`
          UPDATE worktrees SET change_owner_user_id = 'kostas' WHERE id = 'w-1'`.pipe(
          Effect.exit,
          Effect.map(Exit.isFailure),
        );
        return { record: yield* ownerRecord("w-1"), rewrite };
      }),
    );
    expect(outcome).toEqual({
      record: { owner: "anna", recorded: true, proven: true },
      rewrite: true,
    });
  });

  it("does not prove a first owner the history cannot vouch for", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO worktree_owner_gaps (worktree_id) VALUES ('w-1')`;
        yield* sql`INSERT INTO worktree_session_owners (worktree_id, user_id) VALUES ('w-2', 'anna')`;
        yield* insertSession("s-1", "kostas");
        yield* insertSession("s-2", "kostas", "w-2");
        return { gap: yield* ownerRecord("w-1"), other: yield* ownerRecord("w-2") };
      }),
    );
    expect(outcome).toEqual({
      gap: { owner: "kostas", recorded: true, proven: false },
      other: { owner: "kostas", recorded: true, proven: false },
    });
  });

  it("gives a stopped deletion to one removal at a time", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        yield* fences.commit(worktreeRow, taken.id);
        const stale = secondsAgo(LEASE_SECONDS + 5);
        yield* sql`UPDATE worktrees SET removal_since = now() - ${stale}::interval WHERE id = 'w-1'`;
        const [first, second] = yield* Effect.all(
          [fences.take(worktreeRow), fences.take(worktreeRow)],
          { concurrency: 2 },
        );
        return [first._tag, second._tag].toSorted();
      }),
    );
    expect(outcome).toEqual(["finish", "underway"]);
  });

  it("makes a project's removal and its worktree's see each other", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const fences = yield* RemovalFencesRepo;
        const worktree = yield* fences.take(worktreeRow);
        if (worktree._tag !== "held") return yield* Effect.die("fence not taken");
        const projectWhileWorktree = yield* fences.take(projectRow);
        yield* fences.release(worktreeRow, worktree.id);
        const project = yield* fences.take(projectRow);
        if (project._tag !== "held") return yield* Effect.die("project fence not taken");
        const worktreeWhileProject = yield* fences.take(worktreeRow);
        return {
          projectWhileWorktree: projectWhileWorktree._tag,
          worktreeWhileProject: worktreeWhileProject._tag,
        };
      }),
    );
    expect(outcome).toEqual({ projectWhileWorktree: "underway", worktreeWhileProject: "underway" });
  });

  it("keeps a check that outlives the lease able to commit while it renews its mark", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        const nearlyStale = secondsAgo(LEASE_SECONDS - 2);
        yield* sql`UPDATE worktrees SET removal_since = now() - ${nearlyStale}::interval WHERE id = 'w-1'`;
        const renewed = yield* fences.renew(worktreeRow, taken.id);
        yield* sql`UPDATE worktrees SET removal_since = removal_since - interval '10 seconds' WHERE id = 'w-1'`;
        const committed = yield* fences.commit(worktreeRow, taken.id);
        return { renewed, committed };
      }),
    );
    expect(outcome).toEqual({ renewed: true, committed: true });
  });

  it("refuses a shell, a Service, a forward and an added repository while a removal checks", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        yield* insertSession("s-1", "anna");
        yield* sql`UPDATE agent_sessions SET status = 'completed' WHERE id = 's-1'`;
        yield* sql`
          INSERT INTO services (id, session_id, name, declaration_source, workspace_port)
          VALUES ('svc-1', 's-1', 'web', 'recipe', 3000)`;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        const process = (id: string, kind: string) => sql`
          INSERT INTO session_processes (id, session_id, sealant_workspace_id, sealant_session_id, kind)
          VALUES (${id}, 's-1', 'ws-1', 'pty', ${kind})`;
        const shell = yield* refused(process("p-shell", "shell"));
        const service = yield* refused(process("p-service", "service"));
        const observed = yield* refused(process("p-observed", "agent-external"));
        const forward = yield* refused(sql`
          INSERT INTO service_forwards (id, service_id, sealant_workspace_id)
          VALUES ('fwd-1', 'svc-1', 'ws-1')`);
        const repository = yield* refused(sql`
          INSERT INTO session_repositories
            (id, session_id, project_id, worktree_id, name, path, branch, base_sha, capture, source)
          VALUES ('r-1', 's-1', 'p-1', 'w-2', 'lib', 'lib', 'mend/other', 'abc', 'own', 'store')`);
        const admitted = !(yield* refused(fences.admit(SessionId.make("s-1"))));
        return { shell, service, observed, forward, repository, admitted };
      }),
    );
    expect(outcome).toEqual({
      shell: true,
      service: true,
      observed: false,
      forward: true,
      repository: true,
      admitted: false,
    });
  });

  it("refuses a session of another worktree that holds the marked one as a repository", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        yield* sql`
          INSERT INTO projects (id, name, organization_id, store_path, default_branch)
          VALUES ('p-2', 'web', 'org-1', '/store/web/repo.git', 'main')`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('w-b', 'p-2', 'b', 'b', 'mend/b', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id)
          VALUES ('s-b', 'p-2', 'w-b', 'claude', 'b', 'mend/b', 'abc', 'anna')`;
        yield* sql`
          INSERT INTO session_repositories
            (id, session_id, project_id, worktree_id, name, path, branch, base_sha, capture, source)
          VALUES ('r-1', 's-b', 'p-1', 'w-1', 'api', 'api', 'mend/fix', 'abc', 'own', 'store')`;
        yield* sql`UPDATE agent_sessions SET status = 'completed' WHERE id = 's-b'`;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        const resumed = yield* refused(
          sql`UPDATE agent_sessions SET status = 'running' WHERE id = 's-b'`,
        );
        const admitted = !(yield* refused(fences.admit(SessionId.make("s-b"))));
        yield* fences.release(worktreeRow, taken.id);
        const afterRelease = yield* refused(
          sql`UPDATE agent_sessions SET status = 'running' WHERE id = 's-b'`,
        );
        return { resumed, admitted, afterRelease };
      }),
    );
    expect(outcome).toEqual({ resumed: true, admitted: false, afterRelease: false });
  });

  it("refuses a standby made or claimed in a project being removed", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        yield* sql`
          INSERT INTO hot_workspaces (id, project_id, owner_user_id, status, fingerprint)
          VALUES ('hot-1', 'p-1', 'anna', 'ready', 'f')`;
        const taken = yield* fences.take(projectRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        const made = yield* refused(sql`
          INSERT INTO hot_workspaces (id, project_id, owner_user_id, status, fingerprint)
          VALUES ('hot-2', 'p-1', 'anna', 'warming', 'f')`);
        const claimed = yield* refused(
          sql`UPDATE hot_workspaces SET status = 'claimed' WHERE id = 'hot-1'`,
        );
        return { made, claimed };
      }),
    );
    expect(outcome).toEqual({ made: true, claimed: true });
  });

  it("keeps a nested repository's record after the session that added it is deleted", async () => {
    const kept = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertSession("s-1", "anna");
        yield* sql`
          INSERT INTO session_repositories
            (id, session_id, project_id, worktree_id, name, path, branch, base_sha, capture, source)
          VALUES ('r-1', 's-1', 'p-1', 'w-2', 'lib', 'repos/lib', 'mend/other', 'abc', 'nested', 'origin')`;
        yield* sql`UPDATE session_repositories SET state = 'ready' WHERE id = 'r-1'`;
        yield* sql`DELETE FROM agent_sessions WHERE id = 's-1'`;
        return yield* sql<{ readonly path: string; readonly branch: string }>`
          SELECT path, branch FROM worktree_nested_repositories WHERE worktree_id = 'w-1'`;
      }),
    );
    expect(kept).toEqual([{ path: "repos/lib", branch: "mend/other" }]);
  });

  it("keeps a nested repository only once its add finished", async () => {
    const recorded = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertSession("s-1", "anna");
        const nested = (id: string, path: string) => sql`
          INSERT INTO session_repositories
            (id, session_id, project_id, worktree_id, name, path, branch, base_sha, capture, source)
          VALUES (${id}, 's-1', 'p-1', ${id === "r-1" ? "w-2" : "w-1"}, ${id}, ${path}, 'mend/x',
                  'abc', 'nested', 'origin')`;
        yield* nested("r-1", "repos/failed");
        yield* sql`UPDATE session_repositories SET state = 'failed' WHERE id = 'r-1'`;
        const afterFailure = yield* sql`
          SELECT path FROM worktree_nested_repositories WHERE worktree_id = 'w-1'`;
        yield* nested("r-2", "repos/lib");
        yield* sql`UPDATE session_repositories SET state = 'ready' WHERE id = 'r-2'`;
        const afterReady = yield* sql<{ readonly path: string }>`
          SELECT path FROM worktree_nested_repositories WHERE worktree_id = 'w-1'`;
        return { afterFailure: afterFailure.length, afterReady: afterReady.map((row) => row.path) };
      }),
    );
    expect(recorded).toEqual({ afterFailure: 0, afterReady: ["repos/lib"] });
  });

  it("writes the owner's history in the session insert itself", async () => {
    const history = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertSession("s-1", "anna");
        const fences = yield* RemovalFencesRepo;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        const refusedInsert = yield* refused(insertSession("s-2", "kostas"));
        return yield* sql<{ readonly user: string }>`
          SELECT user_id AS user FROM worktree_session_owners WHERE worktree_id = 'w-1'
          ORDER BY user_id`.pipe(
          Effect.map((rows) => ({ refusedInsert, owners: rows.map((row) => row.user) })),
        );
      }),
    );
    expect(history).toEqual({ refusedInsert: true, owners: ["anna"] });
  });

  it("keeps a deletion that renews its mark its own, past the lease", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const fences = yield* RemovalFencesRepo;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        yield* fences.commit(worktreeRow, taken.id);
        yield* age("worktrees", "w-1", LEASE_SECONDS - 2);
        const renewed = yield* fences.renew(worktreeRow, taken.id);
        yield* age("worktrees", "w-1", 60);
        const whileRenewed = yield* fences.take(worktreeRow);
        yield* age("worktrees", "w-1", LEASE_SECONDS + 5);
        const takeover = yield* fences.take(worktreeRow);
        const formerStillHolds = yield* fences.renew(worktreeRow, taken.id);
        return {
          renewed,
          whileRenewed: whileRenewed._tag,
          takeover: takeover._tag,
          formerStillHolds,
        };
      }),
    );
    expect(outcome).toEqual({
      renewed: true,
      whileRenewed: "underway",
      takeover: "finish",
      formerStillHolds: false,
    });
  });

  it("makes a project's removal and its worktree's see each other's stopped deletions at any age", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const fences = yield* RemovalFencesRepo;
        const worktree = yield* fences.take(worktreeRow);
        if (worktree._tag !== "held") return yield* Effect.die("fence not taken");
        yield* fences.commit(worktreeRow, worktree.id);
        yield* age("worktrees", "w-1", 600);
        const projectOverStoppedWorktree = yield* fences.take(projectRow);
        const finished = yield* fences.take(worktreeRow);
        if (finished._tag !== "finish") return yield* Effect.die("stopped deletion not resumed");
        yield* fences.release(worktreeRow, finished.id);
        const project = yield* fences.take(projectRow);
        if (project._tag !== "held") return yield* Effect.die("project fence not taken");
        yield* fences.commit(projectRow, project.id);
        yield* age("projects", "p-1", 600);
        const worktreeUnderStoppedProject = yield* fences.take(worktreeRow);
        return { projectOverStoppedWorktree, worktreeUnderStoppedProject };
      }),
    );
    expect(outcome).toEqual({
      projectOverStoppedWorktree: { _tag: "underway", stopped: { kind: "worktree", name: "fix" } },
      worktreeUnderStoppedProject: { _tag: "underway", stopped: { kind: "project", name: "api" } },
    });
  });

  it("tells a start under a stopped deletion apart from one under a removal at work", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const fences = yield* RemovalFencesRepo;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        const whileChecking = yield* refusal(insertSession("s-1", "anna"));
        yield* fences.commit(worktreeRow, taken.id);
        const whileDeleting = yield* refusal(insertSession("s-1", "anna"));
        yield* fences.handOver(worktreeRow, taken.id);
        const afterStopping = yield* refusal(insertSession("s-1", "anna"));
        return { whileChecking, whileDeleting, afterStopping };
      }),
    );
    expect(outcome).toEqual({
      whileChecking: "under way",
      whileDeleting: "under way",
      afterStopping: "stopped",
    });
  });

  it("lets a start admitted before the mark finish, and counts it as starting", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        yield* insertSession("s-1", "anna");
        yield* insertSession("s-2", "anna");
        yield* sql`UPDATE agent_sessions SET status = 'completed', settled_at = now()
                   WHERE id IN ('s-1', 's-2')`;
        const admission = yield* fences.admit(SessionId.make("s-1"));
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        const starting = yield* fences.startingIn(WORKTREE);
        const admittedOpens = yield* refusal(
          sql`UPDATE agent_sessions SET status = 'running', settled_at = NULL WHERE id = 's-1'`,
        );
        const admittedShell = yield* refusal(sql`
          INSERT INTO session_processes (id, session_id, sealant_workspace_id, sealant_session_id, kind)
          VALUES ('p-shell', 's-1', 'ws-1', 'pty', 'shell')`);
        const lateAdmission = yield* refusal(fences.admit(SessionId.make("s-2")));
        const liveAdmission = yield* refusal(fences.admit(SessionId.make("s-1")));
        yield* fences.endAdmission(admission);
        yield* sql`UPDATE agent_sessions SET status = 'completed' WHERE id = 's-1'`;
        const ended = yield* fences.startingIn(WORKTREE);
        return { starting, admittedOpens, admittedShell, lateAdmission, liveAdmission, ended };
      }),
    );
    expect(outcome).toEqual({
      starting: ["s-1"],
      admittedOpens: "admitted",
      admittedShell: "admitted",
      lateAdmission: "under way",
      liveAdmission: "admitted",
      ended: ["s-1"],
    });
  });

  it("stops counting an admission nobody renews, and stops letting its rows in", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        yield* insertSession("s-1", "anna");
        yield* sql`UPDATE agent_sessions SET status = 'completed' WHERE id = 's-1'`;
        const admission = yield* fences.admit(SessionId.make("s-1"));
        yield* sql`UPDATE session_admissions SET since = now() - ${secondsAgo(LEASE_SECONDS + 5)}::interval
                   WHERE id = ${admission}`;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        return {
          starting: yield* fences.startingIn(WORKTREE),
          opens: yield* refusal(sql`UPDATE agent_sessions SET status = 'running' WHERE id = 's-1'`),
        };
      }),
    );
    expect(outcome).toEqual({ starting: [], opens: "under way" });
  });

  it("counts and fences a session of a project that links the worktree", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        yield* sql`
          INSERT INTO projects (id, name, organization_id, store_path, default_branch)
          VALUES ('p-2', 'web', 'org-1', '/store/web/repo.git', 'main')`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('w-b', 'p-2', 'b', 'b', 'mend/b', 'abc')`;
        yield* sql`
          INSERT INTO project_links (id, project_id, linked_project_id, name, worktree_name)
          VALUES ('l-1', 'p-2', 'p-1', 'api', 'fix')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id)
          VALUES ('s-b', 'p-2', 'w-b', 'claude', 'b', 'mend/b', 'abc', 'anna')`;
        yield* sql`UPDATE agent_sessions SET status = 'completed' WHERE id = 's-b'`;
        const inLinked = yield* fences.sessionsIn(WORKTREE);
        const inOther = yield* fences.sessionsIn(WorktreeId.make("w-2"));
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        const resumed = yield* refusal(
          sql`UPDATE agent_sessions SET status = 'running' WHERE id = 's-b'`,
        );
        const inserted = yield* refusal(sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id)
          VALUES ('s-c', 'p-2', 'w-b', 'claude', 'b', 'mend/b', 'abc', 'anna')`);
        return { inLinked, inOther, resumed, inserted };
      }),
    );
    expect(outcome).toEqual({
      inLinked: ["s-b"],
      inOther: [],
      resumed: "under way",
      inserted: "under way",
    });
  });

  it("names a session in a worktree exactly when the worktree is one of the session's places", async () => {
    const agree = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        yield* sql`
          INSERT INTO projects (id, name, organization_id, store_path, default_branch)
          VALUES ('p-2', 'web', 'org-1', '/store/web/repo.git', 'main')`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('w-b', 'p-2', 'b', 'b', 'mend/b', 'abc')`;
        yield* sql`
          INSERT INTO project_links (id, project_id, linked_project_id, name, worktree_name)
          VALUES ('l-1', 'p-2', 'p-1', 'api', 'other')`;
        yield* insertSession("s-1", "anna");
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id)
          VALUES ('s-b', 'p-2', 'w-b', 'claude', 'b', 'mend/b', 'abc', 'anna')`;
        yield* sql`
          INSERT INTO session_repositories
            (id, session_id, project_id, worktree_id, name, path, branch, base_sha, capture, source)
          VALUES ('r-1', 's-b', 'p-1', 'w-1', 'api', 'api', 'mend/fix', 'abc', 'own', 'store')`;
        const placed = yield* sql<{ readonly session: string; readonly worktree: string }>`
          SELECT s.id AS session, place.worktree_id AS worktree
          FROM agent_sessions s
          CROSS JOIN LATERAL removal_fence_places(s.id, s.project_id, s.worktree_id) place
          WHERE place.worktree_id IS NOT NULL
          ORDER BY 2, 1`;
        const named: Array<{ readonly session: string; readonly worktree: string }> = [];
        for (const worktree of ["w-1", "w-2", "w-b"]) {
          for (const session of yield* fences.sessionsIn(WorktreeId.make(worktree))) {
            named.push({ session, worktree });
          }
        }
        return { placed: [...placed], named };
      }),
    );
    expect(agree.named).toEqual(agree.placed);
    expect(agree.named).toEqual([
      { session: "s-1", worktree: "w-1" },
      { session: "s-b", worktree: "w-1" },
      { session: "s-b", worktree: "w-2" },
      { session: "s-b", worktree: "w-b" },
    ]);
  });

  it("refuses a Service setup in a worktree a removal checks", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        const setup = (site: string, worktree: string) => sql`
          INSERT INTO setup_runs
            (site_key, fingerprint, worktree_id, state, claim_id, workspace_id, claimed_at, lease_until)
          VALUES (${site}, 'f', ${worktree}, 'running', gen_random_uuid(), 'ws-1', now(),
                  now() + interval '1 minute')`;
        const taken = yield* fences.take(worktreeRow);
        if (taken._tag !== "held") return yield* Effect.die("fence not taken");
        return {
          marked: yield* refusal(setup("site-1", "w-1")),
          other: yield* refusal(setup("site-2", "w-2")),
        };
      }),
    );
    expect(outcome).toEqual({ marked: "under way", other: "admitted" });
  });
});
