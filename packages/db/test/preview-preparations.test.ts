import { PgClient } from "@effect/sql-pg";
import { AgentTurnId, PreviewId, SessionId, SessionProcessId, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
} from "../src/repos/agent-conversation.ts";
import {
  type PreviewPreparationClaim,
  PreviewPreparationsRepo,
  PreviewPreparationsRepoLive,
} from "../src/repos/preview-preparations.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_preview_preparations_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const workerLayer = () =>
  Layer.mergeAll(PreviewPreparationsRepoLive, AgentConversationRepoLive).pipe(
    Layer.provideMerge(
      MendDBLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl) }))),
    ),
  );

type Services = PreviewPreparationsRepo | AgentConversationRepo | SqlClient.SqlClient;
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(effect.pipe(Effect.provide(workerLayer()), Effect.scoped));

const SESSION = SessionId.make("sess-1");
const PROCESS = SessionProcessId.make("proc-1");
const SIBLING = SessionId.make("sess-2");
const SIBLING_PROCESS = SessionProcessId.make("proc-2");
const WORKTREE = WorktreeId.make("wt-1");
const LEASE_MS = 60_000;

let turns = 0;
const endedTurn = (status = "completed", session = SESSION) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    turns += 1;
    const id = AgentTurnId.make(`turn-${turns}`);
    const process = session === SESSION ? PROCESS : SIBLING_PROCESS;
    yield* sql`
      INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status, ended_at)
      VALUES (${id}, ${session}, ${process}, ${turns}, 'fix it', ${status},
              ${status === "running" ? null : new Date()})`;
    return id;
  });

const startingWeb = (turn: AgentTurnId) => ({
  service: "web",
  previewId: null,
  startId: `preview-turn:${turn}`,
  phase: "setup" as const,
  note: null,
});

const claimed = (claim: PreviewPreparationClaim | null) => {
  if (claim === null) throw new Error("not claimed");
  return claim;
};

describe.skipIf(postgres.skip)("preview_preparations: one worker prepares each ended turn", () => {
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
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status)
          VALUES (${SESSION}, 'p-1', ${WORKTREE}, 'claude', 'one', 'mend/one', 'abc', 'running')`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status)
          VALUES (${PROCESS}, ${SESSION}, 'ws-1', 'pty-1', 'agent-protocol', 'running')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status)
          VALUES (${SIBLING}, 'p-1', ${WORKTREE}, 'codex', 'one', 'mend/one', 'abc', 'running')`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status)
          VALUES (${SIBLING_PROCESS}, ${SIBLING}, 'ws-1', 'pty-2', 'agent-protocol', 'running')`;
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
  beforeEach(async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM agent_turns`;
      }),
    );
  });

  it("gives one of two workers' concurrent claims the turn, and nothing to a turn still open", async () => {
    const turn = await run(endedTurn());
    const open = await run(endedTurn("running"));
    const claims = await Promise.all(
      Array.from({ length: 6 }, () =>
        run(Effect.flatMap(PreviewPreparationsRepo, (repo) => repo.claim(turn, LEASE_MS))),
      ),
    );
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.find((claim) => claim !== null)).toMatchObject({
      turnId: turn,
      sessionId: SESSION,
      worktreeId: WORKTREE,
    });
    const openClaim = await run(
      Effect.flatMap(PreviewPreparationsRepo, (repo) => repo.claim(open, LEASE_MS)),
    );
    expect(openClaim).toBeNull();
  });

  it("retakes a claim whose lease lapsed, and refuses the lapsed holder's decision", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* PreviewPreparationsRepo;
        const turn = yield* endedTurn();
        const first = claimed(yield* repo.claim(turn, 0));
        const second = claimed(yield* repo.claim(turn, LEASE_MS));
        const held = yield* repo.claim(turn, LEASE_MS);
        const lapsedDecides = yield* repo.decide(first, { _tag: "NoChange" });
        const lapsedProgress = yield* repo.progress(first, {
          service: "web",
          previewId: null,
          startId: `preview-turn:${turn}`,
          phase: "setup",
          note: null,
        });
        const holderDecides = yield* repo.decide(second, { _tag: "NotCaptured" });
        const afterDecided = yield* repo.claim(turn, 0);
        return {
          retaken: second.claimId !== first.claimId,
          held,
          lapsedDecides,
          lapsedProgress,
          holderDecides,
          afterDecided,
          latest: yield* repo.latestForWorktree(WORKTREE),
        };
      }),
    );
    expect(result).toMatchObject({
      retaken: true,
      held: null,
      lapsedDecides: false,
      lapsedProgress: "Lost",
      holderDecides: true,
      afterDecided: null,
      latest: { state: { _tag: "Decided", decision: { _tag: "NotCaptured" } } },
    });
  });

  it("records a start's phase while held, then its decision, and a retake starts it over", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* PreviewPreparationsRepo;
        const turn = yield* endedTurn();
        const claim = claimed(yield* repo.claim(turn, LEASE_MS));
        yield* repo.progress(claim, {
          service: "web",
          previewId: null,
          startId: `preview-turn:${turn}`,
          phase: "depends",
          note: "recipe-changed",
        });
        const starting = yield* repo.latestForWorktree(WORKTREE);
        const renewed = yield* repo.renew(claim, 0);
        const retaken = claimed(yield* repo.claim(turn, LEASE_MS));
        const afterRetake = yield* repo.latestForWorktree(WORKTREE);
        yield* repo.decide(retaken, {
          _tag: "Running",
          service: "web",
          previewId: null,
          note: "recipe-changed",
        });
        return { starting, renewed, afterRetake, decided: yield* repo.latestForWorktree(WORKTREE) };
      }),
    );
    expect(result.starting?.state).toEqual({
      _tag: "Starting",
      service: "web",
      previewId: null,
      phase: "depends",
      note: "recipe-changed",
    });
    expect(result.renewed).toBe(true);
    expect(result.afterRetake).toBeNull();
    expect(result.decided?.state).toMatchObject({
      _tag: "Decided",
      decision: { _tag: "Running", service: "web", note: "recipe-changed" },
    });
  });

  it("lists only the ended turns no preparation decided; the latest decision says the line, a silent one too", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* PreviewPreparationsRepo;
        const refused = yield* endedTurn();
        const question = yield* endedTurn();
        const fresh = yield* endedTurn();
        const lapsed = yield* endedTurn();
        const skipped = yield* endedTurn();
        yield* endedTurn("running");
        yield* repo.decide(claimed(yield* repo.claim(refused, LEASE_MS)), {
          _tag: "NotCaptured",
        });
        yield* repo.decide(claimed(yield* repo.claim(question, LEASE_MS)), { _tag: "NoChange" });
        yield* repo.decide(claimed(yield* repo.claim(skipped, LEASE_MS)), {
          _tag: "Skipped",
          why: "the turn failed",
        });
        yield* repo.claim(lapsed, 0);
        return {
          undecided: yield* repo.undecided(SESSION),
          fresh,
          lapsed,
          latest: yield* repo.latestForWorktree(WORKTREE),
        };
      }),
    );
    expect(result.undecided).toEqual([result.fresh, result.lapsed]);
    expect(result.latest?.state).toMatchObject({
      _tag: "Decided",
      decision: { _tag: "NoChange" },
    });
  });

  it("holds one start per preview across sessions until it decides, and frees a lapsed holder's", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* PreviewPreparationsRepo;
        const mine = yield* endedTurn();
        const theirs = yield* endedTurn("completed", SIBLING);
        const later = yield* endedTurn("completed", SIBLING);
        const mineClaim = claimed(yield* repo.claim(mine, LEASE_MS));
        const theirClaim = claimed(yield* repo.claim(theirs, LEASE_MS));
        const both = yield* Effect.all(
          [
            repo.progress(mineClaim, startingWeb(mine)),
            repo.progress(theirClaim, startingWeb(theirs)),
          ],
          { concurrency: 2 },
        );
        const phaseAgain = yield* repo.progress(both[0] === "Held" ? mineClaim : theirClaim, {
          ...startingWeb(mine),
          phase: "service",
        });
        const docs = yield* repo.progress(both[0] === "Held" ? theirClaim : mineClaim, {
          ...startingWeb(mine),
          service: "docs",
        });
        const line = yield* repo.latestForWorktree(WORKTREE);
        const holder = both[0] === "Held" ? mineClaim : theirClaim;
        yield* repo.renew(holder, 0);
        const laterClaim = claimed(yield* repo.claim(later, LEASE_MS));
        const afterLapse = yield* repo.progress(laterClaim, startingWeb(later));
        const lapsedHolder = yield* repo.progress(holder, startingWeb(mine));
        return { both, phaseAgain, docs, line, afterLapse, lapsedHolder };
      }),
    );
    expect([...result.both].toSorted()).toEqual(["Held", "Taken"]);
    expect(result.phaseAgain).toBe("Held");
    expect(result.docs).toBe("Held");
    expect(result.line?.state).toMatchObject({ _tag: "Starting" });
    expect(result.afterLapse).toBe("Held");
    expect(result.lapsedHolder).toBe("Lost");
  });

  it("says what each earlier turn left: superseded hands its change on", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* PreviewPreparationsRepo;
        const handed = yield* endedTurn();
        const refused = yield* endedTurn();
        yield* endedTurn();
        yield* repo.decide(claimed(yield* repo.claim(handed, LEASE_MS)), { _tag: "Superseded" });
        yield* repo.decide(claimed(yield* repo.claim(refused, LEASE_MS)), {
          _tag: "Refused",
          service: null,
          previewId: null,
          reason: "mend.toml: line 3",
        });
        return {
          handed,
          refused,
          left: yield* repo.left(SESSION),
          latest: yield* repo.latestForWorktree(WORKTREE),
        };
      }),
    );
    expect(result.left).toEqual(
      new Map([
        [result.handed, "superseded"],
        [result.refused, "decided"],
      ]),
    );
    expect(result.latest?.state).toMatchObject({
      _tag: "Decided",
      decision: { _tag: "Refused", service: null, reason: "mend.toml: line 3" },
    });
  });

  it("refuses a decision whose columns contradict its state", async () => {
    const refused = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const turn = yield* endedTurn();
        return yield* sql`
          INSERT INTO preview_preparations
            (turn_id, session_id, worktree_id, state, claim_id, claimed_at, lease_until, decided_at)
          VALUES (${turn}, ${SESSION}, ${WORKTREE}, 'refused', gen_random_uuid(), now(), now(), now())`.pipe(
          Effect.flip,
          Effect.map((error) => String(error.reason.cause)),
        );
      }),
    );
    expect(refused).toContain("preview_preparations_reason_facts");
  });

  it("a mode switch's backfilled turns are terminal history, decided as they land", async () => {
    const result = await run(
      Effect.gen(function* () {
        const conversations = yield* AgentConversationRepo;
        const repo = yield* PreviewPreparationsRepo;
        const sql = yield* SqlClient.SqlClient;
        const landed = yield* conversations.backfillConversation(SESSION, PROCESS, [
          { providerTurnId: "native-1", input: "earlier work", items: [] },
        ]);
        const rows = yield* sql<{
          readonly state: string;
          readonly reason: string;
          readonly worktreeId: string;
        }>`SELECT state, reason, worktree_id AS "worktreeId" FROM preview_preparations`;
        return { landed, rows: [...rows], undecided: yield* repo.undecided(SESSION) };
      }),
    );
    expect(result).toEqual({
      landed: 1,
      rows: [{ state: "skipped", reason: "terminal history", worktreeId: WORKTREE }],
      undecided: [],
    });
  });

  it("a removed preview leaves the preparation that named it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* PreviewPreparationsRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO previews (id, project_id, worktree_id, service_name, label)
          VALUES ('preview-web', 'p-1', ${WORKTREE}, 'web', 'aaaaaaaaaaaaaaaaaaaaaaaaaa')`;
        const turn = yield* endedTurn();
        yield* repo.decide(claimed(yield* repo.claim(turn, LEASE_MS)), {
          _tag: "Stopped",
          service: "web",
          previewId: PreviewId.make("preview-web"),
        });
        yield* sql`DELETE FROM previews WHERE id = 'preview-web'`;
        return yield* repo.latestForWorktree(WORKTREE);
      }),
    );
    expect(result?.state).toMatchObject({
      _tag: "Decided",
      decision: { _tag: "Stopped", service: "web", previewId: null },
    });
  });
});
