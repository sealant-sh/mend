import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "../server/routers/index.ts";
import { currentTrpcClient, orLogin } from "./trpc.ts";

/**
 * Imperative writes + view types for the project-environment group. The
 * shapes are the contract's Type side; 422/409 arrive as structured OUTCOMES
 * — the discriminated unions the router builds from the contract's own typed
 * failures — because the UI keeps drafts on a stale write and shows
 * per-field issues on a rejection. Reads (environment/secrets snapshots) go
 * through the tRPC options proxy like every other query.
 */

type Outputs = inferRouterOutputs<AppRouter>;

export type ProjectEnvironmentSnapshotView = Outputs["environment"]["environment"];
export type ProjectEnvironmentVariableView = ProjectEnvironmentSnapshotView["variables"][number];

type EnvironmentWriteOutcome = Outputs["environment"]["createVariable"];
export type ProjectEnvironmentWriteResult = EnvironmentWriteOutcome;
export type ProjectEnvironmentMutationView = Extract<
  EnvironmentWriteOutcome,
  { ok: true }
>["result"];
export type EnvironmentIssueView = Extract<
  EnvironmentWriteOutcome,
  { kind: "rejected" }
>["issues"][number];

export type ProjectSecretsSnapshotView = Outputs["environment"]["secrets"];
export type ProjectSecretView = ProjectSecretsSnapshotView["secrets"][number];

type SecretWriteOutcome = Outputs["environment"]["createSecret"];
export type ProjectSecretWriteResult = SecretWriteOutcome;
export type ProjectSecretMutationView = Extract<SecretWriteOutcome, { ok: true }>["result"];

export type EnvironmentLoadReportView = Outputs["environment"]["load"];

export type ProjectClusterBindingsSnapshotView = Outputs["environment"]["clusterBindings"];
export type ProjectClusterBindingView = ProjectClusterBindingsSnapshotView["bindings"][number];

type ClusterBindingWriteOutcome = Outputs["environment"]["addClusterBinding"];
export type ClusterBindingWriteResult = ClusterBindingWriteOutcome;

export const createProjectEnvironmentVariable = (
  projectId: string,
  input: { readonly name: string; readonly value: string },
) => orLogin(currentTrpcClient().environment.createVariable.mutate({ projectId, request: input }));

/** Value edit and rename are the same atomic call on the same stable ID. */
export const updateProjectEnvironmentVariable = (
  projectId: string,
  variableId: string,
  input: { readonly name: string; readonly value: string; readonly expectedRevision: number },
) =>
  orLogin(
    currentTrpcClient().environment.updateVariable.mutate({
      projectId,
      variableId,
      request: input,
    }),
  );

export const removeProjectEnvironmentVariable = (
  projectId: string,
  variableId: string,
  expectedRevision: number,
) =>
  orLogin(
    currentTrpcClient().environment.removeVariable.mutate({
      projectId,
      variableId,
      request: { expectedRevision },
    }),
  );

export const createProjectSecret = (
  projectId: string,
  input: { readonly name: string; readonly value: string },
) => orLogin(currentTrpcClient().environment.createSecret.mutate({ projectId, request: input }));

/** `value: null` keeps the stored value (pure rename); a string replaces it. */
export const updateProjectSecret = (
  projectId: string,
  secretId: string,
  input: {
    readonly name: string;
    readonly value: string | null;
    readonly expectedRevision: number;
  },
) =>
  orLogin(
    currentTrpcClient().environment.updateSecret.mutate({ projectId, secretId, request: input }),
  );

export const removeProjectSecret = (
  projectId: string,
  secretId: string,
  expectedRevision: number,
) =>
  orLogin(
    currentTrpcClient().environment.removeSecret.mutate({
      projectId,
      secretId,
      request: { expectedRevision },
    }),
  );

/** Cluster bindings carry NAMES only — nothing in a request or response is ever a value. */
export const addProjectClusterBinding = (
  projectId: string,
  input: { readonly kind: "secret" | "configmap"; readonly objectName: string },
) =>
  orLogin(currentTrpcClient().environment.addClusterBinding.mutate({ projectId, request: input }));

export const removeProjectClusterBinding = (projectId: string, bindingId: string) =>
  orLogin(currentTrpcClient().environment.removeClusterBinding.mutate({ projectId, bindingId }));

/** `null` clears the workspace ServiceAccount trust grant. */
export const setProjectClusterServiceAccount = (projectId: string, serviceAccount: string | null) =>
  orLogin(
    currentTrpcClient().environment.setClusterServiceAccount.mutate({
      projectId,
      request: { serviceAccount },
    }),
  );

/**
 * Post raw dotenv text; the server parses, routes each name (Configuration or Secrets), upserts,
 * and reports per name. The text crosses this request only — nothing in the response is a value.
 */
export const loadProjectEnvironment = (
  projectId: string,
  input: {
    readonly contents: string;
    readonly allSecret: boolean;
    readonly secretNames: ReadonlyArray<string>;
  },
) => orLogin(currentTrpcClient().environment.load.mutate({ projectId, request: input }));
