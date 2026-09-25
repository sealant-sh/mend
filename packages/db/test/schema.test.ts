import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  agentItems,
  agentRequests,
  agentSessions,
  agentTurns,
  briefComments,
  briefVersions,
  briefs,
  changeLandings,
  changePasses,
  changeTours,
  changes,
  checkpoints,
  contextSnapshots,
  followUps,
  inferenceCalls,
  issues,
  projectEnvironmentVariables,
  projectMounts,
  projectSecrets,
  projectReferences,
  projectServiceRecipes,
  projects,
  pushDevices,
  referenceRepos,
  reviewQuestions,
  reviewComments,
  reviewSlices,
  runs,
  serviceForwards,
  serviceObservations,
  services,
  sessionProcesses,
  sessionRuns,
  settings,
  slackChannelDefaults,
  slackEventClaims,
  slackInstalls,
  slackLinkCodes,
  slackLinks,
  slackThreadPosts,
  slackThreads,
  slackUserDefaults,
  worktreeChanges,
  worktrees,
} from "../src/schema/workbench.ts";

describe("Mend Drizzle schema", () => {
  it("maps the retiring issue, change, and run graph", () => {
    expect([issues, changes, runs].map((table) => getTableConfig(table).name)).toEqual([
      "issues",
      "changes",
      "runs",
    ]);
    expect(getTableConfig(issues).columns.map((column) => column.name)).toEqual([
      "id",
      "source",
      "external_ref",
      "repository",
      "title",
      "body",
      "stage",
      "position",
      "last_failure_run_id",
      "created_at",
      "updated_at",
    ]);
    expect(getTableConfig(issues).indexes[0]?.config.name).toBe("issues_stage_position_idx");
    expect(getTableConfig(changes).columns[1]?.isUnique).toBe(true);
    expect(getTableConfig(changes).foreignKeys[0]?.onDelete).toBe("cascade");
    expect(getTableConfig(runs).columns.map((column) => column.name)).toEqual([
      "id",
      "issue_id",
      "change_id",
      "kind",
      "sealant_run_id",
      "sealant_workspace_id",
      "status",
      "outcome",
      "summary",
      "last_seen_sequence",
      "started_at",
      "settled_at",
      "created_at",
      "updated_at",
      "failure_brief",
    ]);
    expect(runs.lastSeenSequence.getSQLType()).toBe("bigint");
    expect(runs.failureBrief.getSQLType()).toBe("jsonb");
    expect(getTableConfig(runs).foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual([
      "cascade",
      "set null",
    ]);
  });

  it("maps living briefs, immutable versions, question indexes, and comments", () => {
    expect(
      [briefs, briefVersions, reviewQuestions, briefComments].map(
        (table) => getTableConfig(table).name,
      ),
    ).toEqual(["briefs", "brief_versions", "review_questions", "brief_comments"]);
    expect(briefs.document.getSQLType()).toBe("jsonb");
    expect(briefVersions.document.getSQLType()).toBe("jsonb");
    expect(reviewQuestions.evidence.getSQLType()).toBe("jsonb");
    expect(
      getTableConfig(briefVersions).primaryKeys[0]?.columns.map((column) => column.name),
    ).toEqual(["brief_id", "version"]);
    expect(getTableConfig(reviewQuestions).uniqueConstraints[0]?.name).toBe(
      "review_questions_brief_id_index_key",
    );
    expect(getTableConfig(briefComments).indexes[0]?.config.name).toBe("brief_comments_brief_idx");
    for (const table of [briefs, briefVersions, reviewQuestions, briefComments]) {
      expect(getTableConfig(table).foreignKeys[0]?.onDelete).toBe("cascade");
    }
  });

  it("maps project defaults for automation and user-scoped setup", () => {
    const projectColumns = getTableConfig(projects).columns;
    for (const name of ["auto_tour", "auto_suggest", "auto_name", "auto_land"]) {
      const column = projectColumns.find((candidate) => candidate.name === name);
      expect(column?.notNull, name).toBe(true);
      expect(column?.default, name).toBe("inherit");
    }
    for (const name of ["apply_dotfiles", "inherit_user_skills"]) {
      const column = projectColumns.find((candidate) => candidate.name === name);
      expect(column?.notNull, name).toBe(true);
      expect(column?.default, name).toBe(true);
    }
  });

  it("maps the session graph to the existing PostgreSQL table and column names", () => {
    expect(
      [
        projects,
        worktrees,
        contextSnapshots,
        agentSessions,
        sessionRuns,
        worktreeChanges,
        checkpoints,
      ].map((table) => getTableConfig(table).name),
    ).toEqual([
      "projects",
      "worktrees",
      "context_snapshots",
      "agent_sessions",
      "session_runs",
      "worktree_changes",
      "checkpoints",
    ]);

    expect(getTableConfig(agentSessions).columns.map((column) => column.name)).toEqual([
      "id",
      "project_id",
      "worktree_id",
      "harness",
      "provider_session_id",
      "label",
      "worktree",
      "branch",
      "base_sha",
      "base_ref",
      "context_snapshot_id",
      "reference_mounts",
      "extra_mounts",
      "sealant_run_id",
      "sealant_workspace_id",
      "sealant_session_id",
      "workspace_expires_at",
      "workspace_ttl_renewed_at",
      "workspace_ttl_renewal_failed_at",
      "workspace_ttl_renewal_error",
      "native_ingest_cursor",
      "workspace_image",
      "dotfiles",
      "owner_user_id",
      "origin",
      "auto_land",
      "shared_control_enabled_by_user_id",
      "shared_control_enabled_at",
      "has_transcript",
      "status",
      "summary",
      "last_seen_sequence",
      "record_history_complete",
      "started_at",
      "settled_at",
      "created_at",
      "updated_at",
    ]);
  });

  it("maps the worktree container: identity split, one change each, a dense chain", () => {
    const worktreeConfig = getTableConfig(worktrees);
    expect(worktreeConfig.columns.map((column) => column.name)).toEqual([
      "id",
      "project_id",
      "name",
      "directory",
      "branch",
      "base_sha",
      "base_ref",
      "created_at",
      "updated_at",
    ]);
    expect(
      worktreeConfig.uniqueConstraints.map((constraint) => constraint.name).toSorted(),
    ).toEqual(["worktrees_project_directory_key", "worktrees_project_name_key"]);

    // Sessions belong to a worktree; deleting the worktree takes its conversations.
    const sessionForeignKeys = getTableConfig(agentSessions).foreignKeys;
    const worktreeFk = sessionForeignKeys.find((fk) =>
      fk.reference().columns.some((column) => column.name === "worktree_id"),
    );
    expect(worktreeFk?.onDelete).toBe("cascade");

    // One change per worktree; the session pointer is a nullable mirror that
    // survives conversation deletion.
    const changeConfig = getTableConfig(worktreeChanges);
    const changeWorktreeColumn = changeConfig.columns.find(
      (column) => column.name === "worktree_id",
    );
    expect(changeWorktreeColumn?.isUnique).toBe(true);
    expect(changeConfig.columns.find((column) => column.name === "session_id")?.notNull).toBe(
      false,
    );
    const changeSessionFk = changeConfig.foreignKeys.find((fk) =>
      fk.reference().columns.some((column) => column.name === "session_id"),
    );
    expect(changeSessionFk?.onDelete).toBe("set null");

    // The checkpoint chain: dense per-worktree ordinals, session as provenance only.
    const checkpointConfig = getTableConfig(checkpoints);
    const ordinalIndex = checkpointConfig.indexes.find(
      (index) => index.config.name === "checkpoints_worktree_ordinal_idx",
    );
    expect(ordinalIndex?.config.unique).toBe(true);
    expect(checkpointConfig.columns.find((column) => column.name === "session_id")?.notNull).toBe(
      false,
    );
    const checkpointSessionFk = checkpointConfig.foreignKeys.find((fk) =>
      fk.reference().columns.some((column) => column.name === "session_id"),
    );
    expect(checkpointSessionFk?.onDelete).toBe("set null");
  });

  it("maps replay-stable protocol conversations and resumable item cursors", () => {
    expect(sessionProcesses.protocolOutputSeq.getSQLType()).toBe("bigint");

    expect(
      [agentTurns, agentItems, agentRequests].map((table) => getTableConfig(table).name),
    ).toEqual(["agent_turns", "agent_items", "agent_requests"]);
    const itemConfig = getTableConfig(agentItems);
    expect(itemConfig.uniqueConstraints.map((constraint) => constraint.name).toSorted()).toEqual([
      "agent_items_process_provider_key",
      "agent_items_session_seq_key",
    ]);
    expect(itemConfig.indexes.map((index) => index.config.name)).toEqual([
      "agent_items_session_seq_idx",
      "agent_items_turn_seq_idx",
    ]);
    expect(itemConfig.foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual([
      "cascade",
      "cascade",
      "cascade",
    ]);

    const turnIndexes = new Map(
      getTableConfig(agentTurns).indexes.map((index) => [index.config.name, index.config]),
    );
    expect(turnIndexes.get("agent_turns_session_provider_key")?.unique).toBe(true);
    expect(turnIndexes.get("agent_turns_one_running_process_idx")?.unique).toBe(true);
    expect(turnIndexes.get("agent_turns_one_running_process_idx")?.where).toBeDefined();
    for (const name of ["intent", "intent_source"]) {
      const column = getTableConfig(agentTurns).columns.find(
        (candidate) => candidate.name === name,
      );
      expect(column?.notNull, name).toBe(false);
    }

    const requestConfig = getTableConfig(agentRequests);
    expect(requestConfig.uniqueConstraints.map((constraint) => constraint.name)).toEqual([
      "agent_requests_process_provider_key",
    ]);
    expect(agentRequests.detail.getSQLType()).toBe("jsonb");
    expect(agentRequests.questions.getSQLType()).toBe("jsonb");
    expect(agentRequests.answers.getSQLType()).toBe("jsonb");
    expect(agentRequests.responseDelivery.default).toBe("none");
  });

  it("preserves run-local bigint cursors and the one-active-run invariant", () => {
    expect(sessionRuns.lastSeenSequence.getSQLType()).toBe("bigint");
    expect(checkpoints.seq.getSQLType()).toBe("bigint");

    const activeRunIndex = getTableConfig(sessionRuns).indexes.find(
      (candidate) => candidate.config.name === "session_runs_one_active_idx",
    );
    expect(activeRunIndex?.config.unique).toBe(true);
    expect(activeRunIndex?.config.where).toBeDefined();
  });

  it("maps project environment variables with ownership, uniqueness, and revisions", () => {
    const config = getTableConfig(projectEnvironmentVariables);
    expect(config.name).toBe("project_environment_variables");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "project_id",
      "name",
      "value",
      "revision",
      "created_at",
      "updated_at",
    ]);
    expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toEqual([
      "project_environment_variables_project_id_name_key",
    ]);
    // The aggregate revision rides the project row; mutations bump it under the row lock.
    const projectColumns = getTableConfig(projects).columns;
    expect(projectColumns.find((column) => column.name === "environment_revision")?.notNull).toBe(
      true,
    );
    // Session runs stamp the SAFE manifest — revision + names, both nullable (legacy/unknown).
    const runColumns = getTableConfig(sessionRuns).columns;
    expect(runColumns.find((column) => column.name === "environment_revision")?.notNull).toBe(
      false,
    );
    expect(
      runColumns.find((column) => column.name === "environment_variable_names")?.getSQLType(),
    ).toBe("jsonb");
  });

  it("maps project secrets as sealed rows with the same ownership/revision discipline", () => {
    const config = getTableConfig(projectSecrets);
    expect(config.name).toBe("project_secrets");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "project_id",
      "name",
      "sealed_value",
      "revision",
      "created_at",
      "updated_at",
    ]);
    // No plaintext column exists to leak into: the only value column is the sealed one.
    expect(config.columns.some((column) => column.name === "value")).toBe(false);
    expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toEqual([
      "project_secrets_project_id_name_key",
    ]);
    const projectColumns = getTableConfig(projects).columns;
    expect(projectColumns.find((column) => column.name === "secret_revision")?.notNull).toBe(true);
    const runColumns = getTableConfig(sessionRuns).columns;
    expect(runColumns.find((column) => column.name === "secret_names")?.getSQLType()).toBe("jsonb");
  });

  it("maps Slack installs with sealed tokens only, and the keys that tie links to one workspace", () => {
    const installs = getTableConfig(slackInstalls);
    expect(installs.name).toBe("slack_installs");
    // No plaintext column exists to leak into: the only token columns are the sealed ones.
    expect(
      installs.columns.filter((column) => column.name.includes("token")).map((c) => c.name),
    ).toEqual(["sealed_app_token", "sealed_bot_token"]);
    expect(installs.uniqueConstraints.map((constraint) => constraint.name)).toEqual([
      "slack_installs_team_id_key",
      "slack_installs_organization_team_key",
    ]);
    for (const [name, value] of [
      ["default_harness", "claude"],
      ["show_agent_messages", true],
      ["show_diffs", false],
      ["external_channels", false],
      ["land_automatically", true],
    ] as const) {
      expect(installs.columns.find((column) => column.name === name)?.default, name).toBe(value);
    }
    const origin = getTableConfig(agentSessions).columns.find((column) => column.name === "origin");
    expect(origin?.notNull).toBe(true);
    expect(origin?.default).toBe("mend");

    const links = getTableConfig(slackLinks);
    expect(links.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "team_id",
      "slack_user_id",
    ]);
    expect(links.uniqueConstraints.map((constraint) => constraint.name)).toEqual([
      "slack_links_team_user_key",
    ]);
    expect(
      links.foreignKeys.map((foreignKey) => [foreignKey.getName(), foreignKey.onDelete]),
    ).toEqual([
      ["slack_links_install_fkey", "cascade"],
      ["slack_links_member_fkey", "cascade"],
    ]);
    expect(getTableConfig(slackLinkCodes).columns.map((column) => column.name)).toEqual([
      "code_hash",
      "team_id",
      "slack_user_id",
      "request",
      "expires_at",
      "used_at",
      "created_at",
    ]);
    for (const table of [slackLinkCodes, slackChannelDefaults]) {
      expect(getTableConfig(table).foreignKeys[0]?.onDelete).toBe("cascade");
    }
    expect(
      getTableConfig(slackChannelDefaults).primaryKeys[0]?.columns.map((column) => column.name),
    ).toEqual(["team_id", "channel_id"]);
    expect(getTableConfig(slackUserDefaults).columns[0]?.primary).toBe(true);
  });

  it("maps Slack threads one session each, many to a thread, and claims by event id", () => {
    const threads = getTableConfig(slackThreads);
    expect(threads.columns.map((column) => column.name)).toEqual([
      "session_id",
      "team_id",
      "channel_id",
      "thread_ts",
      "request_ts",
      "status_ts",
      "slack_user_id",
      "project_source",
      "external",
      "reported_state",
      "reported_status",
      "created_at",
    ]);
    expect(threads.columns[0]?.primary).toBe(true);
    expect(threads.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(threads.indexes[0]?.config.name).toBe("slack_threads_thread_idx");
    const posts = getTableConfig(slackThreadPosts);
    expect(posts.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "session_id",
      "key",
    ]);
    expect(posts.foreignKeys[0]?.onDelete).toBe("cascade");
    const claims = getTableConfig(slackEventClaims);
    expect(claims.columns[0]?.name).toBe("event_id");
    expect(claims.columns[0]?.primary).toBe(true);
    expect(claims.indexes[0]?.config.name).toBe("slack_event_claims_claimed_at_idx");
  });

  it("matches project mount ownership and uniqueness constraints", () => {
    const config = getTableConfig(projectMounts);
    expect(config.name).toBe("project_mounts");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "project_id",
      "name",
      "host_path",
      "read_only",
      "created_at",
      "updated_at",
    ]);
    expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(config.uniqueConstraints.map((constraint) => constraint.name).toSorted()).toEqual([
      "project_mounts_project_id_host_path_key",
      "project_mounts_project_id_name_key",
    ]);
  });

  it("maps reference repositories and per-project selection", () => {
    const referenceConfig = getTableConfig(referenceRepos);
    expect(referenceConfig.name).toBe("reference_repos");
    expect(referenceConfig.columns.map((column) => column.name)).toEqual([
      "id",
      "name",
      "organization_id",
      "created_by_user_id",
      "origin_url",
      "path",
      "pinned_ref",
      "head_sha",
      "refreshed_at",
      "created_at",
      "updated_at",
    ]);
    // Names are unique within an organization (docs/adr/0003); clone paths across the instance.
    expect(referenceConfig.columns[1]?.isUnique).toBe(false);
    expect(referenceConfig.uniqueConstraints.map((constraint) => constraint.name)).toEqual([
      "reference_repos_organization_name_key",
    ]);
    expect(referenceConfig.columns[5]?.isUnique).toBe(true);

    const selectionConfig = getTableConfig(projectReferences);
    expect(selectionConfig.name).toBe("project_references");
    expect(selectionConfig.columns.map((column) => column.name)).toEqual([
      "project_id",
      "reference_id",
      "created_at",
    ]);
    expect(selectionConfig.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "project_id",
      "reference_id",
    ]);
    expect(selectionConfig.foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual([
      "cascade",
      "cascade",
    ]);
  });

  it("maps the singleton settings document without changing its migration shape", () => {
    const config = getTableConfig(settings);
    expect(config.name).toBe("settings");
    expect(config.columns.map((column) => column.name)).toEqual(["key", "value", "updated_at"]);
    expect(config.columns[0]?.primary).toBe(true);
    expect(config.columns[1]?.getSQLType()).toBe("jsonb");
  });

  it("separates stable Services, attempts, forwards, and observations", () => {
    expect(
      [services, sessionProcesses, serviceForwards, serviceObservations].map(
        (table) => getTableConfig(table).name,
      ),
    ).toEqual(["services", "session_processes", "service_forwards", "service_observations"]);

    const serviceConfig = getTableConfig(services);
    expect(serviceConfig.columns.map((column) => column.name)).toContain("current_attempt_id");
    expect(serviceConfig.columns.map((column) => column.name)).toContain("current_forward_id");
    expect(serviceConfig.columns.find((column) => column.name === "bind_addresses")?.notNull).toBe(
      false,
    );
    expect(serviceConfig.foreignKeys[0]?.onDelete).toBe("cascade");

    const attemptConfig = getTableConfig(sessionProcesses);
    expect(attemptConfig.columns.map((column) => column.name)).toContain("service_id");
    expect(attemptConfig.columns.map((column) => column.name)).toContain("attempt_ordinal");
    const attemptIndexes = new Map(
      attemptConfig.indexes.map((index) => [index.config.name, index.config]),
    );
    expect(attemptIndexes.get("session_processes_service_ordinal_idx")?.unique).toBe(true);
    expect(attemptIndexes.get("session_processes_one_live_service_attempt_idx")?.unique).toBe(true);
    expect(
      attemptIndexes.get("session_processes_one_live_service_attempt_idx")?.where,
    ).toBeDefined();

    const forwardConfig = getTableConfig(serviceForwards);
    expect(forwardConfig.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(forwardConfig.columns.map((column) => column.name)).toContain("supersedes_forward_id");

    const observationConfig = getTableConfig(serviceObservations);
    expect(observationConfig.foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual([
      "cascade",
      "cascade",
    ]);
    expect(observationConfig.columns.map((column) => column.name)).toContain("first_observed_at");
    expect(observationConfig.columns.map((column) => column.name)).toContain("last_observed_at");

    expect(getTableConfig(projectServiceRecipes).columns.map((column) => column.name)).toContain(
      "browser_scheme",
    );
  });

  it("maps the append-only inference audit record", () => {
    const config = getTableConfig(inferenceCalls);
    expect(config.name).toBe("inference_calls");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "context",
      "tool",
      "input",
      "output",
      "occurred_at",
    ]);
    expect(config.columns[3]?.getSQLType()).toBe("jsonb");
    expect(config.columns[4]?.getSQLType()).toBe("jsonb");
  });

  it("maps push device identity and activity timestamps", () => {
    const config = getTableConfig(pushDevices);
    expect(config.name).toBe("push_devices");
    expect(config.columns.map((column) => column.name)).toEqual([
      "token",
      "platform",
      "user_id",
      "created_at",
      "last_seen_at",
    ]);
    expect(config.columns[0]?.primary).toBe(true);
  });

  it("maps immutable follow-up input, idempotency, and delivery correlation", () => {
    const config = getTableConfig(followUps);
    expect(config.name).toBe("follow_ups");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "session_id",
      "change_id",
      "review_slice_id",
      "checkpoint_a_id",
      "checkpoint_b_id",
      "diff_digest",
      "comment_ids",
      "idempotency_key",
      "instruction",
      "status",
      "delivery_process_id",
      "delivery_sealant_run_id",
      "delivery_error",
      "delivery_started_at",
      "delivery_attempt_id",
      "delivery_lease_expires_at",
      "created_at",
      "delivered_at",
    ]);
    expect(config.foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual([
      "cascade",
      "cascade",
      "set null",
    ]);
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "follow_ups_session_idx",
      "follow_ups_session_key_idx",
    ]);
  });

  it("maps review comment anchors, evidence, and notification ownership", () => {
    const config = getTableConfig(reviewComments);
    expect(config.name).toBe("review_comments");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "change_id",
      "file",
      "line",
      "author_kind",
      "author_name",
      "body",
      "state",
      "sent_to_session_id",
      "created_at",
      "updated_at",
      "end_line",
      "evidence",
      "kind",
      "suggestion",
      "anchor",
    ]);
    expect(config.columns[12]?.getSQLType()).toBe("jsonb");
    expect(config.columns[15]?.getSQLType()).toBe("jsonb");
    expect(config.foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual([
      "cascade",
      "set null",
    ]);
    expect(config.indexes[0]?.config.name).toBe("review_comments_change_idx");
  });

  it("maps immutable Review slices and idempotency", () => {
    const config = getTableConfig(reviewSlices);
    expect(config.name).toBe("review_slices");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "change_id",
      "checkpoint_a_id",
      "checkpoint_b_id",
      "diff_digest",
      "idempotency_key",
      "created_at",
    ]);
    expect(config.foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual([
      "cascade",
      "cascade",
      "cascade",
    ]);
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "review_slices_change_key_idx",
      "review_slices_change_created_idx",
    ]);
    expect(config.indexes[0]?.config.unique).toBe(true);
  });

  it("maps one composed tour per change with encoded stops", () => {
    const config = getTableConfig(changeTours);
    expect(config.name).toBe("change_tours");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "change_id",
      "session_id",
      "summary",
      "approach",
      "stops",
      "diff_digest",
      "created_at",
    ]);
    expect(config.columns[5]?.getSQLType()).toBe("jsonb");
    expect(config.columns[1]?.isUnique).toBe(true);
    // Tour attribution survives the composing session's deletion (worktree pivot).
    expect(config.foreignKeys.map((foreignKey) => foreignKey.onDelete)).toEqual([
      "cascade",
      "set null",
    ]);
  });

  it("maps one machine-pass outcome per change and kind", () => {
    const config = getTableConfig(changePasses);
    expect(config.name).toBe("change_passes");
    expect(config.columns.map((column) => column.name)).toEqual([
      "change_id",
      "kind",
      "status",
      "detail",
      "findings",
      "started_at",
      "finished_at",
    ]);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "change_id",
      "kind",
    ]);
    expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
  });

  it("maps change landings: gone with the change, kept past their session and checkpoint", () => {
    const config = getTableConfig(changeLandings);
    expect(config.name).toBe("change_landings");
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "change_id",
      "session_id",
      "project_id",
      "checkpoint_id",
      "checkpoint_ref",
      "checkpoint_sha",
      "commit_sha",
      "remote_branch",
      "pushed_sha",
      "trigger",
      "pull_request_number",
      "pull_request_url",
      "pull_request_state",
      "pr_observed_at",
      "outcome",
      "message",
      "user_id",
      "described_tour_id",
      "created_at",
    ]);
    expect(
      config.foreignKeys.map((foreignKey) => [
        foreignKey.reference().columns[0]?.name,
        foreignKey.onDelete,
      ]),
    ).toEqual([
      ["change_id", "cascade"],
      ["session_id", "set null"],
      ["project_id", "cascade"],
      ["checkpoint_id", "set null"],
    ]);
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "change_landings_change_created_idx",
      "change_landings_session_idx",
    ]);
  });

  it("keeps destructive ownership and nullable evidence links explicit", () => {
    const sessionForeignKeys = getTableConfig(agentSessions).foreignKeys;
    const projectForeignKey = sessionForeignKeys.find(
      (foreignKey) => foreignKey.reference().columns[0]?.name === "project_id",
    );
    const snapshotForeignKey = sessionForeignKeys.find(
      (foreignKey) => foreignKey.reference().columns[0]?.name === "context_snapshot_id",
    );
    const checkpointRunForeignKey = getTableConfig(checkpoints).foreignKeys.find(
      (foreignKey) => foreignKey.reference().columns[0]?.name === "sealant_run_id",
    );

    expect(projectForeignKey?.onDelete).toBe("cascade");
    expect(snapshotForeignKey?.onDelete).toBe("set null");
    expect(checkpointRunForeignKey?.onDelete).toBe("set null");
  });
});
