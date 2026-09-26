import { findWorkspaceSecretEnvReservedRule } from "@sealant/api-contracts/workspace-environment";
import { Schema } from "effect";

import { ProjectId, ProjectSecretId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import {
  PROJECT_ENV_MAX_NAME_LENGTH,
  PROJECT_ENV_NAME_PATTERN,
  validateProjectEnvironmentName,
  validateProjectEnvironmentValue,
  type ProjectEnvironmentIssue,
} from "./project-environment.ts";

/**
 * A project-owned SECRET environment variable (`docs/archive/plans/project-environment-variables.md`, "Scope
 * expansion"): the half of a real `.env` that the plaintext Configuration set refuses. Mend
 * stores the value encrypted at rest with a machine-local key and never returns it through the
 * API; at each fresh workspace launch the current set is decrypted once and handed to Sealant's
 * transient secret channel (`CreateOptions.secretEnv`), which never persists it, keeps it out of
 * container env and `docker inspect`, and masks it in captured output.
 */
export class ProjectSecret extends Schema.Class<ProjectSecret>("ProjectSecret")({
  id: ProjectSecretId,
  projectId: ProjectId,
  name: Schema.String,
  /** Integer row revision; stale-write checks compare against it. The value never appears. */
  revision: Schema.Int,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** The project's secrets as the API shows them: names + revisions only, never values. */
export class ProjectSecretsSnapshot extends Schema.Class<ProjectSecretsSnapshot>(
  "ProjectSecretsSnapshot",
)({
  revision: Schema.Int,
  secrets: Schema.Array(ProjectSecret),
}) {}

/**
 * Secret names: same grammar/length as Configuration names, same `MEND_` reservation, and the
 * platform's SECRET-lane policy — every platform-owned class stays reserved, but secret-shaped
 * names are exactly what belongs here.
 */
export const validateProjectSecretName = (name: string): ProjectEnvironmentIssue | null => {
  if (!PROJECT_ENV_NAME_PATTERN.test(name)) return { rule: "name-grammar" };
  if (name.length > PROJECT_ENV_MAX_NAME_LENGTH) return { rule: "name-length" };
  if (name.toUpperCase().startsWith("MEND_")) return { rule: "name-mend-prefix" };
  const reservedRule = findWorkspaceSecretEnvReservedRule(name);
  if (reservedRule !== undefined) return { rule: "name-reserved", reservedRule };
  return null;
};

/** Secret values share the Configuration bounds (empty allowed, NUL and >4 KiB refused). */
export const validateProjectSecretValue = validateProjectEnvironmentValue;

/**
 * Where a dotenv entry belongs by NAME alone: names the plaintext lane accepts are configuration;
 * names it refuses only for looking secret are secrets. Anything else is rejected outright.
 * Never inspects the value — value sniffing is exactly the false assurance the plan forbids.
 */
export type DotenvRoute =
  | { readonly lane: "configuration" }
  | { readonly lane: "secret" }
  | { readonly lane: "rejected"; readonly issue: ProjectEnvironmentIssue };

export const routeDotenvName = (name: string): DotenvRoute => {
  const plain = validateProjectEnvironmentName(name);
  if (plain === null) return { lane: "configuration" };
  if (plain.rule === "name-reserved" && plain.reservedRule === "secret-marker") {
    const secret = validateProjectSecretName(name);
    return secret === null ? { lane: "secret" } : { lane: "rejected", issue: secret };
  }
  return { lane: "rejected", issue: plain };
};
