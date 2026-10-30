import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  SessionProcessesRepo,
  SessionProcessesRepoLive,
  SessionsRepo,
  SessionsRepoLive,
  migrations,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ProjectId, said, SealantWorkspaceId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Session, isLiveAgentProcess } from "@mend/domain/workbench";
import { agentRanIn, Expected, refusalOf } from "@mend/sessions";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_launch_admission_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const reposLayer = Layer.mergeAll(SessionsRepoLive, SessionProcessesRepoLive).pipe(
  Layer.provideMerge(
    MendDBLive.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
    ),
  ),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<A, E, SessionsRepo | SessionProcessesRepo | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const PROJECT = ProjectId.make("p-web");
const WORKTREE = WorktreeId.make("wt-1");
const SESSION = SessionId.make("s-retried");
const RETRIED = SessionId.make("s-failed-retry");

const wire = Schema.toCodecJson(Session);

/** The session as a client holds it: encoded for the wire, sent as JSON, decoded again. */
const asClientReads = (session: Session) =>
  Schema.decodeUnknownSync(wire)(JSON.parse(JSON.stringify(Schema.encodeSync(wire)(session))));

/** The session as the launch gate observes it, read fresh. */
const observedOf = (id: SessionId) =>
  Effect.gen(function* () {
    const session = yield* (yield* SessionsRepo).byId(id);
    const rows = yield* (yield* SessionProcessesRepo).listForSession(id);
    return {
      status: session.status,
      settledAt: session.settledAt,
      agentLive: session.settledAt === null && rows.some(isLiveAgentProcess),
      underWay: false,
      agentRan: agentRanIn(rows),
    };
  });
const observed = observedOf(SESSION);

describe.skipIf(postgres.skip)("the attempt a client saw, through Postgres and the wire", () => {
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
          VALUES (${PROJECT}, 'web', '/store/p-web/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-1', 'wt-1', 'mend/wt-1', 'abc')`;
        for (const id of [SESSION, RETRIED]) {
          yield* (yield* SessionsRepo).create({
            id,
            projectId: PROJECT,
            worktreeId: WORKTREE,
            harness: "codex",
            label: null,
            worktree: "wt-1",
            branch: "mend/wt-1",
            baseSha: Sha.make("abc"),
            baseRef: "main",
            contextSnapshotId: null,
            ownerUserId: "alice",
            origin: "mend",
          });
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

  it("admits the failed attempt a client read, and refuses it once the session moved on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionsRepo;
        yield* sessions.settle(SESSION, "failed", said`launch failed: the platform did not answer`);
        // Postgres keeps microseconds and a client sees milliseconds: the stored instant is given
        // sub-millisecond digits whatever the clock said, so a comparison at the stored precision
        // would refuse the very attempt the client read.
        yield* sql`
          UPDATE agent_sessions
          SET settled_at = date_trunc('milliseconds', settled_at) + interval '456 microseconds'
          WHERE id = ${SESSION}`;
        const [stored] = yield* sql<{ readonly micros: string }>`
          SELECT (extract(epoch FROM settled_at) * 1000000)::bigint::text AS micros
          FROM agent_sessions WHERE id = ${SESSION}`;
        const seen = asClientReads(yield* sessions.byId(SESSION));
        const fresh = yield* observed;
        const admitted = refusalOf(Expected(seen.settledAt), fresh);

        // Another client's resume: its agent runs and the session reopens.
        yield* sessions.reopen(SESSION, "running");
        yield* (yield* SessionProcessesRepo).create({
          sessionId: SESSION,
          sealantWorkspaceId: SealantWorkspaceId.make("ws-2"),
          sealantSessionId: "pty-2",
          kind: "agent-pty",
          harness: "codex",
          label: "codex",
          argv: ["codex"],
        });
        const afterResume = refusalOf(Expected(seen.settledAt), yield* observed);

        // That attempt fails in turn: a new settled attempt the client never saw.
        yield* sessions.settle(SESSION, "failed", said`launch failed: again`);
        const afterSecond = yield* observed;
        const afterSecondRefusal = refusalOf(Expected(seen.settledAt), afterSecond);
        const secondSeen = refusalOf(
          Expected(asClientReads(yield* sessions.byId(SESSION)).settledAt),
          afterSecond,
        );
        return {
          micros: stored?.micros ?? null,
          seen,
          admitted,
          afterResume,
          afterSecond,
          afterSecondRefusal,
          secondSeen,
        };
      }),
    );

    expect(result.micros).not.toBeNull();
    expect(BigInt(result.micros ?? "0") % 1000n).toBe(456n);
    expect(result.seen.settledAt).not.toBeNull();
    expect(BigInt(result.seen.settledAt?.getTime() ?? 0) * 1000n + 456n).toBe(
      BigInt(result.micros ?? "0"),
    );
    expect(result.admitted).toBeNull();
    expect(result.afterResume).toEqual({
      _tag: "MovedOn",
      status: "running",
      settledAt: null,
      reason: "agentLive",
    });
    expect(result.afterSecondRefusal).toMatchObject({ _tag: "MovedOn", status: "failed" });
    expect(result.afterSecond.settledAt?.getTime()).not.toBe(result.seen.settledAt?.getTime());
    expect(result.secondSeen).toBeNull();
  });
  it("keeps the attempt a client saw when a retry fails before its agent starts: the precondition admits it again", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        yield* sessions.settle(RETRIED, "failed", said`launch failed: the platform did not answer`);
        const seen = asClientReads(yield* sessions.byId(RETRIED));
        // The retry the precondition admitted: it fails before any agent runs, so nothing
        // reopens the session, and its settle finds the first one in place.
        yield* sessions.settle(RETRIED, "failed", said`launch failed: again`);
        const after = yield* sessions.byId(RETRIED);
        return {
          seen,
          after,
          again: refusalOf(Expected(seen.settledAt), yield* observedOf(RETRIED)),
        };
      }),
    );

    expect(result.seen.settledAt).not.toBeNull();
    expect(result.after.settledAt?.getTime()).toBe(result.seen.settledAt?.getTime());
    expect(result.after.summary).toBe("launch failed: the platform did not answer");
    expect(result.again).toBeNull();
  });
});
