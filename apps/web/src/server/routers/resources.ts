import {
  ResourceManifestUnverifiable,
  ResourceRegistryUnavailable,
  ResourceRejected,
  ResourceStale,
} from "@mend/api-contracts";
import { ProjectId, ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  ReaderTimeZone,
  ResourceAddInput,
  ResourceName,
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

/** A call whose answer has status lines names the reader's zone, which their clock times read in. */
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
  add: procedure
    .input(
      input(
        Schema.Struct({
          ...reader,
          addition: ResourceAddInput,
          // The worktree the card reads for: a worktree resource starts there at once.
          worktreeId: Schema.NullOr(WorktreeId),
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => {
        const at = {
          params: { id: i.projectId },
          query: {
            timeZone: i.timeZone,
            ...(i.worktreeId === null ? {} : { worktreeId: i.worktreeId }),
          },
        };
        // The derived client takes its union payload as one request type per member, so each
        // member is narrowed before it is sent.
        const { addition } = i;
        switch (addition.kind) {
          case "preset":
            return outcome(api.resources.add({ ...at, payload: addition }));
          case "definition":
            return outcome(api.resources.add({ ...at, payload: addition }));
        }
      }),
    ),
  remove: procedure
    .input(
      input(
        Schema.Struct({
          projectId: ProjectId,
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
  /** A person's Start or Stop; a worktree resource's names the worktree the card reads for. */
  control: procedure
    .input(
      input(
        Schema.Struct({
          ...reader,
          name: ResourceName,
          worktreeId: Schema.NullOr(WorktreeId),
          verb: Schema.Literals(["start", "stop"]),
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => {
        const request = {
          params: { id: i.projectId, name: i.name },
          query: {
            timeZone: i.timeZone,
            ...(i.worktreeId === null ? {} : { worktreeId: i.worktreeId }),
          },
        };
        return outcome(
          i.verb === "start" ? api.resources.start(request) : api.resources.stop(request),
        );
      }),
    ),
});
