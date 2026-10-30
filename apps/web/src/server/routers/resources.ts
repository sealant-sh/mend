import {
  ResourceManifestUnverifiable,
  ResourceRegistryUnavailable,
  ResourceRejected,
  ResourceStale,
} from "@mend/api-contracts";
import { ProjectId, ResourceDefinitionId, ResourceProposalId, WorktreeId } from "@mend/domain";
import {
  ReaderTimeZone,
  ResourceApprovalRequest,
  ResourceProposalInput,
  ResourceSpecDigest,
  WorktreeChoice,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/**
 * A project's resources (ADR 0019). A refusal by field, a read that changed since it was made and
 * a registry that did not answer are OUTCOMES here, not transport errors: the card shows each
 * field's words beside it and offers a reload, so writes return a discriminated union built from
 * the contract's own typed failures. Who may act is the server's; a denial stays an error.
 */
const outcome = <A, E>(
  effect: Effect.Effect<
    A,
    | E
    | ResourceRejected
    | ResourceStale
    | ResourceRegistryUnavailable
    | ResourceManifestUnverifiable
  >,
) =>
  effect.pipe(
    Effect.map((result) => ({ ok: true as const, result })),
    Effect.catchIf(
      (error): error is ResourceRejected => error instanceof ResourceRejected,
      (rejected) =>
        Effect.succeed({
          ok: false as const,
          kind: "rejected" as const,
          refusals: rejected.refusals,
          message: rejected.message,
        }),
    ),
    Effect.catchIf(
      (error): error is ResourceStale => error instanceof ResourceStale,
      (stale) =>
        Effect.succeed({ ok: false as const, kind: "stale" as const, message: stale.message }),
    ),
    Effect.catchIf(
      (error): error is ResourceRegistryUnavailable | ResourceManifestUnverifiable =>
        error instanceof ResourceRegistryUnavailable ||
        error instanceof ResourceManifestUnverifiable,
      (failed) =>
        Effect.succeed({
          ok: false as const,
          kind: "unanswered" as const,
          message: failed.message,
        }),
    ),
  );

/** Every call names its project and the reader's zone, which the status lines it answers read in. */
const reader = { projectId: ProjectId, timeZone: ReaderTimeZone };

export const resourcesRouter = router({
  list: procedure
    .input(input(Schema.Struct({ ...reader, worktreeId: Schema.NullOr(WorktreeId) })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.resources.list({
          params: { id: i.projectId },
          query: {
            timeZone: i.timeZone,
            ...(i.worktreeId === null ? {} : { worktreeId: i.worktreeId }),
          },
        }),
      ),
    ),
  propose: procedure
    .input(input(Schema.Struct({ ...reader, proposal: ResourceProposalInput })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => {
        const at = { params: { id: i.projectId }, query: { timeZone: i.timeZone } };
        // The client types its payload one union member at a time.
        const proposal = i.proposal;
        return outcome(
          proposal.kind === "preset"
            ? api.resources.propose({ ...at, payload: proposal })
            : api.resources.propose({ ...at, payload: proposal }),
        );
      }),
    ),
  /** A proposal another removal took first is gone, which the card says beside a reload. */
  withdraw: procedure
    .input(input(Schema.Struct({ ...reader, proposalId: ResourceProposalId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.resources.withdraw({ params: { id: i.projectId, proposalId: i.proposalId } }).pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catchTag("NotFound", () =>
            Effect.succeed({ ok: false as const, kind: "gone" as const }),
          ),
        ),
      ),
    ),
  remove: procedure
    .input(
      input(
        Schema.Struct({
          ...reader,
          definitionId: ResourceDefinitionId,
          expectedDigest: ResourceSpecDigest,
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        outcome(
          api.resources.remove({
            params: { id: i.projectId, definitionId: i.definitionId },
            payload: { expectedDigest: i.expectedDigest },
          }),
        ),
      ),
    ),
  approve: procedure
    .input(input(Schema.Struct({ ...reader, request: ResourceApprovalRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        outcome(
          api.resources.approve({
            params: { id: i.projectId },
            query: { timeZone: i.timeZone },
            payload: i.request,
          }),
        ),
      ),
    ),
  use: procedure
    .input(
      input(
        Schema.Struct({
          ...reader,
          worktreeId: WorktreeId,
          definitionId: ResourceDefinitionId,
          mode: WorktreeChoice,
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        outcome(
          api.resources.use({
            params: { id: i.projectId, worktreeId: i.worktreeId, definitionId: i.definitionId },
            query: { timeZone: i.timeZone },
            payload: { mode: i.mode },
          }),
        ),
      ),
    ),
});
