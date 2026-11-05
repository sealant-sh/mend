import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Immutable SQL from preview 105, run 42046499850, commit
// 314ea98f1da4efa4ecc89d8b5a6c284427c799d2. Keep the original IDs and DDL.
const executorLinksMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_executors (
    organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    id text NOT NULL UNIQUE, mode text NOT NULL CHECK (mode IN ('own', 'mend-run')),
    url text NOT NULL
  )`;
  yield* sql`CREATE TABLE executor_links (
    id text PRIMARY KEY,
    configuration_id text NOT NULL REFERENCES organization_executors(id) ON DELETE CASCADE,
    subject text NOT NULL, user_id text,
    state text NOT NULL CHECK (state IN ('active', 'refused')),
    sealed_credentials text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT executor_links_configuration_subject_key UNIQUE(configuration_id, subject)
  )`;
  yield* sql`CREATE TABLE executor_link_flows (
    state_hash text PRIMARY KEY,
    configuration_id text NOT NULL REFERENCES organization_executors(id) ON DELETE CASCADE,
    actor_id text NOT NULL, subject text NOT NULL, sealed_flow text NOT NULL,
    expires_at timestamptz NOT NULL
  )`;
  yield* sql`CREATE TABLE executor_calls (
    id text PRIMARY KEY, session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    link_id text REFERENCES executor_links(id) ON DELETE SET NULL,
    as_user_id text, as_member boolean NOT NULL, approver_id text,
    service text NOT NULL, tool text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('requested', 'held', 'answering', 'completed', 'refused', 'denied', 'expired', 'unavailable')),
    message text NOT NULL, observations jsonb NOT NULL DEFAULT '[]'::jsonb,
    sealed_result text, created_at timestamptz NOT NULL DEFAULT now(),
    observed_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz
  )`;
  yield* sql`CREATE INDEX executor_calls_session_id_idx ON executor_calls(session_id, id)`;
});

const executorInstancesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE executor_instances (
    organization_id text PRIMARY KEY REFERENCES organizations(id),
    scope_key text NOT NULL UNIQUE, sealed_state text NOT NULL,
    applied_spec text, image text, backup_at timestamptz, executor_organization_id text
  )`;
});

export const preview105ExecutorMigrations = {
  "0192_executor_links": executorLinksMigration,
  "0193_executor_instances": executorInstancesMigration,
};
