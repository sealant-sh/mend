import {
  findWorkspaceEnvReservedRule,
  WORKSPACE_ENV_MAX_ENTRIES,
  WORKSPACE_ENV_MAX_NAME_LENGTH,
  WORKSPACE_ENV_MAX_TOTAL_BYTES,
  WORKSPACE_ENV_MAX_VALUE_BYTES,
  WORKSPACE_ENV_NAME_PATTERN,
  type WorkspaceEnvReservedRule,
} from "@sealant/api-contracts/workspace-environment";
import { Schema } from "effect";

import { ProjectEnvironmentVariableId, ProjectId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * A project-owned, explicitly NON-SECRET environment name/value pair (plan:
 * `docs/archive/plans/project-environment-variables.md`). Values are ordinary configuration, persisted and
 * returned as plaintext by design; the UI states this before creation. Each fresh workspace launch
 * reads the project's complete current set once and passes it at workspace creation — a live
 * workspace never changes.
 */
export class ProjectEnvironmentVariable extends Schema.Class<ProjectEnvironmentVariable>(
  "ProjectEnvironmentVariable",
)({
  id: ProjectEnvironmentVariableId,
  projectId: ProjectId,
  name: Schema.String,
  value: Schema.String,
  /** Integer row revision; stale-write checks compare against it, timestamps are display-only. */
  revision: Schema.Int,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/**
 * The immutable set resolved for one read: the project's aggregate revision plus its variables in
 * name order. Launch resolves exactly one snapshot per fresh workspace; the settings page shows
 * the same shape.
 */
export class ProjectEnvironmentSnapshot extends Schema.Class<ProjectEnvironmentSnapshot>(
  "ProjectEnvironmentSnapshot",
)({
  revision: Schema.Int,
  variables: Schema.Array(ProjectEnvironmentVariable),
}) {}

// ── Validation ───────────────────────────────────────────────────────────────
//
// The platform policy (grammar, bounds, reserved and secret-marker names) is Sealant's public
// contract, imported from `@sealant/api-contracts/workspace-environment` — the exact module the
// control plane parses `runtime.userEnv` with, re-exported by `@sealant/sdk`. Mend composes ONE
// additional local rule on top: the `MEND_` prefix is reserved for Mend itself.

export const PROJECT_ENV_NAME_PATTERN = WORKSPACE_ENV_NAME_PATTERN;
export const PROJECT_ENV_MAX_NAME_LENGTH = WORKSPACE_ENV_MAX_NAME_LENGTH;
export const PROJECT_ENV_MAX_VALUE_BYTES = WORKSPACE_ENV_MAX_VALUE_BYTES;
export const PROJECT_ENV_MAX_ENTRIES = WORKSPACE_ENV_MAX_ENTRIES;
export const PROJECT_ENV_MAX_TOTAL_BYTES = WORKSPACE_ENV_MAX_TOTAL_BYTES;

/** Why one submitted name/value was refused. Diagnostics never carry values. */
export type ProjectEnvironmentIssue =
  | { readonly rule: "name-grammar" }
  | { readonly rule: "name-length" }
  | { readonly rule: "name-reserved"; readonly reservedRule: WorkspaceEnvReservedRule }
  | { readonly rule: "name-mend-prefix" }
  | { readonly rule: "value-nul" }
  | { readonly rule: "value-size"; readonly valueBytes: number };

export const validateProjectEnvironmentName = (name: string): ProjectEnvironmentIssue | null => {
  if (!PROJECT_ENV_NAME_PATTERN.test(name)) return { rule: "name-grammar" };
  if (name.length > PROJECT_ENV_MAX_NAME_LENGTH) return { rule: "name-length" };
  // Mend's own namespace: reserved locally, deliberately NOT part of Sealant's generic policy.
  if (name.toUpperCase().startsWith("MEND_")) return { rule: "name-mend-prefix" };
  const reservedRule = findWorkspaceEnvReservedRule(name);
  if (reservedRule !== undefined) return { rule: "name-reserved", reservedRule };
  return null;
};

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** Empty is a valid value ("set to empty"); NUL and oversize are not. */
export const validateProjectEnvironmentValue = (value: string): ProjectEnvironmentIssue | null => {
  if (value.includes("\u0000")) return { rule: "value-nul" };
  const valueBytes = utf8Bytes(value);
  if (valueBytes > PROJECT_ENV_MAX_VALUE_BYTES) return { rule: "value-size", valueBytes };
  return null;
};

/** Total encoded budget of a would-be aggregate, for the per-project byte limit. */
export const projectEnvironmentBytes = (
  entries: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): number =>
  entries.reduce((total, entry) => total + entry.name.length + utf8Bytes(entry.value), 0);

/** Human wording for one issue — same text server- and client-side, never a value. */
export const formatProjectEnvironmentIssue = (issue: ProjectEnvironmentIssue): string => {
  switch (issue.rule) {
    case "name-grammar":
      return "Names must start with a letter or underscore and contain only letters, digits, and underscores.";
    case "name-length":
      return `Names must be at most ${PROJECT_ENV_MAX_NAME_LENGTH} characters.`;
    case "name-mend-prefix":
      return "The MEND_ prefix is reserved for Mend itself.";
    case "name-reserved":
      return issue.reservedRule === "secret-marker"
        ? "Secret-looking names (containing TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL, or APIKEY, ending in _KEY, or exactly KEY) are not supported: the workspace runtime filters them out, so the variable would silently never reach any process. Environment variables here are for ordinary non-secret configuration."
        : "This name is owned by the platform or controls process startup, and cannot be set per project.";
    case "value-nul":
      return "Values cannot contain NUL characters.";
    case "value-size":
      return `Values can be at most ${PROJECT_ENV_MAX_VALUE_BYTES} bytes (${issue.valueBytes} submitted).`;
  }
};
