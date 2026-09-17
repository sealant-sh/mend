import { PgClient } from "@effect/sql-pg";
import { SessionId, SessionProcessId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentConversationRepoLive,
  AgentConversationRepo,
} from "../src/repos/agent-conversation.ts";

/**
 * Migration tests run against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway
 * database; without one reachable they skip rather than pretend. Set MEND_TEST_DATABASE_URL to
 * point elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_migration_test_${process.pid}_${Date.now()}`;

const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const withScratch = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(scratchLayer), Effect.scoped));
const scratchDatabaseLayer = MendDBLive.pipe(Layer.provideMerge(scratchLayer));
const scratchConversationLayer = AgentConversationRepoLive.pipe(
  Layer.provide(scratchDatabaseLayer),
);
const withConversation = <A, E>(effect: Effect.Effect<A, E, AgentConversationRepo>) =>
  Effect.runPromise(effect.pipe(Effect.provide(scratchConversationLayer), Effect.scoped));

// The layer itself fails to build when nothing listens, so the guard sits outside the Effect.
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

const ORDERED = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
const upTo = (last: string) =>
  Effect.forEach(
    ORDERED.filter(([name]) => name <= last),
    ([, migration]) => migration,
    { discard: true },
  );

describe.skipIf(!reachable)("0035 process kinds and 0036 agent conversation", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
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

  it("backfills agent rows to agent-pty with the harness read off argv and the provider id on the newest", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0034_workspace_ttl_renewal");
        yield* sql`
          INSERT INTO projects (id, name, origin_url, store_path, default_branch)
          VALUES ('proj-1', 'fixture', NULL, '/store/fixture/repo.git', 'main')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, harness, provider_session_id, worktree, branch, base_sha, status)
          VALUES
            ('sess-claude', 'proj-1', 'claude', 'claude-provider-id', 'wt-1', 'b-1', 'abc', 'completed'),
            ('sess-codex', 'proj-1', 'codex', NULL, 'wt-2', 'b-2', 'abc', 'completed')`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, label, argv, status, created_at)
          VALUES
            ('p-claude-1', 'sess-claude', 'ws-1', 'pty-1', 'agent', 'claude',
             '["sh","-c","seed","sh","claude","--dangerously-skip-permissions"]', 'exited',
             '2026-08-01T00:00:00Z'),
            ('p-claude-2', 'sess-claude', 'ws-2', 'pty-2', 'agent', 'claude',
             '["zsh"]', 'exited', '2026-08-02T00:00:00Z'),
            ('p-claude-3', 'sess-claude', 'ws-3', 'pty-3', 'agent', 'claude',
             '["sh","-c","decode","sh","YWJj"]', 'exited', '2026-08-03T00:00:00Z'),
            ('p-codex-1', 'sess-codex', 'ws-4', 'pty-4', 'agent', 'codex',
             '["codex","--dangerously-bypass-approvals-and-sandbox"]', 'running',
             '2026-08-01T00:00:00Z'),
            ('p-shell-1', 'sess-codex', 'ws-4', 'pty-5', 'shell', 'shell 1', '["zsh"]', 'running',
             '2026-08-01T00:00:00Z'),
            ('p-service-1', 'sess-codex', 'ws-4', NULL, 'service', 'web', '["pnpm","dev"]',
             'reachable', '2026-08-01T00:00:00Z')`;
        yield* migrations["0035_session_process_kinds"];
        return yield* sql<{
          readonly id: string;
          readonly kind: string;
          readonly harness: string | null;
          readonly provider_session_id: string | null;
        }>`SELECT id, kind, harness, provider_session_id FROM session_processes ORDER BY id`;
      }),
    );
    expect(rows).toEqual([
      { id: "p-claude-1", kind: "agent-pty", harness: "claude", provider_session_id: null },
      { id: "p-claude-2", kind: "agent-pty", harness: "shell", provider_session_id: null },
      // The follow-up transport hides the command inside `sh -c`; the label is the fallback,
      // and the session's provider id lands on the NEWEST agent process.
      {
        id: "p-claude-3",
        kind: "agent-pty",
        harness: "claude",
        provider_session_id: "claude-provider-id",
      },
      { id: "p-codex-1", kind: "agent-pty", harness: "codex", provider_session_id: null },
      { id: "p-service-1", kind: "service", harness: null, provider_session_id: null },
      { id: "p-shell-1", kind: "shell", harness: null, provider_session_id: null },
    ]);
  });

  it("keeps provider item identity and sequence stable when protocol output replays", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrations["0036_agent_conversation"];
        yield* sql`
          INSERT INTO agent_turns
            (id, session_id, process_id, ordinal, author, input, status, provider_turn_id)
          VALUES
            ('turn-1', 'sess-codex', 'p-codex-1', 0, 'user-1', 'inspect replay', 'running', 'provider-turn-1')`;
        yield* sql`
          INSERT INTO agent_items
            (id, session_id, process_id, turn_id, seq, provider_item_id,
             provider_output_process_id, provider_output_seq, provider_event_index, kind, status, text)
          VALUES
            ('item-1', 'sess-codex', 'p-codex-1', 'turn-1', 1, 'provider-item-1',
             'p-codex-1', 5, 0, 'assistant-message', 'in-progress', 'first')
          ON CONFLICT (process_id, provider_item_id) DO UPDATE
          SET status = EXCLUDED.status, text = EXCLUDED.text, updated_at = now()`;
        yield* sql`
          INSERT INTO agent_items
            (id, session_id, process_id, turn_id, seq, provider_item_id,
             provider_output_process_id, provider_output_seq, provider_event_index, kind, status, text)
          VALUES
            ('item-replay', 'sess-codex', 'p-codex-1', 'turn-1', 99, 'provider-item-1',
             'p-codex-1', 5, 0, 'assistant-message', 'completed', 'final')
          ON CONFLICT (process_id, provider_item_id) DO UPDATE
          SET status = EXCLUDED.status, text = EXCLUDED.text, updated_at = now()`;
        return yield* sql<{
          readonly id: string;
          readonly seq: number;
          readonly provider_item_id: string;
          readonly status: string;
          readonly text: string;
        }>`SELECT id, seq, provider_item_id, status, text FROM agent_items ORDER BY seq`;
      }),
    );
    expect(rows).toEqual([
      {
        id: "item-1",
        seq: 1,
        provider_item_id: "provider-item-1",
        status: "completed",
        text: "final",
      },
    ]);
  });

  it("preserves item id and seq through repository replay and cursor pagination", async () => {
    await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_turns SET status = 'completed' WHERE id = 'turn-1'`;
      }),
    );
    const result = await withConversation(
      Effect.gen(function* () {
        const conversation = yield* AgentConversationRepo;
        const sessionId = SessionId.make("sess-codex");
        const processId = SessionProcessId.make("p-codex-1");
        const turn = yield* conversation.submitTurn(sessionId, processId, "replay", "user-1");
        const running = yield* conversation.claimNextTurn(processId);
        if (running === null) return yield* Effect.die("turn was not claimed");
        const bound = yield* conversation.bindRunningProviderTurn(
          sessionId,
          processId,
          "provider-turn-repository",
        );
        if (bound?.id !== turn.id) return yield* Effect.die("provider turn was not bound");
        const secondTurn = yield* conversation.submitTurn(
          sessionId,
          processId,
          "queued second",
          "user-2",
        );
        const whileBusy = yield* conversation.claimNextTurn(processId);
        const first = yield* conversation.upsertItem({
          sessionId,
          processId,
          turnId: turn.id,
          providerItemId: "provider-item-repository",
          providerTurnId: "provider-turn-repository",
          providerOutputSeq: 10n,
          providerEventIndex: 0,
          kind: "assistant-message",
          status: "in-progress",
          title: null,
          text: "partial",
          data: null,
        });
        const updated = yield* conversation.upsertItem({
          sessionId,
          processId,
          turnId: turn.id,
          providerItemId: "provider-item-repository",
          providerTurnId: "provider-turn-repository",
          providerOutputSeq: 11n,
          providerEventIndex: 0,
          kind: "assistant-message",
          status: "completed",
          title: null,
          text: "final",
          data: null,
        });
        const replayed = yield* conversation.upsertItem({
          sessionId,
          processId,
          turnId: turn.id,
          providerItemId: "provider-item-repository",
          providerTurnId: "provider-turn-repository",
          providerOutputSeq: 11n,
          providerEventIndex: 0,
          kind: "assistant-message",
          status: "completed",
          title: null,
          text: "final",
          data: null,
        });
        const request = yield* conversation.openRequest({
          sessionId,
          processId,
          turnId: turn.id,
          providerRequestId: "provider-request-repository",
          providerTurnId: "provider-turn-repository",
          providerItemId: "provider-item-repository",
          kind: "command-approval",
          title: "pnpm test",
          detail: { command: ["pnpm", "test"] },
          questions: null,
        });
        const pendingBefore = yield* conversation.hasPendingRequests(sessionId);
        const resolved = yield* conversation.resolveRequest(
          request.id,
          { decision: "accept" },
          "user-2",
        );
        const pendingAfter = yield* conversation.hasPendingRequests(sessionId);
        const raceRequest = yield* conversation.openRequest({
          sessionId,
          processId,
          turnId: turn.id,
          providerRequestId: "provider-request-race",
          providerTurnId: "provider-turn-repository",
          providerItemId: null,
          kind: "tool-permission",
          title: "tool",
          detail: null,
          questions: null,
        });
        yield* conversation.prepareRequestResponse(
          raceRequest.id,
          { decision: "accept" },
          "user-race",
        );
        yield* conversation.cancelOpenForTurn(turn.id);
        const raceResolved = yield* conversation.completeRequestResponse(raceRequest.id);
        yield* conversation.completeTurn(
          "provider-turn-repository",
          sessionId,
          "completed",
          null,
          null,
        );
        const claimedSecond = yield* conversation.claimNextTurn(processId);
        const deliveryRequest = yield* conversation.openRequest({
          sessionId,
          processId,
          turnId: secondTurn.id,
          providerRequestId: "provider-request-delivery",
          providerTurnId: "provider-turn-delivery",
          providerItemId: null,
          kind: "tool-permission",
          title: "tool",
          detail: null,
          questions: null,
        });
        yield* conversation.prepareRequestResponse(
          deliveryRequest.id,
          { decision: "accept" },
          "user-3",
        );
        yield* conversation.failRequestResponse(deliveryRequest.id);
        yield* conversation.cancelOpenForProcess(processId);
        const cancelledDecision = yield* conversation.byRequestId(deliveryRequest.id);
        const systemTurn = yield* conversation.submitTurn(
          sessionId,
          processId,
          "follow-up",
          null,
          "follow-up:1",
        );
        const replayedSystemTurn = yield* conversation.submitTurn(
          sessionId,
          processId,
          "follow-up",
          null,
          "follow-up:1",
        );
        return {
          first,
          updated,
          replayed,
          secondTurn,
          whileBusy,
          claimedSecond,
          pendingBefore,
          pendingAfter,
          resolved,
          raceResolved,
          cancelledDecision,
          systemTurn,
          replayedSystemTurn,
          page: yield* conversation.listItems(sessionId, first.seq, 100),
          after: yield* conversation.listItems(sessionId, updated.seq, 100),
        };
      }),
    );
    expect(result.whileBusy).toBeNull();
    expect(result.claimedSecond?.id).toBe(result.secondTurn.id);
    expect(result.pendingBefore).toBe(true);
    expect(result.pendingAfter).toBe(false);
    expect(result.resolved.decidedBy).toBe("user-2");
    expect(result.raceResolved.status).toBe("resolved");
    expect(result.raceResolved.decision).toBe("accept");
    expect(result.cancelledDecision?.status).toBe("cancelled");
    expect(result.cancelledDecision?.decision).toBe("accept");
    expect(result.cancelledDecision?.decidedBy).toBe("user-3");
    expect(result.replayedSystemTurn.id).toBe(result.systemTurn.id);
    expect(result.updated.id).toBe(result.first.id);
    expect(result.updated.seq).toBeGreaterThan(result.first.seq);
    expect(result.replayed.id).toBe(result.updated.id);
    expect(result.replayed.seq).toBe(result.updated.seq);
    expect(result.replayed.text).toBe("final");
    expect(
      result.page.filter((item) => item.providerItemId === "provider-item-repository"),
    ).toHaveLength(1);
    expect(result.after).toEqual([]);
  });
});

describe.skipIf(!reachable)("0052 project skill inheritance", () => {
  const SETTINGS_DB = `${SCRATCH_DB}_skill_inheritance`;
  const settingsUrl = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${SETTINGS_DB}`;
    return url.toString();
  })();
  const settingsLayer = PgClient.layer({ url: Redacted.make(settingsUrl) });
  const withSettingsDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(settingsLayer), Effect.scoped));

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SETTINGS_DB}`);
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SETTINGS_DB} WITH (FORCE)`);
      }),
    );
  });

  it("defaults existing and new projects to inheriting user skills", async () => {
    const rows = await withSettingsDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0051_user_git_access");
        yield* sql`
          INSERT INTO projects (id, name, origin_url, store_path, default_branch)
          VALUES ('project-existing', 'existing', NULL, '/store/existing/repo.git', 'main')`;
        yield* migrations["0052_project_inherit_user_skills"];
        yield* sql`
          INSERT INTO projects (id, name, origin_url, store_path, default_branch)
          VALUES ('project-new', 'new', NULL, '/store/new/repo.git', 'main')`;
        return yield* sql<{
          readonly id: string;
          readonly inherit_user_skills: boolean;
        }>`SELECT id, inherit_user_skills FROM projects ORDER BY id`;
      }),
    );
    expect(rows).toEqual([
      { id: "project-existing", inherit_user_skills: true },
      { id: "project-new", inherit_user_skills: true },
    ]);
  });
});

describe.skipIf(!reachable)("0046 worktree containers", () => {
  const WORKTREE_DB = `${SCRATCH_DB}_wt`;
  const worktreeUrl = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${WORKTREE_DB}`;
    return url.toString();
  })();
  const worktreeLayer = PgClient.layer({ url: Redacted.make(worktreeUrl) });
  const withWorktreeDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(worktreeLayer), Effect.scoped));

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${WORKTREE_DB}`);
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${WORKTREE_DB} WITH (FORCE)`);
      }),
    );
  });

  it("mints one worktree per session, re-keys the change and chain, and flips the destructive FKs", async () => {
    const result = await withWorktreeDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0045_native_ingest_cursor");
        yield* sql`
          INSERT INTO projects (id, name, origin_url, store_path, default_branch)
          VALUES ('proj-1', 'fixture', NULL, '/store/fixture/repo.git', 'main')`;
        // sess-a and sess-b own distinct worktrees; sess-c defensively SHARES
        // sess-a's directory (the collapse path).
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, harness, worktree, branch, base_sha, base_ref, status, created_at)
          VALUES
            ('sess-a', 'proj-1', 'claude', 'fix-auth', 'mend/fix-auth', 'base-a', 'main', 'completed', '2026-08-01T00:00:00Z'),
            ('sess-b', 'proj-1', 'codex', 'session-b', 'mend/session/b', 'base-b', NULL, 'completed', '2026-08-02T00:00:00Z'),
            ('sess-c', 'proj-1', 'claude', 'fix-auth', 'mend/fix-auth', 'base-a', 'main', 'completed', '2026-08-03T00:00:00Z')`;
        yield* sql`
          INSERT INTO session_changes (id, project_id, session_id, branch, base_sha, created_at)
          VALUES
            ('chg-a', 'proj-1', 'sess-a', 'mend/fix-auth', 'base-a', '2026-08-01T00:00:00Z'),
            ('chg-b', 'proj-1', 'sess-b', 'mend/session/b', 'base-b', '2026-08-02T00:00:00Z'),
            ('chg-c', 'proj-1', 'sess-c', 'mend/fix-auth', 'base-a', '2026-08-03T00:00:00Z')`;
        yield* sql`
          INSERT INTO checkpoints (id, session_id, ref, sha, seq, trigger, created_at)
          VALUES
            ('cp-a0', 'sess-a', 'refs/mend/checkpoints/sess-a/0', 'sha-a0', 0, 'session-start', '2026-08-01T00:00:00Z'),
            ('cp-a1', 'sess-a', 'refs/mend/checkpoints/sess-a/1', 'sha-a1', 5, 'command-settle', '2026-08-01T01:00:00Z'),
            ('cp-b0', 'sess-b', 'refs/mend/checkpoints/sess-b/0', 'sha-b0', 0, 'session-start', '2026-08-02T00:00:00Z'),
            ('cp-c0', 'sess-c', 'refs/mend/checkpoints/sess-c/0', 'sha-c0', 0, 'session-start', '2026-08-03T00:00:00Z')`;
        // A follow-up and a comment hang off the DUPLICATE change (chg-c) so the
        // dedupe re-point is observable.
        yield* sql`
          INSERT INTO follow_ups (id, session_id, change_id, instruction)
          VALUES ('fu-1', 'sess-c', 'chg-c', 'address the review')`;
        yield* sql`
          INSERT INTO review_comments (id, change_id, author_kind, author_name, file, body)
          VALUES ('rc-1', 'chg-c', 'human', 'yiannis', 'src/auth.ts', 'tighten this')`;
        yield* sql`
          INSERT INTO hot_workspaces (id, project_id, fingerprint, worktree, branch, base_sha)
          VALUES ('hot-1', 'proj-1', 'fp', 'session-hot', 'mend/session/hot', 'base-h')`;

        yield* migrations["0046_worktrees"];

        const worktrees = yield* sql<{
          readonly name: string;
          readonly directory: string;
          readonly base_ref: string | null;
        }>`SELECT name, directory, base_ref FROM worktrees ORDER BY name`;
        const sessions = yield* sql<{
          readonly id: string;
          readonly worktree_id: string;
        }>`SELECT id, worktree_id FROM agent_sessions ORDER BY id`;
        const changes = yield* sql<{
          readonly id: string;
          readonly session_id: string | null;
          readonly worktree_id: string;
        }>`SELECT id, session_id, worktree_id FROM worktree_changes ORDER BY id`;
        const ordinals = yield* sql<{
          readonly id: string;
          readonly worktree_id: string;
          readonly ordinal: number;
        }>`SELECT id, worktree_id, ordinal FROM checkpoints ORDER BY worktree_id, ordinal`;
        const followUp = yield* sql<{
          readonly change_id: string;
        }>`SELECT change_id FROM follow_ups WHERE id = 'fu-1'`;
        const comment = yield* sql<{
          readonly change_id: string;
        }>`SELECT change_id FROM review_comments WHERE id = 'rc-1'`;
        const hot = yield* sql<{
          readonly worktree_id: string | null;
        }>`SELECT worktree_id FROM hot_workspaces WHERE id = 'hot-1'`;

        // The destructive-FK flip: deleting a conversation leaves the worktree's
        // change and chain standing, session pointers nulled.
        yield* sql`DELETE FROM agent_sessions WHERE id = 'sess-a'`;
        const afterDelete = yield* sql<{
          readonly change_session: string | null;
          readonly checkpoints: string;
        }>`
          SELECT
            (SELECT session_id FROM worktree_changes WHERE id = 'chg-a') AS change_session,
            (SELECT count(*)::text FROM checkpoints
              WHERE worktree_id = (SELECT worktree_id FROM worktree_changes WHERE id = 'chg-a')) AS checkpoints`;

        return { worktrees, sessions, changes, ordinals, followUp, comment, hot, afterDelete };
      }),
    );

    // Shared directory collapsed: two worktrees, not three; earliest metadata won.
    expect(result.worktrees).toEqual([
      { name: "fix-auth", directory: "fix-auth", base_ref: "main" },
      { name: "session-b", directory: "session-b", base_ref: null },
    ]);
    const byId = new Map(result.sessions.map((row) => [row.id, row.worktree_id]));
    expect(byId.get("sess-a")).toBe(byId.get("sess-c"));
    expect(byId.get("sess-a")).not.toBe(byId.get("sess-b"));

    // One change per worktree: chg-c (the duplicate) went, its dependents re-pointed.
    expect(result.changes.map((row) => row.id)).toEqual(["chg-a", "chg-b"]);
    expect(result.followUp[0]?.change_id).toBe("chg-a");
    expect(result.comment[0]?.change_id).toBe("chg-a");

    // Dense per-worktree ordinals ordered by creation time across sessions.
    const sharedWorktree = byId.get("sess-a");
    expect(
      result.ordinals
        .filter((row) => row.worktree_id === sharedWorktree)
        .map((row) => [row.id, row.ordinal]),
    ).toEqual([
      ["cp-a0", 0],
      ["cp-a1", 1],
      ["cp-c0", 2],
    ]);

    // Legacy pool entries read as stale.
    expect(result.hot[0]?.worktree_id).toBeNull();

    // The chain and the change outlive the conversation.
    expect(result.afterDelete[0]?.change_session).toBeNull();
    expect(result.afterDelete[0]?.checkpoints).toBe("3");
  });
});

describe.skipIf(!reachable)("0053 teams and project scope", () => {
  const SOLO_DB = `${SCRATCH_DB}_teams_solo`;
  const MANY_DB = `${SCRATCH_DB}_teams_many`;
  const layerFor = (name: string) => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    return PgClient.layer({ url: Redacted.make(url.toString()) });
  };
  const withDb = <A, E>(name: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layerFor(name)), Effect.scoped));

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SOLO_DB}`);
        yield* sql.unsafe(`CREATE DATABASE ${MANY_DB}`);
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SOLO_DB} WITH (FORCE)`);
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${MANY_DB} WITH (FORCE)`);
      }),
    );
  });

  const seed = (users: ReadonlyArray<readonly [string, string]>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* upTo("0052_project_inherit_user_skills");
      for (const [id, email] of users) {
        yield* sql`INSERT INTO "user" ("id", "name", "email") VALUES (${id}, ${id}, ${email})`;
      }
      yield* sql`
        INSERT INTO projects (id, name, origin_url, store_path, default_branch)
        VALUES ('project-a', 'a', NULL, '/store/a/repo.git', 'main'),
               ('project-b', 'b', NULL, '/store/b/repo.git', 'main')`;
      yield* migrations["0053_teams"];
      return yield* sql<{
        readonly id: string;
        readonly team_id: string | null;
        readonly owner_user_id: string | null;
      }>`SELECT id, team_id, owner_user_id FROM projects ORDER BY id`;
    });

  it("a single account takes ownership of every existing project", async () => {
    const rows = await withDb(SOLO_DB, seed([["only", "only@example.com"]]));
    expect(rows).toEqual([
      { id: "project-a", team_id: null, owner_user_id: "only" },
      { id: "project-b", team_id: null, owner_user_id: "only" },
    ]);
  });

  it("several accounts keep every existing project instance-wide, and the FKs hold", async () => {
    const result = await withDb(
      MANY_DB,
      Effect.gen(function* () {
        const rows = yield* seed([
          ["one", "one@example.com"],
          ["two", "two@example.com"],
        ]);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO teams (id, name, created_by) VALUES ('team-1', 'Team', 'one')`;
        yield* sql`
          INSERT INTO team_members (team_id, user_id, role) VALUES ('team-1', 'one', 'owner')`;
        yield* sql`UPDATE projects SET team_id = 'team-1' WHERE id = 'project-a'`;
        // RESTRICT: a team with projects cannot be deleted underneath them.
        const restricted = yield* sql`DELETE FROM teams WHERE id = 'team-1'`.pipe(Effect.result);
        // SET NULL: a deleted account's personal project becomes an instance project.
        yield* sql`UPDATE projects SET owner_user_id = 'two' WHERE id = 'project-b'`;
        yield* sql`DELETE FROM "user" WHERE id = 'two'`;
        const after = yield* sql<{
          readonly id: string;
          readonly team_id: string | null;
          readonly owner_user_id: string | null;
        }>`SELECT id, team_id, owner_user_id FROM projects ORDER BY id`;
        return { rows, restricted, after };
      }),
    );
    expect(result.rows).toEqual([
      { id: "project-a", team_id: null, owner_user_id: null },
      { id: "project-b", team_id: null, owner_user_id: null },
    ]);
    expect(result.restricted._tag).toBe("Failure");
    expect(result.after).toEqual([
      { id: "project-a", team_id: "team-1", owner_user_id: null },
      { id: "project-b", team_id: null, owner_user_id: null },
    ]);
  });
});
