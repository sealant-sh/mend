import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * The core tables from ARCHITECTURE.md §3. pg-boss owns its own `pgboss`
 * schema (created on start); the tables here are Mend's product state plus
 * better-auth's required tables (camelCase columns, quoted, as better-auth
 * expects them).
 */
const init = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE issues (
      id text PRIMARY KEY,
      source text NOT NULL,
      external_ref text,
      repository text NOT NULL,
      title text NOT NULL,
      body text NOT NULL DEFAULT '',
      stage text NOT NULL DEFAULT 'triage',
      position integer,
      last_failure_run_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX issues_stage_position_idx ON issues (stage, position)`;

  // One change per issue: the UNIQUE constraint is the cardinality rule.
  yield* sql`
    CREATE TABLE changes (
      id text PRIMARY KEY,
      issue_id text NOT NULL UNIQUE REFERENCES issues(id) ON DELETE CASCADE,
      branch text NOT NULL,
      base_sha text,
      head_sha text,
      pr_number integer,
      pr_url text,
      freshness text NOT NULL DEFAULT 'current',
      moved_base_sha text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;

  // The recording itself stays in Sealant; this is the index over executions.
  yield* sql`
    CREATE TABLE runs (
      id text PRIMARY KEY,
      issue_id text NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      change_id text REFERENCES changes(id) ON DELETE SET NULL,
      kind text NOT NULL,
      sealant_run_id text,
      sealant_workspace_id text,
      status text NOT NULL DEFAULT 'queued',
      outcome text,
      summary text,
      last_seen_sequence bigint NOT NULL DEFAULT 0,
      started_at timestamptz,
      settled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX runs_issue_idx ON runs (issue_id)`;

  // One living brief per change; prior versions stay in history.
  yield* sql`
    CREATE TABLE briefs (
      id text PRIMARY KEY,
      change_id text NOT NULL UNIQUE REFERENCES changes(id) ON DELETE CASCADE,
      current_version integer NOT NULL DEFAULT 1,
      document jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE TABLE brief_versions (
      brief_id text NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
      version integer NOT NULL,
      document jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (brief_id, version)
    )`;
  yield* sql`
    CREATE TABLE review_questions (
      id text PRIMARY KEY,
      brief_id text NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
      index integer NOT NULL,
      question text NOT NULL,
      disposition text NOT NULL,
      evidence jsonb NOT NULL DEFAULT '[]',
      UNIQUE (brief_id, index)
    )`;

  // The interface-inference audit trail: every tool call and model exchange.
  yield* sql`
    CREATE TABLE inference_calls (
      id text PRIMARY KEY,
      context text NOT NULL,
      tool text,
      input jsonb NOT NULL,
      output jsonb NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )`;

  yield* sql`
    CREATE TABLE settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;

  // better-auth tables — camelCase columns as its pg adapter expects.
  yield* sql`
    CREATE TABLE "user" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "email" text NOT NULL UNIQUE,
      "emailVerified" boolean NOT NULL DEFAULT false,
      "image" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE TABLE "session" (
      "id" text PRIMARY KEY,
      "expiresAt" timestamptz NOT NULL,
      "token" text NOT NULL UNIQUE,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    )`;
  yield* sql`CREATE INDEX session_user_idx ON "session" ("userId")`;
  yield* sql`
    CREATE TABLE "account" (
      "id" text PRIMARY KEY,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      "scope" text,
      "password" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX account_user_idx ON "account" ("userId")`;
  yield* sql`
    CREATE TABLE "verification" (
      "id" text PRIMARY KEY,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX verification_identifier_idx ON "verification" ("identifier")`;
});

/**
 * The failure mini-brief (PRODUCT.md §6), denormalized onto the run it sums
 * up: what was tried, what was observed, reproduction status — kept and
 * reported, never hidden. A failed run has no change row to hang a brief off.
 */
const failureBrief = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE runs ADD COLUMN failure_brief jsonb`;
});

/**
 * The brief's review conversation (PRODUCT.md, Iteration): reviewer comments
 * threaded onto the living document, Mend's replies beside them, and the
 * routed decision recorded on the comment that caused it.
 */
const briefComments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE brief_comments (
      id text PRIMARY KEY,
      brief_id text NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
      thread text NOT NULL,
      author_kind text NOT NULL,
      author_name text NOT NULL,
      body text NOT NULL,
      routed_action text,
      routed_run_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX brief_comments_brief_idx ON brief_comments (brief_id, created_at)`;
});

/**
 * The workbench object model (MEND-AGENT-WORKBENCH-PLAN.md §5): projects
 * adopted into the central store, sessions in per-session worktrees,
 * checkpoints, the session change, and review comments. Additive — the
 * queue-era tables stay until their surfaces retire (docs/M0-INVENTORY.md).
 * The product Session lives in `agent_sessions`: better-auth owns `"session"`.
 */
const workbench = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projects (
      id text PRIMARY KEY,
      name text NOT NULL UNIQUE,
      origin_url text,
      store_path text NOT NULL UNIQUE,
      default_branch text NOT NULL,
      adopted_sha text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;

  // Immutable manifest of exactly what a session received (plan §5.4).
  yield* sql`
    CREATE TABLE context_snapshots (
      id text PRIMARY KEY,
      pack_name text,
      items jsonb NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL DEFAULT now()
    )`;

  yield* sql`
    CREATE TABLE agent_sessions (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      harness text NOT NULL,
      provider_session_id text,
      label text,
      worktree text NOT NULL,
      branch text NOT NULL,
      base_sha text NOT NULL,
      context_snapshot_id text REFERENCES context_snapshots(id) ON DELETE SET NULL,
      sealant_run_id text,
      sealant_workspace_id text,
      status text NOT NULL DEFAULT 'starting',
      summary text,
      last_seen_sequence bigint NOT NULL DEFAULT 0,
      started_at timestamptz,
      settled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX agent_sessions_project_idx ON agent_sessions (project_id, created_at)`;
  yield* sql`CREATE INDEX agent_sessions_status_idx ON agent_sessions (status)`;

  // One change per session (plan §5.6); git owns the diff, this row the identity.
  yield* sql`
    CREATE TABLE session_changes (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id text NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE CASCADE,
      branch text NOT NULL,
      base_sha text NOT NULL,
      head_sha text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;

  // (hidden git ref, record seq) pairs — two checkpoints define a slice (§5.6).
  yield* sql`
    CREATE TABLE checkpoints (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      ref text NOT NULL,
      sha text NOT NULL,
      seq bigint NOT NULL DEFAULT 0,
      trigger text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX checkpoints_session_idx ON checkpoints (session_id, seq)`;

  yield* sql`
    CREATE TABLE review_comments (
      id text PRIMARY KEY,
      change_id text NOT NULL REFERENCES session_changes(id) ON DELETE CASCADE,
      file text,
      line integer,
      author_kind text NOT NULL,
      author_name text NOT NULL,
      body text NOT NULL,
      state text NOT NULL DEFAULT 'open',
      sent_to_session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX review_comments_change_idx ON review_comments (change_id, created_at)`;
});

/** The review-to-agent loop (plan §7.3): assembled follow-up instructions. */
const followUps = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE follow_ups (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      change_id text NOT NULL REFERENCES session_changes(id) ON DELETE CASCADE,
      instruction text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      delivered_at timestamptz
    )`;
  yield* sql`CREATE INDEX follow_ups_session_idx ON follow_ups (session_id, created_at)`;
});

/** The platform's PTY session id (SDK 0.7.0) — the durable reattach handle. */
const sealantSession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN sealant_session_id text`;
});

/** A comment can anchor to a RANGE of lines; `end_line` null = single line. */
const reviewCommentSpans = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE review_comments ADD COLUMN end_line integer`;
});

/** Phones registered for push — the token IS the identity (one row per install). */
const pushDevices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE push_devices (
      token text PRIMARY KEY,
      platform text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now()
    )`;
});

/**
 * References (plan §17, decided 2026-08-01): read-only clones of dependency
 * sources in the store, selected per project, mounted at `/workspace/ref/<name>`.
 * Table is `reference_repos` — `references` is a reserved word; the product
 * noun stays `reference`. The session records what it actually mounted
 * (`reference_mounts`), SHAs as observed at launch.
 */
const references = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE reference_repos (
      id text PRIMARY KEY,
      name text NOT NULL UNIQUE,
      origin_url text NOT NULL,
      path text NOT NULL UNIQUE,
      pinned_ref text,
      head_sha text,
      refreshed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE TABLE project_references (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      reference_id text NOT NULL REFERENCES reference_repos(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, reference_id)
    )`;
  yield* sql`
    ALTER TABLE agent_sessions ADD COLUMN reference_mounts jsonb NOT NULL DEFAULT '[]'`;
});

/**
 * Per-project extra mounts (plan §17, decided 2026-08-01): host folders a
 * project's sessions see at `/workspace/home/<name>`, read-only by default.
 * The session records what it actually mounted (`extra_mounts`) so the review
 * surface can state what the agent could see; the reviewable change itself
 * stays worktree-versus-base.
 */
const projectMounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_mounts (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name text NOT NULL,
      host_path text NOT NULL,
      read_only boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (project_id, name),
      UNIQUE (project_id, host_path)
    )`;
  yield* sql`
    ALTER TABLE agent_sessions ADD COLUMN extra_mounts jsonb NOT NULL DEFAULT '[]'`;
});

/**
 * "Mend reads the change" (plan §7.3, M2.5): machine findings land as draft
 * review comments carrying links into the session record. The evidence lives
 * on the comment row — `(sealantRunId, sequence, excerpt)` entries, sequences
 * as decimal strings (jsonb has no bigint).
 */
const reviewCommentEvidence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE review_comments ADD COLUMN evidence jsonb NOT NULL DEFAULT '[]'`;
});

/**
 * The composed review tour (plan §7.3): Mend reads the diff and the record
 * and writes the guided walkthrough — summary, approach, ordered stops with
 * evidence links. One per change, replaced on recompose; the document is
 * jsonb (sequences as decimal strings), diff_digest detects staleness.
 */
const changeTours = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE change_tours (
      id text PRIMARY KEY,
      change_id text NOT NULL UNIQUE REFERENCES session_changes(id) ON DELETE CASCADE,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      summary text NOT NULL,
      approach text,
      stops jsonb NOT NULL,
      diff_digest text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
});

/**
 * Review automation: per-project overrides of the Settings defaults (text
 * tri-state, `inherit` follows Settings), and the suggestion comment shape —
 * `kind` separates notes from suggestions; `suggestion` carries the proposed
 * replacement for the anchored lines.
 */
const reviewAutomation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects
      ADD COLUMN auto_tour text NOT NULL DEFAULT 'inherit',
      ADD COLUMN auto_suggest text NOT NULL DEFAULT 'inherit'`;
  yield* sql`
    ALTER TABLE review_comments
      ADD COLUMN kind text NOT NULL DEFAULT 'note',
      ADD COLUMN suggestion text`;
});

/**
 * Machine-pass outcomes (tour · read · suggest): one row per (change, kind),
 * replaced per run, so "the pass ran and drafted nothing" is a stored fact
 * the review page can state — never the same silence as "the pass never ran".
 */
const changePasses = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE change_passes (
      change_id text NOT NULL REFERENCES session_changes(id) ON DELETE CASCADE,
      kind text NOT NULL,
      status text NOT NULL,
      detail text,
      findings integer,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      PRIMARY KEY (change_id, kind)
    )`;
});

/**
 * A logical Mend session can span multiple Sealant runs: every settled-session resume creates a
 * fresh platform record whose sequence space begins at one. Preserve that membership and keep the
 * crash-resume cursor on the run it belongs to. Existing rows retain only their latest run pointer,
 * so their pre-migration record coverage is marked incomplete rather than reconstructed.
 */
const sessionRunHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE session_runs (
      sealant_run_id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      ordinal integer NOT NULL,
      harness text NOT NULL,
      sealant_workspace_id text NOT NULL,
      sealant_session_id text,
      status text NOT NULL,
      summary text,
      last_seen_sequence bigint NOT NULL DEFAULT 0,
      started_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (session_id, ordinal)
    )`;
  yield* sql`
    CREATE INDEX session_runs_session_idx ON session_runs (session_id, ordinal)`;
  yield* sql`
    CREATE UNIQUE INDEX session_runs_one_active_idx ON session_runs (session_id)
    WHERE settled_at IS NULL`;

  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN record_history_complete boolean NOT NULL DEFAULT false`;

  // The latest pointer is all the old schema retained. Preserve it, but never claim it represents
  // earlier overwritten runs.
  yield* sql`
    INSERT INTO session_runs
      (sealant_run_id, session_id, ordinal, harness, sealant_workspace_id, sealant_session_id,
       status, summary, last_seen_sequence, started_at, settled_at, created_at, updated_at)
    SELECT sealant_run_id, id, 0, harness, sealant_workspace_id, sealant_session_id,
           status, summary, last_seen_sequence, COALESCE(started_at, created_at), settled_at,
           created_at, updated_at
    FROM agent_sessions
    WHERE sealant_run_id IS NOT NULL AND sealant_workspace_id IS NOT NULL`;

  yield* sql`
    ALTER TABLE checkpoints
      ADD COLUMN sealant_run_id text REFERENCES session_runs(sealant_run_id) ON DELETE SET NULL`;
  yield* sql`
    CREATE INDEX checkpoints_session_created_idx ON checkpoints (session_id, created_at)`;
});

/**
 * Plural workspace processes (docs/SESSION-SERVICES.md): the agent is one PTY in the session's
 * workspace, not the only one. Live rows double as workspace leases. Live agent PTYs are backfilled
 * from the singular pointer so leases hold across the upgrade; settled history is not reconstructed.
 */
const sessionProcesses = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE session_processes (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      sealant_workspace_id text NOT NULL,
      sealant_session_id text NOT NULL,
      kind text NOT NULL,
      label text,
      argv jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'starting',
      exit_code integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      exited_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX session_processes_session_idx ON session_processes (session_id, created_at)`;
  yield* sql`
    CREATE INDEX session_processes_live_idx ON session_processes (sealant_workspace_id)
    WHERE exited_at IS NULL`;
  yield* sql`
    INSERT INTO session_processes
      (id, session_id, sealant_workspace_id, sealant_session_id, kind, label, status, created_at)
    SELECT gen_random_uuid()::text, id, sealant_workspace_id, sealant_session_id, 'agent',
           harness, 'running', COALESCE(started_at, created_at)
    FROM agent_sessions
    WHERE sealant_session_id IS NOT NULL AND sealant_workspace_id IS NOT NULL
      AND settled_at IS NULL`;
});

/**
 * Services ride the process table (docs/SESSION-SERVICES.md): an adopted Service has no PTY of
 * ours (sealant_session_id goes nullable) and carries its workspace port plus the host port Mend
 * binds. The one-listener-per-host-port invariant is enforced where it exists: on live rows.
 */
const servicePorts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE session_processes ALTER COLUMN sealant_session_id DROP NOT NULL`;
  yield* sql`
    ALTER TABLE session_processes ADD COLUMN workspace_port integer`;
  yield* sql`
    ALTER TABLE session_processes ADD COLUMN host_port integer`;
  yield* sql`
    CREATE UNIQUE INDEX session_processes_host_port_live_idx ON session_processes (host_port)
    WHERE exited_at IS NULL AND host_port IS NOT NULL`;
});

/**
 * Services' post-mortem logs read the RECORD (the process is gone; the record isn't), which needs
 * the run pointer on the process row. Null for rows created before this — their records exist but
 * are unaddressed.
 */
const processRunPointers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE session_processes ADD COLUMN sealant_run_id text`;
});

/**
 * Project-level Service recipes: the web-editable twin of mend.toml (docs/SESSION-SERVICES.md).
 * The file is project truth that travels with the repo; these rows are THIS machine's additions.
 * Name collisions are refused at the union, never resolved — the file wins.
 */
const projectServiceRecipes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_service_recipes (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name text NOT NULL,
      command text,
      port integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, name)
    )`;
});

/**
 * UDP Services (docs/SESSION-SERVICES.md): a Service is TCP unless declared
 * otherwise — the column records the declaration, never an observation.
 */
const serviceProtocol = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE session_processes ADD COLUMN protocol text NOT NULL DEFAULT 'tcp'`;
  yield* sql`ALTER TABLE project_service_recipes ADD COLUMN protocol text NOT NULL DEFAULT 'tcp'`;
});

/**
 * Per-project git auth mode (docs/GIT-ACCESS.md): `ambient` follows the login
 * user's git/ssh setup; `mend-key` uses the machine's Mend-generated deploy
 * key. Text, not an enum — the mode set will grow (per-user keys, agent
 * bridge) without a migration each time.
 */
const projectGitAuth = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects
      ADD COLUMN git_auth_mode text NOT NULL DEFAULT 'ambient'`;
});

/**
 * The workspace git transport log (docs/GIT-ACCESS.md): one row per remote
 * op the shim routed through the host — who fetched/pushed what, where, as
 * which identity, and how it ended. The host holds the credential, so the
 * host owns the record.
 */
const sessionGitOps = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE session_git_ops (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      project_id text NOT NULL,
      host text NOT NULL,
      port integer,
      kind text NOT NULL,
      command text NOT NULL,
      auth_mode text NOT NULL,
      ref_updates jsonb,
      exit_code integer,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    )`;
  yield* sql`
    CREATE INDEX session_git_ops_session_idx ON session_git_ops (session_id, started_at)`;
});

/**
 * Per-project workspace image (docs/WORKSPACE-IMAGES.md): NULL inherits the global
 * settings.workspaceImage default. Sessions stamp the image they actually launched with, so a
 * later project-setting change never rewrites what a past session ran on.
 */
const projectWorkspaceImage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_image jsonb`;
  yield* sql`
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS workspace_image jsonb`;
});

/**
 * The per-user dotfiles model: dotfiles are identity, not instance configuration. Config rides a
 * per-user row (the snapshot content itself lives in the dotfiles store — a bare git repo per
 * user under the store root, not the database); projects carry only an apply switch; sessions
 * stamp what they actually launched with plus who provisioned them. The DROP covers dev
 * instances that ran this migration's earlier per-project-jsonb shape before it merged.
 */
const dotfilesStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS user_dotfiles (
      user_id text PRIMARY KEY,
      repository jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    ALTER TABLE projects DROP COLUMN IF EXISTS dotfiles`;
  yield* sql`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS apply_dotfiles boolean NOT NULL DEFAULT true`;
  yield* sql`
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS dotfiles jsonb`;
  yield* sql`
    ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS owner_user_id text`;
});

/**
 * Project environment variables (`.plans/project-environment-variables.md`): project-owned,
 * explicitly non-secret name/value rows plus an aggregate revision on the project. Session runs
 * stamp the SAFE manifest they launched with — revision and name list, never values; NULL on both
 * marks the explicit legacy/unknown state for runs created before the feature or attached
 * externally.
 */
const projectEnvironment = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS environment_revision integer NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_environment_variables (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      name text NOT NULL,
      value text NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT project_environment_variables_project_id_name_key UNIQUE (project_id, name)
    )`;
  yield* sql`
    ALTER TABLE session_runs ADD COLUMN IF NOT EXISTS environment_revision integer`;
  yield* sql`
    ALTER TABLE session_runs ADD COLUMN IF NOT EXISTS environment_variable_names jsonb`;
});

/**
 * Project secrets: sealed-at-rest name/value rows (the value column holds ciphertext from the
 * machine's secrets key, never plaintext), an aggregate revision on the project, and the safe
 * name-only launch manifest on session runs — the secret half of the project env store.
 */
const projectSecretsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS secret_revision integer NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_secrets (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      name text NOT NULL,
      sealed_value text NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT project_secrets_project_id_name_key UNIQUE (project_id, name)
    )`;
  yield* sql`
    ALTER TABLE session_runs ADD COLUMN IF NOT EXISTS secret_revision integer`;
  yield* sql`
    ALTER TABLE session_runs ADD COLUMN IF NOT EXISTS secret_names jsonb`;
});

/**
 * Hot sessions: a per-project count of pre-provisioned session skeletons (worktree + live
 * workspace keyed by a pre-generated session id) claimable at session start, plus the pool table
 * itself. `fingerprint` hashes every create-time-fixed workspace input; a claim requires an exact
 * match, and the reconciler drains mismatched entries.
 */
const hotSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS hot_sessions integer NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS hot_workspaces (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      owner_user_id text,
      status text NOT NULL DEFAULT 'warming',
      error text,
      fingerprint text NOT NULL,
      worktree text NOT NULL,
      branch text NOT NULL,
      base_sha text NOT NULL,
      sealant_workspace_id text,
      workspace_image jsonb,
      dotfiles jsonb,
      environment jsonb,
      reference_mounts jsonb NOT NULL DEFAULT '[]'::jsonb,
      extra_mounts jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS hot_workspaces_project_status_idx
      ON hot_workspaces (project_id, status)`;
});

/** Session auto-naming: the per-project override of the Settings `autoName` default. */
const autoName = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects
      ADD COLUMN auto_name text NOT NULL DEFAULT 'inherit'`;
});

/**
 * Immutable Review comparisons and slice-bound comment anchors. Existing comments retain a null
 * anchor and render as legacy live-diff comments; no checkpoint pair is invented for them.
 */
const immutableReviewSlices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS review_slices (
      id text PRIMARY KEY,
      change_id text NOT NULL REFERENCES session_changes (id) ON DELETE CASCADE,
      checkpoint_a_id text NOT NULL REFERENCES checkpoints (id) ON DELETE CASCADE,
      checkpoint_b_id text NOT NULL REFERENCES checkpoints (id) ON DELETE CASCADE,
      diff_digest text NOT NULL,
      idempotency_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS review_slices_change_key_idx
      ON review_slices (change_id, idempotency_key)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS review_slices_change_created_idx
      ON review_slices (change_id, created_at)`;
  yield* sql`ALTER TABLE review_comments ADD COLUMN IF NOT EXISTS anchor jsonb`;
});

/** Durable, idempotent Review delivery with process-level launch correlation. */
const recoverableFollowUpDelivery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE session_processes
      ADD COLUMN IF NOT EXISTS launch_correlation_id text`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS session_processes_launch_correlation_idx
      ON session_processes (launch_correlation_id)
      WHERE launch_correlation_id IS NOT NULL`;
  yield* sql`
    ALTER TABLE follow_ups
      ADD COLUMN IF NOT EXISTS review_slice_id text REFERENCES review_slices(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS checkpoint_a_id text REFERENCES checkpoints(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS checkpoint_b_id text REFERENCES checkpoints(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS diff_digest text,
      ADD COLUMN IF NOT EXISTS comment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS idempotency_key text,
      ADD COLUMN IF NOT EXISTS delivery_process_id text REFERENCES session_processes(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS delivery_sealant_run_id text,
      ADD COLUMN IF NOT EXISTS delivery_error text,
      ADD COLUMN IF NOT EXISTS delivery_started_at timestamptz`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS follow_ups_session_key_idx
      ON follow_ups (session_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL`;
});

/** A live launch renews this lease; expiry is evidence of server loss, not merely elapsed time. */
const followUpDeliveryLeases = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE follow_ups
      ADD COLUMN IF NOT EXISTS delivery_attempt_id text,
      ADD COLUMN IF NOT EXISTS delivery_lease_expires_at timestamptz`;
});

/**
 * Stable Services own declarations; session_processes becomes their append-only attempt ledger;
 * forwards and target observations retain their own identities and timestamps. Pre-stable Service
 * rows are discarded: their mutable run, forward, and reachability fields cannot be reconstructed
 * into honest histories.
 */
const stableServices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS services (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
      name text NOT NULL,
      declaration_source text NOT NULL,
      workspace_port integer NOT NULL,
      transport text NOT NULL DEFAULT 'tcp',
      browser_scheme text,
      bind_addresses jsonb,
      preferred_host_port integer,
      current_attempt_id text,
      current_forward_id text,
      attempt_history_complete boolean NOT NULL DEFAULT true,
      forward_history_complete boolean NOT NULL DEFAULT true,
      observation_history_complete boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS services_session_created_idx
      ON services (session_id, created_at)`;
  yield* sql`
    ALTER TABLE session_processes
      ADD COLUMN IF NOT EXISTS service_id text REFERENCES services (id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS attempt_ordinal integer`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS session_processes_service_created_idx
      ON session_processes (service_id, created_at)`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS session_processes_service_ordinal_idx
      ON session_processes (service_id, attempt_ordinal)
      WHERE service_id IS NOT NULL AND attempt_ordinal IS NOT NULL`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS session_processes_one_live_service_attempt_idx
      ON session_processes (service_id)
      WHERE service_id IS NOT NULL AND attempt_ordinal IS NOT NULL AND exited_at IS NULL`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS service_forwards (
      id text PRIMARY KEY,
      service_id text NOT NULL REFERENCES services (id) ON DELETE CASCADE,
      sealant_workspace_id text NOT NULL,
      preferred_host_port integer,
      host_port integer,
      bound_addresses jsonb,
      state text NOT NULL DEFAULT 'binding',
      error text,
      supersedes_forward_id text REFERENCES service_forwards (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      bound_at timestamptz,
      closed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS service_forwards_service_created_idx
      ON service_forwards (service_id, created_at)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS service_forwards_workspace_state_idx
      ON service_forwards (sealant_workspace_id, state)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS service_observations (
      id text PRIMARY KEY,
      service_id text NOT NULL REFERENCES services (id) ON DELETE CASCADE,
      forward_id text NOT NULL REFERENCES service_forwards (id) ON DELETE CASCADE,
      state text NOT NULL,
      source text NOT NULL,
      error text,
      first_observed_at timestamptz NOT NULL DEFAULT now(),
      last_observed_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS service_observations_service_observed_idx
      ON service_observations (service_id, last_observed_at)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS service_observations_forward_observed_idx
      ON service_observations (forward_id, last_observed_at)`;

  yield* sql`
    DELETE FROM session_processes
    WHERE kind = 'service'`;

  yield* sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'services_current_attempt_id_fkey'
      ) THEN
        ALTER TABLE services
          ADD CONSTRAINT services_current_attempt_id_fkey
          FOREIGN KEY (current_attempt_id) REFERENCES session_processes (id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'services_current_forward_id_fkey'
      ) THEN
        ALTER TABLE services
          ADD CONSTRAINT services_current_forward_id_fkey
          FOREIGN KEY (current_forward_id) REFERENCES service_forwards (id) ON DELETE SET NULL;
      END IF;
    END
    $$`;
});

/** Browser behavior is declaration data; null continues to mean raw TCP or UDP. */
const serviceAccessPolicy = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE project_service_recipes
      ADD COLUMN IF NOT EXISTS browser_scheme text`;
});

/** Exact, workspace-scoped TTL renewal facts survive process restarts and platform outages. */
const workspaceTtlRenewal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN IF NOT EXISTS workspace_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS workspace_ttl_renewed_at timestamptz,
      ADD COLUMN IF NOT EXISTS workspace_ttl_renewal_failed_at timestamptz,
      ADD COLUMN IF NOT EXISTS workspace_ttl_renewal_error text`;
});

/**
 * Sessions are worktrees; everything else is a process (decided 2026-08-21). The agent stops
 * being a special row: its kind names the transport (`agent-pty` today, `agent-protocol`
 * reserved), it carries the harness that launched it, and the provider session id a native
 * resume addresses lives on the process, not the session. Existing `agent` rows become
 * `agent-pty`; the harness is read off the recorded argv (the login-shell launches of an agent
 * session read as `shell`), falling back to the label the launch stamped (= the session harness
 * at the time). The session's provider id moves onto its newest agent process.
 */
const sessionProcessKinds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE session_processes
      ADD COLUMN IF NOT EXISTS harness text,
      ADD COLUMN IF NOT EXISTS provider_session_id text`;
  yield* sql`UPDATE session_processes SET kind = 'agent-pty' WHERE kind = 'agent'`;
  yield* sql`
    UPDATE session_processes
    SET harness = CASE
      WHEN argv ? 'claude' THEN 'claude'
      WHEN argv ? 'codex' THEN 'codex'
      WHEN argv ? 'opencode' THEN 'opencode'
      WHEN argv->>0 IN ('bash', 'zsh', 'fish', 'sh') AND NOT (argv ? '-c') THEN 'shell'
      ELSE label
    END
    WHERE kind = 'agent-pty' AND harness IS NULL`;
  yield* sql`
    UPDATE session_processes AS p
    SET provider_session_id = s.provider_session_id
    FROM agent_sessions AS s
    WHERE p.session_id = s.id
      AND p.kind = 'agent-pty'
      AND s.provider_session_id IS NOT NULL
      AND p.id = (
        SELECT q.id FROM session_processes AS q
        WHERE q.session_id = p.session_id AND q.kind = 'agent-pty'
        ORDER BY q.created_at DESC, q.id DESC
        LIMIT 1
      )`;
});

/** Structured protocol conversation with replay-stable item identity and resumable output. */
const agentConversation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE session_processes
      ADD COLUMN IF NOT EXISTS protocol_output_seq bigint NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_turns (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      process_id text NOT NULL REFERENCES session_processes(id) ON DELETE CASCADE,
      ordinal integer NOT NULL,
      author text,
      input text NOT NULL,
      status text NOT NULL DEFAULT 'queued',
      provider_turn_id text,
      launch_correlation_id text,
      error text,
      usage jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      ended_at timestamptz,
      CONSTRAINT agent_turns_session_ordinal_key UNIQUE (session_id, ordinal)
    )`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_turns_session_provider_key
      ON agent_turns (session_id, provider_turn_id)
      WHERE provider_turn_id IS NOT NULL`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_turns_session_correlation_key
      ON agent_turns (session_id, launch_correlation_id)
      WHERE launch_correlation_id IS NOT NULL`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_turns_one_running_process_idx
      ON agent_turns (process_id) WHERE status = 'running'`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS agent_turns_session_created_idx
      ON agent_turns (session_id, ordinal)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS agent_turns_process_status_idx
      ON agent_turns (process_id, status, ordinal)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_items (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      process_id text NOT NULL REFERENCES session_processes(id) ON DELETE CASCADE,
      turn_id text NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      seq integer NOT NULL,
      provider_item_id text NOT NULL,
      provider_output_process_id text NOT NULL,
      provider_output_seq bigint NOT NULL,
      provider_event_index integer NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      title text,
      text text,
      data jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT agent_items_session_seq_key UNIQUE (session_id, seq),
      CONSTRAINT agent_items_process_provider_key UNIQUE (process_id, provider_item_id)
    )`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS agent_items_session_seq_idx
      ON agent_items (session_id, seq)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS agent_items_turn_seq_idx
      ON agent_items (turn_id, seq)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_requests (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      process_id text NOT NULL REFERENCES session_processes(id) ON DELETE CASCADE,
      turn_id text NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      kind text NOT NULL,
      provider_request_id text NOT NULL,
      provider_item_id text,
      title text,
      detail jsonb,
      questions jsonb,
      status text NOT NULL DEFAULT 'pending',
      decision text,
      decided_by text,
      answers jsonb,
      response_delivery text NOT NULL DEFAULT 'none',
      created_at timestamptz NOT NULL DEFAULT now(),
      decided_at timestamptz,
      CONSTRAINT agent_requests_process_provider_key UNIQUE (process_id, provider_request_id)
    )`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS agent_requests_session_status_idx
      ON agent_requests (session_id, status, created_at)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS agent_requests_process_status_idx
      ON agent_requests (process_id, status)`;
});

/**
 * Per-user Sealant identity (docs/SEALANT-IDENTITY.md): each Mend account acts as
 * its own Sealant user, provisioned on first use; this is the mapping.
 */
const userSealantIdentities = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE user_sealant_identities (
      user_id text PRIMARY KEY,
      sealant_user_id text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
});

/**
 * Device pairing (docs: the settings Devices panel): a short-lived code minted by a
 * signed-in user, claimed once by a phone, which then holds a hashed bearer token.
 */
const devicePairing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE device_tokens (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name text NOT NULL,
      platform text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    )`;
  yield* sql`
    CREATE INDEX device_tokens_user_created_idx ON device_tokens (user_id, created_at)`;
  yield* sql`
    CREATE TABLE pairing_codes (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      code text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      claimed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX pairing_codes_user_created_idx ON pairing_codes (user_id, created_at)`;
});

/**
 * Network session channel tokens (docs/KUBERNETES.md): one hashed bearer token per session for
 * workspaces that cannot mount the session socket. Only the hash is ever stored.
 */
const sessionChannelTokens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE session_channel_tokens (
      session_id text PRIMARY KEY,
      token_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    )`;
});

/**
 * Cluster bindings (`.plans/cluster-env-sources.md`): name-only references to Kubernetes
 * Secrets/ConfigMaps resolved by the Sealant worker at launch, the workspace ServiceAccount
 * trust grant, an aggregate revision on the project, and the name-only launch manifest on
 * session runs. No value column exists to add — Mend never holds the bound contents.
 */
const projectClusterBindingsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS cluster_binding_revision integer NOT NULL DEFAULT 0`;
  yield* sql`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_service_account text`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_cluster_bindings (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      kind text NOT NULL,
      object_name text NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT project_cluster_bindings_project_id_kind_object_name_key
        UNIQUE (project_id, kind, object_name)
    )`;
  yield* sql`
    ALTER TABLE session_runs ADD COLUMN IF NOT EXISTS cluster_binding_revision integer`;
  yield* sql`
    ALTER TABLE session_runs ADD COLUMN IF NOT EXISTS cluster_binding_names jsonb`;
  yield* sql`
    ALTER TABLE session_runs ADD COLUMN IF NOT EXISTS cluster_service_account text`;
});

/**
 * CLI authorize requests (docs: `mend login`): pairing with the direction
 * reversed — the CLI creates a request holding only a hashed device code, a
 * signed-in browser approves it by user code, and the CLI's next poll mints a
 * device token. No plaintext credential ever rests here.
 */
const cliAuthRequestsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE cli_auth_requests (
      id text PRIMARY KEY,
      device_code_hash text NOT NULL UNIQUE,
      user_code text NOT NULL UNIQUE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      approved_by text REFERENCES "user"(id) ON DELETE CASCADE,
      denied_at timestamptz,
      collected_at timestamptz
    )`;
});

/**
 * Sessions carry the base as the user named it (branch, tag, or sha — the
 * project's default branch when nothing was chosen). `base_sha` already pins
 * the commit; this preserves the human name for lists and review headers.
 * Pre-column rows stay null — the name was never recorded, and inventing one
 * from the project's current default branch would fabricate history.
 */
const sessionBaseRef = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN base_ref text`;
});

const backgroundSessionsChoice = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projects ADD COLUMN background_sessions text NOT NULL DEFAULT 'inherit'`;
});

const protocolOptionsColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE session_processes ADD COLUMN protocol_options jsonb`;
});

const nativeIngestCursorColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN native_ingest_cursor jsonb`;
});

/**
 * The worktree-container pivot (plan §5.5/§5.6, decided 2026-08-31): the worktree
 * becomes the durable named container; sessions are conversations inside it, many
 * per worktree and several live at once; the change and the checkpoint chain move
 * to the worktree. One worktree row is minted per existing session (they were 1:1),
 * `session_changes` is renamed to `worktree_changes` and re-keyed, and every
 * session-scoped CASCADE that would let a deleted conversation destroy worktree
 * history flips to SET NULL. Pre-rename constraint names (`session_changes_pkey`
 * and friends) stay as historical artifacts.
 */
/**
 * Standby workspaces (ADR-0001): a hot skeleton no longer pre-creates a worktree — the pool mounts
 * the project's worktrees root and the claiming session binds its own worktree at launch. The
 * worktree columns stay for rows from before, which the drain still removes.
 */
const standbyHotWorkspacesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE hot_workspaces ALTER COLUMN worktree DROP NOT NULL`;
  yield* sql`ALTER TABLE hot_workspaces ALTER COLUMN branch DROP NOT NULL`;
  yield* sql`ALTER TABLE hot_workspaces ALTER COLUMN base_sha DROP NOT NULL`;
});

/** Linked projects (ADR-0001): sibling adopted projects mounted read-write at /workspace/repos/<name>. */
const projectLinksMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_links (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      linked_project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name text NOT NULL,
      worktree_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT project_links_project_id_name_key UNIQUE (project_id, name),
      CONSTRAINT project_links_project_id_linked_key UNIQUE (project_id, linked_project_id)
    )`;
});

/** Whether a session left a conversation behind; null until settle classifies it. */
const sessionHasTranscriptMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS has_transcript boolean`;
});

/** Per-user git access default: Mend key on the server, or the user's own machine via the bridge. */
const userGitAccessMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS user_git_access (
      user_id text PRIMARY KEY,
      mode text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
});

/** Project skills are always delivered; user-library inheritance is an opt-out project setting. */
const projectInheritUserSkillsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS inherit_user_skills boolean NOT NULL DEFAULT true`;
});

const worktreesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE worktrees (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name text NOT NULL,
      directory text NOT NULL,
      branch text NOT NULL,
      base_sha text NOT NULL,
      base_ref text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT worktrees_project_name_key UNIQUE (project_id, name),
      CONSTRAINT worktrees_project_directory_key UNIQUE (project_id, directory)
    )`;

  // 1 worktree per existing session; sessions that (defensively) share a worktree
  // directory genuinely share the worktree, so collapse — earliest session's
  // metadata wins. name = directory = the old per-session dir name.
  yield* sql`
    INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha, base_ref, created_at, updated_at)
    SELECT DISTINCT ON (project_id, worktree)
           gen_random_uuid()::text, project_id, worktree, worktree, branch, base_sha, base_ref, created_at, updated_at
    FROM agent_sessions
    ORDER BY project_id, worktree, created_at ASC`;

  yield* sql`ALTER TABLE agent_sessions ADD COLUMN worktree_id text REFERENCES worktrees(id) ON DELETE CASCADE`;
  yield* sql`
    UPDATE agent_sessions s SET worktree_id = w.id
    FROM worktrees w WHERE w.project_id = s.project_id AND w.directory = s.worktree`;
  yield* sql`ALTER TABLE agent_sessions ALTER COLUMN worktree_id SET NOT NULL`;
  yield* sql`CREATE INDEX agent_sessions_worktree_idx ON agent_sessions (worktree_id, created_at)`;

  // One change per worktree. Rename keeps every dependent FK/index by OID.
  yield* sql`ALTER TABLE session_changes RENAME TO worktree_changes`;
  yield* sql`ALTER TABLE worktree_changes ADD COLUMN worktree_id text REFERENCES worktrees(id) ON DELETE CASCADE`;
  yield* sql`
    UPDATE worktree_changes c SET worktree_id = s.worktree_id
    FROM agent_sessions s WHERE s.id = c.session_id`;
  // Defensive dedupe for shared-directory collapse: keep the earliest change row
  // per worktree; re-point the dependents without uniqueness constraints
  // (follow_ups, review_comments) at it; the duplicates' tours/passes/slices go
  // with their rows (each keyed uniquely per change — merging would collide).
  yield* sql`
    UPDATE follow_ups f SET change_id = d.keep_id
    FROM (
      SELECT id, first_value(id) OVER (PARTITION BY worktree_id ORDER BY created_at, id) AS keep_id
      FROM worktree_changes
    ) d
    WHERE f.change_id = d.id AND d.id <> d.keep_id`;
  yield* sql`
    UPDATE review_comments rc SET change_id = d.keep_id
    FROM (
      SELECT id, first_value(id) OVER (PARTITION BY worktree_id ORDER BY created_at, id) AS keep_id
      FROM worktree_changes
    ) d
    WHERE rc.change_id = d.id AND d.id <> d.keep_id`;
  yield* sql`
    DELETE FROM worktree_changes c USING (
      SELECT id, first_value(id) OVER (PARTITION BY worktree_id ORDER BY created_at, id) AS keep_id
      FROM worktree_changes
    ) d
    WHERE c.id = d.id AND d.id <> d.keep_id`;
  yield* sql`ALTER TABLE worktree_changes ALTER COLUMN worktree_id SET NOT NULL`;
  yield* sql`ALTER TABLE worktree_changes ADD CONSTRAINT worktree_changes_worktree_id_key UNIQUE (worktree_id)`;
  // The session pointer becomes a maintained mirror (last contributing session):
  // optional, and deleting a conversation no longer deletes the change.
  yield* sql`ALTER TABLE worktree_changes DROP CONSTRAINT session_changes_session_id_key`;
  yield* sql`ALTER TABLE worktree_changes ALTER COLUMN session_id DROP NOT NULL`;
  yield* sql`ALTER TABLE worktree_changes DROP CONSTRAINT session_changes_session_id_fkey`;
  yield* sql`
    ALTER TABLE worktree_changes
    ADD CONSTRAINT worktree_changes_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL`;

  // The checkpoint chain is the worktree's history: shared ordinal sequence,
  // session pointer demoted to provenance that survives session deletion.
  yield* sql`ALTER TABLE checkpoints ADD COLUMN worktree_id text REFERENCES worktrees(id) ON DELETE CASCADE`;
  yield* sql`
    UPDATE checkpoints c SET worktree_id = s.worktree_id
    FROM agent_sessions s WHERE s.id = c.session_id`;
  yield* sql`ALTER TABLE checkpoints ALTER COLUMN worktree_id SET NOT NULL`;
  yield* sql`ALTER TABLE checkpoints ADD COLUMN ordinal integer`;
  yield* sql`
    UPDATE checkpoints SET ordinal = n.rn - 1
    FROM (
      SELECT id, row_number() OVER (PARTITION BY worktree_id ORDER BY created_at, id) AS rn
      FROM checkpoints
    ) n
    WHERE checkpoints.id = n.id`;
  yield* sql`ALTER TABLE checkpoints ALTER COLUMN ordinal SET NOT NULL`;
  yield* sql`CREATE UNIQUE INDEX checkpoints_worktree_ordinal_idx ON checkpoints (worktree_id, ordinal)`;
  yield* sql`CREATE INDEX checkpoints_worktree_created_idx ON checkpoints (worktree_id, created_at)`;
  yield* sql`ALTER TABLE checkpoints ALTER COLUMN session_id DROP NOT NULL`;
  yield* sql`ALTER TABLE checkpoints DROP CONSTRAINT checkpoints_session_id_fkey`;
  yield* sql`
    ALTER TABLE checkpoints
    ADD CONSTRAINT checkpoints_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL`;

  // Tour attribution likewise survives the composing session's deletion.
  yield* sql`ALTER TABLE change_tours ALTER COLUMN session_id DROP NOT NULL`;
  yield* sql`ALTER TABLE change_tours DROP CONSTRAINT change_tours_session_id_fkey`;
  yield* sql`
    ALTER TABLE change_tours
    ADD CONSTRAINT change_tours_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL`;

  // Pooled skeletons pre-create their worktree row from now on; legacy entries
  // (worktree_id NULL) read as stale and drain on the first sweep.
  yield* sql`ALTER TABLE hot_workspaces ADD COLUMN worktree_id text REFERENCES worktrees(id) ON DELETE SET NULL`;
});

/**
 * Skill libraries (plan §17: skills materialize through the mounted harness
 * home). One table, two scopes: a user's library (identity, like dotfiles)
 * and a project's (travels with the repository). The bundle's files ride the
 * row as jsonb — skills are small text by contract, and the launch path
 * reads whole bundles anyway. Name is unique per owner within its scope.
 */
const skillsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS skills (
      id text PRIMARY KEY,
      scope text NOT NULL,
      owner_user_id text,
      project_id text REFERENCES projects (id) ON DELETE CASCADE,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      files jsonb NOT NULL DEFAULT '[]'::jsonb,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT skills_scope_owner_check CHECK (
        (scope = 'user' AND owner_user_id IS NOT NULL AND project_id IS NULL)
        OR (scope = 'project' AND project_id IS NOT NULL AND owner_user_id IS NULL)
      )
    )`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS skills_user_name_key
      ON skills (owner_user_id, name) WHERE scope = 'user'`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS skills_project_name_key
      ON skills (project_id, name) WHERE scope = 'project'`;
});

/**
 * The capture store (docs/adr/0002-session-capture-store.md "Postgres schema"): the only mutable
 * state of a remote session's work product. Leases and chain heads are keyed per worktree;
 * captures are immutable rows named by the sha256 of their manifest; every advance is one
 * statement (`repos/capture-store.ts`), so it survives transaction-mode pooling. `parent` has
 * no foreign key on purpose: retention thins `auto`/`turn` captures out of the middle of a
 * chain, and a checkpoint must keep naming the parent it had. `store_refs` is the only place a
 * project ref moves, with a version for compare-and-swap.
 */
const captureStoreMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS worktree_leases (
      worktree_id text PRIMARY KEY REFERENCES worktrees (id) ON DELETE CASCADE,
      executor_id text,
      epoch bigint NOT NULL DEFAULT 0,
      expires_at timestamptz
    )`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS worktree_chain (
      worktree_id text PRIMARY KEY REFERENCES worktrees (id) ON DELETE CASCADE,
      head_capture text,
      head_n integer NOT NULL DEFAULT -1,
      head_epoch bigint NOT NULL DEFAULT 0
    )`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS captures (
      id text PRIMARY KEY,
      worktree_id text NOT NULL REFERENCES worktrees (id) ON DELETE CASCADE,
      n integer NOT NULL,
      parent text,
      epoch bigint NOT NULL,
      seq bigint NOT NULL,
      kind text NOT NULL,
      manifest_key text NOT NULL,
      sections jsonb NOT NULL DEFAULT '{}'::jsonb,
      git_fsck text NOT NULL DEFAULT 'unverified',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT captures_worktree_n_key UNIQUE (worktree_id, n),
      CONSTRAINT captures_kind_check
        CHECK (kind IN ('auto', 'turn', 'checkpoint', 'suspend', 'final')),
      CONSTRAINT captures_git_fsck_check
        CHECK (git_fsck IN ('verified', 'failed', 'unverified'))
    )`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS packs (
      id text PRIMARY KEY,
      key text NOT NULL UNIQUE,
      class text NOT NULL,
      state text NOT NULL DEFAULT 'uploaded',
      bytes bigint NOT NULL DEFAULT 0,
      worktree_id text REFERENCES worktrees (id) ON DELETE SET NULL,
      epoch bigint,
      platform text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT packs_class_check CHECK (class IN ('git', 'workspace', 'bulk')),
      CONSTRAINT packs_state_check
        CHECK (state IN ('uploaded', 'verified', 'live', 'retired'))
    )`;
  yield* sql`CREATE INDEX IF NOT EXISTS packs_worktree_epoch_idx ON packs (worktree_id, epoch)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS capture_summaries (
      capture_id text PRIMARY KEY REFERENCES captures (id) ON DELETE CASCADE,
      worktree_id text NOT NULL REFERENCES worktrees (id) ON DELETE CASCADE,
      key text NOT NULL,
      state text NOT NULL DEFAULT 'claimed',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT capture_summaries_state_check CHECK (state IN ('claimed', 'observed'))
    )`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS store_refs (
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      name text NOT NULL,
      sha text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, name)
    )`;
  // The checkpoint row is inserted after the register CAS returns, keyed by the capture that
  // carries `checkpoint: {ordinal, sha, ref}`; co-located checkpoints leave it NULL.
  yield* sql`
    ALTER TABLE checkpoints
    ADD COLUMN IF NOT EXISTS capture_id text REFERENCES captures (id) ON DELETE SET NULL`;
});

export const migrations = {
  "0001_init": init,
  "0002_failure_brief": failureBrief,
  "0003_brief_comments": briefComments,
  "0004_workbench": workbench,
  "0005_follow_ups": followUps,
  "0006_sealant_session": sealantSession,
  "0007_review_comment_spans": reviewCommentSpans,
  // 0008 went to push devices on main while these were in flight — renumbered.
  "0008_push_devices": pushDevices,
  "0009_references": references,
  "0010_project_mounts": projectMounts,
  "0011_review_comment_evidence": reviewCommentEvidence,
  "0012_change_tours": changeTours,
  "0013_review_automation": reviewAutomation,
  "0014_change_passes": changePasses,
  "0015_session_run_history": sessionRunHistory,
  "0016_session_processes": sessionProcesses,
  "0017_service_ports": servicePorts,
  "0018_process_run_pointers": processRunPointers,
  "0019_project_service_recipes": projectServiceRecipes,
  "0020_service_protocol": serviceProtocol,
  "0021_project_git_auth": projectGitAuth,
  "0022_session_git_ops": sessionGitOps,
  "0023_project_workspace_image": projectWorkspaceImage,
  "0024_dotfiles_store": dotfilesStore,
  "0025_project_environment": projectEnvironment,
  "0026_project_secrets": projectSecretsMigration,
  "0027_hot_sessions": hotSessions,
  "0028_auto_name": autoName,
  "0029_immutable_review_slices": immutableReviewSlices,
  "0030_recoverable_follow_up_delivery": recoverableFollowUpDelivery,
  "0031_follow_up_delivery_leases": followUpDeliveryLeases,
  "0032_stable_services": stableServices,
  "0033_service_access_policy": serviceAccessPolicy,
  "0034_workspace_ttl_renewal": workspaceTtlRenewal,
  "0035_session_process_kinds": sessionProcessKinds,
  "0036_agent_conversation": agentConversation,
  "0037_user_sealant_identities": userSealantIdentities,
  "0038_device_pairing": devicePairing,
  "0039_session_channel_tokens": sessionChannelTokens,
  "0040_project_cluster_bindings": projectClusterBindingsMigration,
  "0041_cli_auth_requests": cliAuthRequestsMigration,
  "0042_session_base_ref": sessionBaseRef,
  "0043_background_sessions": backgroundSessionsChoice,
  "0044_protocol_options": protocolOptionsColumn,
  "0045_native_ingest_cursor": nativeIngestCursorColumn,
  "0046_worktrees": worktreesMigration,
  "0047_skills": skillsMigration,
  "0048_standby_hot_workspaces": standbyHotWorkspacesMigration,
  "0049_project_links": projectLinksMigration,
  "0050_session_has_transcript": sessionHasTranscriptMigration,
  "0051_user_git_access": userGitAccessMigration,
  "0052_project_inherit_user_skills": projectInheritUserSkillsMigration,
  "0053_capture_store": captureStoreMigration,
};
