import {
  findWorkspaceSecretEnvReservedRule,
  providerLoginEnvNames,
} from "@sealant/api-contracts/workspace-environment";
import { Record, Schema } from "effect";

import { ProjectId, ProjectSecretId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { CREDENTIAL_PROVIDER_LABELS } from "./default-login.ts";
import {
  PROJECT_ENV_MAX_NAME_LENGTH,
  PROJECT_ENV_NAME_PATTERN,
  validateProjectEnvironmentName,
  validateProjectEnvironmentValue,
  type ProjectEnvironmentIssue,
  type ProviderLoginProvider,
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

const providerLoginByName: ReadonlyMap<string, ProviderLoginProvider> = new Map(
  Record.toEntries(providerLoginEnvNames).flatMap(([provider, names]) =>
    names.map((name) => [name, provider] as const),
  ),
);

/**
 * Secret names: same grammar/length as Configuration names, same `MEND_` reservation, and the
 * platform's SECRET-lane policy — every platform-owned class stays reserved, but secret-shaped
 * names are exactly what belongs here.
 */
export const validateProjectSecretName = (name: string): ProjectEnvironmentIssue | null => {
  if (!PROJECT_ENV_NAME_PATTERN.test(name)) return { rule: "name-grammar" };
  if (name.length > PROJECT_ENV_MAX_NAME_LENGTH) return { rule: "name-length" };
  const upper = name.toUpperCase();
  if (upper.startsWith("MEND_")) return { rule: "name-mend-prefix" };
  const provider = providerLoginByName.get(upper);
  if (provider !== undefined) return { rule: "name-provider-login", name, provider };
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
  if (validateProjectEnvironmentName(name) === null) return { lane: "configuration" };
  const issue = validateProjectSecretName(name);
  return issue === null ? { lane: "secret" } : { lane: "rejected", issue };
};

/**
 * Words for a secret stored under a provider login name before Mend refused those names, or null.
 * The row stays as it was; the words ask its owner to rename or remove it.
 */
export const storedSecretNameRefusal = (name: string): string | null => {
  const issue = validateProjectSecretName(name);
  if (issue === null || issue.rule !== "name-provider-login") return null;
  const label = CREDENTIAL_PROVIDER_LABELS[issue.provider];
  return `${issue.name} is a ${label} login, and Mend no longer takes it as a project secret. This one was stored before; rename or remove it, and connect your ${label} login in Settings → Connected accounts.`;
};
