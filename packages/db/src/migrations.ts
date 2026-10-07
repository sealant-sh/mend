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
 * queue-era tables stay until their surfaces retire (docs/archive/M0-INVENTORY.md).
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
 * Per-project workspace image (docs/archive/WORKSPACE-IMAGES.md): NULL inherits the global
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
 * Project environment variables (`docs/archive/plans/project-environment-variables.md`): project-owned,
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

/**
 * ADR-0002 amended 2026-09-13 (decisions 2 and 9): the project's install command, run by Mend in
 * a workspace whose dependency tree does not match the executor's platform, and by the install
 * job that feeds the per-project shared cache. NULL = detected from the base tree's lockfile.
 */
const projectInstallCommandMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS install_command text`;
});

/**
 * docs/adr/0003-organizations-and-tenancy.md: the tenant. Creates organizations, memberships
 * (one per account), single-use invitations and instance roles, then upgrades what exists
 * without widening anything: one organization, every account a member, the oldest account its
 * owner and the operator, every project shared (today everyone sees everything), and sessions
 * with no owner assigned to the oldest account (today's fallback). Accounts are deactivated,
 * never deleted, so every FK to "user" RESTRICTs.
 */
const organizationsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE organizations (
      id text PRIMARY KEY,
      name text NOT NULL,
      created_by_user_id text REFERENCES "user" (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE UNIQUE INDEX organizations_name_lower_key ON organizations (lower(btrim(name)))`;
  yield* sql`
    CREATE TABLE organization_members (
      organization_id text NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
      role text NOT NULL,
      added_by_user_id text REFERENCES "user" (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, user_id),
      CONSTRAINT organization_members_user_key UNIQUE (user_id),
      CONSTRAINT organization_members_role_check CHECK (role IN ('owner', 'member'))
    )`;
  yield* sql`
    CREATE INDEX organization_members_org_role_idx ON organization_members (organization_id, role)`;
  yield* sql`
    CREATE TABLE organization_invitations (
      id text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      role text NOT NULL,
      email text,
      created_by_user_id text NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      accepted_by_user_id text REFERENCES "user" (id) ON DELETE RESTRICT,
      accepted_at timestamptz,
      revoked_at timestamptz,
      CONSTRAINT organization_invitations_role_check CHECK (role IN ('owner', 'member')),
      CONSTRAINT organization_invitations_email_check
        CHECK (email IS NULL OR email = lower(btrim(email))),
      CONSTRAINT organization_invitations_expiry_check CHECK (expires_at > created_at),
      CONSTRAINT organization_invitations_accepted_check
        CHECK ((accepted_by_user_id IS NULL) = (accepted_at IS NULL)),
      CONSTRAINT organization_invitations_spent_check
        CHECK (accepted_at IS NULL OR revoked_at IS NULL)
    )`;
  yield* sql`
    CREATE INDEX organization_invitations_org_idx
    ON organization_invitations (organization_id, created_at DESC)`;
  yield* sql`
    CREATE TABLE instance_roles (
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
      role text NOT NULL,
      granted_by_user_id text REFERENCES "user" (id) ON DELETE RESTRICT,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role),
      CONSTRAINT instance_roles_role_check CHECK (role IN ('operator'))
    )`;
  // Deactivation replaces deletion; enforcement lands with member removal.
  yield* sql`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "deactivatedAt" timestamptz`;

  // The upgrade. Exactly one organization exists from here on, even on an empty database.
  yield* sql`
    INSERT INTO organizations (id, name)
    SELECT gen_random_uuid()::text, 'Default'
    WHERE NOT EXISTS (SELECT 1 FROM organizations)`;
  yield* sql`
    WITH org AS (SELECT id FROM organizations ORDER BY created_at, id LIMIT 1),
         oldest AS (SELECT id FROM "user" ORDER BY "createdAt" ASC, id ASC LIMIT 1)
    INSERT INTO organization_members (organization_id, user_id, role)
    SELECT org.id, u.id, CASE WHEN u.id = oldest.id THEN 'owner' ELSE 'member' END
    FROM "user" u, org, oldest`;
  yield* sql`
    INSERT INTO instance_roles (user_id, role)
    SELECT id, 'operator' FROM "user" ORDER BY "createdAt" ASC, id ASC LIMIT 1`;

  yield* sql`
    ALTER TABLE projects
      ADD COLUMN organization_id text REFERENCES organizations (id) ON DELETE RESTRICT,
      ADD COLUMN visibility text NOT NULL DEFAULT 'private',
      ADD COLUMN created_by_user_id text REFERENCES "user" (id) ON DELETE RESTRICT`;
  yield* sql`
    UPDATE projects SET
      organization_id = (SELECT id FROM organizations ORDER BY created_at, id LIMIT 1),
      visibility = 'shared',
      created_by_user_id = (SELECT id FROM "user" ORDER BY "createdAt" ASC, id ASC LIMIT 1)`;
  yield* sql`ALTER TABLE projects ALTER COLUMN organization_id SET NOT NULL`;
  yield* sql`
    ALTER TABLE projects
      DROP CONSTRAINT projects_name_key,
      ADD CONSTRAINT projects_organization_name_key UNIQUE (organization_id, name),
      ADD CONSTRAINT projects_visibility_check CHECK (visibility IN ('private', 'shared'))`;
  yield* sql`
    CREATE INDEX projects_organization_visibility_idx ON projects (organization_id, visibility)`;

  yield* sql`
    UPDATE agent_sessions
    SET owner_user_id = (SELECT id FROM "user" ORDER BY "createdAt" ASC, id ASC LIMIT 1)
    WHERE owner_user_id IS NULL`;
});

/**
 * docs/adr/0003-organizations-and-tenancy.md: resources that belonged to the whole instance now
 * belong to an account or an organization. Push devices get the account whose notifications they
 * receive (existing ones: the oldest account, which is who registered them on a one-person
 * install); reference repositories get the organization (the only one existing) and their name is
 * unique within it.
 */
const perAccountResourcesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE push_devices
    ADD COLUMN user_id text REFERENCES "user" (id) ON DELETE RESTRICT`;
  yield* sql`
    UPDATE push_devices
    SET user_id = (SELECT id FROM "user" ORDER BY "createdAt" ASC, id ASC LIMIT 1)`;
  // No account to own them: an unclaimed instance's devices notify nobody, so they go.
  yield* sql`DELETE FROM push_devices WHERE user_id IS NULL`;
  yield* sql`ALTER TABLE push_devices ALTER COLUMN user_id SET NOT NULL`;
  yield* sql`CREATE INDEX push_devices_user_idx ON push_devices (user_id)`;

  yield* sql`
    ALTER TABLE reference_repos
      ADD COLUMN organization_id text REFERENCES organizations (id) ON DELETE RESTRICT,
      ADD COLUMN created_by_user_id text REFERENCES "user" (id) ON DELETE RESTRICT`;
  yield* sql`
    UPDATE reference_repos SET
      organization_id = (SELECT id FROM organizations ORDER BY created_at, id LIMIT 1),
      created_by_user_id = (SELECT id FROM "user" ORDER BY "createdAt" ASC, id ASC LIMIT 1)`;
  yield* sql`ALTER TABLE reference_repos ALTER COLUMN organization_id SET NOT NULL`;
  yield* sql`
    ALTER TABLE reference_repos
      DROP CONSTRAINT reference_repos_name_key,
      ADD CONSTRAINT reference_repos_organization_name_key UNIQUE (organization_id, name)`;
});

/**
 * docs/adr/0003-organizations-and-tenancy.md: folders, the Mend-managed directories that replace
 * host mounts. A folder in use by a project cannot be deleted (RESTRICT); removing a project drops
 * its selections.
 */
const foldersMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE folders (
      id text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
      name text NOT NULL,
      path text NOT NULL UNIQUE,
      created_by_user_id text REFERENCES "user" (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT folders_organization_name_key UNIQUE (organization_id, name)
    )`;
  yield* sql`
    CREATE TABLE project_folders (
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      folder_id text NOT NULL REFERENCES folders (id) ON DELETE RESTRICT,
      name text NOT NULL,
      read_only boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, folder_id),
      CONSTRAINT project_folders_project_name_key UNIQUE (project_id, name)
    )`;
});

/**
 * docs/adr/0003-organizations-and-tenancy.md: a hot workspace always runs as one account. Entries
 * warmed before this ran as the first account, so that is who owns them now; the reconcile drains
 * any whose owner is no longer one the pool serves.
 */
const hotPoolOwnersMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE hot_workspaces
    SET owner_user_id = (SELECT id FROM "user" ORDER BY "createdAt" ASC, id ASC LIMIT 1)
    WHERE owner_user_id IS NULL`;
  yield* sql`DELETE FROM hot_workspaces WHERE owner_user_id IS NULL`;
  yield* sql`ALTER TABLE hot_workspaces ALTER COLUMN owner_user_id SET NOT NULL`;
  yield* sql`
    CREATE INDEX agent_sessions_project_owner_idx
    ON agent_sessions (project_id, owner_user_id, created_at DESC)`;
});

/**
 * docs/adr/0003-organizations-and-tenancy.md: the organization audit log. Accounts are deactivated,
 * never deleted, so an actor always resolves.
 */
const auditEventsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE audit_events (
      id text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
      actor_user_id text NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
      action text NOT NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX audit_events_org_created_idx ON audit_events (organization_id, created_at DESC)`;
});

/**
 * docs/adr/0003-organizations-and-tenancy.md: shared control on a session, and the record of who
 * steered it beyond turns and approvals.
 */
const sharedControlMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN shared_control_enabled_by_user_id text REFERENCES "user" (id) ON DELETE RESTRICT,
      ADD COLUMN shared_control_enabled_at timestamptz,
      ADD CONSTRAINT agent_sessions_shared_control_check
        CHECK ((shared_control_enabled_by_user_id IS NULL) = (shared_control_enabled_at IS NULL))`;
  yield* sql`
    CREATE TABLE session_control_events (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
      actor_user_id text NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN (
        'interrupt', 'terminal-attach', 'shell-open', 'stop', 'shared-control-on', 'shared-control-off'
      )),
      ref_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX session_control_events_session_idx
    ON session_control_events (session_id, created_at)`;
});

/**
 * Upgrade tickets (docs/adr/0004-access-without-a-private-network.md, "Upgrade tickets"): the one
 * credential that still rides a URL, because a browser cannot set a header on a WebSocket and a
 * WebView cannot set one on a page load. Single use, thirty seconds, bound to one account, one
 * target and that target's exact parameters. Only the hash is stored.
 */
const upgradeTicketsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE upgrade_tickets (
      token_hash text PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      target text NOT NULL,
      scope text NOT NULL,
      credential text,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX upgrade_tickets_expires_at_idx ON upgrade_tickets (expires_at)`;
});

/**
 * docs/adr/0006-slack.md: an organization's Slack app, the Slack users linked to Mend accounts,
 * the defaults that pick a project, the threads sessions report to, and the events already
 * claimed. Tokens are stored sealed (`SecretCipher`) and link codes as their sha256 only.
 * Removing an install removes its links, link codes and channel defaults; removing a member
 * removes their link. Threads stay with their sessions, and a session keeps its origin.
 */
const slackMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN origin text NOT NULL DEFAULT 'mend',
      ADD CONSTRAINT agent_sessions_origin_check CHECK (origin IN ('mend', 'slack'))`;

  // One app per organization, and a Slack workspace belongs to at most one organization. The
  // (organization, team) key is what a link's composite reference points at.
  yield* sql`
    CREATE TABLE slack_installs (
      organization_id text PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
      team_id text NOT NULL,
      team_name text NOT NULL,
      bot_user_id text NOT NULL,
      app_id text NOT NULL,
      sealed_app_token text NOT NULL,
      sealed_bot_token text NOT NULL,
      web_origin text NOT NULL,
      default_harness text NOT NULL DEFAULT 'claude',
      show_agent_messages boolean NOT NULL DEFAULT true,
      show_diffs boolean NOT NULL DEFAULT false,
      external_channels boolean NOT NULL DEFAULT false,
      installed_by_user_id text NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT slack_installs_team_id_key UNIQUE (team_id),
      CONSTRAINT slack_installs_organization_team_key UNIQUE (organization_id, team_id)
    )`;

  // One Slack user in one workspace to one Mend account in the install's organization, and back.
  yield* sql`
    CREATE TABLE slack_links (
      organization_id text NOT NULL,
      team_id text NOT NULL,
      slack_user_id text NOT NULL,
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (team_id, slack_user_id),
      CONSTRAINT slack_links_team_user_key UNIQUE (team_id, user_id),
      CONSTRAINT slack_links_install_fkey FOREIGN KEY (organization_id, team_id)
        REFERENCES slack_installs (organization_id, team_id) ON DELETE CASCADE,
      CONSTRAINT slack_links_member_fkey FOREIGN KEY (organization_id, user_id)
        REFERENCES organization_members (organization_id, user_id) ON DELETE CASCADE
    )`;
  yield* sql`
    CREATE TABLE slack_link_codes (
      code_hash text PRIMARY KEY,
      team_id text NOT NULL REFERENCES slack_installs (team_id) ON DELETE CASCADE,
      slack_user_id text NOT NULL,
      request jsonb NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX slack_link_codes_expires_at_idx ON slack_link_codes (expires_at)`;

  yield* sql`
    CREATE TABLE slack_channel_defaults (
      team_id text NOT NULL REFERENCES slack_installs (team_id) ON DELETE CASCADE,
      channel_id text NOT NULL,
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      set_by_user_id text NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (team_id, channel_id)
    )`;
  yield* sql`
    CREATE TABLE slack_user_defaults (
      user_id text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;

  // A thread holds many sessions; a session belongs to at most one thread.
  yield* sql`
    CREATE TABLE slack_threads (
      session_id text PRIMARY KEY REFERENCES agent_sessions (id) ON DELETE CASCADE,
      team_id text NOT NULL,
      channel_id text NOT NULL,
      thread_ts text NOT NULL,
      request_ts text NOT NULL,
      status_ts text,
      slack_user_id text NOT NULL,
      project_source text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX slack_threads_thread_idx
    ON slack_threads (team_id, channel_id, thread_ts, created_at DESC)`;

  // Slack may deliver an event twice, or to two workers: the first claim wins. Old claims are
  // swept by age.
  yield* sql`
    CREATE TABLE slack_event_claims (
      event_id text PRIMARY KEY,
      team_id text NOT NULL,
      claimed_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX slack_event_claims_claimed_at_idx ON slack_event_claims (claimed_at)`;
});

/**
 * docs/adr/0006-slack.md, "What Mend posts, and where": what the thread reporter has shown, so
 * that a restart or a second worker never posts twice. `reported_status` is the status line last
 * written to the status message, moved only by a compare-and-set; `slack_thread_posts` holds a
 * key per reply posted (a turn's closing message, a question, the review count). `external`
 * records whether the thread is in a Slack Connect channel; a row from before it reads external,
 * which shows the least.
 */
const slackReportsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE slack_threads
      ADD COLUMN external boolean NOT NULL DEFAULT true,
      ADD COLUMN reported_state text,
      ADD COLUMN reported_status text`;
  yield* sql`
    CREATE TABLE slack_thread_posts (
      session_id text NOT NULL REFERENCES slack_threads (session_id) ON DELETE CASCADE,
      key text NOT NULL,
      posted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, key)
    )`;
});

/**
 * docs/adr/0007-landing.md: the record of each landing, the project's "Land when a turn
 * completes", a session's own override, the Slack app's "Land automatically", and what each
 * turn's request asked for. A landing keeps its row when its session or checkpoint is removed,
 * and goes with its change. The pull request's number, url, state and observation time are set
 * together or not at all; a turn's intent is null exactly when it was never read or could not be.
 */
const landingMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects
      ADD COLUMN auto_land text NOT NULL DEFAULT 'inherit',
      ADD CONSTRAINT projects_auto_land_check CHECK (auto_land IN ('inherit', 'on', 'off'))`;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN auto_land boolean`;
  yield* sql`ALTER TABLE slack_installs ADD COLUMN land_automatically boolean NOT NULL DEFAULT true`;
  yield* sql`
    ALTER TABLE agent_turns
      ADD COLUMN intent text,
      ADD COLUMN intent_source text,
      ADD CONSTRAINT agent_turns_intent_check CHECK (
        CASE
          WHEN intent_source IS NULL OR intent_source = 'unread' THEN intent IS NULL
          WHEN intent_source IN ('read', 'option') THEN
            intent IS NOT NULL AND intent IN ('change', 'question')
          ELSE false
        END
      )`;
  yield* sql`
    CREATE TABLE change_landings (
      id text PRIMARY KEY,
      change_id text NOT NULL REFERENCES worktree_changes (id) ON DELETE CASCADE,
      session_id text REFERENCES agent_sessions (id) ON DELETE SET NULL,
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      checkpoint_id text REFERENCES checkpoints (id) ON DELETE SET NULL,
      checkpoint_ref text,
      checkpoint_sha text,
      commit_sha text,
      remote_branch text NOT NULL,
      pushed_sha text,
      trigger text NOT NULL CHECK (trigger IN ('manual', 'automatic')),
      pull_request_number integer,
      pull_request_url text,
      pull_request_state text CHECK (pull_request_state IN ('open', 'closed', 'merged')),
      pr_observed_at timestamptz,
      outcome text NOT NULL CHECK (outcome IN ('pushed', 'pull-request', 'refused', 'failed')),
      message text,
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT change_landings_checkpoint_check
        CHECK ((checkpoint_ref IS NULL) = (checkpoint_sha IS NULL)),
      CONSTRAINT change_landings_pull_request_check CHECK (
        (pull_request_number IS NULL AND pull_request_url IS NULL
          AND pull_request_state IS NULL AND pr_observed_at IS NULL)
        OR (pull_request_number IS NOT NULL AND pull_request_url IS NOT NULL
          AND pull_request_state IS NOT NULL AND pr_observed_at IS NOT NULL)
      ),
      CONSTRAINT change_landings_outcome_facts_check CHECK (
        (outcome = 'pushed' AND pushed_sha IS NOT NULL)
        OR (outcome = 'pull-request' AND pushed_sha IS NOT NULL AND pull_request_number IS NOT NULL)
        OR (outcome = 'refused' AND pushed_sha IS NULL)
        OR outcome = 'failed'
      )
    )`;
  yield* sql`
    CREATE INDEX change_landings_change_created_idx
    ON change_landings (change_id, created_at DESC)`;
  yield* sql`CREATE INDEX change_landings_session_idx ON change_landings (session_id, created_at)`;
});

/**
 * Automatic landing (docs/adr/0007-landing.md, "When a completed turn lands"): what Mend decided
 * about each turn once it ended, and the claim that makes one worker decide it. A turn that
 * ended before this migration is decided already: it never lands by itself.
 */
const turnLandingMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_turns
      ADD COLUMN landing_claimed_at timestamptz,
      ADD COLUMN landing text,
      ADD COLUMN landing_id text REFERENCES change_landings (id) ON DELETE SET NULL,
      ADD CONSTRAINT agent_turns_landing_check CHECK (
        (landing IS NULL
          OR landing IN ('attempted', 'question', 'option', 'off', 'not-owner', 'skipped'))
        AND (landing IS NULL OR landing_claimed_at IS NOT NULL)
        AND (landing_id IS NULL OR landing = 'attempted')
      )`;
  yield* sql`
    UPDATE agent_turns
    SET landing_claimed_at = coalesce(ended_at, created_at), landing = 'skipped'
    WHERE status NOT IN ('queued', 'running')`;
});

/**
 * docs/adr/0007-landing.md, "What the thread sees": a pull request Mend opened before its tour
 * existed gains the tour once the tour completes. The column is the claim that makes each tour
 * update a landing's pull request once, whichever worker finishes the tour.
 */
const landingDescriptionMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE change_landings ADD COLUMN described_tour_id text`;
});

/**
 * docs/SESSION-SERVICES.md, "Stop": a stop keeps Services running, and their own Stop services
 * action is a steering act like the stop, so the session's control log records who took it.
 */
const servicesStopControlMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE session_control_events
      DROP CONSTRAINT IF EXISTS session_control_events_kind_check`;
  yield* sql`
    ALTER TABLE session_control_events
      ADD CONSTRAINT session_control_events_kind_check CHECK (kind IN (
        'interrupt', 'terminal-attach', 'shell-open', 'stop', 'services-stop',
        'shared-control-on', 'shared-control-off'
      ))`;
});

/**
 * docs/GIT-ACCESS.md, "Git author": the name and email an account's workspaces commit as. No row
 * means the account's own registration name and email.
 */
const userGitAuthorMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE user_git_author (
      user_id text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
      name text NOT NULL,
      email text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
});

/**
 * docs/adr/0007-landing.md, "Pull requests opened outside Mend": a pull request the agent (or a
 * person) opened for the change's branch is adopted as a landing that pushed nothing. Its trigger
 * and outcome are `adopted`; it carries the pull request and no pushed sha, so the commit planning
 * (L, H, T) never builds on it. A pull request whose head is in a fork says so and whose it is.
 */
const landingAdoptionMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE change_landings
      DROP CONSTRAINT IF EXISTS change_landings_trigger_check,
      DROP CONSTRAINT IF EXISTS change_landings_outcome_check,
      DROP CONSTRAINT IF EXISTS change_landings_outcome_facts_check`;
  yield* sql`
    ALTER TABLE change_landings
      ADD COLUMN pr_cross_repository boolean NOT NULL DEFAULT false,
      ADD COLUMN pr_head_owner text,
      ADD CONSTRAINT change_landings_trigger_check
        CHECK (trigger IN ('manual', 'automatic', 'adopted')),
      ADD CONSTRAINT change_landings_outcome_check
        CHECK (outcome IN ('pushed', 'pull-request', 'refused', 'failed', 'adopted')),
      ADD CONSTRAINT change_landings_outcome_facts_check CHECK (
        (outcome = 'pushed' AND pushed_sha IS NOT NULL)
        OR (outcome = 'pull-request' AND pushed_sha IS NOT NULL AND pull_request_number IS NOT NULL)
        OR (outcome = 'refused' AND pushed_sha IS NULL)
        OR outcome = 'failed'
        OR (outcome = 'adopted' AND trigger = 'adopted' AND pushed_sha IS NULL
          AND pull_request_number IS NOT NULL)
      )`;
});

/**
 * docs/adr/0003-organizations-and-tenancy.md, "Resources that were instance-global": the settings
 * document stays the operator's, and each organization's owners set its own defaults over it. A
 * null column follows the instance; no row means the organization set nothing.
 */
const organizationSettingsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE organization_settings (
      organization_id text PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
      workspace_image jsonb,
      auto_tour boolean,
      auto_suggest boolean,
      auto_name boolean,
      auto_land boolean,
      background_sessions boolean,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
});

/**
 * The default shell profile (packages/sessions/src/shell-profile.ts): on for every project,
 * existing ones included; a project turns it off in Setup.
 */
const projectDefaultShellProfileMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS default_shell_profile boolean NOT NULL DEFAULT true`;
});

/**
 * The idle stop (docs/SELF-HOSTING.md, "Idle agents"): Mend stops a protocol agent that sat idle
 * past MEND_PROTOCOL_IDLE_STOP_MINUTES. `idle_stopped_at` is the claim that stops it once across
 * workers, and what the session's surfaces read the stop as; a reopen clears it. The control log
 * records the stop as `idle-stop`, the owner as its actor.
 */
const protocolIdleStopMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN idle_stopped_at timestamptz`;
  yield* sql`
    ALTER TABLE session_control_events
      DROP CONSTRAINT IF EXISTS session_control_events_kind_check`;
  yield* sql`
    ALTER TABLE session_control_events
      ADD CONSTRAINT session_control_events_kind_check CHECK (kind IN (
        'interrupt', 'terminal-attach', 'shell-open', 'stop', 'services-stop', 'idle-stop',
        'shared-control-on', 'shared-control-off'
      ))`;
});

/**
 * docs/adr/0007-landing.md, amended 2026-09-27: a turn's request may ask to `land` the change as
 * it stands, and every turn that did not land records why: the change is empty, nothing is new
 * since the last landing, or the executor's captures never caught up with the turn.
 */
const landingReasonsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_intent_check`;
  yield* sql`
    ALTER TABLE agent_turns
      ADD CONSTRAINT agent_turns_intent_check CHECK (
        CASE
          WHEN intent_source IS NULL OR intent_source = 'unread' THEN intent IS NULL
          WHEN intent_source IN ('read', 'option') THEN
            intent IS NOT NULL AND intent IN ('change', 'question', 'land')
          ELSE false
        END
      )`;
  yield* sql`ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_landing_check`;
  yield* sql`
    ALTER TABLE agent_turns
      ADD CONSTRAINT agent_turns_landing_check CHECK (
        (landing IS NULL
          OR landing IN ('attempted', 'question', 'option', 'off', 'not-owner', 'no-change',
                         'nothing-new', 'not-captured', 'skipped'))
        AND (landing IS NULL OR landing_claimed_at IS NOT NULL)
        AND (landing_id IS NULL OR landing = 'attempted')
      )`;
});

/**
 * docs/adr/0002-session-capture-store.md, "Stop drains, then terminates" (2026-09-27): nothing an
 * executor holds is lost to a stop. A session records what its executor last answered to a flush
 * (pending captures, bytes once sealantd reports them, refusals, the head's registration time) and
 * a drain under way — why, since when, the last movement, and when it stopped moving — so a Mend
 * restart takes the drain up again. The cap is counted from the executor's own start, and a
 * removal asked while the workspace was up waits for it. The owner's "discard unsaved and stop" is
 * a control event of its own.
 */
const captureDrainMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN capture_pending integer,
      ADD COLUMN capture_pending_bytes bigint,
      ADD COLUMN capture_refused integer,
      ADD COLUMN capture_registered_at timestamptz,
      ADD COLUMN capture_observed_at timestamptz,
      ADD COLUMN capture_drain text,
      ADD COLUMN capture_drain_requested_at timestamptz,
      ADD COLUMN capture_drain_progress_at timestamptz,
      ADD COLUMN capture_not_saved_at timestamptz,
      ADD COLUMN executor_started_at timestamptz,
      ADD COLUMN removal_requested_at timestamptz`;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD CONSTRAINT agent_sessions_capture_drain_check CHECK (
        (capture_drain IS NULL OR capture_drain IN ('stop', 'relaunch', 'replacement'))
        AND ((capture_drain IS NULL) = (capture_drain_requested_at IS NULL))
        AND (capture_not_saved_at IS NULL OR capture_drain IS NOT NULL)
      )`;
  yield* sql`
    CREATE INDEX agent_sessions_capture_drain_idx ON agent_sessions (capture_drain_requested_at)
      WHERE capture_drain IS NOT NULL`;
  yield* sql`
    CREATE INDEX agent_sessions_removal_requested_idx ON agent_sessions (removal_requested_at)
      WHERE removal_requested_at IS NOT NULL`;
  yield* sql`
    ALTER TABLE session_control_events
      DROP CONSTRAINT IF EXISTS session_control_events_kind_check`;
  yield* sql`
    ALTER TABLE session_control_events
      ADD CONSTRAINT session_control_events_kind_check CHECK (kind IN (
        'interrupt', 'terminal-attach', 'shell-open', 'stop', 'services-stop', 'idle-stop',
        'shared-control-on', 'shared-control-off', 'discard-unsaved-stop'
      ))`;
});

/**
 * Retention and register agree on what may be deleted (review 2026-09-27 #4). Retention computed
 * its live set, a register then named an object only a thinned capture had named, and retention
 * deleted it: the new head could not be read. `worktree_chain.guard` is bumped by every register
 * for each chain whose objects it names, and by retention when it condemns objects of that chain;
 * each writes only while the guard still reads what it read, so exactly one of the two wins.
 * `capture_tombstones` is what retention condemned: `deleted_at` NULL while the bytes may still be
 * going (a register naming one is refused), set once they are gone (a register may bring the key
 * back only after it has seen the bytes again).
 */
const captureGuardsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE worktree_chain ADD COLUMN guard bigint NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE TABLE capture_tombstones (
      key text PRIMARY KEY,
      worktree_id text NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    )`;
  yield* sql`CREATE INDEX capture_tombstones_worktree_idx ON capture_tombstones (worktree_id)`;
});

/**
 * 0077: the rest of a drain's transition (docs/adr/0002, "Stop drains, then terminates").
 * - `capture_drain_resume`: a relaunch drains the previous executor first; the harness it resumes
 *   with is durable beside the drain, so a restart mid-drain finishes the relaunch instead of
 *   stopping at the terminate. Cleared once the launch has run its course, or by the user's stop.
 * - `capture_final_workspace_id`: the executor Mend sent a final flush to. It admits nothing after
 *   that, so nothing is started, joined or resumed in it again; the next run is a fresh executor.
 * - `capture_incomplete_reason`: why its last final flush did not complete, as sealantd said.
 */
const captureDrainResumeMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN capture_drain_resume text,
      ADD COLUMN capture_final_workspace_id text,
      ADD COLUMN capture_incomplete_reason text`;
  yield* sql`
    CREATE INDEX agent_sessions_capture_drain_resume_idx ON agent_sessions (id)
      WHERE capture_drain_resume IS NOT NULL`;
});

/**
 * 0078: what a failing capture looks like while it happens, and what a discard ended
 * (docs/adr/0002, "Stop drains, then terminates").
 * - `capture_incomplete_detail`: what sealantd named behind an incomplete final flush — the
 *   snap's error, the first path it could not read.
 * - `capture_failing_since` / `capture_failing_error`: a running executor whose snaps fail,
 *   observed from its status or a flush; cleared once its snaps succeed again.
 * - `capture_discarded_at` / `capture_discarded_by`: the owner's "discard unsaved and stop" —
 *   when, and who; cleared once the session runs again.
 */
const captureFailingMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN capture_incomplete_detail text,
      ADD COLUMN capture_failing_since timestamptz,
      ADD COLUMN capture_failing_error text,
      ADD COLUMN capture_discarded_at timestamptz,
      ADD COLUMN capture_discarded_by text`;
});

/**
 * 0079: the executor's own word that its final flush completed (docs/adr/0002, "Stop drains, then
 * terminates"). `capture_saved_workspace_id` / `capture_saved_at` / `capture_saved_n`: the
 * executor that answered `complete: true` with nothing pending, when Mend observed it, and the
 * chain position it named. Its writers are stopped and it admits nothing after that, so this is
 * how its end reads, whatever suspend captures register on top.
 */
const captureSavedMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN capture_saved_workspace_id text,
      ADD COLUMN capture_saved_at timestamptz,
      ADD COLUMN capture_saved_n integer`;
});

/**
 * 0080: deletion owns its objects until it is done, and a completed final flush is a fact on the
 * chain (docs/adr/0002-session-capture-store.md).
 *
 * - `capture_deletion_claims`: each retention pass that condemns a key holds a claim on it
 *   (`token`, one per pass) from the condemnation until it has deleted the bytes and settled the
 *   tombstone. A register may bring a condemned key back only once its tombstone reads deleted
 *   AND no claim on it is live: a second pass that finished first no longer lets a register
 *   revive bytes the first pass is still about to delete (review 2026-09-28 #1). A claim lapses
 *   at `expires_at` (a crashed pass); its holder renews it before every delete and stops deleting
 *   once a renewal fails.
 * - `capture_seals`: the `final_seal` a registered capture carried (cross-repo decision 1,
 *   2026-09-28) — sealantd's word, on the store, that the final flush of `executor_id` under
 *   `epoch` completed: everything shipped, writers stopped. Written by the register CAS itself,
 *   so it exists only for a capture that landed on a contiguous chain; one per worktree and epoch
 *   (the newest sealing capture of that epoch). Mend's saved evidence, and what it attests to
 *   Sealant when it asks to stop that executor.
 */
const captureClaimsAndSealsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE capture_deletion_claims (
      key text NOT NULL REFERENCES capture_tombstones(key) ON DELETE CASCADE,
      token text NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (key, token)
    )`;
  yield* sql`CREATE INDEX capture_deletion_claims_token_idx ON capture_deletion_claims (token)`;
  yield* sql`
    CREATE TABLE capture_seals (
      worktree_id text NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      epoch bigint NOT NULL,
      executor_id text NOT NULL,
      capture_id text NOT NULL,
      n integer NOT NULL,
      sealed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (worktree_id, epoch)
    )`;
  yield* sql`CREATE INDEX capture_seals_executor_idx ON capture_seals (worktree_id, executor_id)`;
});

/**
 * 0081: which executor a save and a stop's attestation name (review 2026-09-28 #13).
 * - `capture_saved_epoch`: the lease epoch beside a completed final flush Mend observed, so the
 *   save binds to that executor AND epoch — never to a later claim of the same worktree.
 * - `executor_resource_id`: the current executor's runtime identity as the platform reports it
 *   (`details().runtime.resourceId`), recorded at launch; what a stop's completion attestation
 *   names. Cleared whenever the session takes a new executor.
 */
const captureExecutorIdentityMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN capture_saved_epoch integer,
      ADD COLUMN executor_resource_id text`;
});

/**
 * 0082: a create Mend asked for and has not seen answered (review 2026-09-28 #7, Core's
 * idempotent create). `executor_create_key`: the idempotency key of the session's executor
 * create, written before the create is asked and cleared once the platform's answer is on the row
 * (or it refused). While it stands, the lease that names the session belongs to an executor Mend
 * may not have seen: nothing reads it as ended, and the key finds it
 * (`workspaces.findByIdempotencyKey`).
 */
const executorCreateKeyMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN executor_create_key text`;
  yield* sql`
    CREATE INDEX agent_sessions_executor_create_key_idx ON agent_sessions (id)
      WHERE executor_create_key IS NOT NULL`;
});

/**
 * 0083: every physical executor has its own launch identity (cross-repo decision 5, review
 * 2026-09-28 (3) #1 and #5): its create's idempotency key, minted before the create.
 * - `session_channel_tokens`: one row per token, keyed by its hash, naming the session and the
 *   launch it was issued for. A new launch adds a token and never rotates another's: an executor
 *   whose stop was kept, or whose create was never answered, keeps its own until its end is
 *   observed. A row from before carries its session id as its launch — what that executor's
 *   plan answered, and so what its seal names.
 * - `agent_sessions.executor_launch_id`: the current executor's launch, recorded beside its
 *   workspace; what a seal must name to be attested for it.
 */
const executorLaunchIdentityMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE session_channel_tokens ADD COLUMN launch_id text`;
  yield* sql`UPDATE session_channel_tokens SET launch_id = session_id`;
  yield* sql`ALTER TABLE session_channel_tokens ALTER COLUMN launch_id SET NOT NULL`;
  yield* sql`ALTER TABLE session_channel_tokens DROP CONSTRAINT session_channel_tokens_pkey`;
  yield* sql`ALTER TABLE session_channel_tokens ADD PRIMARY KEY (token_hash)`;
  yield* sql`CREATE INDEX session_channel_tokens_session_idx ON session_channel_tokens (session_id)`;
  yield* sql`CREATE INDEX session_channel_tokens_launch_idx ON session_channel_tokens (launch_id)`;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN executor_launch_id text`;
  yield* sql`
    UPDATE agent_sessions SET executor_launch_id = id WHERE sealant_workspace_id IS NOT NULL`;
});

/**
 * 0084: an executor's answer that said it held unsaved work, the latest one (review 2026-09-28
 * (4) #1 and #9, cross-repo decision 10). `capture_unsaved_workspace_id` / `_at` / `_detail`: the
 * executor, when Mend took the answer, and its words. Taken after a completed final flush Mend
 * observed (`capture_saved_*`) or a seal the store holds, it revokes that save: nothing reads the
 * executor saved on it, and nothing attests it to the platform.
 */
const captureUnsavedObservationMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN capture_unsaved_workspace_id text,
      ADD COLUMN capture_unsaved_at timestamptz,
      ADD COLUMN capture_unsaved_detail text`;
});

/**
 * 0085: a worktree lease is bound to the physical launch that holds it (cross-repo decision 11,
 * review 2026-09-28 (4) #11). `worktree_leases.launch_id`: the launch — the executor's create key,
 * what its channel token names — that claimed it. The holder is (session, launch): plan,
 * heartbeat, upload and register check both, so an older launch of the same session never learns,
 * renews or ships under a newer launch's epoch. NULL: Mend's own `mend:` claims, and a lease taken
 * before this — any launch of its holder is accepted until the lease is next claimed.
 */
const leaseLaunchMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE worktree_leases ADD COLUMN launch_id text`;
});

/**
 * 0086: what an executor answered, per physical executor (cross-repo decision 14, review
 * 2026-09-28 (5) #3). `executor_capture_evidence`, one row per workspace — one physical
 * executor, one disk — holding the latest completed final flush Mend observed from it
 * (`saved_*`, under `saved_epoch`) and the latest answer that said it held unsaved work
 * (`unsaved_*`), whichever session asked: a joined session's read of the executor it shares
 * describes the same disk as its holder's. `launch_id`: the launch Mend knew for it when it
 * answered. What a seal, an attestation and an executor's end are weighed against; it outlives
 * the sessions that took it (a removed joined session keeps its answer here) and goes with the
 * worktree.
 */
const executorCaptureEvidenceMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE executor_capture_evidence (
      workspace_id text PRIMARY KEY,
      worktree_id text NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      launch_id text,
      saved_at timestamptz,
      saved_n integer,
      saved_epoch integer,
      unsaved_at timestamptz,
      unsaved_detail text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX executor_capture_evidence_worktree_idx ON executor_capture_evidence (worktree_id)`;
});

/**
 * 0087: evidence ordered by the executor, and a version every decision reads (cross-repo
 * decisions 17 and 18, review 2026-09-28 (6) #6).
 * - `executor_capture_evidence.saved_position` / `unsaved_position`: where in its own history the
 *   executor made each kept answer (`CapturePosition`: epoch, launch, boot, boot generation,
 *   observation, head). An answer replaces the kept one of its kind unless the executor made it
 *   before; a save stands over an unsaved answer only when ordered after it. The `*_at` columns
 *   stay, for display only.
 * - `executor_capture_evidence.version`: bumped by every answer taken from the executor, whether
 *   or not it changed what is kept. A "saved" or an attestation decided on what it read commits
 *   only while the version it read is still the current one.
 * - `capture_seals.boot_id` / `boot_generation` / `observation`: where sealantd stamped the seal
 *   in its own order (`final_seal.boot_id`, `.boot_generation`, `.observation`), when it did;
 *   without them nothing orders the seal against an answer, and an unsaved answer revokes it.
 */
const executorEvidenceOrderMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE executor_capture_evidence
      ADD COLUMN saved_position jsonb,
      ADD COLUMN unsaved_position jsonb,
      ADD COLUMN version bigint NOT NULL DEFAULT 0`;
  yield* sql`
    ALTER TABLE capture_seals
      ADD COLUMN boot_id text,
      ADD COLUMN boot_generation bigint,
      ADD COLUMN observation bigint`;
});

/**
 * 0088: an executor's evidence is fenced durably (cross-repo decision 18, review 2026-09-28 (7)
 * #3). `executor_evidence_fences`: one row per answer asked of an executor and not yet published
 * as its evidence — from the moment Mend asks until the answer is published in the transaction
 * that deletes the row, or the ask comes back unanswered. An answer that arrived and could not be
 * published keeps its row (`unpublished`) until an answer asked after it is published. While a
 * row names an executor its evidence is unknown to every engine, across restarts. The answer, the
 * session's reading of it and the executor's evidence are written in one transaction.
 * `agent_sessions.capture_observed_position`: where in its own history the executor made the
 * answer behind the session's queue reading (`origin`, review 2026-09-28 (7) #4), so the reading
 * is ordered against a seal like the executor's own evidence is.
 *
 * Rows written before this could hold an unsaved answer on a session whose executor-wide write
 * failed: every executor whose sessions hold an unsaved answer later than the one its evidence
 * keeps is fenced here, unpublished, until an answer asked after this publishes.
 */
const executorEvidenceFencesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE executor_evidence_fences (
      ticket bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      holder text NOT NULL,
      unpublished boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    CREATE INDEX executor_evidence_fences_workspace_idx
      ON executor_evidence_fences (workspace_id)`;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN capture_observed_position jsonb`;
  yield* sql`
    INSERT INTO executor_evidence_fences (workspace_id, holder, unpublished)
    SELECT DISTINCT s.capture_unsaved_workspace_id, 'migration-0088', true
      FROM agent_sessions s
      LEFT JOIN executor_capture_evidence e ON e.workspace_id = s.capture_unsaved_workspace_id
     WHERE s.capture_unsaved_workspace_id IS NOT NULL
       AND s.capture_unsaved_at IS NOT NULL
       AND (e.unsaved_at IS NULL OR e.unsaved_at < s.capture_unsaved_at)`;
});

/**
 * 0089: a seal stands only over bytes nothing can still replace (review 2026-09-28 (7) #8).
 * - `capture_put_authority`: per worktree epoch, the latest expiry of every upload URL Mend handed
 *   out under its prefix — recorded before the URL leaves Mend. On a bucket that ignores
 *   `If-None-Match` (Garage) such a URL could replace an object until then, so no seal of the
 *   epoch stands before it.
 * - `capture_seals.reverified_at`: when every object the sealed capture names was read back after
 *   that and found to be what its name says; the seal stands from then until another URL is handed
 *   out under its epoch. `capture_seals.void_reason`: an object read back as other bytes — the seal
 *   never stands again.
 */
const capturePutAuthorityMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE capture_put_authority (
      worktree_id text NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      epoch bigint NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (worktree_id, epoch)
    )`;
  yield* sql`
    ALTER TABLE capture_seals
      ADD COLUMN reverified_at timestamptz,
      ADD COLUMN void_reason text`;
});

/**
 * 0090: an executor's evidence keeps every unsaved answer nothing it keeps was made after
 * (cross-repo decision 25, review 2026-09-28 (9) #4). `executor_capture_evidence.unsaved_answers`:
 * the antichain of unsaved answers in the executor's own order (`withUnsavedAnswer`), each
 * `{at, words, position}`, the latest received last. An answer nothing orders against a kept one
 * used to replace it, erasing a failure no save covered; now both are kept, and a save stands
 * only over every one. The `unsaved_*` columns keep the latest received, for display. Existing
 * rows start from the one answer they kept.
 */
const executorUnsavedAnswersMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE executor_capture_evidence
      ADD COLUMN unsaved_answers jsonb NOT NULL DEFAULT '[]'::jsonb`;
  yield* sql`
    UPDATE executor_capture_evidence
       SET unsaved_answers = jsonb_build_array(jsonb_build_object(
             'at', to_jsonb(unsaved_at),
             'words', COALESCE(unsaved_detail, 'not saved'),
             'position', unsaved_position))
     WHERE unsaved_at IS NOT NULL`;
});

/**
 * 0091: write authority and a seal's acceptance serialize on one row (cross-repo decision 26,
 * review 2026-09-28 (9) #6). `capture_put_authority.expires_at` may be null: the epoch's row is
 * created, with no authority, by whichever comes first — issuing an upload URL or marking a seal
 * re-verified — and both lock it `FOR UPDATE` before reading anything fresh. The mark's old
 * `NOT EXISTS` read the authority from its statement's snapshot, taken before it waited on the
 * seal row, and so missed authority committed while it waited. Issuing authority refuses while a
 * seal of the epoch is recorded that the caller did not check its keys against.
 */
const capturePutAuthorityLockMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE capture_put_authority ALTER COLUMN expires_at DROP NOT NULL`;
});

/**
 * 0092: a seal stands over the write authority of every epoch its objects live under (cross-repo
 * decision 31, review 2026-09-28 (10) #5). `capture_seals.scopes`: `[{worktreeId, epoch}]`, every
 * `captures/<worktree>/<epoch>/` prefix holding an object the sealed capture names — its manifest,
 * packs, trees and dir packs, the ones it carries from an earlier epoch or another worktree
 * included, its own epoch always among them. A seal stands only while no upload URL handed out
 * under any of them could still replace an object; its re-verification mark is a compare-and-set
 * against all of them; and once it is recorded, no URL that could replace one of its objects is
 * handed out under any of them. Existing seals get every prefix their capture's sections and
 * manifest key name, and are read back again before they stand: the mark they carry was made
 * against their own epoch alone.
 */
const captureSealScopesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE capture_seals ADD COLUMN scopes jsonb`;
  yield* sql`
    UPDATE capture_seals s
       SET scopes = (
             SELECT jsonb_agg(DISTINCT jsonb_build_object('worktreeId', m.wt, 'epoch', m.ep))
               FROM (
                 SELECT s.worktree_id AS wt, s.epoch AS ep
                 UNION
                 SELECT r[1], r[2]::bigint
                   FROM captures c,
                        regexp_matches(c.sections::text || ' ' || c.manifest_key,
                                       'captures/([^/"]+)/([0-9]{1,18})/', 'g') AS r
                  WHERE c.id = s.capture_id
               ) m),
           reverified_at = NULL`;
  yield* sql`CREATE INDEX capture_seals_scopes_idx ON capture_seals USING gin (scopes jsonb_path_ops)`;
});

/**
 * 0093: a capture step still running past its bound (sealantd `CaptureStatusReport.overdue`,
 * e2e8): the innermost such step the executor last reported — `capture_overdue_step`, when it
 * started, how long it had run and the bound it passed. Observed on every status read and flush;
 * cleared when a reading reports none and when the executor is gone. In e2e8 a capture deadlocked
 * on a git pipe for 17 minutes while every status read `running · 0 pending`.
 */
const captureOverdueMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_sessions
      ADD COLUMN capture_overdue_step text,
      ADD COLUMN capture_overdue_since timestamptz,
      ADD COLUMN capture_overdue_running_ms bigint,
      ADD COLUMN capture_overdue_bound_ms bigint`;
});

/**
 * 0094: a git section recorded `failed` is checked again (review 2026-09-28 (13) #1). Until now
 * any git step the Mend host could not finish — killed by the OOM killer, out of disk, output past
 * its buffer — recorded a sound capture `failed`, for good: plans restored an older git section
 * under it and its seal was refused on every ask. Why a row failed was never stored, so every
 * `failed` row goes back to `unverified`, once: the next plan, register or seal re-ask verifies it
 * again, and only git rejecting its bytes or its closure records `failed` from now on.
 */
const captureGitFsckRecheckMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE captures SET git_fsck = 'unverified' WHERE git_fsck = 'failed'`;
});

/**
 * When a process's record first carried output (`SessionProcess.firstOutputAt`): an agent that has
 * drawn nothing yet reads as starting on its machine, not as a blank screen. Rows from before it
 * was observed stay null.
 */
const processFirstOutputMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE session_processes ADD COLUMN IF NOT EXISTS first_output_at timestamptz`;
});

/**
 * Phone notifications (packages/jobs/src/session-notifier.ts): what each person hears about on
 * their phones. No row means the defaults, which the columns repeat: sessions started from Slack
 * push only what their thread does not already say, and every kind is on.
 */
const notificationSettingsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE user_notification_settings (
      user_id text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
      slack_sessions boolean NOT NULL DEFAULT false,
      turn_finished boolean NOT NULL DEFAULT true,
      needs_input boolean NOT NULL DEFAULT true,
      failed boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
});

/**
 * Each person's pi setup (`mend connect pi`): one row per account, removed with the account. The
 * files are jsonb like skills'; the launch path reads them whole.
 */
const userPiProfilesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE user_pi_profiles (
      user_id text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
      files jsonb NOT NULL,
      digest text NOT NULL,
      bytes integer NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
});

/**
 * Each person's agent memory per project (docs/adr/0009): one row per file, and the versions Mend
 * replaced or deleted. Both go with the account and with the project.
 */
const agentMemoryMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE agent_memory_files (
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      path text NOT NULL,
      encoding text NOT NULL,
      contents text NOT NULL,
      digest text NOT NULL,
      bytes integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by_session text,
      PRIMARY KEY (user_id, project_id, path)
    )`;
  yield* sql`
    CREATE TABLE agent_memory_versions (
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      path text NOT NULL,
      digest text NOT NULL,
      encoding text NOT NULL,
      contents text NOT NULL,
      saved_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, project_id, path, digest)
    )`;
});

/**
 * 0099: the SHA-256 each bytes-bound upload URL of a pack index was signed for, and until when one
 * of them could still be used (ADR 0002 decision 48). It was a registry in the server's memory, so
 * a restart forgot it and every seal waited out the longest a URL could live, 20 minutes after
 * each start (measured on a self-hosted box, 2026-10-02). On record here, a restart forgets
 * nothing: a seal never stands over an index a live URL bound to other bytes could replace, and
 * waits for nothing else.
 *
 * The server this one replaces kept its bindings in memory, and they are gone. A URL it bound in
 * its last minutes can live for 20 more (the longest life of a URL plus the bucket's clock
 * margin). `capture_bound_index_cutover` says until when: seals wait the start window out as
 * before until then, once, and never again. A database with no worktree has handed out no URL,
 * and gets no such wait.
 */
const captureBoundIndexesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE capture_bound_indexes (
      key text PRIMARY KEY,
      sha256 text NOT NULL,
      until timestamptz NOT NULL
    )`;
  yield* sql`CREATE INDEX capture_bound_indexes_until ON capture_bound_indexes (until)`;
  yield* sql`
    CREATE TABLE capture_bound_index_cutover (
      only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
      until timestamptz NOT NULL
    )`;
  yield* sql`
    INSERT INTO capture_bound_index_cutover (until)
    SELECT now() + interval '20 minutes' WHERE EXISTS (SELECT 1 FROM worktrees)`;
});

/**
 * 0100: what each executor launch said it reads, in its `plan.get` (`upload_answers`): `present`,
 * and `sha256` for upload URLs bound to their bytes. It was kept in the server's memory, and an
 * executor plans once, at boot. So after a Mend restart every running executor was answered as
 * an older daemon: unbound URLs, and its Stop waited 10.5 minutes for them to expire (measured
 * on a self-hosted box, 2026-10-02). On record, a restart changes nothing for it.
 */
const captureLaunchAnswersMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE capture_launch_answers (
      launch_id text PRIMARY KEY,
      answers jsonb NOT NULL,
      noted_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX capture_launch_answers_noted_at ON capture_launch_answers (noted_at)`;
});

/**
 * 0101: each person's secret files (docs/adr/0010-secret-files.md): one row per path, the content
 * sealed with the machine's secrets key as project secrets are. Removed with the account.
 */
const secretFilesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE user_secret_files (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      path text NOT NULL,
      sealed_contents text NOT NULL,
      bytes integer NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_secret_files_user_id_path_key UNIQUE (user_id, path)
    )`;
});

/**
 * 0102: the server-owned model catalog (docs/models-audit.md): one row per harness and model id, seeded
 * with what the harness adapters supported on 2026-10-03 (`HARNESS_MODEL_SEED`, written out here
 * so the migration stays what it was). `efforts` null means the harness's own; one default per
 * harness. And the model and effort a session was started with, on the session itself.
 */
const harnessModelsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE harness_models (
      harness text NOT NULL,
      id text NOT NULL,
      label text NOT NULL,
      is_default boolean NOT NULL DEFAULT false,
      efforts jsonb,
      position integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (harness, id)
    )`;
  yield* sql`
    CREATE UNIQUE INDEX harness_models_one_default_idx ON harness_models (harness) WHERE is_default`;
  yield* sql`
    INSERT INTO harness_models (harness, id, label, is_default, efforts, position) VALUES
      ('claude', 'fable', 'Fable · latest', true, NULL, 0),
      ('claude', 'opus', 'Opus · latest', false, NULL, 1),
      ('claude', 'sonnet', 'Sonnet · latest', false, NULL, 2),
      ('claude', 'haiku', 'Haiku · latest', false, NULL, 3),
      ('codex', 'gpt-6.1-sol', 'GPT-6.1 Sol', true, NULL, 0),
      ('codex', 'gpt-6-astra', 'GPT-6 Astra', false, NULL, 1),
      ('codex', 'gpt-6-sol', 'GPT-6 Sol', false, NULL, 2),
      ('codex', 'gpt-6-luna', 'GPT-6 Luna', false, '["low","medium","high","xhigh","max"]'::jsonb, 3),
      ('codex', 'gpt-5.6-sol', 'GPT-5.6 Sol', false, NULL, 4),
      ('codex', 'gpt-5.6-terra', 'GPT-5.6 Terra', false, NULL, 5),
      ('codex', 'gpt-5.6-luna', 'GPT-5.6 Luna', false, '["low","medium","high","xhigh","max"]'::jsonb, 6),
      ('codex', 'gpt-5.5', 'GPT-5.5', false, '["low","medium","high","xhigh"]'::jsonb, 7)`;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN model text`;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN effort text`;
});

/**
 * 0103: repositories in a session (docs/adr/0010): the sibling worktrees a session holds at
 * `/workspace/repos/<name>`, with the state of their arrival and how each is saved.
 */
const sessionRepositoriesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE session_repositories (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      worktree_id text NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
      name text NOT NULL,
      path text NOT NULL,
      branch text NOT NULL,
      base_sha text NOT NULL,
      base_ref text,
      state text NOT NULL DEFAULT 'adding',
      error text,
      capture text NOT NULL,
      source text NOT NULL,
      added_by_user_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      ready_at timestamptz,
      CONSTRAINT session_repositories_session_name_key UNIQUE (session_id, name),
      CONSTRAINT session_repositories_session_worktree_key UNIQUE (session_id, worktree_id),
      CONSTRAINT session_repositories_state_check
        CHECK (state IN ('adding', 'ready', 'failed', 'missing')),
      CONSTRAINT session_repositories_capture_check CHECK (capture IN ('nested', 'own')),
      CONSTRAINT session_repositories_source_check CHECK (source IN ('origin', 'store'))
    )`;
  yield* sql`CREATE INDEX session_repositories_worktree_idx ON session_repositories (worktree_id)`;
});

/**
 * 0104: the pull request's title as `gh` reports it, so a session's conversation and every list
 * can name it (docs/adr/0007-landing.md, "What Mend records and shows"), and the index those lists
 * read each change's newest pull request through.
 */
const landingPullRequestTitleMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE change_landings ADD COLUMN pull_request_title text`;
  yield* sql`
    CREATE INDEX change_landings_project_pull_request_idx
    ON change_landings (project_id, change_id, created_at DESC)
    WHERE pull_request_number IS NOT NULL`;
});

/**
 * Who opened a turn (`request` | `harness`): Claude opens a turn on its own when a background
 * task or workflow it started ends, and Mend records it rather than dropping its output.
 */
const turnOriginMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_turns ADD COLUMN origin text NOT NULL DEFAULT 'request'`;
  yield* sql`
    ALTER TABLE agent_turns
      ADD CONSTRAINT agent_turns_origin_check CHECK (origin IN ('request', 'harness'))`;
});

/**
 * docs/adr/0013-whoever-sends-a-turn-pays.md, "Terminal sessions: only the owner types": an attach
 * by anyone but the owner streams output and drops input, and the control log says so.
 */
const terminalWatchControlMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE session_control_events
      DROP CONSTRAINT IF EXISTS session_control_events_kind_check`;
  yield* sql`
    ALTER TABLE session_control_events
      ADD CONSTRAINT session_control_events_kind_check CHECK (kind IN (
        'interrupt', 'terminal-attach', 'terminal-watch', 'shell-open', 'stop', 'services-stop',
        'idle-stop', 'shared-control-on', 'shared-control-off', 'discard-unsaved-stop'
      ))`;
});

/**
 * docs/adr/0013-whoever-sends-a-turn-pays.md, "Every turn records its payer": the person and the
 * connected account a turn ran on, with the account's name as it was then. Null on turns sent
 * before it, and on turns Mend could not say of. A payer, like every other actor Mend records, is
 * never deleted from under the record.
 */
const turnPayerMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE agent_turns
      ADD COLUMN billed_user_id text REFERENCES "user" (id) ON DELETE RESTRICT,
      ADD COLUMN billed_account_id text,
      ADD COLUMN billed_account_name text`;
});

/**
 * 0108: what `mend memory import` last imported from each checkout on each machine
 * (docs/adr/0009, decision 4), so the next import from there merges three-way against it instead
 * of with no shared version. A text file's contents are kept; a binary one's digest is enough.
 * And which kept versions are pinned beyond the cap.
 */
const agentMemoryImportBasesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE agent_memory_import_bases (
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      source text NOT NULL,
      path text NOT NULL,
      digest text NOT NULL,
      encoding text NOT NULL,
      contents text,
      imported_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, project_id, source, path)
    )`;
  // A version that is the only copy of some lines (a machine's file in a conflict, one a merge
  // did not keep whole, a stored file a read-back could not merge) is pinned: the cap of twenty
  // versions per file never takes it.
  yield* sql`ALTER TABLE agent_memory_versions ADD COLUMN pinned boolean NOT NULL DEFAULT false`;
  // Every version kept before this one may be the only copy of some lines, and nothing recorded
  // which: all of them are pinned. Memory versions are small text, and few.
  yield* sql`UPDATE agent_memory_versions SET pinned = true`;
});

/**
 * 0109: opencode's models in the catalog (`HARNESS_MODEL_SEED.opencode`, written out here so the
 * migration stays what it was): the Codex models through the ChatGPT login, as opencode names them,
 * for the pickers to list. None is the default: a launch that names no model leaves the choice to
 * opencode and the person's own opencode config (`HARNESSES_CHOOSING_THEIR_OWN_MODEL`). A row an
 * operator already added is kept as it is, their default with it.
 */
const opencodeModelsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO harness_models (harness, id, label, is_default, efforts, position) VALUES
      ('opencode', 'openai/gpt-6.1-sol', 'GPT-6.1 Sol', false, NULL, 0),
      ('opencode', 'openai/gpt-6-astra', 'GPT-6 Astra', false, NULL, 1),
      ('opencode', 'openai/gpt-6-sol', 'GPT-6 Sol', false, NULL, 2),
      ('opencode', 'openai/gpt-6-luna', 'GPT-6 Luna', false, NULL, 3),
      ('opencode', 'openai/gpt-5.6-sol', 'GPT-5.6 Sol', false, NULL, 4),
      ('opencode', 'openai/gpt-5.6-terra', 'GPT-5.6 Terra', false, NULL, 5),
      ('opencode', 'openai/gpt-5.6-luna', 'GPT-5.6 Luna', false, NULL, 6),
      ('opencode', 'openai/gpt-5.5', 'GPT-5.5', false, NULL, 7)
    ON CONFLICT (harness, id) DO NOTHING`;
});

/**
 * The project's "Automatic install" setting: whether Mend runs an install command for it at all,
 * in a session's workspace or in the install job that feeds the shared cache. Every project,
 * existing and new, starts on, which is what Mend did before the setting existed.
 */
const projectInstallEnabledMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS install_enabled boolean NOT NULL DEFAULT true`;
});

/**
 * docs/adr/0009-agent-memory-per-person-per-project.md, capture mode: whose memory each worktree's
 * one harness home holds, as the server decided it when the launch of an executor handed the home
 * over. It outlives the session rows (a removed session's executor is still known as its owner's),
 * and the home's own record, which anything running in the executor can write, is never consulted.
 * - `user_id`, `session_id`, `workspace_id`: the settled home, the one the worktree's head capture
 *   holds. `user_id` null: the person was removed, or nobody could be named.
 * - `pending_*`: the hand-over of the executor launched last, under the lease `pending_epoch`. It
 *   counts only once a capture of that epoch, at chain position `pending_n` or later, is on the
 *   chain. `pending_n` is where the executor's first caught-up flush after the hand-over reached,
 *   null until one answers: an executor lost before it saved its hand-over leaves the previous
 *   home in place.
 */
const agentMemoryHomesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE agent_memory_homes (
      worktree_id text PRIMARY KEY REFERENCES worktrees (id) ON DELETE CASCADE,
      user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      session_id text,
      workspace_id text,
      pending_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      pending_session_id text,
      pending_workspace_id text,
      pending_epoch integer,
      pending_n integer,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
});

/**
 * docs/adr/0016-per-person-harness-homes.md, behind `MEND_HARNESS_LAYOUT`:
 * - `linux_identities`: each account's Linux login name and uid, allocated the first time it runs
 *   anything in a person-layout workspace, stable instance-wide (the same name, uid and home in
 *   every executor and project). No foreign key: a removed account's uid is never given to
 *   another, since its files in old captures are owned by it.
 * - `worktrees.harness_layout`: `person` once the worktree has had a person launch, never cleared
 *   (decision 14: there is no way back). Null until then.
 * - `worktrees.harness_layout_requested`: the operator-only `harnessLayout` a start that made the
 *   worktree asked for (the benchmark picks the layout per launch on fresh worktrees).
 * - `executor_layouts`: the layout of each launch (one physical executor), with what decided it.
 *   `confirmed`: prepare found the executor could run it (a `person` prediction may fall back to
 *   `shared` on a fresh worktree, and is then recorded as `shared` from `fallback`).
 * - `image_layout_capabilities`: what an executor's prepare found about its image and runtime,
 *   per image key, which wins over Core's report for the same image.
 */
const harnessLayoutMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE linux_identities (
      user_id text PRIMARY KEY,
      name text NOT NULL UNIQUE,
      uid integer NOT NULL UNIQUE CHECK (uid BETWEEN 40001 AND 49999),
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`
    ALTER TABLE worktrees
      ADD COLUMN harness_layout text CHECK (harness_layout = 'person'),
      ADD COLUMN harness_layout_requested text
        CHECK (harness_layout_requested IN ('person', 'shared'))`;
  yield* sql`
    CREATE TABLE executor_layouts (
      launch_id text PRIMARY KEY,
      worktree_id text NOT NULL REFERENCES worktrees (id) ON DELETE CASCADE,
      session_id text NOT NULL,
      layout text NOT NULL CHECK (layout IN ('person', 'shared')),
      source text NOT NULL
        CHECK (source IN ('worktree', 'operator', 'capability', 'flag', 'fallback')),
      reason text,
      image_key text,
      confirmed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  yield* sql`CREATE INDEX executor_layouts_worktree_idx ON executor_layouts (worktree_id)`;
  yield* sql`
    CREATE TABLE image_layout_capabilities (
      image_key text NOT NULL,
      runtime text NOT NULL,
      person boolean NOT NULL,
      missing jsonb NOT NULL DEFAULT '[]'::jsonb,
      observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (image_key, runtime)
    )`;
});

/**
 * docs/adr/0016, decision 4 (Delivery 13): git and Mend identity per process. A session channel
 * token is either the launch's own (`account_id` null: sealantd's capture channel, and in a
 * `shared` executor everything, as before) or one person's in that launch, which the SSH shim and
 * the `mend` helper present from `~/.mend/session-token`. A Service remembers who started it, so
 * a restart in a person executor runs as them (null: its session's owner, as before).
 */
const personIdentityMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE session_channel_tokens ADD COLUMN account_id text`;
  yield* sql`ALTER TABLE services ADD COLUMN started_by text`;
});

/**
 * 0114: who created a workspace, found by the workspace (`SessionsRepo.executorSessionOf`): the
 * session whose row names it under a launch of its own (0083). A call about a workspace runs as
 * that session's owner, whoever asks (alpha 2026-10-06, 9e486cfc: a second person's join looked
 * the holder's workspace up as themselves, and Core answered 404). Partial: joined rows name the
 * workspace with no launch and are never the answer. One assumption: 0083 backfilled
 * `executor_launch_id = id` on every row that named a workspace, joined ones included, so for an
 * executor older than 0083 (2026-09-28) a joiner's row could answer too. No such executor is still
 * running; executors live hours, not weeks.
 */
const executorWorkspaceIndexMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX agent_sessions_executor_workspace_idx ON agent_sessions (sealant_workspace_id)
      WHERE executor_launch_id IS NOT NULL`;
});

/**
 * 0115 (docs/adr/0016, decision 11): "Start my agents after install.sh", a per-person setting,
 * off by default. A person's `install.sh` runs beside the agent of their first process in an
 * executor someone else launched, so a join stays inside its budget; with this on, their agents
 * wait for it.
 */
const startAgentsAfterInstallMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE user_dotfiles
      ADD COLUMN start_agents_after_install boolean NOT NULL DEFAULT false`;
});

/**
 * 0116 (docs/adr/0016, decision 9): when a session's shared control was first turned on, never
 * cleared, so a session once shared keeps running on no one's memory after control is turned
 * off. Sessions shared now count from now.
 */
const sharedControlEverMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_sessions ADD COLUMN shared_control_ever_at timestamptz`;
  yield* sql`
    UPDATE agent_sessions SET shared_control_ever_at = shared_control_enabled_at
    WHERE shared_control_enabled_at IS NOT NULL`;
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
  "0054_project_install_command": projectInstallCommandMigration,
  "0055_organizations": organizationsMigration,
  "0056_per_account_resources": perAccountResourcesMigration,
  "0057_folders": foldersMigration,
  "0058_hot_pool_owners": hotPoolOwnersMigration,
  "0059_audit_events": auditEventsMigration,
  "0060_shared_control": sharedControlMigration,
  "0061_upgrade_tickets": upgradeTicketsMigration,
  "0062_slack": slackMigration,
  "0063_slack_reports": slackReportsMigration,
  "0064_landing": landingMigration,
  "0065_turn_landing": turnLandingMigration,
  "0066_landing_description": landingDescriptionMigration,
  "0067_services_stop_control": servicesStopControlMigration,
  "0068_user_git_author": userGitAuthorMigration,
  "0069_landing_adoption": landingAdoptionMigration,
  "0070_organization_settings": organizationSettingsMigration,
  "0071_project_default_shell_profile": projectDefaultShellProfileMigration,
  "0072_protocol_idle_stop": protocolIdleStopMigration,
  "0073_landing_reasons": landingReasonsMigration,
  "0075_capture_drain": captureDrainMigration,
  "0076_capture_guards": captureGuardsMigration,
  "0077_capture_drain_resume": captureDrainResumeMigration,
  "0078_capture_failing": captureFailingMigration,
  "0079_capture_saved": captureSavedMigration,
  "0080_capture_claims_and_seals": captureClaimsAndSealsMigration,
  "0081_capture_executor_identity": captureExecutorIdentityMigration,
  "0082_executor_create_key": executorCreateKeyMigration,
  "0083_executor_launch_identity": executorLaunchIdentityMigration,
  "0084_capture_unsaved_observation": captureUnsavedObservationMigration,
  "0085_lease_launch": leaseLaunchMigration,
  "0086_executor_capture_evidence": executorCaptureEvidenceMigration,
  "0087_executor_evidence_order": executorEvidenceOrderMigration,
  "0088_executor_evidence_fences": executorEvidenceFencesMigration,
  "0089_capture_put_authority": capturePutAuthorityMigration,
  "0090_executor_unsaved_answers": executorUnsavedAnswersMigration,
  "0091_capture_put_authority_lock": capturePutAuthorityLockMigration,
  "0092_capture_seal_scopes": captureSealScopesMigration,
  "0093_capture_overdue": captureOverdueMigration,
  "0094_capture_git_fsck_recheck": captureGitFsckRecheckMigration,
  "0095_process_first_output": processFirstOutputMigration,
  "0096_notification_settings": notificationSettingsMigration,
  "0097_user_pi_profiles": userPiProfilesMigration,
  "0098_agent_memory": agentMemoryMigration,
  "0099_capture_bound_indexes": captureBoundIndexesMigration,
  "0100_capture_launch_answers": captureLaunchAnswersMigration,
  "0101_secret_files": secretFilesMigration,
  "0102_harness_models": harnessModelsMigration,
  "0103_session_repositories": sessionRepositoriesMigration,
  "0104_landing_pull_request_title": landingPullRequestTitleMigration,
  "0105_turn_origin": turnOriginMigration,
  "0106_terminal_watch_control": terminalWatchControlMigration,
  "0107_turn_payer": turnPayerMigration,
  "0108_agent_memory_import_bases": agentMemoryImportBasesMigration,
  "0109_opencode_models": opencodeModelsMigration,
  "0110_project_install_enabled": projectInstallEnabledMigration,
  "0111_agent_memory_homes": agentMemoryHomesMigration,
  "0112_harness_layout": harnessLayoutMigration,
  "0113_person_identity": personIdentityMigration,
  "0114_executor_workspace_index": executorWorkspaceIndexMigration,
  "0115_start_agents_after_install": startAgentsAfterInstallMigration,
  "0116_shared_control_ever": sharedControlEverMigration,
};
