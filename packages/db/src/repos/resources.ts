import {
  type ProjectId,
  ResourceApprovalId,
  ResourceDatabaseId,
  ResourceDefinitionId,
  ResourceInstanceId,
  type WorktreeId,
} from "@mend/domain";
import {
  defaultChoiceFor,
  isDatabasePreset,
  type OwnTarget,
  ResourceDefinitionInput,
  resourceDefinitionRefusals,
  ResourceRefusal,
  ResourceSpecDigest,
  resourceSpecDigest,
  selectionRefusal,
  SelectionRevision,
  WorktreeSelection,
} from "@mend/domain/workbench";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import {
  resourceApprovals,
  resourceDefinitions,
  resourceSelections,
  worktrees,
} from "../schema/workbench.ts";

/** A definition as a project's settings hold it (ADR 0019); a `mend.toml` proposal is not one. */
export interface StoredResourceDefinition {
  readonly id: ResourceDefinitionId;
  readonly projectId: ProjectId;
  readonly spec: ResourceDefinitionInput;
  readonly declaredBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One approved spec of a definition. It approves its digest, whenever the spec has it again. */
export interface ResourceApproval {
  readonly id: ResourceApprovalId;
  readonly definitionId: ResourceDefinitionId;
  readonly revision: number;
  readonly digest: ResourceSpecDigest;
  readonly spec: ResourceDefinitionInput;
  readonly approvedBy: string;
  readonly approvedAt: Date;
}

/** A selection as a person asks for it; the repo numbers its revision. */
export type SelectionChoice =
  | { readonly mode: "off" }
  | { readonly mode: "shared" }
  | { readonly mode: "own"; readonly target: OwnTarget };

export interface StoredSelection {
  readonly worktreeId: WorktreeId;
  readonly definitionId: ResourceDefinitionId;
  readonly selection: WorktreeSelection;
  /** Null when the policy's default applied and nobody chose. */
  readonly chosenBy: string | null;
  readonly chosenAt: Date;
}

export class ResourceDefinitionRefusedError extends Schema.TaggedError<ResourceDefinitionRefusedError>()(
  "ResourceDefinitionRefusedError",
  { name: Schema.String, refusals: Schema.Array(ResourceRefusal) },
) {}

export class ResourceDefinitionNotFoundError extends Schema.TaggedError<ResourceDefinitionNotFoundError>()(
  "ResourceDefinitionNotFoundError",
  { id: Schema.String },
) {}

/** The spec changed after the approver read it: what they approved is not what would run. */
export class ResourceApprovalStaleError extends Schema.TaggedError<ResourceApprovalStaleError>()(
  "ResourceApprovalStaleError",
  { definitionId: Schema.String, approving: ResourceSpecDigest, current: ResourceSpecDigest },
) {}

export class ResourceSelectionRefusedError extends Schema.TaggedError<ResourceSelectionRefusedError>()(
  "ResourceSelectionRefusedError",
  { definitionId: Schema.String, refusal: ResourceRefusal },
) {}

export class ResourcesRepo extends Context.Service<
  ResourcesRepo,
  {
    /** Declares `spec` under its name, or replaces that name's spec; the same spec twice is one write. */
    readonly declare: (
      projectId: ProjectId,
      spec: ResourceDefinitionInput,
      declaredBy: string,
    ) => Effect.Effect<StoredResourceDefinition, ResourceDefinitionRefusedError>;
    readonly remove: (projectId: ProjectId, name: string) => Effect.Effect<void>;
    readonly listForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<StoredResourceDefinition>>;
    readonly byName: (
      projectId: ProjectId,
      name: string,
    ) => Effect.Effect<StoredResourceDefinition | null>;
    /** Approves the spec whose digest the approver read; approving one digest twice is one row. */
    readonly approve: (
      definitionId: ResourceDefinitionId,
      digest: ResourceSpecDigest,
      approvedBy: string,
    ) => Effect.Effect<
      ResourceApproval,
      ResourceDefinitionNotFoundError | ResourceApprovalStaleError
    >;
    /** The approval of the definition's spec as it is now, or null until that spec is approved. */
    readonly currentApproval: (
      definitionId: ResourceDefinitionId,
    ) => Effect.Effect<ResourceApproval | null, ResourceDefinitionNotFoundError>;
    /** The worktree's selection, set from the default when it has none; null for a worktree resource. */
    readonly ensureSelection: (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
    ) => Effect.Effect<
      StoredSelection | null,
      ResourceDefinitionNotFoundError | ResourceSelectionRefusedError
    >;
    /** A changed choice takes the next revision; the same choice again changes nothing. */
    readonly setSelection: (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      choice: SelectionChoice,
      chosenBy: string,
    ) => Effect.Effect<
      StoredSelection,
      ResourceDefinitionNotFoundError | ResourceSelectionRefusedError
    >;
  }
>()("@mend/db/ResourcesRepo") {}

const decodeSpec = Schema.decodeUnknownEffect(ResourceDefinitionInput);
const encodeSpec = Schema.encodeEffect(ResourceDefinitionInput);
const decodeSelection = Schema.decodeUnknownEffect(WorktreeSelection);

const toDefinition = (row: typeof resourceDefinitions.$inferSelect) =>
  decodeSpec(row.spec).pipe(
    Effect.map(
      (spec): StoredResourceDefinition => ({
        id: row.id,
        projectId: row.projectId,
        spec,
        declaredBy: row.declaredBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    ),
    Effect.orDie,
  );

const toApproval = (row: typeof resourceApprovals.$inferSelect) =>
  decodeSpec(row.spec).pipe(
    Effect.map((spec): ResourceApproval => ({ ...row, spec })),
    Effect.orDie,
  );

const toSelection = (row: typeof resourceSelections.$inferSelect) =>
  decodeSelection({
    mode: row.mode,
    revision: row.revision,
    ...(row.mode === "own" ? { target: row.ownTarget } : {}),
  }).pipe(
    Effect.map(
      (selection): StoredSelection => ({
        worktreeId: row.worktreeId,
        definitionId: row.definitionId,
        selection,
        chosenBy: row.chosenBy,
        chosenAt: row.chosenAt,
      }),
    ),
    Effect.orDie,
  );

/** What a new `own` names: a database on the project instance, or an instance of its own. */
const newOwnTarget = (spec: ResourceDefinitionInput): OwnTarget =>
  isDatabasePreset(spec)
    ? { kind: "database", database: ResourceDatabaseId.make(`rdb_${crypto.randomUUID()}`) }
    : { kind: "instance", instance: ResourceInstanceId.make(`rins_${crypto.randomUUID()}`) };

export const ResourcesRepoLive: Layer.Layer<ResourcesRepo, never, MendDB> = Layer.effect(
  ResourcesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const definitionById = (id: ResourceDefinitionId) =>
      db
        .select()
        .from(resourceDefinitions)
        .where(eq(resourceDefinitions.id, id))
        .pipe(
          Effect.orDie,
          Effect.flatMap(([row]) =>
            row === undefined
              ? Effect.fail(new ResourceDefinitionNotFoundError({ id }))
              : toDefinition(row),
          ),
        );

    const byName = Effect.fn("ResourcesRepo.byName")(function* (
      projectId: ProjectId,
      name: string,
    ) {
      const [row] = yield* db
        .select()
        .from(resourceDefinitions)
        .where(
          and(eq(resourceDefinitions.projectId, projectId), eq(resourceDefinitions.name, name)),
        )
        .pipe(Effect.orDie);
      return row === undefined ? null : yield* toDefinition(row);
    });

    const declare = Effect.fn("ResourcesRepo.declare")(function* (
      projectId: ProjectId,
      spec: ResourceDefinitionInput,
      declaredBy: string,
    ) {
      const refusals = resourceDefinitionRefusals(spec);
      if (refusals.length > 0) {
        return yield* new ResourceDefinitionRefusedError({ name: spec.name, refusals });
      }
      const encoded = yield* encodeSpec(spec).pipe(Effect.orDie);
      const [row] = yield* db
        .insert(resourceDefinitions)
        .values({
          id: ResourceDefinitionId.make(`rdef_${crypto.randomUUID()}`),
          projectId,
          name: spec.name,
          scope: spec.scope,
          preset: spec.preset,
          spec: encoded,
          declaredBy,
        })
        .onConflictDoUpdate({
          target: [resourceDefinitions.projectId, resourceDefinitions.name],
          set: {
            scope: sql`excluded.scope`,
            preset: sql`excluded.preset`,
            spec: sql`excluded.spec`,
            declaredBy: sql`excluded.declared_by`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`${resourceDefinitions.spec} IS DISTINCT FROM excluded.spec`,
        })
        .returning()
        .pipe(Effect.orDie);
      if (row !== undefined) return yield* toDefinition(row);
      const unchanged = yield* byName(projectId, spec.name);
      return unchanged ?? (yield* Effect.die(new Error("a declared definition was not stored")));
    });

    const remove = Effect.fn("ResourcesRepo.remove")(function* (
      projectId: ProjectId,
      name: string,
    ) {
      yield* db
        .delete(resourceDefinitions)
        .where(
          and(eq(resourceDefinitions.projectId, projectId), eq(resourceDefinitions.name, name)),
        )
        .pipe(Effect.orDie);
    });

    const listForProject = Effect.fn("ResourcesRepo.listForProject")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select()
        .from(resourceDefinitions)
        .where(eq(resourceDefinitions.projectId, projectId))
        .orderBy(asc(resourceDefinitions.name))
        .pipe(Effect.orDie);
      return yield* Effect.forEach(rows, toDefinition);
    });

    const approve = Effect.fn("ResourcesRepo.approve")(function* (
      definitionId: ResourceDefinitionId,
      digest: ResourceSpecDigest,
      approvedBy: string,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // The definition's row lock orders approvals of one definition, so revisions never race.
            const [locked] = yield* tx
              .select()
              .from(resourceDefinitions)
              .where(eq(resourceDefinitions.id, definitionId))
              .for("update")
              .pipe(Effect.orDie);
            if (locked === undefined) {
              return yield* new ResourceDefinitionNotFoundError({ id: definitionId });
            }
            const definition = yield* toDefinition(locked);
            const current = resourceSpecDigest(definition.spec);
            if (current !== digest) {
              return yield* new ResourceApprovalStaleError({
                definitionId,
                approving: digest,
                current,
              });
            }
            const [existing] = yield* tx
              .select()
              .from(resourceApprovals)
              .where(
                and(
                  eq(resourceApprovals.definitionId, definitionId),
                  eq(resourceApprovals.digest, digest),
                ),
              )
              .pipe(Effect.orDie);
            if (existing !== undefined) return yield* toApproval(existing);
            const [latest] = yield* tx
              .select({ revision: max(resourceApprovals.revision) })
              .from(resourceApprovals)
              .where(eq(resourceApprovals.definitionId, definitionId))
              .pipe(Effect.orDie);
            const [inserted] = yield* tx
              .insert(resourceApprovals)
              .values({
                id: ResourceApprovalId.make(`rapr_${crypto.randomUUID()}`),
                definitionId,
                revision: (latest?.revision ?? 0) + 1,
                digest,
                spec: locked.spec,
                approvedBy,
              })
              .returning()
              .pipe(Effect.orDie);
            if (inserted === undefined) return yield* Effect.die(new Error("approval not stored"));
            return yield* toApproval(inserted);
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    const currentApproval = Effect.fn("ResourcesRepo.currentApproval")(function* (
      definitionId: ResourceDefinitionId,
    ) {
      const definition = yield* definitionById(definitionId);
      const [row] = yield* db
        .select()
        .from(resourceApprovals)
        .where(
          and(
            eq(resourceApprovals.definitionId, definitionId),
            eq(resourceApprovals.digest, resourceSpecDigest(definition.spec)),
          ),
        )
        .pipe(Effect.orDie);
      return row === undefined ? null : yield* toApproval(row);
    });

    /** The definition, once the worktree is known to be one of its project's. */
    const definitionForWorktree = Effect.fn("ResourcesRepo.definitionForWorktree")(function* (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
    ) {
      const definition = yield* definitionById(definitionId);
      const [worktree] = yield* db
        .select({ projectId: worktrees.projectId })
        .from(worktrees)
        .where(eq(worktrees.id, worktreeId))
        .pipe(Effect.orDie);
      if (worktree?.projectId !== definition.projectId) {
        return yield* new ResourceSelectionRefusedError({
          definitionId,
          refusal: {
            key: "worktree",
            message: `is not a worktree of the project that declares @${definition.spec.name}`,
          },
        });
      }
      return definition;
    });

    const selectionRow = (worktreeId: WorktreeId, definitionId: ResourceDefinitionId) =>
      db
        .select()
        .from(resourceSelections)
        .where(
          and(
            eq(resourceSelections.worktreeId, worktreeId),
            eq(resourceSelections.definitionId, definitionId),
          ),
        )
        .pipe(
          Effect.orDie,
          Effect.flatMap(([row]) =>
            row === undefined
              ? Effect.die(new Error("a written selection was not stored"))
              : toSelection(row),
          ),
        );

    const ensureSelection = Effect.fn("ResourcesRepo.ensureSelection")(function* (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
    ) {
      const { spec } = yield* definitionForWorktree(worktreeId, definitionId);
      const mode = defaultChoiceFor(spec);
      if (mode === null) return null;
      yield* db
        .insert(resourceSelections)
        .values({
          worktreeId,
          definitionId,
          mode,
          revision: 0,
          ownTarget: mode === "own" ? newOwnTarget(spec) : null,
          chosenBy: null,
        })
        .onConflictDoNothing()
        .pipe(Effect.orDie);
      return yield* selectionRow(worktreeId, definitionId);
    });

    const setSelection = Effect.fn("ResourcesRepo.setSelection")(function* (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      choice: SelectionChoice,
      chosenBy: string,
    ) {
      const { spec } = yield* definitionForWorktree(worktreeId, definitionId);
      const refusal = selectionRefusal(spec, { ...choice, revision: SelectionRevision.make(0) });
      if (refusal !== null) {
        return yield* new ResourceSelectionRefusedError({ definitionId, refusal });
      }
      yield* db
        .insert(resourceSelections)
        .values({
          worktreeId,
          definitionId,
          mode: choice.mode,
          revision: 0,
          ownTarget: choice.mode === "own" ? choice.target : null,
          chosenBy,
        })
        .onConflictDoUpdate({
          target: [resourceSelections.worktreeId, resourceSelections.definitionId],
          set: {
            mode: sql`excluded.mode`,
            ownTarget: sql`excluded.own_target`,
            chosenBy: sql`excluded.chosen_by`,
            chosenAt: sql`now()`,
            revision: sql`${resourceSelections.revision} + 1`,
          },
          setWhere: sql`(${resourceSelections.mode}, ${resourceSelections.ownTarget})
            IS DISTINCT FROM (excluded.mode, excluded.own_target)`,
        })
        .pipe(Effect.orDie);
      return yield* selectionRow(worktreeId, definitionId);
    });

    return {
      declare,
      remove,
      listForProject,
      byName,
      approve,
      currentApproval,
      ensureSelection,
      setSelection,
    };
  }),
);
