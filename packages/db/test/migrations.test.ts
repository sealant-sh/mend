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
          turnMessages: yield* conversation.turnMessages(turn.id),
          secondTurnMessages: yield* conversation.turnMessages(secondTurn.id),
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
    // The turn's messages: the one message, once, at its latest text.
    expect(result.turnMessages.map((item) => [item.kind, item.text])).toEqual([
      ["assistant-message", "final"],
    ]);
    expect(result.secondTurnMessages).toEqual([]);
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

/** Run a statement that a constraint may refuse, reporting which it was. */
const attempt = (statement: Effect.Effect<unknown, unknown>) =>
  statement.pipe(
    Effect.as("inserted"),
    Effect.catch(() => Effect.succeed("refused")),
  );

describe.skipIf(!reachable)("0055 organizations", () => {
  const ORG_DB = `${SCRATCH_DB}_org`;
  const EMPTY_DB = `${SCRATCH_DB}_org_empty`;
  const layerFor = (database: string) => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${database}`;
    return PgClient.layer({ url: Redacted.make(url.toString()) });
  };
  const withDb =
    (database: string) =>
    <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layerFor(database)), Effect.scoped));

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${ORG_DB}`);
        yield* sql.unsafe(`CREATE DATABASE ${EMPTY_DB}`);
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${ORG_DB} WITH (FORCE)`);
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${EMPTY_DB} WITH (FORCE)`);
      }),
    );
  });

  it("upgrades without widening: one organization, the oldest account owns and operates it, projects stay shared", async () => {
    const result = await withDb(ORG_DB)(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0054_project_install_command");
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
            ('u-middle', 'Middle', 'middle@example.com', '2026-02-01T00:00:00Z'),
            ('u-oldest', 'Oldest', 'oldest@example.com', '2026-01-01T00:00:00Z'),
            ('u-newest', 'Newest', 'newest@example.com', '2026-03-01T00:00:00Z')`;
        yield* sql`
          INSERT INTO projects (id, name, origin_url, store_path, default_branch) VALUES
            ('p-1', 'api', NULL, '/store/api/repo.git', 'main'),
            ('p-2', 'web', NULL, '/store/web/repo.git', 'main')`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'one', 'abc'),
                 ('wt-2', 'p-1', 'two', 'two', 'two', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, owner_user_id, harness, worktree, branch, base_sha, status)
          VALUES ('s-null', 'p-1', 'wt-1', NULL, 'codex', 'one', 'one', 'abc', 'stopped'),
                 ('s-owned', 'p-1', 'wt-2', 'u-newest', 'codex', 'two', 'two', 'abc', 'stopped')`;
        yield* migrations["0055_organizations"];

        const organizations = yield* sql<{
          readonly id: string;
          readonly name: string;
        }>`SELECT id, name FROM organizations`;
        const members = yield* sql<{
          readonly user_id: string;
          readonly role: string;
        }>`SELECT user_id, role FROM organization_members ORDER BY user_id`;
        const operators = yield* sql<{
          readonly user_id: string;
        }>`SELECT user_id FROM instance_roles WHERE role = 'operator'`;
        const projects = yield* sql<{
          readonly id: string;
          readonly organization_id: string;
          readonly visibility: string;
          readonly created_by_user_id: string;
        }>`SELECT id, organization_id, visibility, created_by_user_id FROM projects ORDER BY id`;
        const sessions = yield* sql<{
          readonly id: string;
          readonly owner_user_id: string;
        }>`SELECT id, owner_user_id FROM agent_sessions ORDER BY id`;

        const organizationId = organizations[0]?.id ?? "";
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-other', 'Other')`;
        const sameNameElsewhere = yield* sql`
          INSERT INTO projects (id, name, organization_id, store_path, default_branch)
          VALUES ('p-3', 'api', 'org-other', '/store/p-3/repo.git', 'main')`.pipe(
          Effect.as("inserted"),
          Effect.catch(() => Effect.succeed("refused")),
        );
        const sameNameSameOrganization = yield* sql`
          INSERT INTO projects (id, name, organization_id, store_path, default_branch)
          VALUES ('p-4', 'api', ${organizationId}, '/store/p-4/repo.git', 'main')`.pipe(
          Effect.as("inserted"),
          Effect.catch(() => Effect.succeed("refused")),
        );
        return {
          organizations,
          members,
          operators,
          projects,
          sessions,
          sameNameElsewhere,
          sameNameSameOrganization,
        };
      }),
    );

    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0]?.name).toBe("Default");
    expect(result.members).toEqual([
      { user_id: "u-middle", role: "member" },
      { user_id: "u-newest", role: "member" },
      { user_id: "u-oldest", role: "owner" },
    ]);
    expect(result.operators).toEqual([{ user_id: "u-oldest" }]);
    const organizationId = result.organizations[0]?.id;
    expect(result.projects).toEqual([
      {
        id: "p-1",
        organization_id: organizationId,
        visibility: "shared",
        created_by_user_id: "u-oldest",
      },
      {
        id: "p-2",
        organization_id: organizationId,
        visibility: "shared",
        created_by_user_id: "u-oldest",
      },
    ]);
    expect(result.sessions).toEqual([
      { id: "s-null", owner_user_id: "u-oldest" },
      { id: "s-owned", owner_user_id: "u-newest" },
    ]);
    expect(result.sameNameElsewhere).toBe("inserted");
    expect(result.sameNameSameOrganization).toBe("refused");
  });

  it("creates the organization on an empty database, and new projects need one", async () => {
    const result = await withDb(EMPTY_DB)(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0055_organizations");
        const organizations = yield* sql<{
          readonly id: string;
        }>`SELECT id FROM organizations`;
        const members = yield* sql`SELECT 1 FROM organization_members`;
        const withoutOrganization = yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch)
          VALUES ('p-x', 'x', '/store/p-x/repo.git', 'main')`.pipe(
          Effect.as("inserted"),
          Effect.catch(() => Effect.succeed("refused")),
        );
        return { organizations, members, withoutOrganization };
      }),
    );
    expect(result.organizations).toHaveLength(1);
    expect(result.members).toHaveLength(0);
    expect(result.withoutOrganization).toBe("refused");
  });

  it("the constraints hold the model: roles, one organization per account, consistent invitations, no deletion", async () => {
    const outcomes = await withDb(ORG_DB)(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [organization] = yield* sql<{
          readonly id: string;
        }>`SELECT id FROM organizations WHERE id <> 'org-other' LIMIT 1`;
        const organizationId = organization?.id ?? "";
        return {
          validInvitation: yield* attempt(sql`
            INSERT INTO organization_invitations
              (id, organization_id, token_hash, role, email, created_by_user_id, expires_at)
            VALUES ('inv-0', ${organizationId}, 'h0', 'member', 'carol@example.com', 'u-oldest',
                    now() + interval '1 day')`),
          validAcceptance: yield* attempt(sql`
            UPDATE organization_invitations
            SET accepted_by_user_id = 'u-middle', accepted_at = now() WHERE id = 'inv-0'`),
          badRole: yield* attempt(sql`
            UPDATE organization_members SET role = 'admin' WHERE user_id = 'u-middle'`),
          secondMembership: yield* attempt(sql`
            INSERT INTO organization_members (organization_id, user_id, role)
            VALUES ('org-other', 'u-middle', 'member')`),
          acceptedWithoutAccepter: yield* attempt(sql`
            INSERT INTO organization_invitations
              (id, organization_id, token_hash, role, created_by_user_id, expires_at, accepted_at)
            VALUES ('inv-1', ${organizationId}, 'h1', 'member', 'u-oldest',
                    now() + interval '1 day', now())`),
          acceptedAndRevoked: yield* attempt(sql`
            INSERT INTO organization_invitations
              (id, organization_id, token_hash, role, created_by_user_id, expires_at,
               accepted_by_user_id, accepted_at, revoked_at)
            VALUES ('inv-2', ${organizationId}, 'h2', 'member', 'u-oldest',
                    now() + interval '1 day', 'u-middle', now(), now())`),
          expiredAtBirth: yield* attempt(sql`
            INSERT INTO organization_invitations
              (id, organization_id, token_hash, role, created_by_user_id, expires_at)
            VALUES ('inv-3', ${organizationId}, 'h3', 'member', 'u-oldest', now() - interval '1 day')`),
          unfoldedEmail: yield* attempt(sql`
            INSERT INTO organization_invitations
              (id, organization_id, token_hash, role, email, created_by_user_id, expires_at)
            VALUES ('inv-4', ${organizationId}, 'h4', 'member', 'Carol@Example.com', 'u-oldest',
                    now() + interval '1 day')`),
          deleteMember: yield* attempt(sql`DELETE FROM "user" WHERE id = 'u-middle'`),
          duplicateOrganizationName: yield* attempt(sql`
            INSERT INTO organizations (id, name) VALUES ('org-dup', '  default ')`),
        };
      }),
    );
    expect(outcomes).toEqual({
      validInvitation: "inserted",
      validAcceptance: "inserted",
      badRole: "refused",
      secondMembership: "refused",
      acceptedWithoutAccepter: "refused",
      acceptedAndRevoked: "refused",
      expiredAtBirth: "refused",
      unfoldedEmail: "refused",
      deleteMember: "refused",
      duplicateOrganizationName: "refused",
    });
  });
});

describe.skipIf(!reachable)("0056 per-account resources", () => {
  const RESOURCES_DB = `${SCRATCH_DB}_resources`;
  const resourcesLayer = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${RESOURCES_DB}`;
    return PgClient.layer({ url: Redacted.make(url.toString()) });
  })();
  const withResourcesDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(resourcesLayer), Effect.scoped));

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${RESOURCES_DB}`);
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${RESOURCES_DB} WITH (FORCE)`);
      }),
    );
  });

  it("gives devices to the oldest account and references to the organization", async () => {
    const result = await withResourcesDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0055_organizations");
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
            ('u-new', 'New', 'new@example.com', '2026-02-01T00:00:00Z'),
            ('u-old', 'Old', 'old@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`
          INSERT INTO push_devices (token, platform) VALUES ('tok-1', 'ios'), ('tok-2', 'android')`;
        yield* sql`
          INSERT INTO reference_repos (id, name, origin_url, path)
          VALUES ('ref-1', 'effect', 'https://example.invalid/effect.git', '/store/_references/effect')`;
        yield* migrations["0056_per_account_resources"];
        const devices = yield* sql<{
          readonly token: string;
          readonly user_id: string;
        }>`SELECT token, user_id FROM push_devices ORDER BY token`;
        const references = yield* sql<{
          readonly organization_id: string;
          readonly created_by_user_id: string;
        }>`SELECT organization_id, created_by_user_id FROM reference_repos`;
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-2', 'Second')`;
        const sameNameElsewhere = yield* attempt(sql`
          INSERT INTO reference_repos (id, name, organization_id, origin_url, path)
          VALUES ('ref-2', 'effect', 'org-2', 'https://example.invalid/effect.git', '/store/r2')`);
        const sameNameSameOrganization = yield* attempt(sql`
          INSERT INTO reference_repos (id, name, organization_id, origin_url, path)
          VALUES ('ref-3', 'effect', ${organization?.id ?? ""}, 'https://example.invalid/e.git', '/store/r3')`);
        const deviceWithoutAccount = yield* attempt(
          sql`INSERT INTO push_devices (token, platform) VALUES ('tok-3', 'ios')`,
        );
        return {
          devices,
          references,
          organizationId: organization?.id,
          sameNameElsewhere,
          sameNameSameOrganization,
          deviceWithoutAccount,
        };
      }),
    );
    expect(result.devices).toEqual([
      { token: "tok-1", user_id: "u-old" },
      { token: "tok-2", user_id: "u-old" },
    ]);
    expect(result.references).toEqual([
      { organization_id: result.organizationId, created_by_user_id: "u-old" },
    ]);
    expect(result.sameNameElsewhere).toBe("inserted");
    expect(result.sameNameSameOrganization).toBe("refused");
    expect(result.deviceWithoutAccount).toBe("refused");
  });
});

describe.skipIf(!reachable)("0058 hot pool owners", () => {
  const HOT_DB = `${SCRATCH_DB}_hot`;
  const hotLayer = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${HOT_DB}`;
    return PgClient.layer({ url: Redacted.make(url.toString()) });
  })();
  const withHotDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(hotLayer), Effect.scoped));

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${HOT_DB}`);
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${HOT_DB} WITH (FORCE)`);
      }),
    );
  });

  it("credits ownerless entries to the first account they ran as, and refuses new ones", async () => {
    const result = await withHotDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0057_folders");
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
            ('u-new', 'New', 'new@example.com', '2026-02-01T00:00:00Z'),
            ('u-old', 'Old', 'old@example.com', '2026-01-01T00:00:00Z')`;
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, origin_url, store_path, default_branch, organization_id)
          VALUES ('proj-1', 'fixture', NULL, '/store/proj-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO hot_workspaces (id, project_id, fingerprint, owner_user_id, status)
          VALUES ('hot-legacy', 'proj-1', 'fp', NULL, 'ready'), ('hot-new', 'proj-1', 'fp', 'u-new', 'ready')`;
        yield* migrations["0058_hot_pool_owners"];
        const owners = yield* sql<{
          readonly id: string;
          readonly owner_user_id: string;
        }>`SELECT id, owner_user_id FROM hot_workspaces ORDER BY id`;
        const ownerless = yield* attempt(sql`
          INSERT INTO hot_workspaces (id, project_id, fingerprint) VALUES ('hot-3', 'proj-1', 'fp')`);
        return { owners, ownerless };
      }),
    );
    expect(result).toEqual({
      owners: [
        { id: "hot-legacy", owner_user_id: "u-old" },
        { id: "hot-new", owner_user_id: "u-new" },
      ],
      ownerless: "refused",
    });
  });
});

describe.skipIf(!reachable)("0062 slack", () => {
  const SLACK_DB = `${SCRATCH_DB}_slack`;
  const slackLayer = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${SLACK_DB}`;
    return PgClient.layer({ url: Redacted.make(url.toString()) });
  })();
  const withSlackDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(slackLayer), Effect.scoped));

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SLACK_DB}`);
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SLACK_DB} WITH (FORCE)`);
      }),
    );
  });

  it("marks existing sessions as Mend's, and the keys hold the model: one workspace per organization, links inside it", async () => {
    const result = await withSlackDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0061_upgrade_tickets");
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
            ('u-alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z'),
            ('u-bob', 'Bob', 'bob@example.com', '2026-02-01T00:00:00Z'),
            ('u-carol', 'Carol', 'carol@example.com', '2026-03-01T00:00:00Z')`;
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        const acme = organization?.id ?? "";
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-other', 'Other')`;
        yield* sql`
          INSERT INTO organization_members (organization_id, user_id, role) VALUES
            (${acme}, 'u-alice', 'owner'),
            (${acme}, 'u-bob', 'member'),
            ('org-other', 'u-carol', 'owner')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${acme})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, owner_user_id, harness, worktree, branch, base_sha, status)
          VALUES ('s-old', 'p-1', 'wt-1', 'u-alice', 'codex', 'one', 'mend/one', 'abc', 'stopped')`;
        yield* migrations["0062_slack"];

        const origins = yield* sql<{
          readonly id: string;
          readonly origin: string;
        }>`SELECT id, origin FROM agent_sessions`;
        const unknownOrigin = yield* attempt(sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, origin)
          VALUES ('s-teams', 'p-1', 'wt-1', 'codex', 'one', 'mend/one', 'abc', 'teams')`);

        const install = (organizationId: string, teamId: string, by: string) => sql`
          INSERT INTO slack_installs
            (organization_id, team_id, team_name, bot_user_id, app_id, sealed_app_token,
             sealed_bot_token, web_origin, installed_by_user_id)
          VALUES (${organizationId}, ${teamId}, 'Acme', 'B1', 'A1', 'sealed-app', 'sealed-bot',
                  'https://mend.example', ${by})`;
        yield* install(acme, "T-ACME", "u-alice");
        const [settings] = yield* sql<{
          readonly default_harness: string;
          readonly show_agent_messages: boolean;
          readonly show_diffs: boolean;
          readonly external_channels: boolean;
        }>`SELECT default_harness, show_agent_messages, show_diffs, external_channels
           FROM slack_installs`;
        const sameTeamElsewhere = yield* attempt(install("org-other", "T-ACME", "u-carol"));
        const secondInstall = yield* attempt(install(acme, "T-OTHER", "u-alice"));

        const link = (organizationId: string, slackUserId: string, userId: string) => sql`
          INSERT INTO slack_links (organization_id, team_id, slack_user_id, user_id)
          VALUES (${organizationId}, 'T-ACME', ${slackUserId}, ${userId})`;
        const aliceLinked = yield* attempt(link(acme, "U-ALICE", "u-alice"));
        const bobLinked = yield* attempt(link(acme, "U-BOB", "u-bob"));
        const slackUserTwice = yield* attempt(link(acme, "U-ALICE", "u-bob"));
        const accountTwice = yield* attempt(link(acme, "U-ALICE-2", "u-alice"));
        const outsider = yield* attempt(link(acme, "U-CAROL", "u-carol"));
        const wrongOrganization = yield* attempt(link("org-other", "U-CAROL", "u-carol"));

        yield* sql`
          INSERT INTO slack_link_codes (code_hash, team_id, slack_user_id, request, expires_at)
          VALUES ('hash-1', 'T-ACME', 'U-DAVE', '{}'::jsonb, now() + interval '10 minutes')`;
        yield* sql`
          INSERT INTO slack_channel_defaults (team_id, channel_id, project_id, set_by_user_id)
          VALUES ('T-ACME', 'C-1', 'p-1', 'u-bob')`;
        yield* sql`INSERT INTO slack_user_defaults (user_id, project_id) VALUES ('u-bob', 'p-1')`;
        yield* sql`
          INSERT INTO slack_threads
            (session_id, team_id, channel_id, thread_ts, request_ts, slack_user_id, project_source)
          VALUES ('s-old', 'T-ACME', 'C-1', '1.0', '1.1', 'U-ALICE', 'channel-default')`;
        const sessionInTwoThreads = yield* attempt(sql`
          INSERT INTO slack_threads
            (session_id, team_id, channel_id, thread_ts, request_ts, slack_user_id, project_source)
          VALUES ('s-old', 'T-ACME', 'C-2', '2.0', '2.1', 'U-ALICE', 'message')`);

        // Removing a member removes their link; removing the install removes the rest.
        yield* sql`DELETE FROM organization_members WHERE user_id = 'u-bob'`;
        const linksAfterRemoval = yield* sql<{
          readonly slack_user_id: string;
        }>`SELECT slack_user_id FROM slack_links ORDER BY slack_user_id`;
        yield* sql`DELETE FROM slack_installs WHERE organization_id = ${acme}`;
        const count = (table: string) =>
          sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM ${sql(table)}`.pipe(
            Effect.map((rows) => rows[0]?.n ?? -1),
          );
        const afterUninstall = {
          links: yield* count("slack_links"),
          codes: yield* count("slack_link_codes"),
          channelDefaults: yield* count("slack_channel_defaults"),
          userDefaults: yield* count("slack_user_defaults"),
          threads: yield* count("slack_threads"),
        };
        yield* sql`DELETE FROM agent_sessions WHERE id = 's-old'`;
        const threadsAfterSession = yield* count("slack_threads");

        return {
          origins,
          unknownOrigin,
          settings,
          sameTeamElsewhere,
          secondInstall,
          aliceLinked,
          bobLinked,
          slackUserTwice,
          accountTwice,
          outsider,
          wrongOrganization,
          sessionInTwoThreads,
          linksAfterRemoval,
          afterUninstall,
          threadsAfterSession,
        };
      }),
    );
    expect(result).toEqual({
      origins: [{ id: "s-old", origin: "mend" }],
      unknownOrigin: "refused",
      settings: {
        default_harness: "claude",
        show_agent_messages: true,
        show_diffs: false,
        external_channels: false,
      },
      sameTeamElsewhere: "refused",
      secondInstall: "refused",
      aliceLinked: "inserted",
      bobLinked: "inserted",
      slackUserTwice: "refused",
      accountTwice: "refused",
      // Carol is not a member of the organization that installed the app.
      outsider: "refused",
      // Nor can a link claim another organization's workspace.
      wrongOrganization: "refused",
      sessionInTwoThreads: "refused",
      linksAfterRemoval: [{ slack_user_id: "U-ALICE" }],
      afterUninstall: { links: 0, codes: 0, channelDefaults: 0, userDefaults: 1, threads: 1 },
      threadsAfterSession: 0,
    });
  });
});

describe.skipIf(!reachable)("0063 slack reports", () => {
  const REPORTS_DB = `${SCRATCH_DB}_slack_reports`;
  const reportsLayer = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${REPORTS_DB}`;
    return PgClient.layer({ url: Redacted.make(url.toString()) });
  })();
  const withReportsDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(reportsLayer), Effect.scoped));

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${REPORTS_DB}`);
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${REPORTS_DB} WITH (FORCE)`);
      }),
    );
  });

  it("reads an earlier thread as external with nothing reported, and posts go with the session", async () => {
    const result = await withReportsDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0062_slack");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status, origin)
          VALUES ('s-1', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running', 'slack')`;
        yield* sql`
          INSERT INTO slack_threads
            (session_id, team_id, channel_id, thread_ts, request_ts, slack_user_id, project_source)
          VALUES ('s-1', 'T-ACME', 'C-1', '1.0', '1.1', 'U-ALICE', 'message')`;
        yield* migrations["0063_slack_reports"];

        const [thread] = yield* sql<{
          readonly external: boolean;
          readonly reported_state: string | null;
          readonly reported_status: string | null;
        }>`SELECT external, reported_state, reported_status FROM slack_threads`;
        const post = () =>
          attempt(sql`INSERT INTO slack_thread_posts (session_id, key) VALUES ('s-1', 'plan')`);
        const first = yield* post();
        const again = yield* post();
        const orphan = yield* attempt(
          sql`INSERT INTO slack_thread_posts (session_id, key) VALUES ('s-none', 'plan')`,
        );
        yield* sql`DELETE FROM agent_sessions WHERE id = 's-1'`;
        const [left] = yield* sql<{
          readonly n: number;
        }>`SELECT count(*)::int AS n FROM slack_thread_posts`;
        return { thread, first, again, orphan, postsAfterSession: left?.n ?? -1 };
      }),
    );
    expect(result).toEqual({
      thread: { external: true, reported_state: null, reported_status: null },
      first: "inserted",
      again: "refused",
      orphan: "refused",
      postsAfterSession: 0,
    });
  });
});
