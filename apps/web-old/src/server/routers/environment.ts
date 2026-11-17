import {
  ClusterBindingDuplicate,
  ClusterBindingRejected,
  ClusterBindingRequest,
  ClusterServiceAccountRequest,
  EnvironmentLoadRequest,
  EnvironmentRejected,
  EnvironmentStaleWrite,
  ProjectEnvironmentVariableRemoveRequest,
  ProjectEnvironmentVariableRequest,
  ProjectEnvironmentVariableUpdateRequest,
  ProjectSecretRemoveRequest,
  ProjectSecretRequest,
  ProjectSecretUpdateRequest,
} from "@mend/api-contracts";
import {
  ProjectClusterBindingId,
  ProjectId,
  ProjectEnvironmentVariableId,
  ProjectSecretId,
} from "@mend/domain";
import { Effect, Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byProject = input(Schema.Struct({ projectId: ProjectId }));

/**
 * Project environment · secrets. 422/409 are OUTCOMES here, not transport
 * errors: the UI keeps drafts on a stale write and shows per-field issues on
 * a rejection, so writes return a discriminated union — the contract's own
 * typed failures caught by tag, never a status code parsed by hand.
 */
const outcome = <A, E>(effect: Effect.Effect<A, E | EnvironmentRejected | EnvironmentStaleWrite>) =>
  effect.pipe(
    Effect.map((result) => ({ ok: true as const, result })),
    Effect.catchIf(
      (error): error is EnvironmentRejected => error instanceof EnvironmentRejected,
      (rejected) =>
        Effect.succeed({ ok: false as const, kind: "rejected" as const, issues: rejected.issues }),
    ),
    Effect.catchIf(
      (error): error is EnvironmentStaleWrite => error instanceof EnvironmentStaleWrite,
      (stale) =>
        Effect.succeed({
          ok: false as const,
          kind: "stale" as const,
          currentRevision: stale.currentRevision,
        }),
    ),
  );

/**
 * Cluster-binding writes: same outcome discipline — 422 (grammar/limit) and 409 (duplicate) keep
 * the caller's draft alive as structured outcomes, never thrown transport errors.
 */
const bindingOutcome = <A, E>(
  effect: Effect.Effect<A, E | ClusterBindingRejected | ClusterBindingDuplicate>,
) =>
  effect.pipe(
    Effect.map((result) => ({ ok: true as const, result })),
    Effect.catchIf(
      (error): error is ClusterBindingRejected => error instanceof ClusterBindingRejected,
      (rejected) =>
        Effect.succeed({
          ok: false as const,
          kind: "rejected" as const,
          message: rejected.message,
        }),
    ),
    Effect.catchIf(
      (error): error is ClusterBindingDuplicate => error instanceof ClusterBindingDuplicate,
      (duplicate) =>
        Effect.succeed({
          ok: false as const,
          kind: "duplicate" as const,
          binding: `${duplicate.kind}/${duplicate.objectName}`,
        }),
    ),
  );

export const environmentRouter = router({
  environment: procedure
    .input(byProject)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectEnvironment.get({ params: { id: i.projectId } })),
    ),
  createVariable: procedure
    .input(
      input(Schema.Struct({ projectId: ProjectId, request: ProjectEnvironmentVariableRequest })),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        outcome(api.projectEnvironment.create({ params: { id: i.projectId }, payload: i.request })),
      ),
    ),
  updateVariable: procedure
    .input(
      input(
        Schema.Struct({
          projectId: ProjectId,
          variableId: ProjectEnvironmentVariableId,
          request: ProjectEnvironmentVariableUpdateRequest,
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        outcome(
          api.projectEnvironment.update({
            params: { id: i.projectId, variableId: i.variableId },
            payload: i.request,
          }),
        ),
      ),
    ),
  removeVariable: procedure
    .input(
      input(
        Schema.Struct({
          projectId: ProjectId,
          variableId: ProjectEnvironmentVariableId,
          request: ProjectEnvironmentVariableRemoveRequest,
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        outcome(
          api.projectEnvironment.remove({
            params: { id: i.projectId, variableId: i.variableId },
            payload: i.request,
          }),
        ),
      ),
    ),
  secrets: procedure
    .input(byProject)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectSecrets.get({ params: { id: i.projectId } })),
    ),
  createSecret: procedure
    .input(input(Schema.Struct({ projectId: ProjectId, request: ProjectSecretRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        outcome(api.projectSecrets.create({ params: { id: i.projectId }, payload: i.request })),
      ),
    ),
  updateSecret: procedure
    .input(
      input(
        Schema.Struct({
          projectId: ProjectId,
          secretId: ProjectSecretId,
          request: ProjectSecretUpdateRequest,
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        outcome(
          api.projectSecrets.update({
            params: { id: i.projectId, secretId: i.secretId },
            payload: i.request,
          }),
        ),
      ),
    ),
  removeSecret: procedure
    .input(
      input(
        Schema.Struct({
          projectId: ProjectId,
          secretId: ProjectSecretId,
          request: ProjectSecretRemoveRequest,
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        outcome(
          api.projectSecrets.remove({
            params: { id: i.projectId, secretId: i.secretId },
            payload: i.request,
          }),
        ),
      ),
    ),
  clusterBindings: procedure
    .input(byProject)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectClusterBindings.get({ params: { id: i.projectId } })),
    ),
  addClusterBinding: procedure
    .input(input(Schema.Struct({ projectId: ProjectId, request: ClusterBindingRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        bindingOutcome(
          api.projectClusterBindings.add({ params: { id: i.projectId }, payload: i.request }),
        ),
      ),
    ),
  removeClusterBinding: procedure
    .input(input(Schema.Struct({ projectId: ProjectId, bindingId: ProjectClusterBindingId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.projectClusterBindings.remove({
          params: { id: i.projectId, bindingId: i.bindingId },
        }),
      ),
    ),
  setClusterServiceAccount: procedure
    .input(input(Schema.Struct({ projectId: ProjectId, request: ClusterServiceAccountRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        bindingOutcome(
          api.projectClusterBindings.setServiceAccount({
            params: { id: i.projectId },
            payload: i.request,
          }),
        ),
      ),
    ),
  load: procedure
    .input(input(Schema.Struct({ projectId: ProjectId, request: EnvironmentLoadRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.projectEnvironment.load({ params: { id: i.projectId }, payload: i.request }),
      ),
    ),
});
