import {
  AccessPolicyBuiltIn,
  AccessPolicyNameTaken,
  AccessPolicyNotApplied,
  AccessPolicyOwnersOnly,
  AccessPolicyRejected,
  AccessPolicyStaleWrite,
  AssignAccessPolicyRequest,
  CreateAccessPolicyRequest,
  RevokeAccessRequest,
  UpdateAccessPolicyRequest,
} from "@mend/api-contracts";
import { AccessPolicyId, ProjectId, WorktreeId } from "@mend/domain";
import { Effect, Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** Every Access policy refusal a page lays out itself instead of showing as a failure. */
type PolicyRefusalError =
  | AccessPolicyRejected
  | AccessPolicyNameTaken
  | AccessPolicyStaleWrite
  | AccessPolicyBuiltIn
  | AccessPolicyOwnersOnly
  | AccessPolicyNotApplied;

/**
 * A refusal as the page reads it: which one, the server's sentence, and for a rejection every
 * problem it listed; for a stale write, the revision the policy has now.
 */
export type PolicyRefusal =
  | {
      readonly ok: false;
      readonly kind: "rejected";
      readonly message: string;
      readonly problems: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      readonly kind: "stale";
      readonly message: string;
      readonly revision: number;
    }
  | {
      readonly ok: false;
      readonly kind: "name-taken" | "built-in" | "owners-only" | "not-applied";
      readonly message: string;
    };

const isPolicyRefusal = (error: unknown): error is PolicyRefusalError =>
  error instanceof AccessPolicyRejected ||
  error instanceof AccessPolicyNameTaken ||
  error instanceof AccessPolicyStaleWrite ||
  error instanceof AccessPolicyBuiltIn ||
  error instanceof AccessPolicyOwnersOnly ||
  error instanceof AccessPolicyNotApplied;

export const policyRefusalOf = (error: PolicyRefusalError): PolicyRefusal => {
  if (error instanceof AccessPolicyRejected)
    return { ok: false, kind: "rejected", message: error.message, problems: error.problems };
  if (error instanceof AccessPolicyStaleWrite)
    return { ok: false, kind: "stale", message: error.message, revision: error.currentRevision };
  if (error instanceof AccessPolicyNameTaken)
    return { ok: false, kind: "name-taken", message: error.message };
  if (error instanceof AccessPolicyBuiltIn)
    return { ok: false, kind: "built-in", message: error.message };
  if (error instanceof AccessPolicyOwnersOnly)
    return { ok: false, kind: "owners-only", message: error.message };
  return { ok: false, kind: "not-applied", message: error.message };
};

/**
 * Access policy writes answer a union, as the environment's do: saved, or refused with the
 * server's words (and every problem a rejection listed), so a dialog keeps its draft and says
 * what to fix. Anything else (not found, the API down) stays a transport error.
 */
export const policyOutcome = <A, E>(effect: Effect.Effect<A, E | PolicyRefusalError>) =>
  effect.pipe(
    Effect.map((result) => ({ ok: true as const, result })),
    Effect.catchIf(
      (error: E | PolicyRefusalError): error is PolicyRefusalError => isPolicyRefusal(error),
      (error) => Effect.succeed(policyRefusalOf(error)),
    ),
  );

/**
 * Access policies (ADR 0025's 2026-11-24 amendment): the organization's templates and
 * revocations, a project's own copy, and a worktree's pin with "Apply updated policy".
 */
export const accessPoliciesRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.accessPolicies.list())),
  create: procedure
    .input(input(CreateAccessPolicyRequest))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => policyOutcome(api.accessPolicies.create({ payload }))),
    ),
  update: procedure
    .input(input(Schema.Struct({ id: AccessPolicyId, request: UpdateAccessPolicyRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        policyOutcome(api.accessPolicies.update({ params: { id: i.id }, payload: i.request })),
      ),
    ),
  remove: procedure
    .input(input(Schema.Struct({ id: AccessPolicyId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => policyOutcome(api.accessPolicies.remove({ params: { id: i.id } }))),
    ),
  revoke: procedure
    .input(input(RevokeAccessRequest))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => policyOutcome(api.accessPolicies.revoke({ payload }))),
    ),
  project: procedure
    .input(input(Schema.Struct({ projectId: ProjectId })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.projectAccessPolicy.get({ params: { id: i.projectId } })),
    ),
  assign: procedure
    .input(input(Schema.Struct({ projectId: ProjectId, request: AssignAccessPolicyRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        policyOutcome(
          api.projectAccessPolicy.set({ params: { id: i.projectId }, payload: i.request }),
        ),
      ),
    ),
  worktree: procedure
    .input(input(Schema.Struct({ id: WorktreeId })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.worktreeAccessPolicy.get({ params: { id: i.id } })),
    ),
  applyUpdated: procedure
    .input(input(Schema.Struct({ id: WorktreeId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => policyOutcome(api.worktreeAccessPolicy.apply({ params: { id: i.id } }))),
    ),
});
