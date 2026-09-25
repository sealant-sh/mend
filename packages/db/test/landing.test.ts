import { PgClient } from "@effect/sql-pg";
import {
  AgentTurnId,
  ChangeId,
  ChangeLandingId,
  CheckpointId,
  ProjectId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
} from "../src/repos/agent-conversation.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import {
  ChangeLandingsRepo,
  ChangeLandingsRepoLive,
  type NewChangeLanding,
} from "../src/repos/change-landings.ts";
import { ProjectsRepo, ProjectsRepoLive } from "../src/repos/projects.ts";

/**
 * docs/adr/0007-landing.md against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway
 * database. Without one reachable these skip rather than pretend; set MEND_TEST_DATABASE_URL
 * elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_landing_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = Layer.mergeAll(
  ChangeLandingsRepoLive,
  SessionsRepoLive,
  ProjectsRepoLive,
  AgentConversationRepoLive,
).pipe(Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))));

type Repos =
  | ChangeLandingsRepo
  | SessionsRepo
  | ProjectsRepo
  | AgentConversationRepo
  | SqlClient.SqlClient;

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

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

const PROJECT = ProjectId.make("p-api");
const WORKTREE = WorktreeId.make("wt-1");
const SESSION = SessionId.make("s-1");
const CHANGE = ChangeId.make("c-1");
const CHECKPOINT = CheckpointId.make("cp-1");
const PROCESS = SessionProcessId.make("proc-1");
const sha = (c: string) => Sha.make(c.repeat(40));

const landingWith = (result: NewChangeLanding["result"]): NewChangeLanding => ({
  changeId: CHANGE,
  sessionId: SESSION,
  projectId: PROJECT,
  checkpoint: { id: CHECKPOINT, ref: "refs/mend/checkpoints/wt-1/1", sha: sha("c") },
  commitSha: sha("d"),
  remoteBranch: "mend/fix-login",
  trigger: "automatic",
  userId: "alice",
  result,
});

describe.skipIf(!reachable)("landing in Postgres", () => {
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
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'api', '/store/p-api/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'fix-login', 'fix-login', 'mend/fix-login', 'abc')`;
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

  it("keeps the project's setting and a session's own override", async () => {
    await run(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        const sessions = yield* SessionsRepo;
        expect((yield* projects.byId(PROJECT)).autoLand).toBe("inherit");
        expect((yield* projects.setAutoLand(PROJECT, "off")).autoLand).toBe("off");
        expect((yield* projects.byId(PROJECT)).autoLand).toBe("off");
        yield* projects.setAutoLand(PROJECT, "inherit");
        const cascade = {
          autoTour: "inherit",
          autoSuggest: "inherit",
          autoName: "inherit",
          backgroundSessions: "inherit",
        } as const;
        // The automation route writes it with the cascade, and leaves it when a client omits it.
        expect(
          (yield* projects.setAutomation(PROJECT, { ...cascade, autoLand: "on" })).autoLand,
        ).toBe("on");
        expect((yield* projects.setAutomation(PROJECT, cascade)).autoLand).toBe("on");
        yield* projects.setAutoLand(PROJECT, "inherit");

        const base = {
          projectId: PROJECT,
          worktreeId: WORKTREE,
          harness: "claude",
          label: null,
          worktree: "fix-login",
          branch: "mend/fix-login",
          baseSha: Sha.make("abc"),
          baseRef: "main",
          contextSnapshotId: null,
          ownerUserId: "alice",
          origin: "mend" as const,
        };
        const landing = yield* sessions.create({ ...base, id: SESSION, autoLand: true });
        expect(landing.autoLand).toBe(true);
        const following = yield* sessions.create({ ...base, id: SessionId.make("s-2") });
        expect(following.autoLand).toBeNull();
        expect((yield* sessions.byId(SESSION)).autoLand).toBe(true);
      }),
    );
  });

  it("records a turn's intent, replacing an earlier reading", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const conversation = yield* AgentConversationRepo;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status)
          VALUES (${PROCESS}, ${SESSION}, 'ws-1', 'pty-1', 'agent-protocol', 'running')`;
        const turn = yield* conversation.submitTurn(
          SESSION,
          PROCESS,
          "why does it flake?",
          "alice",
        );
        expect([turn.intent, turn.intentSource]).toEqual([null, null]);

        const unread = yield* conversation.setTurnIntent(turn.id, {
          intent: null,
          source: "unread",
        });
        expect([unread.intent, unread.intentSource]).toEqual([null, "unread"]);
        yield* conversation.setTurnIntent(turn.id, { intent: "question", source: "read" });
        const [listed] = yield* conversation.listTurns(SESSION);
        expect([listed?.intent, listed?.intentSource]).toEqual(["question", "read"]);

        const missing = yield* conversation
          .setTurnIntent(AgentTurnId.make("t-missing"), {
            intent: "change",
            source: "option",
          })
          .pipe(Effect.flip);
        expect(missing._tag).toBe("AgentTurnNotFoundError");
      }),
    );
  });

  it("lets one worker claim an ended turn, and records what it decided", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const conversation = yield* AgentConversationRepo;
        const landings = yield* ChangeLandingsRepo;
        const turn = yield* conversation.submitTurn(
          SESSION,
          PROCESS,
          "fix the login test",
          "alice",
        );
        expect([turn.landing, turn.landingId]).toEqual([null, null]);

        // An open turn is not claimed: its end has not happened.
        expect(yield* conversation.claimTurnLanding(turn.id)).toBeNull();
        yield* sql`UPDATE agent_turns SET status = 'completed', ended_at = now() WHERE id = ${turn.id}`;
        const [first, second] = yield* Effect.all(
          [conversation.claimTurnLanding(turn.id), conversation.claimTurnLanding(turn.id)],
          { concurrency: 2 },
        );
        expect([first, second].filter((claimed) => claimed !== null)).toHaveLength(1);
        expect(yield* conversation.claimTurnLanding(turn.id)).toBeNull();

        const change = ChangeId.make("c-turn");
        yield* sql`
          INSERT INTO worktree_changes (id, project_id, worktree_id, session_id, branch, base_sha)
          VALUES (${change}, ${PROJECT}, ${WORKTREE}, ${SESSION}, 'mend/fix-login', 'abc')`;
        const landed = yield* landings.record({
          ...landingWith({ outcome: "pushed", pushedSha: sha("e") }),
          changeId: change,
          checkpoint: null,
        });
        const decided = yield* conversation.decideTurnLanding(turn.id, "attempted", landed.id);
        expect([decided.landing, decided.landingId]).toEqual(["attempted", landed.id]);

        // The turn keeps its decision when the landing goes with its change.
        yield* sql`DELETE FROM worktree_changes WHERE id = ${change}`;
        const [kept] = (yield* conversation.listTurns(SESSION)).filter(
          (listed) => listed.id === turn.id,
        );
        expect([kept?.landing, kept?.landingId]).toEqual(["attempted", null]);

        const question = yield* conversation.decideTurnLanding(turn.id, "question", null);
        expect(question.landing).toBe("question");
        const missing = yield* conversation
          .decideTurnLanding(AgentTurnId.make("t-missing"), "skipped", null)
          .pipe(Effect.flip);
        expect(missing._tag).toBe("AgentTurnNotFoundError");
      }),
    );
  });

  it("records each landing with the facts its outcome has, newest first, and refreshes its pull request", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const landings = yield* ChangeLandingsRepo;
        yield* sql`
          INSERT INTO worktree_changes (id, project_id, worktree_id, session_id, branch, base_sha)
          VALUES (${CHANGE}, ${PROJECT}, ${WORKTREE}, ${SESSION}, 'mend/fix-login', 'abc')`;
        yield* sql`
          INSERT INTO checkpoints (id, worktree_id, session_id, ordinal, ref, sha, trigger)
          VALUES (${CHECKPOINT}, ${WORKTREE}, ${SESSION}, 1, 'refs/mend/checkpoints/wt-1/1',
                  ${sha("c")}, 'turn-boundary')`;

        expect(yield* landings.latestForChange(CHANGE)).toBeNull();
        const opened = new Date("2026-09-24T10:00:00.000Z");
        const first = yield* landings.record(
          landingWith({
            outcome: "pull-request",
            pushedSha: sha("e"),
            pullRequest: {
              number: 412,
              url: "https://github.com/acme/api/pull/412",
              state: "open",
              observedAt: opened,
            },
          }),
        );
        expect(first).toMatchObject({
          changeId: CHANGE,
          sessionId: SESSION,
          checkpointId: CHECKPOINT,
          checkpointRef: "refs/mend/checkpoints/wt-1/1",
          checkpointSha: sha("c"),
          commitSha: sha("d"),
          remoteBranch: "mend/fix-login",
          pushedSha: sha("e"),
          trigger: "automatic",
          outcome: "pull-request",
          message: null,
          userId: "alice",
          pullRequest: { number: 412, state: "open", observedAt: opened },
        });

        yield* sql`SELECT pg_sleep(0.01)`;
        const refused = yield* landings.record({
          ...landingWith({
            outcome: "refused",
            message: "! [rejected] mend/fix-login -> mend/fix-login (fetch first)",
          }),
          commitSha: null,
          trigger: "manual",
        });
        expect(refused).toMatchObject({ outcome: "refused", pushedSha: null, pullRequest: null });
        expect(refused.message).toContain("fetch first");

        expect((yield* landings.listForChange(CHANGE)).map((landing) => landing.id)).toEqual([
          refused.id,
          first.id,
        ]);
        expect((yield* landings.latestForChange(CHANGE))?.id).toBe(refused.id);

        const merged = new Date("2026-09-24T11:00:00.000Z");
        const refreshed = yield* landings.observePullRequest(first.id, {
          number: 412,
          url: "https://github.com/acme/api/pull/412",
          state: "merged",
          observedAt: merged,
        });
        expect(refreshed?.pullRequest).toEqual({
          number: 412,
          url: "https://github.com/acme/api/pull/412",
          state: "merged",
          observedAt: merged,
        });
        expect((yield* landings.byId(first.id))?.pullRequest?.state).toBe("merged");
        expect(
          yield* landings.observePullRequest(ChangeLandingId.make("l-none"), {
            number: 1,
            url: "https://github.com/acme/api/pull/1",
            state: "open",
            observedAt: merged,
          }),
        ).toBeNull();

        // A completed tour updates the pull request once, whichever worker claims it first.
        expect(yield* landings.claimTourDescription(first.id, "tour-1")).toBe(true);
        expect(yield* landings.claimTourDescription(first.id, "tour-1")).toBe(false);
        expect(yield* landings.claimTourDescription(first.id, "tour-2")).toBe(true);
        expect(yield* landings.claimTourDescription(ChangeLandingId.make("l-none"), "tour-2")).toBe(
          false,
        );

        // A failure before the checkpoint existed records no checkpoint and nothing pushed.
        const early = yield* landings.record({
          ...landingWith({ outcome: "failed", pushedSha: null, message: "checkpoint failed" }),
          checkpoint: null,
          commitSha: null,
        });
        expect(early).toMatchObject({
          checkpointId: null,
          checkpointRef: null,
          checkpointSha: null,
          pushedSha: null,
          message: "checkpoint failed",
        });

        // The record outlives the session and the checkpoint, and goes with the change.
        yield* sql`DELETE FROM checkpoints WHERE id = ${CHECKPOINT}`;
        const kept = yield* landings.byId(first.id);
        expect([kept?.checkpointId, kept?.checkpointSha]).toEqual([null, sha("c")]);
        yield* sql`DELETE FROM worktree_changes WHERE id = ${CHANGE}`;
        expect(yield* landings.listForChange(CHANGE)).toEqual([]);
      }),
    );
  });
});
