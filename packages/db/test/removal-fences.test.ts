import { PgClient } from "@effect/sql-pg";
import { ProjectId, WorktreeId } from "@mend/domain";
import { REMOVAL_FENCE_LEASE_SECONDS } from "@mend/domain/workbench";
import { Deferred, Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import {
  isRemovalFenced,
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

const changeOwner = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly owner: string | null }>`
    SELECT change_owner_user_id AS owner FROM worktrees WHERE id = 'w-1'`;
  return row?.owner ?? null;
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
        const ago = `${REMOVAL_FENCE_LEASE_SECONDS + 5} seconds`;
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
          resumed: resumed._tag === "finish" && resumed.id === takeover.id,
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
});
