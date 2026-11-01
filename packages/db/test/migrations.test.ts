import { PgClient } from "@effect/sql-pg";
import { HARNESS_MODEL_SEED, OPENCODE_DEFAULT_MODEL } from "@mend/domain/workbench";
import { Effect, Redacted, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import { postgresTestConfig } from "./postgres.ts";

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
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
const ORDERED = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
const upTo = (last: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.forEach(
        ORDERED.filter(([name]) => name <= last),
        ([, migration]) => migration,
        { discard: true },
      ),
    );
  });

/**
 * DROP DATABASE forces a server-wide checkpoint, which takes seconds while other test files write.
 */
const emptyScratch = () =>
  withScratch(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP SCHEMA public CASCADE`;
      yield* sql`CREATE SCHEMA public`;
    }),
  );

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

describe.skipIf(postgres.skip)("conversation migration boundaries: 0035, 0036 and 0107", () => {
  beforeEach(emptyScratch);
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
        yield* upTo("0035_session_process_kinds");
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch)
          VALUES ('proj-1','fixture','/store/fixture/repo.git','main')`;
        yield* sql`INSERT INTO agent_sessions (id,project_id,harness,worktree,branch,base_sha,status)
          VALUES ('sess-codex','proj-1','codex','fixture','mend/fixture',${"a".repeat(40)},'running')`;
        yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status)
          VALUES ('p-codex-1','sess-codex','ws-1','agent-protocol','codex','running')`;
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
    const refusals = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          duplicateProvider: yield* attempt(sql`INSERT INTO agent_items
          (id,session_id,process_id,turn_id,seq,provider_item_id,provider_output_process_id,provider_output_seq,provider_event_index,kind,status)
          VALUES ('duplicate-provider','sess-codex','p-codex-1','turn-1',2,'provider-item-1','p-codex-1',6,0,'assistant-message','completed')`),
          duplicateSequence: yield* attempt(sql`INSERT INTO agent_items
          (id,session_id,process_id,turn_id,seq,provider_item_id,provider_output_process_id,provider_output_seq,provider_event_index,kind,status)
          VALUES ('duplicate-seq','sess-codex','p-codex-1','turn-1',1,'new-provider-item','p-codex-1',6,0,'assistant-message','completed')`),
          admitted: yield* sql`INSERT INTO agent_items
            (id,session_id,process_id,turn_id,seq,provider_item_id,provider_output_process_id,provider_output_seq,provider_event_index,kind,status)
            VALUES ('distinct-item','sess-codex','p-codex-1','turn-1',2,'new-provider-item','p-codex-1',6,0,'assistant-message','completed') RETURNING id`,
        };
      }),
    );
    expect(refusals).toEqual({
      admitted: [{ id: "distinct-item" }],
      duplicateProvider: { code: "23505", constraint: "agent_items_process_provider_key" },
      duplicateSequence: { code: "23505", constraint: "agent_items_session_seq_key" },
    });
  });

  it("0107 preserves old turn data with unknown payer and enforces named payer references", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0106_terminal_watch_control");
        const fixture = yield* seedMigrationSession("payer");
        yield* sql`INSERT INTO "user" (id,name,email,"createdAt")
        VALUES ('payer-billing','Billing account','billing@example.invalid','2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status)
        VALUES ('payer-process',${fixture.session},'ws-payer','agent-protocol','claude','running')`;
        yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,author,input,status)
        VALUES ('payer-old',${fixture.session},'payer-process',1,${fixture.actor},'historic input','completed')`;
        yield* migrations["0107_turn_payer"];
        const before =
          yield* sql`SELECT id,author,input,billed_user_id,billed_account_id,billed_account_name
        FROM agent_turns WHERE id='payer-old'`;
        yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,input,status)
        VALUES ('payer-new',${fixture.session},'payer-process',2,'new input','queued')`;
        const fresh =
          yield* sql`SELECT billed_user_id,billed_account_id,billed_account_name FROM agent_turns WHERE id='payer-new'`;
        yield* sql`UPDATE agent_turns SET billed_user_id='payer-billing',billed_account_id='account-1',billed_account_name='default' WHERE id='payer-old'`;
        const recorded =
          yield* sql`SELECT billed_user_id,billed_account_id,billed_account_name FROM agent_turns WHERE id='payer-old'`;
        return {
          before,
          fresh,
          recorded,
          unknownPayer: yield* attempt(
            sql`UPDATE agent_turns SET billed_user_id='missing-payer' WHERE id='payer-old'`,
          ),
          deletePayer: yield* attempt(sql`DELETE FROM "user" WHERE id='payer-billing'`),
        };
      }),
    );
    expect(result).toEqual({
      before: [
        {
          id: "payer-old",
          author: "payer-actor",
          input: "historic input",
          billed_user_id: null,
          billed_account_id: null,
          billed_account_name: null,
        },
      ],
      fresh: [{ billed_user_id: null, billed_account_id: null, billed_account_name: null }],
      recorded: [
        {
          billed_user_id: "payer-billing",
          billed_account_id: "account-1",
          billed_account_name: "default",
        },
      ],
      unknownPayer: { code: "23503", constraint: "agent_turns_billed_user_id_fkey" },
      deletePayer: { code: "23503", constraint: "agent_turns_billed_user_id_fkey" },
    });
  });
});

describe.skipIf(postgres.skip)("0052 project skill inheritance", () => {
  beforeAll(emptyScratch);

  it("defaults existing and new projects to inheriting user skills", async () => {
    const rows = await withScratch(
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

describe.skipIf(postgres.skip)("0110 automatic install", () => {
  beforeAll(emptyScratch);

  it("turns automatic install on for existing and new projects, and keeps a saved command", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0109_opencode_models");
        yield* sql`
          INSERT INTO organizations (id, name) VALUES ('org-install', 'Install')`;
        yield* sql`
          INSERT INTO projects (id, organization_id, name, origin_url, store_path, default_branch, install_command)
          VALUES ('project-existing', 'org-install', 'existing', NULL, '/store/existing/repo.git', 'main', 'make deps')`;
        yield* migrations["0110_project_install_enabled"];
        yield* sql`
          INSERT INTO projects (id, organization_id, name, origin_url, store_path, default_branch)
          VALUES ('project-new', 'org-install', 'new', NULL, '/store/new/repo.git', 'main')`;
        return yield* sql<{
          readonly id: string;
          readonly install_enabled: boolean;
          readonly install_command: string | null;
        }>`SELECT id, install_enabled, install_command FROM projects ORDER BY id`;
      }),
    );
    expect(rows).toEqual([
      { id: "project-existing", install_enabled: true, install_command: "make deps" },
      { id: "project-new", install_enabled: true, install_command: null },
    ]);
  });
});

describe.skipIf(postgres.skip)("0111 agent memory homes", () => {
  beforeAll(emptyScratch);

  it("comes after 0110 and records a home per worktree that outlives its person and goes with its worktree", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0110_project_install_enabled");
        yield* migrations["0111_agent_memory_homes"];
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
            ('u-maria', 'Maria', 'maria@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-homes', 'Homes')`;
        yield* sql`
          INSERT INTO projects (id, organization_id, name, store_path, default_branch)
          VALUES ('p-homes', 'org-homes', 'homes', '/store/homes/repo.git', 'main')`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha) VALUES
            ('wt-kept', 'p-homes', 'kept', 'kept', 'mend/kept', 'abc'),
            ('wt-gone', 'p-homes', 'gone', 'gone', 'mend/gone', 'abc')`;
        yield* sql`
          INSERT INTO agent_memory_homes
            (worktree_id, user_id, session_id, workspace_id, pending_user_id, pending_epoch) VALUES
            ('wt-kept', 'u-maria', 's-removed', 'ws-1', 'u-maria', 4),
            ('wt-gone', 'u-maria', 's-other', 'ws-2', NULL, NULL)`;
        yield* sql`DELETE FROM "user" WHERE id = 'u-maria'`;
        yield* sql`DELETE FROM worktrees WHERE id = 'wt-gone'`;
        return yield* sql<{
          readonly worktree_id: string;
          readonly user_id: string | null;
          readonly session_id: string | null;
          readonly pending_user_id: string | null;
        }>`SELECT worktree_id, user_id, session_id, pending_user_id FROM agent_memory_homes ORDER BY worktree_id`;
      }),
    );
    expect(rows).toEqual([
      { worktree_id: "wt-kept", user_id: null, session_id: "s-removed", pending_user_id: null },
    ]);
  });
});

describe.skipIf(postgres.skip)("0046 worktree containers", () => {
  beforeAll(emptyScratch);

  it("mints one worktree per session, re-keys the change and chain, and flips the destructive FKs", async () => {
    const result = await withScratch(
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

const ConstraintDiagnostic = Schema.Struct({
  code: Schema.String,
  constraint: Schema.optional(Schema.String),
  column: Schema.optional(Schema.String),
});

/** Preserve PostgreSQL's refusal identity; unexpected SQL errors cannot satisfy a constraint check. */
const attempt = (statement: Effect.Effect<unknown, SqlError>) =>
  statement.pipe(
    Effect.as("inserted"),
    Effect.catch((error) =>
      Effect.sync(() => {
        const diagnostic = Schema.decodeUnknownSync(ConstraintDiagnostic)(error.reason.cause);
        return diagnostic.constraint === undefined
          ? { code: diagnostic.code, column: diagnostic.column }
          : { code: diagnostic.code, constraint: diagnostic.constraint };
      }),
    ),
  );

/** A valid owned session at either of the migration boundaries exercised below. */
const seedMigrationSession = (prefix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
    if (organization === undefined) throw new Error("migration fixture needs an organization");
    const actor = `${prefix}-actor`;
    const project = `${prefix}-project`;
    const worktree = `${prefix}-worktree`;
    const session = `${prefix}-session`;
    yield* sql`
      INSERT INTO "user" (id, name, email, "createdAt")
      VALUES (${actor}, 'Migration owner', ${`${prefix}@example.invalid`}, '2026-01-01T00:00:00Z')`;
    yield* sql`
      INSERT INTO organization_members (organization_id, user_id, role)
      VALUES (${organization.id}, ${actor}, 'owner')`;
    yield* sql`
      INSERT INTO projects (id, name, organization_id, created_by_user_id, store_path, default_branch)
      VALUES (${project}, ${prefix}, ${organization.id}, ${actor}, ${`/store/${prefix}/repo.git`}, 'main')`;
    yield* sql`
      INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
      VALUES (${worktree}, ${project}, 'fixture', 'fixture', 'mend/fixture', ${"a".repeat(40)})`;
    yield* sql`
      INSERT INTO agent_sessions
        (id, project_id, worktree_id, owner_user_id, harness, worktree, branch, base_sha, status)
      VALUES (${session}, ${project}, ${worktree}, ${actor}, 'claude', 'fixture', 'mend/fixture', ${"a".repeat(40)}, 'running')`;
    return { actor, project, worktree, session };
  });

describe.skipIf(postgres.skip)("0055 organizations", () => {
  const EMPTY_DB = `${SCRATCH_DB}_org_empty`;
  const emptyLayer = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${EMPTY_DB}`;
    return PgClient.layer({ url: Redacted.make(url.toString()) });
  })();
  const withEmptyDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(emptyLayer), Effect.scoped));

  beforeAll(async () => {
    await emptyScratch();
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${EMPTY_DB}`);
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${EMPTY_DB} WITH (FORCE)`);
      }),
    );
  });

  it("upgrades without widening: one organization, the oldest account owns and operates it, projects stay shared", async () => {
    const result = await withScratch(
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
        const sameNameElsewhere = yield* attempt(sql`
          INSERT INTO projects (id, name, organization_id, store_path, default_branch)
          VALUES ('p-3', 'api', 'org-other', '/store/p-3/repo.git', 'main')`);
        const sameNameSameOrganization = yield* attempt(sql`
          INSERT INTO projects (id, name, organization_id, store_path, default_branch)
          VALUES ('p-4', 'api', ${organizationId}, '/store/p-4/repo.git', 'main')`);
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
    expect(result.sameNameSameOrganization).toEqual({
      code: "23505",
      constraint: "projects_organization_name_key",
    });
  });

  it("creates the organization on an empty database, and new projects need one", async () => {
    const result = await withEmptyDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0055_organizations");
        const organizations = yield* sql<{
          readonly id: string;
        }>`SELECT id FROM organizations`;
        const members = yield* sql`SELECT 1 FROM organization_members`;
        const withoutOrganization = yield* attempt(sql`
          INSERT INTO projects (id, name, store_path, default_branch)
          VALUES ('p-x', 'x', '/store/p-x/repo.git', 'main')`);
        return { organizations, members, withoutOrganization };
      }),
    );
    expect(result.organizations).toHaveLength(1);
    expect(result.members).toHaveLength(0);
    expect(result.withoutOrganization).toEqual({ code: "23502", column: "organization_id" });
  });

  it("the constraints hold the model: roles, one organization per account, consistent invitations, no deletion", async () => {
    const outcomes = await withScratch(
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
            SET accepted_by_user_id = 'u-newest', accepted_at = now() WHERE id = 'inv-0'`),
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
      badRole: { code: "23514", constraint: "organization_members_role_check" },
      secondMembership: { code: "23505", constraint: "organization_members_user_key" },
      acceptedWithoutAccepter: {
        code: "23514",
        constraint: "organization_invitations_accepted_check",
      },
      acceptedAndRevoked: { code: "23514", constraint: "organization_invitations_spent_check" },
      expiredAtBirth: { code: "23514", constraint: "organization_invitations_expiry_check" },
      unfoldedEmail: { code: "23514", constraint: "organization_invitations_email_check" },
      deleteMember: { code: "23503", constraint: "organization_members_user_id_fkey" },
      duplicateOrganizationName: { code: "23505", constraint: "organizations_name_lower_key" },
    });
  });
});

describe.skipIf(postgres.skip)("0056 per-account resources", () => {
  beforeAll(emptyScratch);

  it("gives devices to the oldest account and references to the organization", async () => {
    const result = await withScratch(
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
    expect(result.sameNameSameOrganization).toEqual({
      code: "23505",
      constraint: "reference_repos_organization_name_key",
    });
    expect(result.deviceWithoutAccount).toEqual({ code: "23502", column: "user_id" });
  });
});

describe.skipIf(postgres.skip)("0058 hot pool owners", () => {
  beforeAll(emptyScratch);

  it("credits ownerless entries to the first account they ran as, and refuses new ones", async () => {
    const result = await withScratch(
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
      ownerless: { code: "23502", column: "owner_user_id" },
    });
  });
});

describe.skipIf(postgres.skip)("0062 slack", () => {
  beforeAll(emptyScratch);

  it("marks existing sessions as Mend's, and the keys hold the model: one workspace per organization, links inside it", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0061_upgrade_tickets");
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
            ('u-alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z'),
            ('u-bob', 'Bob', 'bob@example.com', '2026-02-01T00:00:00Z'),
            ('u-carol', 'Carol', 'carol@example.com', '2026-03-01T00:00:00Z'),
            ('u-dave', 'Dave', 'dave@example.com', '2026-04-01T00:00:00Z')`;
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        const acme = organization?.id ?? "";
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-other', 'Other')`;
        yield* sql`
          INSERT INTO organization_members (organization_id, user_id, role) VALUES
            (${acme}, 'u-alice', 'owner'),
            (${acme}, 'u-bob', 'member'),
            (${acme}, 'u-dave', 'member'),
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
        // Dave is an existing member with no link, so only the Slack-user primary key conflicts.
        const slackUserTwice = yield* attempt(link(acme, "U-ALICE", "u-dave"));
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
      unknownOrigin: { code: "23514", constraint: "agent_sessions_origin_check" },
      settings: {
        default_harness: "claude",
        show_agent_messages: true,
        show_diffs: false,
        external_channels: false,
      },
      sameTeamElsewhere: { code: "23505", constraint: "slack_installs_team_id_key" },
      secondInstall: { code: "23505", constraint: "slack_installs_pkey" },
      aliceLinked: "inserted",
      bobLinked: "inserted",
      slackUserTwice: { code: "23505", constraint: "slack_links_pkey" },
      accountTwice: { code: "23505", constraint: "slack_links_team_user_key" },
      // Carol is not a member of the organization that installed the app.
      outsider: { code: "23503", constraint: "slack_links_member_fkey" },
      // Nor can a link claim another organization's workspace.
      wrongOrganization: { code: "23503", constraint: "slack_links_install_fkey" },
      sessionInTwoThreads: { code: "23505", constraint: "slack_threads_pkey" },
      linksAfterRemoval: [{ slack_user_id: "U-ALICE" }],
      afterUninstall: { links: 0, codes: 0, channelDefaults: 0, userDefaults: 1, threads: 1 },
      threadsAfterSession: 0,
    });
  });
});

describe.skipIf(postgres.skip)("0063 slack reports", () => {
  beforeAll(emptyScratch);

  it("reads an earlier thread as external with nothing reported, and posts go with the session", async () => {
    const result = await withScratch(
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
      again: { code: "23505", constraint: "slack_thread_posts_pkey" },
      orphan: { code: "23503", constraint: "slack_thread_posts_session_id_fkey" },
      postsAfterSession: 0,
    });
  });
});

describe.skipIf(postgres.skip)("0064 landing", () => {
  beforeAll(emptyScratch);

  it("leaves existing rows to their defaults, and the checks hold a landing's facts together", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0063_slack_reports");
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES ('u-alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z')`;
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        const acme = organization?.id ?? "";
        yield* sql`
          INSERT INTO organization_members (organization_id, user_id, role)
          VALUES (${acme}, 'u-alice', 'owner')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${acme})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status)
          VALUES ('s-1', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running')`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status)
          VALUES ('proc-1', 's-1', 'ws-1', 'pty-1', 'agent-protocol', 'running')`;
        yield* sql`
          INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status)
          VALUES ('t-1', 's-1', 'proc-1', 1, 'why does the login test flake?', 'completed')`;
        yield* sql`
          INSERT INTO slack_installs
            (organization_id, team_id, team_name, bot_user_id, app_id, sealed_app_token,
             sealed_bot_token, web_origin, installed_by_user_id)
          VALUES (${acme}, 'T-ACME', 'Acme', 'B1', 'A1', 'sealed-app', 'sealed-bot',
                  'https://mend.example', 'u-alice')`;
        yield* sql`
          INSERT INTO worktree_changes (id, project_id, worktree_id, session_id, branch, base_sha)
          VALUES ('c-1', 'p-1', 'wt-1', 's-1', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO checkpoints (id, worktree_id, session_id, ordinal, ref, sha, trigger)
          VALUES ('cp-1', 'wt-1', 's-1', 0, 'refs/mend/checkpoints/wt-1/0', 'def', 'session-start')`;
        yield* migrations["0064_landing"];

        const [defaults] = yield* sql<{
          readonly project: string;
          readonly session: boolean | null;
          readonly slack: boolean;
          readonly intent: string | null;
          readonly intent_source: string | null;
        }>`
          SELECT
            (SELECT auto_land FROM projects) AS project,
            (SELECT auto_land FROM agent_sessions) AS session,
            (SELECT land_automatically FROM slack_installs) AS slack,
            (SELECT intent FROM agent_turns) AS intent,
            (SELECT intent_source FROM agent_turns) AS intent_source`;
        const projectChoice = yield* attempt(sql`UPDATE projects SET auto_land = 'sometimes'`);

        const intent = (value: string | null, source: string | null) =>
          attempt(sql`UPDATE agent_turns SET intent = ${value}, intent_source = ${source}`);
        const intents = {
          read: yield* intent("question", "read"),
          option: yield* intent("change", "option"),
          unread: yield* intent(null, "unread"),
          unreadWithIntent: yield* intent("change", "unread"),
          readWithoutIntent: yield* intent(null, "read"),
          intentWithoutSource: yield* intent("change", null),
          unknownIntent: yield* intent("chat", "read"),
        };

        let next = 0;
        const land = (columns: {
          readonly outcome: string;
          readonly pushed?: string | null;
          readonly pr?: number | null;
          readonly checkpointRef?: string | null;
          readonly checkpointSha?: string | null;
        }) => {
          next += 1;
          const pr = columns.pr ?? null;
          return attempt(sql`
            INSERT INTO change_landings
              (id, change_id, session_id, project_id, checkpoint_id, checkpoint_ref,
               checkpoint_sha, remote_branch, pushed_sha, trigger, pull_request_number,
               pull_request_url, pull_request_state, pr_observed_at, outcome, message, user_id)
            VALUES (${`l-${next}`}, 'c-1', 's-1', 'p-1', 'cp-1',
                    ${columns.checkpointRef === undefined ? "refs/mend/checkpoints/wt-1/0" : columns.checkpointRef},
                    ${columns.checkpointSha === undefined ? "def" : columns.checkpointSha},
                    'mend/one', ${columns.pushed === undefined ? "abc123" : columns.pushed},
                    'manual', ${pr}, ${pr === null ? null : "https://github.com/acme/api/pull/1"},
                    ${pr === null ? null : "open"}, ${pr === null ? null : new Date()},
                    ${columns.outcome}, null, 'u-alice')`);
        };
        const landings = {
          pushed: yield* land({ outcome: "pushed" }),
          pullRequest: yield* land({ outcome: "pull-request", pr: 1 }),
          refused: yield* land({ outcome: "refused", pushed: null }),
          failedBeforePush: yield* land({ outcome: "failed", pushed: null }),
          failedAfterPush: yield* land({ outcome: "failed" }),
          noCheckpoint: yield* land({
            outcome: "failed",
            pushed: null,
            checkpointRef: null,
            checkpointSha: null,
          }),
          pushedWithoutSha: yield* land({ outcome: "pushed", pushed: null }),
          pullRequestWithoutOne: yield* land({ outcome: "pull-request" }),
          refusedButPushed: yield* land({ outcome: "refused" }),
          halfACheckpoint: yield* land({ outcome: "pushed", checkpointSha: null }),
          unknownOutcome: yield* land({ outcome: "merged" }),
        };
        const halfAPullRequest = yield* attempt(
          sql`UPDATE change_landings SET pull_request_url = NULL WHERE id = 'l-2'`,
        );

        const count = sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM change_landings`;
        yield* sql`DELETE FROM checkpoints`;
        yield* sql`DELETE FROM agent_sessions`;
        const [kept] = yield* sql<{
          readonly n: number;
          readonly sessions: number;
          readonly checkpoints: number;
        }>`
          SELECT count(*)::int AS n,
                 count(session_id)::int AS sessions,
                 count(checkpoint_id)::int AS checkpoints
          FROM change_landings`;
        yield* sql`DELETE FROM worktree_changes`;
        const [afterChange] = yield* count;

        return {
          defaults,
          projectChoice,
          intents,
          landings,
          halfAPullRequest,
          kept,
          afterChange: afterChange?.n ?? -1,
        };
      }),
    );
    expect(result).toEqual({
      defaults: {
        project: "inherit",
        session: null,
        slack: true,
        intent: null,
        intent_source: null,
      },
      projectChoice: { code: "23514", constraint: "projects_auto_land_check" },
      intents: {
        read: "inserted",
        option: "inserted",
        unread: "inserted",
        unreadWithIntent: { code: "23514", constraint: "agent_turns_intent_check" },
        readWithoutIntent: { code: "23514", constraint: "agent_turns_intent_check" },
        intentWithoutSource: { code: "23514", constraint: "agent_turns_intent_check" },
        unknownIntent: { code: "23514", constraint: "agent_turns_intent_check" },
      },
      landings: {
        pushed: "inserted",
        pullRequest: "inserted",
        refused: "inserted",
        failedBeforePush: "inserted",
        failedAfterPush: "inserted",
        noCheckpoint: "inserted",
        pushedWithoutSha: { code: "23514", constraint: "change_landings_outcome_facts_check" },
        pullRequestWithoutOne: { code: "23514", constraint: "change_landings_outcome_facts_check" },
        refusedButPushed: { code: "23514", constraint: "change_landings_outcome_facts_check" },
        halfACheckpoint: { code: "23514", constraint: "change_landings_checkpoint_check" },
        unknownOutcome: { code: "23514", constraint: "change_landings_outcome_check" },
      },
      halfAPullRequest: { code: "23514", constraint: "change_landings_pull_request_check" },
      // The record of a push outlives its session and its checkpoint, and goes with its change.
      kept: { n: 6, sessions: 0, checkpoints: 0 },
      afterChange: 0,
    });
  });
});

describe.skipIf(postgres.skip)("0065 turn landing", () => {
  beforeAll(emptyScratch);

  it("decides every turn that already ended, and holds a decision to its claim", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0064_landing");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status)
          VALUES ('s-1', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running')`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status)
          VALUES ('proc-1', 's-1', 'ws-1', 'pty-1', 'agent-protocol', 'running')`;
        yield* sql`
          INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status, ended_at)
          VALUES ('t-done', 's-1', 'proc-1', 0, 'fix it', 'completed', '2026-09-01T00:00:00Z'),
                 ('t-failed', 's-1', 'proc-1', 1, 'fix it', 'failed', NULL),
                 ('t-open', 's-1', 'proc-1', 2, 'fix it', 'running', NULL)`;
        // A real landing makes the no-attempt probe independent of the landing foreign key.
        yield* sql`INSERT INTO "user" (id, name, email) VALUES ('u-alice', 'Alice', 'alice@example.com')`;
        yield* sql`
          INSERT INTO worktree_changes (id, project_id, worktree_id, session_id, branch, base_sha)
          VALUES ('c-1', 'p-1', 'wt-1', 's-1', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO change_landings
            (id, change_id, session_id, project_id, remote_branch, trigger, outcome, user_id)
          VALUES ('l-valid', 'c-1', 's-1', 'p-1', 'mend/one', 'manual', 'refused', 'u-alice')`;
        yield* migrations["0065_turn_landing"];

        const turns = yield* sql<{
          readonly id: string;
          readonly landing: string | null;
          readonly claimed: boolean;
        }>`
          SELECT id, landing, landing_claimed_at IS NOT NULL AS claimed
          FROM agent_turns ORDER BY ordinal`;
        const decide = (landing: string | null, claimed: boolean) =>
          attempt(sql`
            UPDATE agent_turns
            SET landing = ${landing},
                landing_claimed_at = ${claimed ? new Date() : null}
            WHERE id = 't-open'`);
        return {
          turns: turns.map((turn) => ({ ...turn })),
          checks: {
            decidedWithClaim: yield* decide("question", true),
            decidedWithoutClaim: yield* decide("question", false),
            unknownDecision: yield* decide("merged", true),
            claimedUndecided: yield* decide(null, true),
            landingWithoutAttempt: yield* attempt(
              sql`UPDATE agent_turns SET landing_id = 'l-valid' WHERE id = 't-done'`,
            ),
            missingLanding: yield* attempt(sql`
              UPDATE agent_turns SET landing = 'attempted', landing_claimed_at = now(),
                landing_id = 'l-none' WHERE id = 't-open'`),
            validLanding: yield* attempt(sql`
              UPDATE agent_turns SET landing = 'attempted', landing_claimed_at = now(),
                landing_id = 'l-valid' WHERE id = 't-open'`),
          },
        };
      }),
    );
    expect(result).toEqual({
      turns: [
        { id: "t-done", landing: "skipped", claimed: true },
        { id: "t-failed", landing: "skipped", claimed: true },
        { id: "t-open", landing: null, claimed: false },
      ],
      checks: {
        decidedWithClaim: "inserted",
        decidedWithoutClaim: { code: "23514", constraint: "agent_turns_landing_check" },
        unknownDecision: { code: "23514", constraint: "agent_turns_landing_check" },
        claimedUndecided: "inserted",
        landingWithoutAttempt: { code: "23514", constraint: "agent_turns_landing_check" },
        missingLanding: { code: "23503", constraint: "agent_turns_landing_id_fkey" },
        validLanding: "inserted",
      },
    });
  });
});

describe.skipIf(postgres.skip)("0066 landing description", () => {
  beforeAll(emptyScratch);

  it("keeps existing landing facts and gives every old landing an unclaimed nullable tour field", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0065_turn_landing");
        const fixture = yield* seedMigrationSession("description");
        yield* sql`
          INSERT INTO worktree_changes (id, project_id, worktree_id, session_id, branch, base_sha)
          VALUES ('description-change', ${fixture.project}, ${fixture.worktree}, ${fixture.session}, 'mend/fixture', ${"a".repeat(40)})`;
        yield* sql`
          INSERT INTO checkpoints (id, worktree_id, session_id, ordinal, ref, sha, trigger)
          VALUES ('description-checkpoint', ${fixture.worktree}, ${fixture.session}, 0,
                  'refs/mend/checkpoints/description/0', ${"b".repeat(40)}, 'session-start')`;
        yield* sql`
          INSERT INTO change_landings
            (id, change_id, session_id, project_id, checkpoint_id, checkpoint_ref, checkpoint_sha,
             commit_sha, remote_branch, pushed_sha, trigger, pull_request_number, pull_request_url,
             pull_request_state, pr_observed_at, outcome, message, user_id, created_at)
          VALUES
            ('landing-rich', 'description-change', ${fixture.session}, ${fixture.project}, 'description-checkpoint',
             'refs/mend/checkpoints/description/0', ${"b".repeat(40)}, ${"c".repeat(40)}, 'mend/description',
             ${"c".repeat(40)}, 'automatic', 42, 'https://github.com/example/fixture/pull/42', 'open',
             '2026-09-21T12:00:00Z', 'pull-request', 'opened with recorded provenance', ${fixture.actor}, '2026-09-21T11:00:00Z'),
            ('landing-refused', 'description-change', NULL, ${fixture.project}, NULL, NULL, NULL,
             NULL, 'mend/refused', NULL, 'manual', NULL, NULL, NULL, NULL, 'refused',
             'origin moved', ${fixture.actor}, '2026-09-20T11:00:00Z')`;
        const before = yield* sql<{ readonly id: string; readonly facts: unknown }>`
          SELECT id, to_jsonb(l) AS facts FROM change_landings l ORDER BY id`;
        expect(before.map((row) => row.id)).toEqual(["landing-refused", "landing-rich"]);
        yield* migrations["0066_landing_description"];
        const columns = yield* sql<{ readonly column_name: string; readonly is_nullable: string }>`
          SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = 'change_landings' AND column_name = 'described_tour_id'`;
        const after = yield* sql<{
          readonly id: string;
          readonly facts: unknown;
          readonly described_tour_id: string | null;
        }>`SELECT id, to_jsonb(l) - 'described_tour_id' AS facts, described_tour_id
             FROM change_landings l ORDER BY id`;
        return { before, after, columns: columns.map((row) => ({ ...row })) };
      }),
    );
    expect(result.columns).toEqual([{ column_name: "described_tour_id", is_nullable: "YES" }]);
    expect(result.after.map(({ id, facts }) => ({ id, facts }))).toEqual(result.before);
    expect(result.after.map(({ id, described_tour_id }) => ({ id, described_tour_id }))).toEqual([
      { id: "landing-refused", described_tour_id: null },
      { id: "landing-rich", described_tour_id: null },
    ]);
  });
});

describe.skipIf(postgres.skip)("0071 project default shell profile", () => {
  beforeAll(emptyScratch);

  it("turns the default shell profile on for existing and new projects", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0070_organization_settings");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        const organizationId = organization?.id ?? "";
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('project-existing', 'existing', '/store/existing/repo.git', 'main', ${organizationId})`;
        yield* migrations["0071_project_default_shell_profile"];
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('project-new', 'new', '/store/new/repo.git', 'main', ${organizationId})`;
        return yield* sql<{
          readonly id: string;
          readonly default_shell_profile: boolean;
        }>`SELECT id, default_shell_profile FROM projects ORDER BY id`;
      }),
    );
    expect(rows).toEqual([
      { id: "project-existing", default_shell_profile: true },
      { id: "project-new", default_shell_profile: true },
    ]);
  });
});

describe.skipIf(postgres.skip)("0073 landing reasons", () => {
  beforeAll(emptyScratch);

  it("lets a turn read as a landing request and record why it did not land", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0072_protocol_idle_stop");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status)
          VALUES ('s-1', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running')`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status)
          VALUES ('proc-1', 's-1', 'ws-1', 'pty-1', 'agent-protocol', 'running')`;
        yield* sql`
          INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status, ended_at)
          VALUES ('t-1', 's-1', 'proc-1', 0, 'ok land it', 'completed', now())`;
        const landBefore = yield* attempt(
          sql`UPDATE agent_turns SET intent = 'land', intent_source = 'read'`,
        );
        const capturedBefore = yield* attempt(
          sql`UPDATE agent_turns SET landing_claimed_at = now(), landing = 'not-captured'`,
        );
        yield* migrations["0073_landing_reasons"];
        const intent = (value: string | null, source: string | null) =>
          attempt(sql`UPDATE agent_turns SET intent = ${value}, intent_source = ${source}`);
        const decide = (landing: string) =>
          attempt(sql`
            UPDATE agent_turns SET landing_claimed_at = now(), landing = ${landing}, landing_id = NULL`);
        return {
          before: { land: landBefore, notCaptured: capturedBefore },
          intents: {
            land: yield* intent("land", "read"),
            change: yield* intent("change", "option"),
            unread: yield* intent(null, "unread"),
            unreadLand: yield* intent("land", "unread"),
            unknown: yield* intent("publish", "read"),
          },
          decisions: {
            noChange: yield* decide("no-change"),
            nothingNew: yield* decide("nothing-new"),
            notCaptured: yield* decide("not-captured"),
            question: yield* decide("question"),
            skipped: yield* decide("skipped"),
            unknown: yield* decide("stale"),
          },
        };
      }),
    );
    expect(result).toEqual({
      before: {
        land: { code: "23514", constraint: "agent_turns_intent_check" },
        notCaptured: { code: "23514", constraint: "agent_turns_landing_check" },
      },
      intents: {
        land: "inserted",
        change: "inserted",
        unread: "inserted",
        unreadLand: { code: "23514", constraint: "agent_turns_intent_check" },
        unknown: { code: "23514", constraint: "agent_turns_intent_check" },
      },
      decisions: {
        noChange: "inserted",
        nothingNew: "inserted",
        notCaptured: "inserted",
        question: "inserted",
        skipped: "inserted",
        unknown: { code: "23514", constraint: "agent_turns_landing_check" },
      },
    });
  });
});

describe.skipIf(postgres.skip)("0075 capture drain", () => {
  beforeAll(emptyScratch);

  it("gives an existing session no drain, and admits only whole drain intents and the discard", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0073_landing_reasons");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status)
          VALUES ('s-1', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running')`;
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z')`;
        const discardBefore = yield* attempt(sql`
          INSERT INTO session_control_events (id, session_id, actor_user_id, kind)
          VALUES ('e-0', 's-1', 'alice', 'discard-unsaved-stop')`);
        yield* migrations["0075_capture_drain"];
        const [existing] = yield* sql<{
          readonly captureDrain: string | null;
          readonly capturePending: number | null;
          readonly executorStartedAt: Date | null;
          readonly removalRequestedAt: Date | null;
        }>`
          SELECT capture_drain AS "captureDrain", capture_pending AS "capturePending",
                 executor_started_at AS "executorStartedAt",
                 removal_requested_at AS "removalRequestedAt"
            FROM agent_sessions WHERE id = 's-1'`;
        const drain = (reason: string | null, requestedAt: string | null, notSaved: boolean) =>
          attempt(sql`
            UPDATE agent_sessions
               SET capture_drain = ${reason},
                   capture_drain_requested_at = ${requestedAt}::timestamptz,
                   capture_not_saved_at = CASE WHEN ${notSaved} THEN now() ELSE NULL END
             WHERE id = 's-1'`);
        return {
          existing,
          discardBefore,
          discardAfter: yield* attempt(sql`
            INSERT INTO session_control_events (id, session_id, actor_user_id, kind)
            VALUES ('e-1', 's-1', 'alice', 'discard-unsaved-stop')`),
          drains: {
            stop: yield* drain("stop", "2026-09-27T10:00:00Z", false),
            notSaved: yield* drain("replacement", "2026-09-27T10:00:00Z", true),
            relaunch: yield* drain("relaunch", "2026-09-27T10:00:00Z", false),
            unknown: yield* drain("cap", "2026-09-27T10:00:00Z", false),
            reasonWithoutTime: yield* drain("stop", null, false),
            timeWithoutReason: yield* drain(null, "2026-09-27T10:00:00Z", false),
            notSavedWithoutDrain: yield* drain(null, null, true),
            none: yield* drain(null, null, false),
          },
        };
      }),
    );
    expect(result).toEqual({
      existing: {
        captureDrain: null,
        capturePending: null,
        executorStartedAt: null,
        removalRequestedAt: null,
      },
      discardBefore: { code: "23514", constraint: "session_control_events_kind_check" },
      discardAfter: "inserted",
      drains: {
        stop: "inserted",
        notSaved: "inserted",
        relaunch: "inserted",
        unknown: { code: "23514", constraint: "agent_sessions_capture_drain_check" },
        reasonWithoutTime: { code: "23514", constraint: "agent_sessions_capture_drain_check" },
        timeWithoutReason: { code: "23514", constraint: "agent_sessions_capture_drain_check" },
        notSavedWithoutDrain: { code: "23514", constraint: "agent_sessions_capture_drain_check" },
        none: "inserted",
      },
    });
  });
});

describe.skipIf(postgres.skip)("0077 capture drain resume", () => {
  beforeAll(emptyScratch);

  it("gives a session draining before it no relaunch to finish", async () => {
    const existing = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0075_capture_drain");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status,
             capture_drain, capture_drain_requested_at)
          VALUES ('s-1', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running',
                  'relaunch', '2026-09-27T10:00:00Z')`;
        yield* migrations["0077_capture_drain_resume"];
        const [row] = yield* sql<{ readonly resume: string | null; readonly drain: string }>`
          SELECT capture_drain_resume AS resume, capture_drain AS drain
            FROM agent_sessions WHERE id = 's-1'`;
        return row;
      }),
    );
    expect(existing).toEqual({ resume: null, drain: "relaunch" });
  });
});

describe.skipIf(postgres.skip)("0096 notification settings", () => {
  beforeAll(emptyScratch);

  it("gives a row the defaults: Slack sessions off, every kind on", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0095_process_first_output");
        yield* migrations["0096_notification_settings"];
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES ('anna', 'Anna Example', 'anna@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO user_notification_settings (user_id) VALUES ('anna')`;
        return yield* sql<{
          readonly user_id: string;
          readonly slack_sessions: boolean;
          readonly turn_finished: boolean;
          readonly needs_input: boolean;
          readonly failed: boolean;
        }>`
          SELECT user_id, slack_sessions, turn_finished, needs_input, failed
          FROM user_notification_settings`;
      }),
    );
    expect(rows.map((row) => ({ ...row }))).toEqual([
      {
        user_id: "anna",
        slack_sessions: false,
        turn_finished: true,
        needs_input: true,
        failed: true,
      },
    ]);
  });
});

describe.skipIf(postgres.skip)("0106 terminal watch control", () => {
  beforeAll(emptyScratch);

  it("keeps old control events, accepts every supported kind and refuses unknown kinds", async () => {
    const previousKinds = [
      "interrupt",
      "terminal-attach",
      "shell-open",
      "stop",
      "services-stop",
      "idle-stop",
      "shared-control-on",
      "shared-control-off",
      "discard-unsaved-stop",
    ];
    const supportedKinds = [...previousKinds, "terminal-watch"];
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0105_turn_origin");
        const fixture = yield* seedMigrationSession("watch");
        for (const kind of previousKinds) {
          yield* sql`
            INSERT INTO session_control_events (id, session_id, actor_user_id, kind, ref_id, created_at)
            VALUES (${`existing-${kind}`}, ${fixture.session}, ${fixture.actor}, ${kind},
                    ${`reference-${kind}`}, '2026-10-01T12:00:00Z')`;
        }
        const before = yield* sql<{ readonly id: string; readonly facts: unknown }>`
          SELECT id, to_jsonb(e) AS facts FROM session_control_events e ORDER BY id`;
        expect(before.map((row) => row.id)).toEqual(
          previousKinds.map((kind) => `existing-${kind}`).toSorted(),
        );
        yield* migrations["0106_terminal_watch_control"];
        const preserved = yield* sql<{ readonly id: string; readonly facts: unknown }>`
          SELECT id, to_jsonb(e) AS facts FROM session_control_events e ORDER BY id`;
        for (const kind of supportedKinds) {
          yield* sql`
            INSERT INTO session_control_events (id, session_id, actor_user_id, kind, ref_id, created_at)
            VALUES (${`new-${kind}`}, ${fixture.session}, ${fixture.actor}, ${kind},
                    ${`new-reference-${kind}`}, '2026-10-02T12:00:00Z')`;
        }
        const accepted = yield* sql<{ readonly id: string; readonly kind: string }>`
          SELECT id, kind FROM session_control_events WHERE id LIKE 'new-%' ORDER BY id`;
        const rejected = [];
        for (const kind of ["unknown-control", "TERMINAL-WATCH"]) {
          rejected.push(
            yield* attempt(sql`
            INSERT INTO session_control_events (id, session_id, actor_user_id, kind)
            VALUES (${`invalid-${kind}`}, ${fixture.session}, ${fixture.actor}, ${kind})`),
          );
        }
        return { before, preserved, accepted, rejected };
      }),
    );
    expect(result.preserved).toEqual(result.before);
    expect(result.accepted).toEqual(
      supportedKinds.toSorted().map((kind) => ({ id: `new-${kind}`, kind })),
    );
    expect(result.rejected).toEqual([
      { code: "23514", constraint: "session_control_events_kind_check" },
      { code: "23514", constraint: "session_control_events_kind_check" },
    ]);
  });
});

describe.skipIf(postgres.skip)("0109 opencode models", () => {
  const opencodeRows = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly id: string;
      readonly label: string;
      readonly is_default: boolean;
    }>`
      SELECT id, label, is_default FROM harness_models
      WHERE harness = 'opencode' ORDER BY position, id`;
    return rows.map((row) => ({ ...row }));
  });

  beforeAll(emptyScratch);

  it("lists the ChatGPT login's models for opencode with no default of its own, and keeps an operator's rows", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0108_agent_memory_import_bases");
        // An operator added opencode rows by hand before this migration: theirs stay as they are,
        // and their default stays the only one.
        yield* sql`
          INSERT INTO harness_models (harness, id, label, is_default, efforts, position) VALUES
            ('opencode', 'anthropic/claude-opus-5', 'Opus 5 · API key', true, NULL, 0),
            ('opencode', 'openai/gpt-5.5', 'Their label', false, NULL, 9)`;
        yield* migrations["0109_opencode_models"];
        return yield* opencodeRows;
      }),
    );
    expect(rows.filter((row) => row.is_default).map((row) => row.id)).toEqual([
      "anthropic/claude-opus-5",
    ]);
    expect(rows.find((row) => row.id === "openai/gpt-5.5")?.label).toBe("Their label");
    expect(rows.map((row) => row.id)).toContain("openai/gpt-6.1-sol");

    // A catalog with no opencode rows takes the seed as it is.
    const fresh = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM harness_models WHERE harness = 'opencode'`;
        yield* migrations["0109_opencode_models"];
        return yield* opencodeRows;
      }),
    );
    expect(fresh).toEqual(
      (HARNESS_MODEL_SEED.opencode ?? []).map((model) => ({
        id: model.id,
        label: model.label,
        is_default: model.isDefault,
      })),
    );
    // No default: a launch naming no model leaves the choice to opencode and its config.
    expect(fresh.filter((row) => row.is_default)).toEqual([]);
    expect(fresh[0]?.id).toBe(OPENCODE_DEFAULT_MODEL);
  });
});

describe.skipIf(postgres.skip)("0116 shared control ever", () => {
  beforeAll(emptyScratch);

  it("counts a session shared and then unshared before it from its first shared-control-on, and one shared now", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0115_start_agents_after_install");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES ('anna', 'Anna', 'anna@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status,
             shared_control_enabled_by_user_id, shared_control_enabled_at)
          VALUES
            ('unshared', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running', NULL, NULL),
            ('shared-now', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running',
             'anna', '2026-10-05T10:00:00Z'),
            ('never', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running', NULL, NULL)`;
        yield* sql`
          INSERT INTO session_control_events (id, session_id, actor_user_id, kind, created_at)
          VALUES
            ('e-1', 'unshared', 'anna', 'shared-control-on', '2026-10-01T09:00:00Z'),
            ('e-2', 'unshared', 'anna', 'shared-control-off', '2026-10-01T10:00:00Z'),
            ('e-3', 'unshared', 'anna', 'shared-control-on', '2026-10-02T09:00:00Z'),
            ('e-4', 'never', 'anna', 'interrupt', '2026-10-02T09:00:00Z')`;
        yield* migrations["0116_shared_control_ever"];
        return yield* sql<{ readonly id: string; readonly ever: Date | null }>`
          SELECT id, shared_control_ever_at AS ever FROM agent_sessions ORDER BY id`;
      }),
    );
    expect(rows.map((row) => [row.id, row.ever?.toISOString() ?? null])).toEqual([
      ["never", null],
      ["shared-now", "2026-10-05T10:00:00.000Z"],
      ["unshared", "2026-10-01T09:00:00.000Z"],
    ]);
  });
});

describe.skipIf(postgres.skip)("0117 conversation homes", () => {
  beforeAll(emptyScratch);

  it("says who a live agent in a person-layout executor runs as: its session's owner, and nobody else's", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0116_shared_control_ever");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        // Alice's launch made a person executor, Maria joined it; Carol's launch is shared.
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status,
             owner_user_id, sealant_workspace_id, executor_launch_id)
          VALUES
            ('alice', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running', 'alice', 'ws-person', 'launch-person'),
            ('maria', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running', 'maria', 'ws-person', NULL),
            ('carol', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running', 'carol', 'ws-shared', 'launch-shared')`;
        yield* sql`
          INSERT INTO executor_layouts (launch_id, worktree_id, session_id, layout, source, confirmed)
          VALUES ('launch-person', 'wt-1', 'alice', 'person', 'flag', true),
                 ('launch-shared', 'wt-1', 'carol', 'shared', 'flag', true)`;
        yield* sql`
          INSERT INTO session_processes (id, session_id, sealant_workspace_id, sealant_session_id, kind, status, exited_at)
          VALUES
            ('p-alice', 'alice', 'ws-person', 'pty-1', 'agent-protocol', 'running', NULL),
            ('p-maria', 'maria', 'ws-person', 'pty-2', 'agent-protocol', 'running', NULL),
            ('p-alice-shell', 'alice', 'ws-person', 'pty-3', 'shell', 'running', NULL),
            ('p-alice-old', 'alice', 'ws-person', 'pty-4', 'agent-protocol', 'exited', now()),
            ('p-carol', 'carol', 'ws-shared', 'pty-5', 'agent-protocol', 'running', NULL)`;
        yield* migrations["0117_conversation_homes"];
        return yield* sql<{ readonly id: string; readonly runsAs: string | null }>`
          SELECT id, runs_as AS "runsAs" FROM session_processes ORDER BY id`;
      }),
    );
    expect(rows.map((row) => [row.id, row.runsAs])).toEqual([
      ["p-alice", "alice"],
      ["p-alice-old", null],
      ["p-alice-shell", null],
      ["p-carol", null],
      ["p-maria", "maria"],
    ]);
  });
});

describe.skipIf(postgres.skip)("0118 pre-release executors", () => {
  beforeAll(emptyScratch);

  it("adds the migration and retirement tables, which go with their worktree", async () => {
    const left = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0117_conversation_homes");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status, owner_user_id)
          VALUES ('s-a', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running', 'alice'),
                 ('s-b', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running', 'alice'),
                 ('s-c', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running', NULL)`;
        yield* migrations["0118_pre_release_executors"];
        // Who had sessions there, once each, and the worktree marked as older than the record.
        const owners = yield* sql<{ readonly userId: string }>`
          SELECT user_id AS "userId" FROM worktree_session_owners WHERE worktree_id = 'wt-1'`;
        expect(owners.map((row) => row.userId)).toEqual(["alice"]);
        const gaps = yield* sql`SELECT 1 FROM worktree_owner_gaps WHERE worktree_id = 'wt-1'`;
        expect(gaps).toHaveLength(1);
        yield* sql`
          INSERT INTO pre_release_migrations (worktree_id, capture_id, capture_n, final, decided_by)
          VALUES ('wt-1', 'cap-1', 1, false, 'nothing')`;
        yield* sql`
          INSERT INTO executor_retirements (workspace_id, worktree_id, session_id, pre_release, state)
          VALUES ('ws-1', 'wt-1', 's-1', true, 'marked')`;
        const refused = yield* attempt(sql`
          INSERT INTO executor_retirements (workspace_id, worktree_id, session_id, pre_release, state)
          VALUES ('ws-2', 'wt-1', 's-1', true, 'gone')`);
        expect(refused).toEqual({ code: "23514", constraint: "executor_retirements_state_check" });
        yield* sql`DELETE FROM agent_sessions WHERE worktree_id = 'wt-1'`;
        yield* sql`DELETE FROM worktrees WHERE id = 'wt-1'`;
        const [counts] = yield* sql<{
          readonly migrations: number;
          readonly retirements: number;
          readonly owners: number;
        }>`
          SELECT (SELECT count(*)::int FROM pre_release_migrations) AS migrations,
                 (SELECT count(*)::int FROM executor_retirements) AS retirements,
                 (SELECT count(*)::int FROM worktree_session_owners) AS owners`;
        return counts;
      }),
    );
    expect(left).toEqual({ migrations: 0, retirements: 0, owners: 0 });
  });
});

describe.skipIf(postgres.skip)("0119 image layout confirmed", () => {
  beforeAll(emptyScratch);

  it("keeps a yes confirmed where a person launch ran on the image, and everything else unconfirmed", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0118_pre_release_executors");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO executor_layouts
            (launch_id, worktree_id, session_id, layout, source, image_key, confirmed)
          VALUES ('l-1', 'wt-1', 's-1', 'person', 'flag', 'digest:ran', true),
                 ('l-2', 'wt-1', 's-2', 'person', 'flag', 'digest:predicted', false)`;
        yield* sql`
          INSERT INTO image_layout_capabilities (image_key, runtime, person, missing)
          VALUES ('digest:ran', 'docker', true, '[]'::jsonb),
                 ('digest:predicted', 'docker', true, '[]'::jsonb),
                 ('digest:probed', 'docker', true, '[]'::jsonb),
                 ('digest:no', 'docker', false, '["no sudo"]'::jsonb)`;
        yield* migrations["0119_image_layout_confirmed"];
        return yield* sql<{ readonly imageKey: string; readonly confirmed: boolean }>`
          SELECT image_key AS "imageKey", confirmed FROM image_layout_capabilities
          ORDER BY image_key`;
      }),
    );
    expect(rows.map((row) => [row.imageKey, row.confirmed])).toEqual([
      ["digest:no", false],
      ["digest:predicted", false],
      ["digest:probed", false],
      ["digest:ran", true],
    ]);
  });
});

describe.skipIf(postgres.skip)("0120 hot workspace layout", () => {
  beforeAll(emptyScratch);

  it("a standby from before it booted shared, and a layout is person or shared", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0119_image_layout_confirmed");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO hot_workspaces (id, project_id, owner_user_id, fingerprint)
          VALUES ('hot-before', 'p-1', 'alice', 'fp')`;
        yield* migrations["0120_hot_workspace_layout"];
        yield* sql`
          INSERT INTO hot_workspaces (id, project_id, owner_user_id, fingerprint, harness_layout)
          VALUES ('hot-person', 'p-1', 'alice', 'fp', 'person')`;
        const refused = yield* attempt(sql`
          INSERT INTO hot_workspaces (id, project_id, owner_user_id, fingerprint, harness_layout)
          VALUES ('hot-other', 'p-1', 'alice', 'fp', 'other')`);
        const rows = yield* sql<{ readonly id: string; readonly layout: string }>`
          SELECT id, harness_layout AS layout FROM hot_workspaces ORDER BY id`;
        return { rows: rows.map((row) => [row.id, row.layout]), refused };
      }),
    );
    expect(result).toEqual({
      rows: [
        ["hot-before", "shared"],
        ["hot-person", "person"],
      ],
      refused: { code: "23514", constraint: "hot_workspaces_harness_layout_check" },
    });
  });
});

describe.skipIf(postgres.skip)("0126 repository URL credentials", () => {
  beforeAll(emptyScratch);

  it("strips the login or token from every stored repository URL, and leaves the rest as typed", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0125_ssh_key_revocations");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        const org = organization?.id ?? "";
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES ('anna', 'Anna', 'anna@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id, origin_url)
          VALUES
            ('p-token', 'token', '/store/p-token/repo.git', 'main', ${org},
             'https://oauth2:TOKEN-SECRET@gitlab.com/org/repo.git'),
            ('p-user', 'user', '/store/p-user/repo.git', 'main', ${org},
             'https://ghp_TOKEN-SECRET@github.com/org/repo.git'),
            ('p-ssh', 'ssh', '/store/p-ssh/repo.git', 'main', ${org},
             'ssh://git:TOKEN-SECRET@host.example/srv/repo.git'),
            ('p-clean', 'clean', '/store/p-clean/repo.git', 'main', ${org},
             'ssh://git@host.example:2222/srv/repo.git'),
            ('p-scp', 'scp', '/store/p-scp/repo.git', 'main', ${org}, 'git@github.com:org/repo.git'),
            ('p-none', 'none', '/store/p-none/repo.git', 'main', ${org}, NULL)`;
        yield* sql`
          INSERT INTO reference_repos (id, name, organization_id, origin_url, path)
          VALUES ('r-token', 'docs', ${org}, 'https://x-access-token:TOKEN-SECRET@github.com/o/docs.git',
                  '/store/refs/r-token')`;
        yield* sql`
          INSERT INTO user_dotfiles (user_id, repository)
          VALUES ('anna', ${JSON.stringify({ url: "https://anna:TOKEN-SECRET@github.com/anna/dots.git", ref: null })}::jsonb)`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-clean', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status, dotfiles)
          VALUES ('s-1', 'p-clean', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running',
                  ${JSON.stringify({ repository: { url: "https://anna:TOKEN-SECRET@github.com/anna/dots.git", ref: "main" }, snapshotSha: null })}::jsonb)`;
        yield* migrations["0126_repository_url_credentials"];
        const projects = yield* sql<{ readonly id: string; readonly url: string | null }>`
          SELECT id, origin_url AS url FROM projects ORDER BY id`;
        const [reference] = yield* sql<{ readonly url: string }>`
          SELECT origin_url AS url FROM reference_repos`;
        const [dotfiles] = yield* sql<{ readonly url: string }>`
          SELECT repository->>'url' AS url FROM user_dotfiles`;
        const [stamped] = yield* sql<{ readonly url: string; readonly ref: string }>`
          SELECT dotfiles->'repository'->>'url' AS url, dotfiles->'repository'->>'ref' AS ref
          FROM agent_sessions`;
        return {
          projects: projects.map((row) => [row.id, row.url]),
          reference: reference?.url,
          dotfiles: dotfiles?.url,
          stamped: [stamped?.url, stamped?.ref],
        };
      }),
    );
    expect(JSON.stringify(result)).not.toContain("TOKEN-SECRET");
    expect(result).toEqual({
      projects: [
        ["p-clean", "ssh://git@host.example:2222/srv/repo.git"],
        ["p-none", null],
        ["p-scp", "git@github.com:org/repo.git"],
        ["p-ssh", "ssh://git@host.example/srv/repo.git"],
        ["p-token", "https://gitlab.com/org/repo.git"],
        ["p-user", "https://github.com/org/repo.git"],
      ],
      reference: "https://github.com/o/docs.git",
      dotfiles: "https://github.com/anna/dots.git",
      stamped: ["https://github.com/anna/dots.git", "main"],
    });
  });
});

/** A stored family image; rows from before custom mode existed carry no `mode`. */
const familyImage = (packages: ReadonlyArray<string>, withMode = true) => ({
  ...(withMode ? { mode: "family" } : {}),
  os: "arch",
  packages,
  shell: "zsh",
  services: { docker: true },
});
const customImage = {
  mode: "custom",
  baseImage: "ghcr.io/me/base:1",
  packages: ["ripgrep"],
  setupCommands: [],
  services: { docker: true },
};

describe.skipIf(postgres.skip)("0127 default bun", () => {
  beforeAll(emptyScratch);

  it("adds bun and unzip to every stored family image where missing, and leaves custom bases alone", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0126_repository_url_credentials");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        const org = organization?.id ?? "";
        yield* sql`
          INSERT INTO settings (key, value)
          VALUES ('mend', ${JSON.stringify({ prMode: "draft-immediately", concurrency: 1, workspaceImage: familyImage(["pnpm", "jq"]) })}::jsonb)`;
        yield* sql`
          INSERT INTO organization_settings (organization_id, workspace_image)
          VALUES (${org}, ${JSON.stringify(familyImage(["ripgrep", "unzip"], false))}::jsonb)`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id, workspace_image)
          VALUES
            ('p-family', 'family', '/store/p-family/repo.git', 'main', ${org}, ${JSON.stringify(familyImage(["bun", "fd"]))}::jsonb),
            ('p-custom', 'custom', '/store/p-custom/repo.git', 'main', ${org}, ${JSON.stringify(customImage)}::jsonb),
            ('p-inherit', 'inherit', '/store/p-inherit/repo.git', 'main', ${org}, NULL)`;
        yield* migrations["0127_default_bun"];
        // Running it again changes nothing.
        yield* migrations["0127_default_bun"];
        const [instance] = yield* sql<{ readonly packages: ReadonlyArray<string> }>`
          SELECT value->'workspaceImage'->'packages' AS packages FROM settings`;
        const [organizationImage] = yield* sql<{ readonly packages: ReadonlyArray<string> }>`
          SELECT workspace_image->'packages' AS packages FROM organization_settings`;
        const projects = yield* sql<{
          readonly id: string;
          readonly packages: ReadonlyArray<string> | null;
        }>`SELECT id, workspace_image->'packages' AS packages FROM projects ORDER BY id`;
        return {
          instance: instance?.packages,
          organization: organizationImage?.packages,
          projects: projects.map((row) => [row.id, row.packages]),
        };
      }),
    );
    expect(result).toEqual({
      instance: ["pnpm", "jq", "bun", "unzip"],
      organization: ["ripgrep", "unzip", "bun"],
      projects: [
        ["p-custom", ["ripgrep"]],
        ["p-family", ["bun", "fd", "unzip"]],
        ["p-inherit", null],
      ],
    });
  });
});

describe.skipIf(postgres.skip)("0129 ambient removed", () => {
  beforeAll(emptyScratch);

  it("moves ambient projects to their creator's mode, else mend-key, and new projects default to mend-key", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0128_cli_auth_client");
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        const org = organization?.id ?? "";
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES ('anna', 'Anna', 'anna@example.com', '2026-01-01T00:00:00Z'),
                 ('ben', 'Ben', 'ben@example.com', '2026-01-02T00:00:00Z'),
                 ('cara', 'Cara', 'cara@example.com', '2026-01-03T00:00:00Z')`;
        yield* sql`
          INSERT INTO user_git_access (user_id, mode) VALUES ('anna', 'bridge'), ('ben', 'mend-key')`;
        yield* sql`
          INSERT INTO projects
            (id, name, store_path, default_branch, organization_id, created_by_user_id, origin_url)
          VALUES
            ('p-anna', 'anna', '/store/p-anna/repo.git', 'main', ${org}, 'anna',
             'https://github.com/octocat/Hello-World.git'),
            ('p-ben', 'ben', '/store/p-ben/repo.git', 'main', ${org}, 'ben',
             'https://github.com/octocat/Hello-World.git'),
            ('p-cara', 'cara', '/store/p-cara/repo.git', 'main', ${org}, 'cara',
             'https://github.com/octocat/Hello-World.git'),
            ('p-nobody', 'nobody', '/store/p-nobody/repo.git', 'main', ${org}, NULL, NULL)`;
        yield* sql`
          INSERT INTO projects
            (id, name, store_path, default_branch, organization_id, created_by_user_id,
             origin_url, git_auth_mode)
          VALUES ('p-kept', 'kept', '/store/p-kept/repo.git', 'main', ${org}, 'anna',
                  'git@github.com:acme/api.git', 'mend-key')`;
        const before = yield* sql<{ readonly id: string; readonly mode: string }>`
          SELECT id, git_auth_mode AS mode FROM projects ORDER BY id`;
        yield* migrations["0129_ambient_removed"];
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-new', 'new', '/store/p-new/repo.git', 'main', ${org})`;
        const after = yield* sql<{ readonly id: string; readonly mode: string }>`
          SELECT id, git_auth_mode AS mode FROM projects ORDER BY id`;
        return {
          before: before.map((row) => [row.id, row.mode]),
          after: after.map((row) => [row.id, row.mode]),
        };
      }),
    );
    expect(rows.before).toEqual([
      ["p-anna", "ambient"],
      ["p-ben", "ambient"],
      ["p-cara", "ambient"],
      ["p-kept", "mend-key"],
      ["p-nobody", "ambient"],
    ]);
    expect(rows.after).toEqual([
      ["p-anna", "bridge"],
      ["p-ben", "mend-key"],
      ["p-cara", "mend-key"],
      ["p-kept", "mend-key"],
      ["p-new", "mend-key"],
      ["p-nobody", "mend-key"],
    ]);
  });
});

describe.skipIf(postgres.skip)("0130 claude's own default", () => {
  beforeAll(emptyScratch);

  it("takes the default off the seeded `fable`, and leaves codex's as it is", async () => {
    const defaults = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0129_ambient_removed");
        const read = sql<{ readonly harness: string; readonly id: string }>`
          SELECT harness, id FROM harness_models WHERE is_default ORDER BY harness, id`;
        const before = yield* read;
        yield* migrations["0130_claude_own_default"];
        const after = yield* read;
        return {
          before: before.map((row) => [row.harness, row.id]),
          after: after.map((row) => [row.harness, row.id]),
        };
      }),
    );
    expect(defaults.before).toEqual([
      ["claude", "fable"],
      ["codex", "gpt-6.1-sol"],
    ]);
    expect(defaults.after).toEqual([["codex", "gpt-6.1-sol"]]);
  });
});

describe.skipIf(postgres.skip)("0138 kubernetes person layout", () => {
  beforeAll(emptyScratch);

  const KUBERNETES = "Kubernetes workspaces cannot run per-person users: no one's sudo works there";
  const NO_NEW_PRIVILEGES = "no-new-privileges is set, so no one's sudo works";
  const OWNER_MAP = "its sealantd does not restore files per person";

  it("takes the reasons only Kubernetes or an unprobed image caused out of every no, drops a no left with none, and runs twice the same", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0137_preview_grants");
        const rows: ReadonlyArray<readonly [string, string, boolean, ReadonlyArray<string>]> = [
          ["k8s-nnp", "k8s", false, [NO_NEW_PRIVILEGES]],
          ["unknown-kubernetes", "unknown", false, [KUBERNETES]],
          ["k3s-owner-map", "k3s", false, [OWNER_MAP]],
          ["docker-owner-map", "docker", false, [OWNER_MAP]],
          ["k8s-nnp-kubernetes", "k8s", false, [NO_NEW_PRIVILEGES, KUBERNETES]],
          ["k8s-setfacl-nnp-sudo", "k8s", false, ["no setfacl", NO_NEW_PRIVILEGES, "no sudo"]],
          ["docker-owner-map-acl", "docker", false, [OWNER_MAP, "no ACLs on /workspace"]],
          ["docker-nnp", "docker", false, [NO_NEW_PRIVILEGES]],
          ["docker-nnp-kubernetes", "docker", false, [NO_NEW_PRIVILEGES, KUBERNETES]],
          ["k8s-yes", "k8s", true, []],
          ["k8s-no-sudo", "k8s", false, ["no sudo"]],
        ];
        for (const [imageKey, runtime, person, missing] of rows) {
          yield* sql`
            INSERT INTO image_layout_capabilities (image_key, runtime, person, missing, confirmed)
            VALUES (${imageKey}, ${runtime}, ${person}, ${JSON.stringify(missing)}::jsonb, true)`;
        }
        const read = sql<{ readonly imageKey: string; readonly missing: ReadonlyArray<string> }>`
          SELECT image_key AS "imageKey", missing FROM image_layout_capabilities
          ORDER BY image_key`;
        yield* migrations["0138_kubernetes_person_layout"];
        const once = yield* read;
        yield* migrations["0138_kubernetes_person_layout"];
        const twice = yield* read;
        return { once, twice };
      }),
    );
    const kept = [
      { imageKey: "docker-nnp", missing: [NO_NEW_PRIVILEGES] },
      { imageKey: "docker-nnp-kubernetes", missing: [NO_NEW_PRIVILEGES] },
      { imageKey: "docker-owner-map-acl", missing: ["no ACLs on /workspace"] },
      { imageKey: "k8s-no-sudo", missing: ["no sudo"] },
      { imageKey: "k8s-setfacl-nnp-sudo", missing: ["no setfacl", "no sudo"] },
      { imageKey: "k8s-yes", missing: [] },
    ];
    expect(result.once).toEqual(kept);
    expect(result.twice).toEqual(kept);
  });
});

const migrateWith = (record: Record<string, Effect.Effect<void, SqlError, SqlClient.SqlClient>>) =>
  Migrator.make({})({ loader: Migrator.fromRecord(record), table: "mend_migrations" });

describe.skipIf(postgres.skip)("0140 session pages", () => {
  beforeAll(emptyScratch);

  it("reaches a database the migrator already took to 0139", async () => {
    const tables = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrateWith(
          Object.fromEntries(ORDERED.filter(([name]) => name <= "0139_preview_controls")),
        );
        const before = yield* sql<{ readonly name: string | null }>`
          SELECT to_regclass('session_pages')::text AS name`;
        yield* migrateWith(migrations);
        const after = yield* sql<{ readonly name: string | null }>`
          SELECT to_regclass('session_pages')::text AS name`;
        const applied = yield* sql<{ readonly name: string }>`
          SELECT name FROM mend_migrations WHERE migration_id = 140`;
        return { before: before[0]?.name, after: after[0]?.name, recorded: applied[0]?.name };
      }),
    );
    expect(tables).toEqual({ before: null, after: "session_pages", recorded: "session_pages" });
  });
});

const refused = (statement: Effect.Effect<unknown, SqlError>) =>
  statement.pipe(
    Effect.as("done"),
    Effect.catch(() => Effect.succeed("refused")),
  );

describe.skipIf(postgres.skip)("0148 resources", () => {
  beforeAll(emptyScratch);

  it("holds a definition to its spec, keeps approvals and own targets apart, and keeps its project", async () => {
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const outcome = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0143_recipe_launch");
        yield* migrations["0148_resources"];
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main', ${organization?.id ?? ""})`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc'),
                 ('wt-2', 'p-1', 'two', 'two', 'mend/two', 'abc')`;
        const spec = JSON.stringify({ name: "db", scope: "project", preset: "postgres" });
        const misnamed = yield* attempt(sql`
          INSERT INTO resource_definitions
            (id, project_id, name, scope, preset, spec, spec_digest, declared_by)
          VALUES ('rdef_2', 'p-1', 'cache', 'project', 'postgres', ${spec}::jsonb, ${digestA}, 'alice')`);
        const unpreset = yield* attempt(sql`
          INSERT INTO resource_definitions
            (id, project_id, name, scope, preset, spec, spec_digest, declared_by)
          VALUES ('rdef_2', 'p-1', 'db', 'project', NULL, ${spec}::jsonb, ${digestA}, 'alice')`);
        yield* sql`
          INSERT INTO resource_definitions
            (id, project_id, name, scope, preset, spec, spec_digest, declared_by)
          VALUES ('rdef_1', 'p-1', 'db', 'project', 'postgres', ${spec}::jsonb, ${digestA}, 'alice')`;
        const approve = (id: string, revision: number, worktree: string | null) =>
          sql`
            INSERT INTO resource_approvals
              (id, definition_id, worktree_id, revision, definition_digest, digest, spec, approved_by)
            VALUES (${id}, 'rdef_1', ${worktree}, ${revision}, ${digestA}, ${digestB},
                    ${spec}::jsonb, 'alice')`;
        yield* approve("rapr_1", 1, null);
        const sameRevision = yield* attempt(approve("rapr_2", 1, null));
        yield* approve("rapr_3", 3, "wt-1");
        const rewritten = yield* refused(
          sql`UPDATE resource_approvals SET approved_by = 'mallory'`,
        );
        const deleted = yield* refused(sql`DELETE FROM resource_approvals WHERE id = 'rapr_1'`);
        const ownWithoutTarget = yield* attempt(sql`
          INSERT INTO resource_selections (worktree_id, definition_id, mode, revision)
          VALUES ('wt-1', 'rdef_1', 'own', 0)`);
        const target = JSON.stringify({ kind: "database", database: "rdb_1" });
        yield* sql`
          INSERT INTO resource_selections (worktree_id, definition_id, mode, revision, own_target)
          VALUES ('wt-1', 'rdef_1', 'own', 0, ${target}::jsonb)`;
        const sharedTarget = yield* attempt(sql`
          INSERT INTO resource_selections (worktree_id, definition_id, mode, revision, own_target)
          VALUES ('wt-2', 'rdef_1', 'own', 0, ${target}::jsonb)`);
        yield* sql`INSERT INTO project_removal_fences (id, project_id) VALUES ('rfen_1', 'p-1')`;
        const projectDeleted = yield* attempt(sql`DELETE FROM projects WHERE id = 'p-1'`);
        // A worktree's approvals go with it, and the rest with their definition.
        yield* sql`DELETE FROM worktrees WHERE id = 'wt-1'`;
        const [afterWorktree] = yield* sql<{ readonly approvals: number }>`
          SELECT count(*)::int AS approvals FROM resource_approvals`;
        yield* sql`DELETE FROM resource_definitions WHERE id = 'rdef_1'`;
        yield* sql`DELETE FROM projects WHERE id = 'p-1'`;
        const [left] = yield* sql<{
          readonly selections: number;
          readonly approvals: number;
          readonly fences: number;
        }>`
          SELECT (SELECT count(*)::int FROM resource_selections) AS selections,
                 (SELECT count(*)::int FROM resource_approvals) AS approvals,
                 (SELECT count(*)::int FROM project_removal_fences) AS fences`;
        return {
          misnamed,
          unpreset,
          sameRevision,
          rewritten,
          deleted,
          ownWithoutTarget,
          sharedTarget,
          projectDeleted,
          afterWorktree,
          left,
        };
      }),
    );
    expect(outcome).toEqual({
      misnamed: { code: "23514", constraint: "resource_definitions_spec_columns" },
      unpreset: { code: "23514", constraint: "resource_definitions_spec_columns" },
      sameRevision: { code: "23505", constraint: "resource_approvals_definition_revision_key" },
      rewritten: "refused",
      deleted: "refused",
      ownWithoutTarget: { code: "23514", constraint: "resource_selections_own_target" },
      sharedTarget: { code: "23505", constraint: "resource_selections_own_target_key" },
      projectDeleted: { code: "23503", constraint: "resource_definitions_project_id_fkey" },
      afterWorktree: { approvals: 1 },
      left: { selections: 0, approvals: 0, fences: 0 },
    });
  }, 60_000);
});

describe.skipIf(postgres.skip)("0170 drop recipe approvals", () => {
  beforeAll(emptyScratch);

  it("leaves nothing that refers to recipe approvals, and keeps a refused turn decided", async () => {
    const outcome = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0168_turn_dispatch_attempt");
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status)
          VALUES ('s-1', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running')`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status,
             launch_source)
          VALUES ('proc-1', 's-1', 'ws-1', 'pty-1', 'agent-protocol', 'running', 'recipe')`;
        yield* sql`
          INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status, ended_at)
          VALUES ('t-refused', 's-1', 'proc-1', 0, 'fix it', 'completed', now()),
                 ('t-changed', 's-1', 'proc-1', 1, 'fix it', 'completed', now())`;
        yield* sql`
          INSERT INTO recipe_approvals (worktree_id, service_name, digest, approved_by, spec)
          VALUES ('wt-1', 'web', 'd-1', 'alice', '{}'::jsonb)`;
        yield* sql`
          INSERT INTO preview_preparations
            (turn_id, session_id, worktree_id, state, note, service_name, claim_id, claimed_at,
             lease_until, decided_at)
          VALUES
            ('t-refused', 's-1', 'wt-1', 'not-approved', NULL, 'web', gen_random_uuid(), now(),
             now(), now()),
            ('t-changed', 's-1', 'wt-1', 'running', 'recipe-changed', 'web', gen_random_uuid(),
             now(), now(), now())`;
        yield* migrations["0170_drop_recipe_approvals"];
        const named = yield* sql<{ readonly what: string }>`
          SELECT relname AS what FROM pg_class WHERE relname LIKE '%recipe_approval%'
          UNION ALL
          SELECT conname FROM pg_constraint
          WHERE pg_get_constraintdef(oid) LIKE '%recipe_approval%'
            OR pg_get_constraintdef(oid) LIKE '%not-approved%'
            OR pg_get_constraintdef(oid) LIKE '%recipe-changed%'
          UNION ALL
          SELECT proname FROM pg_proc WHERE prosrc LIKE '%recipe_approval%'
          UNION ALL
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'session_processes' AND column_name = 'launch_source'`;
        const preparations = yield* sql<{
          readonly turnId: string;
          readonly state: string;
          readonly note: string | null;
          readonly decided: boolean;
        }>`
          SELECT turn_id AS "turnId", state, note, decided_at IS NOT NULL AS decided
          FROM preview_preparations ORDER BY turn_id`;
        const refusedAgain = yield* attempt(
          sql`UPDATE preview_preparations SET state = 'not-approved', service_name = NULL
            WHERE turn_id = 't-changed'`,
        );
        return { named: named.map((row) => row.what), preparations, refusedAgain };
      }),
    );
    expect(outcome).toEqual({
      named: [],
      preparations: [
        { turnId: "t-changed", state: "running", note: null, decided: true },
        { turnId: "t-refused", state: "skipped", note: null, decided: true },
      ],
      refusedAgain: { code: "23514", constraint: "preview_preparations_state_check" },
    });
  }, 60_000);
});

const pin = (hex: string) => `sha256:${hex.repeat(64)}`;

describe.skipIf(postgres.skip)("0173 drop resource approvals", () => {
  beforeAll(emptyScratch);

  it("keeps each definition's pin on its own row, and drops what only approval held", async () => {
    const outcome = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0172_doppler");
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1)),
                 ('p-gone', 'old', '/store/p-gone/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        const define = (id: string, project: string, name: string, image: string, digest: string) =>
          sql`
            INSERT INTO resource_definitions
              (id, project_id, name, scope, preset, spec, spec_digest, declared_by)
            VALUES (${id}, ${project}, ${name}, 'project', NULL,
                    ${JSON.stringify({ name, scope: "project", preset: null, image })}::jsonb,
                    ${digest.repeat(64)}, 'alice')`;
        const approve = (
          id: string,
          definition: string,
          revision: number,
          declared: string,
          image: string,
          worktree: string | null = null,
        ) =>
          sql`
            INSERT INTO resource_approvals
              (id, definition_id, worktree_id, revision, definition_digest, digest, spec,
               approved_by)
            VALUES (${id}, ${definition}, ${worktree}, ${revision}, ${declared.repeat(64)},
                    ${"f".repeat(64)}, ${JSON.stringify({ image })}::jsonb, 'maria')`;
        // The latest project approval of the spec held now pins it.
        yield* define("rdef_db", "p-1", "db", "postgres:17", "a");
        yield* approve("rapr_1", "rdef_db", 1, "a", `postgres:17@${pin("1")}`);
        yield* approve("rapr_2", "rdef_db", 2, "a", `postgres:17@${pin("2")}`);
        yield* approve("rapr_3", "rdef_db", 3, "a", `postgres:17@${pin("3")}`, "wt-1");
        // An approval of an older spec never carries over; an image pinned already pins itself.
        yield* define("rdef_cache", "p-1", "cache", `redis:8@${pin("4")}`, "b");
        yield* approve("rapr_4", "rdef_cache", 1, "c", `redis:8@${pin("5")}`);
        // Neither: it was never the project's, and goes with its selection.
        yield* define("rdef_mail", "p-1", "mail", "axllent/mailpit:v1.27", "d");
        yield* sql`
          INSERT INTO resource_selections (worktree_id, definition_id, mode, revision)
          VALUES ('wt-1', 'rdef_mail', 'shared', 0)`;
        yield* sql`
          INSERT INTO resource_proposals (id, project_id, name, spec, spec_digest, proposed_by)
          VALUES ('rprop_1', 'p-1', 'db', '{"name":"db"}'::jsonb, ${"e".repeat(64)}, 'tom')`;
        // A removed project's definition takes its pin too.
        yield* define("rdef_old", "p-gone", "db", "postgres:16", "a");
        yield* approve("rapr_5", "rdef_old", 1, "a", `postgres:16@${pin("6")}`);
        yield* sql`
          UPDATE projects SET removal_phase = 'removed', removal_id = 'rmv_1',
            removal_since = now(), removed_at = now()
          WHERE id = 'p-gone'`;
        yield* migrations["0173_drop_resource_approvals"];
        const definitions = yield* sql<{
          readonly id: string;
          readonly imageDigest: string;
          readonly addedBy: string;
        }>`
          SELECT id, image_digest AS "imageDigest", added_by AS "addedBy"
          FROM resource_definitions ORDER BY id`;
        const selections = yield* sql<{ readonly n: number }>`
          SELECT count(*)::int AS n FROM resource_selections`;
        const named = yield* sql<{ readonly what: string }>`
          SELECT relname AS what FROM pg_class
          WHERE relname LIKE 'resource_approval%' OR relname LIKE 'resource_proposal%'
          UNION ALL
          SELECT proname FROM pg_proc WHERE proname LIKE 'resource_approval%'`;
        const unpinned = yield* attempt(
          sql`UPDATE resource_definitions SET image_digest = 'latest' WHERE id = 'rdef_db'`,
        );
        const removedChanged = yield* attempt(
          sql`UPDATE resource_definitions SET added_by = 'mallory' WHERE id = 'rdef_old'`,
        );
        return {
          definitions,
          selections: selections[0]?.n,
          named: named.map((row) => row.what),
          unpinned,
          removedChanged,
        };
      }),
    );
    expect(outcome).toMatchObject({
      definitions: [
        { id: "rdef_cache", imageDigest: pin("4"), addedBy: "alice" },
        { id: "rdef_db", imageDigest: pin("2"), addedBy: "alice" },
        { id: "rdef_old", imageDigest: pin("6"), addedBy: "alice" },
      ],
      selections: 0,
      named: [],
      unpinned: { code: "23514" },
      // The removed project's guard is back once the pins are in.
      removedChanged: { code: "MRFRM" },
    });
  }, 60_000);
});

describe.skipIf(postgres.skip)("0163 push device credentials", () => {
  beforeAll(emptyScratch);

  it("drops every push token no device can be proven to own, and ties the next ones to a device", async () => {
    const result = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrateWith(
          Object.fromEntries(ORDERED.filter(([name]) => name <= "0159_session_messages")),
        );
        yield* sql`
          INSERT INTO "user" (id, name, email) VALUES ('u-phone', 'Phone', 'phone@example.com')`;
        yield* sql`
          INSERT INTO device_tokens (id, user_id, name, platform, token_hash) VALUES
            ('d-a', 'u-phone', 'Phone a', 'ios', 'hash-a'),
            ('d-b', 'u-phone', 'Phone b', 'ios', 'hash-b')`;
        yield* sql`
          INSERT INTO push_devices (token, platform, user_id) VALUES
            ('legacy-a', 'ios', 'u-phone'), ('legacy-b', 'android', 'u-phone')`;
        yield* migrateWith(migrations);
        const legacy = yield* sql<{ readonly token: string }>`SELECT token FROM push_devices`;
        const columns = yield* sql<{ readonly column_name: string; readonly is_nullable: string }>`
          SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = 'push_devices' AND column_name IN ('user_id', 'device_token_id')`;
        const unowned = yield* attempt(
          sql`INSERT INTO push_devices (token, platform) VALUES ('unowned', 'ios')`,
        );
        yield* sql`
          INSERT INTO push_devices (token, platform, device_token_id) VALUES
            ('push-a', 'ios', 'd-a'), ('push-b', 'ios', 'd-b')`;
        yield* sql`UPDATE device_tokens SET revoked_at = now() WHERE id = 'd-a'`;
        const afterRevoke = yield* sql<{ readonly token: string }>`SELECT token FROM push_devices`;
        yield* sql`UPDATE "user" SET "deactivatedAt" = now() WHERE id = 'u-phone'`;
        const afterDeactivate = yield* sql`SELECT token FROM push_devices`;
        return {
          legacy: legacy.map((row) => row.token),
          columns,
          unowned,
          afterRevoke: afterRevoke.map((row) => row.token),
          afterDeactivate: afterDeactivate.length,
        };
      }),
    );
    expect(result).toEqual({
      legacy: [],
      columns: [{ column_name: "device_token_id", is_nullable: "NO" }],
      unowned: { code: "23502", column: "device_token_id" },
      afterRevoke: ["push-b"],
      afterDeactivate: 0,
    });
  });
});

describe.skipIf(postgres.skip)("0165 preview preparations", () => {
  beforeAll(emptyScratch);

  it("decides every turn that already ended, and leaves an open one to the job", async () => {
    const rows = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0157_recipe_approvals");
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'api', '/store/p-1/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'one', 'one', 'mend/one', 'abc')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status)
          VALUES ('s-1', 'p-1', 'wt-1', 'claude', 'one', 'mend/one', 'abc', 'running')`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status)
          VALUES ('proc-1', 's-1', 'ws-1', 'pty-1', 'agent-protocol', 'running')`;
        yield* sql`
          INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status, ended_at)
          VALUES ('t-done', 's-1', 'proc-1', 0, 'fix it', 'completed', '2026-09-01T00:00:00Z'),
                 ('t-failed', 's-1', 'proc-1', 1, 'fix it', 'failed', NULL),
                 ('t-open', 's-1', 'proc-1', 2, 'fix it', 'running', NULL)`;
        yield* migrations["0165_preview_preparations"];
        return yield* sql<{
          readonly turnId: string;
          readonly state: string;
          readonly worktreeId: string;
          readonly decidedAt: Date | null;
        }>`
          SELECT turn_id AS "turnId", state, worktree_id AS "worktreeId", decided_at AS "decidedAt"
          FROM preview_preparations ORDER BY turn_id`;
      }),
    );
    expect(rows.map((row) => ({ ...row, decided: row.decidedAt !== null }))).toEqual([
      {
        turnId: "t-done",
        state: "skipped",
        worktreeId: "wt-1",
        decidedAt: new Date("2026-09-01T00:00:00Z"),
        decided: true,
      },
      expect.objectContaining({
        turnId: "t-failed",
        state: "skipped",
        worktreeId: "wt-1",
        decided: true,
      }),
    ]);
  }, 60_000);
});

describe.skipIf(postgres.skip)("0183 resource own databases key repair", () => {
  beforeEach(async () => {
    await emptyScratch();
    await withScratch(
      Effect.gen(function* () {
        yield* upTo("0182_slack_proof_turns");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-repair', 'Repair')`;
        yield* sql`INSERT INTO projects (id, name, organization_id, store_path, default_branch)
          VALUES ('p-repair', 'repair', 'org-repair', '/store/repair/repo.git', 'main')`;
        yield* sql`INSERT INTO resource_definitions (id, project_id, name)
          VALUES ('db-repair', 'p-repair', 'db')`;
      }),
    );
  });

  const inventory = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      columns: yield* sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'resource_own_databases'
        ORDER BY ordinal_position`,
      constraints: yield* sql`SELECT oid, conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid = 'resource_own_databases'::regclass ORDER BY conname`,
      rows: yield* sql`SELECT * FROM resource_own_databases ORDER BY worktree_id, definition_id`,
    };
  });

  it.each([false, true])("repairs retired 0180 with a renamed key: %s", async (renamed) => {
    await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`ALTER TABLE resource_own_databases ADD COLUMN purpose text NOT NULL DEFAULT 'own' CHECK (purpose IN ('own', 'base'))`;
        yield* sql`ALTER TABLE resource_own_databases DROP CONSTRAINT resource_own_databases_pkey`;
        yield* sql`ALTER TABLE resource_own_databases ADD PRIMARY KEY (worktree_id, definition_id, purpose)`;
        if (renamed) {
          yield* sql`ALTER TABLE resource_own_databases RENAME CONSTRAINT resource_own_databases_pkey TO preview_primary_key`;
        }
        yield* sql`INSERT INTO resource_own_databases
          (worktree_id, definition_id, origin, purpose, made_at) VALUES
          ('wt-repair', 'db-repair', 'copied', 'own', '2026-11-01T00:00:00Z'),
          ('wt-repair', 'db-repair', 'empty', 'base', '2026-11-01T00:00:00Z')`;
        yield* migrations["0183_resource_own_databases_key_repair"];
        expect(
          yield* sql`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
            WHERE conrelid = 'resource_own_databases'::regclass AND contype = 'p'`,
        ).toEqual([
          {
            conname: "resource_own_databases_pkey",
            definition: "PRIMARY KEY (worktree_id, definition_id)",
          },
        ]);
        expect(
          yield* sql`SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'resource_own_databases' AND column_name = 'purpose'`,
        ).toEqual([]);
        expect(
          yield* sql`SELECT conname FROM pg_constraint
            WHERE conrelid = 'resource_own_databases'::regclass AND conname = 'resource_own_databases_purpose_check'`,
        ).toEqual([]);
        expect(
          yield* sql`SELECT worktree_id, definition_id, origin, made_at FROM resource_own_databases`,
        ).toEqual([
          {
            worktree_id: "wt-repair",
            definition_id: "db-repair",
            origin: "copied",
            made_at: new Date("2026-11-01T00:00:00Z"),
          },
        ]);
        yield* sql`INSERT INTO resource_own_databases (worktree_id, definition_id, origin)
          VALUES ('wt-repair', 'db-repair', 'loaded')
          ON CONFLICT ("worktree_id", "definition_id") DO UPDATE
          SET origin = EXCLUDED.origin, made_at = now()`;
        expect(yield* sql`SELECT origin FROM resource_own_databases`).toEqual([
          { origin: "loaded" },
        ]);
        const repaired = yield* inventory;
        yield* migrations["0183_resource_own_databases_key_repair"];
        expect(yield* inventory).toEqual(repaired);
      }),
    );
  });

  it("leaves a database that never applied 0180 unchanged", async () => {
    await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO resource_own_databases (worktree_id, definition_id, origin)
          VALUES ('wt-repair', 'db-repair', 'copied')`;
        const original = yield* inventory;
        yield* migrations["0183_resource_own_databases_key_repair"];
        yield* migrations["0183_resource_own_databases_key_repair"];
        expect(yield* inventory).toEqual(original);
      }),
    );
  });
});

describe.skipIf(postgres.skip)("0166 worktree removal", () => {
  beforeAll(emptyScratch);

  it("records each worktree's earliest standing owner, proven only where the history vouches", async () => {
    const outcome = await withScratch(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* upTo("0165_preview_preparations");
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-1', 'Acme')`;
        yield* sql`
          INSERT INTO projects (id, name, organization_id, store_path, default_branch)
          VALUES ('p-1', 'api', 'org-1', '/store/api/repo.git', 'main')`;
        // Before 0118 every worktree has a gap in its owner history; these come after it.
        yield* sql`DELETE FROM worktree_owner_gaps`;
        for (const id of [
          "w-sole",
          "w-shared",
          "w-first-deleted",
          "w-ownerless",
          "w-gap-standing",
          "w-deleted-one",
          "w-gap",
          "w-empty",
        ]) {
          yield* sql`
            INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
            VALUES (${id}, 'p-1', ${id}, ${id}, ${`mend/${id}`}, 'abc')`;
        }
        const session = (id: string, worktree: string, owner: string | null, at: string) => sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id,
             status, created_at)
          VALUES (${id}, 'p-1', ${worktree}, 'claude', ${worktree}, 'mend/x', 'abc', ${owner},
                  'completed', ${at}::timestamptz)`;
        yield* session("s-1", "w-sole", "anna", "2026-10-01T00:00:00Z");
        yield* session("s-2", "w-shared", "kostas", "2026-10-02T00:00:00Z");
        yield* session("s-3", "w-shared", "anna", "2026-10-01T00:00:00Z");
        // Anna's first session here was deleted; Kostas's is the earliest that stands.
        yield* session("s-4", "w-first-deleted", "kostas", "2026-10-02T00:00:00Z");
        yield* session("s-5", "w-ownerless", null, "2026-10-01T00:00:00Z");
        yield* session("s-6", "w-ownerless", "anna", "2026-10-02T00:00:00Z");
        yield* session("s-7", "w-gap-standing", "anna", "2026-10-01T00:00:00Z");
        yield* sql`
          INSERT INTO worktree_session_owners (worktree_id, user_id)
          VALUES ('w-sole', 'anna'), ('w-shared', 'anna'), ('w-shared', 'kostas'),
                 ('w-first-deleted', 'anna'), ('w-first-deleted', 'kostas'),
                 ('w-ownerless', 'anna'), ('w-gap-standing', 'anna'),
                 ('w-deleted-one', 'anna'), ('w-gap', 'anna')`;
        yield* sql`
          INSERT INTO worktree_owner_gaps (worktree_id) VALUES ('w-gap'), ('w-gap-standing')`;
        yield* migrations["0166_worktree_removal"];
        // A worktree with no session left is recorded by the next one.
        yield* session("s-8", "w-deleted-one", "kostas", "2026-10-31T00:00:00Z");
        yield* session("s-9", "w-empty", "anna", "2026-10-31T00:00:00Z");
        const rows = yield* sql<{
          readonly id: string;
          readonly owner: string | null;
          readonly recorded: boolean;
          readonly proven: boolean;
        }>`
          SELECT id, change_owner_user_id AS owner, change_owner_recorded AS recorded,
                 change_owner_proven AS proven
          FROM worktrees ORDER BY id`;
        return Object.fromEntries(
          rows.map((row) => [row.id, [row.owner, row.recorded, row.proven]]),
        );
      }),
    );
    expect(outcome).toEqual({
      "w-sole": ["anna", true, true],
      "w-shared": ["anna", true, false],
      "w-first-deleted": ["kostas", true, false],
      "w-ownerless": [null, true, false],
      "w-gap-standing": ["anna", true, false],
      "w-deleted-one": ["kostas", true, false],
      "w-gap": [null, false, false],
      "w-empty": ["anna", true, true],
    });
  });
});
