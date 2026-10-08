import { PgClient } from "@effect/sql-pg";
import { WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import {
  HarnessLayoutsRepo,
  HarnessLayoutsRepoLive,
  linuxLoginNameOf,
} from "../src/repos/harness-layouts.ts";

/**
 * docs/adr/0016-per-person-harness-homes.md, decisions 1 and 14, against the dev Postgres
 * (`compose.dev.yaml`, :5434) in a throwaway database. Without one reachable these skip rather
 * than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_harness_layouts_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = HarnessLayoutsRepoLive.pipe(Layer.provideMerge(scratchLayer));

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, HarnessLayoutsRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));

const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
    return true;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);

const worktree = WorktreeId.make("wt-1");

describe("Linux login names", () => {
  it("are m and 8 base32 characters, stable per account and attempt", () => {
    const name = linuxLoginNameOf("Q94IcJexample");
    expect(name).toMatch(/^m[a-z2-7]{8}$/);
    expect(linuxLoginNameOf("Q94IcJexample")).toBe(name);
    expect(linuxLoginNameOf("Q94IcJexample", 1)).not.toBe(name);
    expect(linuxLoginNameOf("Q94IcJexample", 1)).toMatch(/^m[a-z2-7]{8}$/);
    expect(linuxLoginNameOf("another")).not.toBe(name);
  });
});

describe.skipIf(!reachable)("per-person harness homes, in Postgres", () => {
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
          VALUES ('p-1', 'p', '/store/p-1/repo.git', 'main', (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${worktree}, 'p-1', 'auth', 'auth', 'mend/auth', 'abc')`;
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

  // Runs first: nothing recorded yet. What startup reads once to know it may read no more.
  it("says no layout is recorded on a fresh store, and an operator's request counts", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* HarnessLayoutsRepo;
        const fresh = yield* repo.anyRecorded();
        yield* repo.requestLayout(worktree, "shared");
        const requested = yield* repo.anyRecorded();
        yield* sql`UPDATE worktrees SET harness_layout_requested = NULL WHERE id = ${worktree}`;
        return { fresh, requested, cleared: yield* repo.anyRecorded() };
      }),
    );
    expect(result).toEqual({ fresh: false, requested: true, cleared: false });
  });

  it("gives each account one stable identity, uids from 40001, even when they ask at once", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* HarnessLayoutsRepo;
        const accounts = Array.from({ length: 12 }, (_, index) => `account-${index}`);
        const first = yield* Effect.forEach(accounts, (id) => repo.ensureIdentity(id), {
          concurrency: "unbounded",
        });
        const uids = first.map((identity) => identity.uid).toSorted((a, b) => a - b);
        expect(uids).toEqual(Array.from({ length: 12 }, (_, index) => 40_001 + index));
        expect(new Set(first.map((identity) => identity.name)).size).toBe(12);
        for (const identity of first) {
          expect(identity.name).toBe(linuxLoginNameOf(identity.accountId));
        }
        // Asked again, from anywhere: the same name and uid.
        const again = yield* repo.ensureIdentity("account-3");
        expect(again).toEqual(first[3]);
        const listed = yield* repo.identitiesOf(["account-3", "account-0", "nobody"]);
        expect(listed.map((identity) => identity.accountId)).toEqual(["account-0", "account-3"]);
        // By login name, as a home Core lists names its person.
        const named = yield* repo.identitiesNamed([linuxLoginNameOf("account-5"), "mnobody23"]);
        expect(named.map((identity) => identity.accountId)).toEqual(["account-5"]);
      }),
    );
  });

  it("moves on to the next name when another account holds the first", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* HarnessLayoutsRepo;
        yield* sql`
          INSERT INTO linux_identities (user_id, name, uid)
          VALUES ('squatter', ${linuxLoginNameOf("late")}, 49000)`;
        const late = yield* repo.ensureIdentity("late");
        expect(late.name).toBe(linuxLoginNameOf("late", 1));
        expect(late.uid).toBe(49_001);
      }),
    );
  });

  it("makes a worktree person with its first confirmed person launch, and never clears it", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* HarnessLayoutsRepo;
        expect(yield* repo.worktreeLayout(worktree)).toEqual({ layout: null, requested: null });
        // A predicted person launch is not the worktree's layout until prepare confirms it.
        yield* repo.recordLaunch({
          launchId: "launch-1",
          worktreeId: worktree,
          sessionId: "s-1",
          layout: "person",
          source: "flag",
          reason: null,
          imageKey: "img",
          confirmed: false,
        });
        expect((yield* repo.worktreeLayout(worktree)).layout).toBeNull();
        // Prepare found otherwise: the launch falls back, the worktree stays without a layout.
        yield* repo.recordFallback("launch-1", "no sudo");
        expect(yield* repo.launchLayout("launch-1")).toMatchObject({
          layout: "shared",
          source: "fallback",
          reason: "no sudo",
          confirmed: true,
        });
        expect((yield* repo.worktreeLayout(worktree)).layout).toBeNull();
        // The next one is confirmed: the worktree is person from now on.
        yield* repo.recordLaunch({
          launchId: "launch-2",
          worktreeId: worktree,
          sessionId: "s-1",
          layout: "person",
          source: "flag",
          reason: null,
          imageKey: "img",
          confirmed: false,
        });
        yield* repo.confirmPerson("launch-2", worktree);
        expect((yield* repo.worktreeLayout(worktree)).layout).toBe("person");
        // A later shared record (nothing should make one, but nothing may undo the worktree).
        yield* repo.recordLaunch({
          launchId: "launch-3",
          worktreeId: worktree,
          sessionId: "s-2",
          layout: "shared",
          source: "flag",
          reason: null,
          imageKey: null,
          confirmed: true,
        });
        yield* repo.recordFallback("launch-2", "late");
        expect((yield* repo.worktreeLayout(worktree)).layout).toBe("person");
        expect((yield* repo.launchLayout("launch-2"))?.layout).toBe("person");
      }),
    );
  });

  it("keeps the operator's request and what prepare found per image and runtime", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* HarnessLayoutsRepo;
        yield* repo.requestLayout(worktree, "shared");
        expect((yield* repo.worktreeLayout(worktree)).requested).toBe("shared");
        expect(yield* repo.capabilityOf("img", "docker")).toBeNull();
        yield* repo.recordCapability({
          imageKey: "img",
          runtime: "docker",
          person: false,
          missing: ["sudo", "uid 40001 is taken"],
        });
        expect(yield* repo.capabilityOf("img", "docker")).toMatchObject({
          person: false,
          missing: ["sudo", "uid 40001 is taken"],
        });
        yield* repo.recordCapability({
          imageKey: "img",
          runtime: "docker",
          person: true,
          missing: [],
        });
        expect(yield* repo.capabilityOf("img", "docker")).toMatchObject({
          person: true,
          missing: [],
        });
        expect(yield* repo.capabilityOf("img", "microvm")).toBeNull();
      }),
    );
  });

  // Runs last: the person launches above are recorded.
  it("says a layout is recorded once a person launch is", async () => {
    expect(await run(Effect.flatMap(HarnessLayoutsRepo, (repo) => repo.anyRecorded()))).toBe(true);
  });
});

describe.skipIf(!reachable)(
  "one live agent process per conversation, in Postgres (Delivery 17)",
  () => {
    const db = `mend_conversations_test_${process.pid}_${Date.now()}`;
    const url = (() => {
      const parsed = new URL(ADMIN_URL);
      parsed.pathname = `/${db}`;
      return parsed.toString();
    })();
    const layer = HarnessLayoutsRepoLive.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
    );
    const inDb = <A, E>(effect: Effect.Effect<A, E, HarnessLayoutsRepo | SqlClient.SqlClient>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));

    beforeAll(async () => {
      await withAdmin(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`CREATE DATABASE ${db}`);
        }),
      );
      await inDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
          yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
          yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'p', '/store/p-1/repo.git', 'main', (SELECT id FROM organizations LIMIT 1))`;
          yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'auth', 'auth', 'mend/auth', 'abc')`;
          yield* sql`
          INSERT INTO agent_sessions (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id)
          VALUES ('s-1', 'p-1', 'wt-1', 'claude', 'auth', 'mend/auth', 'abc', 'alice'),
                 ('s-2', 'p-1', 'wt-1', 'codex', 'auth', 'mend/auth', 'abc', 'alice')`;
        }),
      );
    });

    afterAll(async () => {
      await withAdmin(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
        }),
      );
    });

    it("takes once: a second start is held off until the platform reports the process exited", async () => {
      await inDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const repo = yield* HarnessLayoutsRepo;
          const first = yield* repo.takeConversation("s-1", "launch-a");
          expect(first).toEqual({ taken: true, fence: 1 });
          // A second start, anywhere: held, even before the first bound its process.
          expect(yield* repo.takeConversation("s-1", "launch-b")).toEqual({
            taken: false,
            launchId: "launch-a",
            processId: null,
          });
          yield* sql`
          INSERT INTO session_processes (id, session_id, sealant_workspace_id, sealant_session_id, kind, status, runs_as)
          VALUES ('proc-1', 's-1', 'ws-1', 'pty-1', 'agent-protocol', 'running', 'bob')`;
          expect(yield* repo.bindConversation("s-1", 1, "proc-1")).toBe(true);
          // A process the platform has not reported exited is the conversation's: an unreachable
          // executor means wait, never a second process.
          expect(yield* repo.takeConversation("s-1", "launch-b")).toEqual({
            taken: false,
            launchId: "launch-a",
            processId: "proc-1",
          });
          // Reported exited (and a release that never came, say Mend restarted): taken again.
          yield* sql`UPDATE session_processes SET exited_at = now() WHERE id = 'proc-1'`;
          const next = yield* repo.takeConversation("s-1", "launch-b");
          expect(next).toEqual({ taken: true, fence: 2 });
          // The older start can no longer bind: fenced out.
          expect(yield* repo.bindConversation("s-1", 1, "proc-late")).toBe(false);
          const rows = yield* sql<{ readonly runsAs: string | null }>`
          SELECT runs_as AS "runsAs" FROM session_processes WHERE id = 'proc-1'`;
          expect(rows[0]?.runsAs).toBe("bob");
        }),
      );
    });

    it("releases by process and by an unbound start's fence, never a newer take; a hand-over takes from the process it replaces", async () => {
      await inDb(
        Effect.gen(function* () {
          const repo = yield* HarnessLayoutsRepo;
          const take = yield* repo.takeConversation("s-2", "launch-a");
          if (!take.taken) throw new Error("not taken");
          // A start that failed before its process existed releases by its fence.
          yield* repo.releaseConversation("s-2", { fence: take.fence });
          expect((yield* repo.conversationHolder("s-2"))?.launchId).toBeNull();
          const again = yield* repo.takeConversation("s-2", "launch-a");
          if (!again.taken) throw new Error("not taken");
          yield* repo.bindConversation("s-2", again.fence, "proc-2");
          // An older start's fence releases nothing of the newer take.
          yield* repo.releaseConversation("s-2", { fence: take.fence });
          expect((yield* repo.conversationHolder("s-2"))?.processId).toBe("proc-2");
          // A start that replaces the live process (a hand-over) takes it from that process, and
          // only from that one; anyone else is held off.
          expect(yield* repo.takeConversation("s-2", "launch-b", "proc-other")).toMatchObject({
            taken: false,
          });
          expect(yield* repo.takeConversation("s-2", "launch-a", "proc-2")).toEqual({
            taken: true,
            fence: again.fence + 1,
          });
          // While its start runs, a second start is held off, even one naming the old process.
          expect(yield* repo.takeConversation("s-2", "launch-a", "proc-2")).toEqual({
            taken: false,
            launchId: "launch-a",
            processId: null,
          });
          // The replaced process's exit releases nothing of the newer take.
          yield* repo.releaseConversation("s-2", { processId: "proc-2" });
          expect((yield* repo.conversationHolder("s-2"))?.launchId).toBe("launch-a");
        }),
      );
    });

    it("records a conversation's move into C once: the first move's owner and time stay", async () => {
      await inDb(
        Effect.gen(function* () {
          const repo = yield* HarnessLayoutsRepo;
          expect(yield* repo.sharedConversationOf("s-1")).toBeNull();
          yield* repo.markConversationShared("s-1", "alice");
          const first = yield* repo.sharedConversationOf("s-1");
          yield* repo.markConversationShared("s-1", "someone-else");
          expect(yield* repo.sharedConversationOf("s-1")).toEqual(first);
          expect(first?.owner).toBe("alice");
        }),
      );
    });
  },
);

describe.skipIf(!reachable)(
  "pre-release executors and the old shared home's migration, in Postgres (Delivery 19)",
  () => {
    const db = `mend_pre_release_test_${process.pid}_${Date.now()}`;
    const url = (() => {
      const parsed = new URL(ADMIN_URL);
      parsed.pathname = `/${db}`;
      return parsed.toString();
    })();
    const layer = HarnessLayoutsRepoLive.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
    );
    const inDb = <A, E>(effect: Effect.Effect<A, E, HarnessLayoutsRepo | SqlClient.SqlClient>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
    const other = WorktreeId.make("wt-2");

    beforeAll(async () => {
      await withAdmin(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`CREATE DATABASE ${db}`);
        }),
      );
      await inDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
          yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
          yield* sql`
            INSERT INTO projects (id, name, store_path, default_branch, organization_id)
            VALUES ('p-1', 'p', '/store/p-1/repo.git', 'main', (SELECT id FROM organizations LIMIT 1))`;
          yield* sql`
            INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
            VALUES (${worktree}, 'p-1', 'auth', 'auth', 'mend/auth', 'abc'),
                   (${other}, 'p-1', 'docs', 'docs', 'mend/docs', 'abc')`;
        }),
      );
    });

    afterAll(async () => {
      await withAdmin(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
        }),
      );
    });

    it("records each run of the migration in place of the last, naming the capture it read", async () => {
      await inDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const repo = yield* HarnessLayoutsRepo;
          expect(yield* repo.preReleaseMigrationOf(worktree)).toBeNull();
          const provisional = {
            worktreeId: worktree,
            captureId: "cap-3",
            captureN: 3,
            final: false,
            creditedTo: "alice",
            decidedBy: "only-person" as const,
            credited: { ".claude/projects/-workspace-repo/memory/MEMORY.md": "d1" },
            notCredited: [],
          };
          yield* repo.recordPreReleaseMigration(provisional);
          expect(yield* repo.preReleaseMigrationOf(worktree)).toEqual(provisional);
          // A person worktree whose only run was provisional still waits for its final one.
          yield* sql`UPDATE worktrees SET harness_layout = 'person' WHERE id IN (${worktree}, ${other})`;
          expect((yield* repo.worktreesAwaitingMigration()).toSorted()).toEqual(
            [worktree, other].toSorted(),
          );
          const final = {
            ...provisional,
            captureId: "cap-5",
            captureN: 5,
            final: true,
            credited: { ...provisional.credited, ".codex/memories/notes.md": "d2" },
          };
          yield* repo.recordPreReleaseMigration(final);
          expect(yield* repo.preReleaseMigrationOf(worktree)).toEqual(final);
          expect(yield* repo.worktreesAwaitingMigration()).toEqual([other]);
        }),
      );
    });

    it("marks an executor to retire, takes it to retiring once, and keeps what a retiring one found", async () => {
      await inDb(
        Effect.gen(function* () {
          const repo = yield* HarnessLayoutsRepo;
          const marked = yield* repo.markRetirement({
            workspaceId: "ws-old",
            worktreeId: worktree,
            sessionId: "s-1",
            launcher: "alice",
            preRelease: true,
            stops: [{ kind: "shell", label: "shell 1" }],
            reason: null,
            checkedAt: null,
          });
          expect(marked.state).toBe("marked");
          const markedAt = marked.updatedAt;
          expect(yield* repo.beginRetiring("ws-old")).toBe(true);
          // A second attempt finds it held.
          expect(yield* repo.beginRetiring("ws-old")).toBe(false);
          // The sweep marking it again while it retires changes nothing.
          const retiring = yield* repo.retirementOf("ws-old");
          const again = yield* repo.markRetirement({
            ...marked,
            stops: [],
            reason: "later",
            checkedAt: new Date(),
          });
          expect(again).toMatchObject({
            state: "retiring",
            stops: [{ kind: "shell" }],
            checkedAt: null,
          });
          // Its time is the replacement's: a sweep's mark never makes a stale row look fresh.
          expect(again.updatedAt).toEqual(retiring?.updatedAt);
          expect(retiring?.updatedAt.getTime()).toBeGreaterThanOrEqual(markedAt.getTime());
          yield* repo.unmarkRetiring("ws-old", {
            stops: [{ kind: "process", label: "sleep 600" }],
            reason: "a process Mend did not start runs in it",
          });
          expect(yield* repo.retirementOf("ws-old")).toMatchObject({
            state: "marked",
            stops: [{ kind: "process", label: "sleep 600" }],
            reason: "a process Mend did not start runs in it",
          });
          expect((yield* repo.listRetirements()).map((row) => row.workspaceId)).toEqual(["ws-old"]);
          yield* repo.clearRetirement("ws-old");
          expect(yield* repo.retirementOf("ws-old")).toBeNull();
        }),
      );
    });

    it("keeps every account that had a session in a worktree, and says which worktrees predate it", async () => {
      await inDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const repo = yield* HarnessLayoutsRepo;
          // Made after the record began: complete. One older than it is a gap, whatever it holds.
          expect(yield* repo.sessionOwnersOf(worktree)).toEqual({ owners: [], complete: true });
          yield* sql`INSERT INTO worktree_owner_gaps (worktree_id) VALUES (${worktree})`;
          expect(yield* repo.sessionOwnersOf(worktree)).toEqual({ owners: [], complete: false });
          yield* sql`
            INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
            VALUES ('wt-new', 'p-1', 'new', 'new', 'mend/new', 'abc')`;
          yield* sql`
            INSERT INTO worktree_session_owners (worktree_id, user_id)
            VALUES ('wt-new', 'alice'), ('wt-new', 'bob'), ('wt-new', 'alice')
            ON CONFLICT DO NOTHING`;
          expect(yield* repo.sessionOwnersOf(WorktreeId.make("wt-new"))).toEqual({
            owners: ["alice", "bob"],
            complete: true,
          });
        }),
      );
    });
  },
);
