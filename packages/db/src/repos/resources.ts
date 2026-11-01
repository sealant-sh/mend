import { ProjectId, ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  type ImageDigest,
  type OwnDatabaseOrigin,
  type OwnDatabaseRemoval,
  pinImage,
  ResourceDefinition,
  ResourceRefusal,
  type ResourceBindingRows,
  ResourceSpecDigest,
  resourceSpecDigest,
  resourceDefinitionRefusals,
  envCollisionRefusals,
  type WorktreeChoice,
  choiceInEffect,
} from "@mend/domain/workbench";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import {
  projects,
  resourceDefinitions,
  resourceInstances,
  resourceOwnDatabases,
  resourceSelections,
  worktrees,
} from "../schema/workbench.ts";

/** A resource's stable project/name identity, also the base of its Sealant keys. */
export interface StoredResourceIdentity {
  readonly id: ResourceDefinitionId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly createdAt: Date;
}

/** The definition and image that an explicit start remembered at one level. */
export interface StoredResourceInstance {
  readonly id: ResourceDefinitionId;
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId | null;
  readonly spec: ResourceDefinition;
  readonly specDigest: ResourceSpecDigest;
  readonly imageDigest: ImageDigest;
  readonly image: string;
  readonly startedBy: string;
  readonly startedAt: Date;
  readonly updatedAt: Date;
}

/** One remembered instance and the worktree's effective choice of its resource. */
export interface DefinitionWithChoice {
  readonly definition: StoredResourceInstance;
  readonly choice: WorktreeChoice;
}

/** The choice persisted for a single worktree and identity. */
export interface StoredSelection {
  readonly worktreeId: WorktreeId;
  readonly definitionId: ResourceDefinitionId;
  readonly mode: WorktreeChoice;
  readonly chosenBy: string | null;
  readonly chosenAt: Date;
}

export class ResourceDefinitionRefusedError extends Schema.TaggedError<ResourceDefinitionRefusedError>()(
  "ResourceDefinitionRefusedError",
  { name: Schema.String, refusals: Schema.Array(ResourceRefusal) },
) {}
export class ResourceDefinitionNotFoundError extends Schema.TaggedError<ResourceDefinitionNotFoundError>()(
  "ResourceDefinitionNotFoundError",
  { id: ResourceDefinitionId },
) {}
export class ResourceSelectionRefusedError extends Schema.TaggedError<ResourceSelectionRefusedError>()(
  "ResourceSelectionRefusedError",
  { definitionId: ResourceDefinitionId, name: Schema.String, refusal: ResourceRefusal },
) {}

/** Stored resource identities, remembered instances, selections and retained own-database inventory. */
export class ResourcesRepo extends Context.Service<
  ResourcesRepo,
  {
    readonly ensureIdentity: (
      projectId: ProjectId,
      name: string,
    ) => Effect.Effect<StoredResourceIdentity, ResourceDefinitionRefusedError>;
    readonly remember: (
      projectId: ProjectId,
      resourceId: ResourceDefinitionId,
      worktreeId: WorktreeId | null,
      spec: ResourceDefinition,
      imageDigest: ImageDigest,
      by: string,
    ) => Effect.Effect<StoredResourceInstance, ResourceDefinitionRefusedError>;
    readonly removeInstance: (
      resourceId: ResourceDefinitionId,
      worktreeId: WorktreeId | null,
    ) => Effect.Effect<void>;
    readonly listForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<StoredResourceInstance>>;
    readonly listIdentities: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<StoredResourceIdentity>>;
    readonly listWithChoices: (
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
    ) => Effect.Effect<ReadonlyArray<DefinitionWithChoice>>;
    readonly bindingRows: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
    ) => Effect.Effect<ResourceBindingRows>;
    /** Project server, or a legacy worktree instance when no project instance exists. */
    readonly byName: (
      projectId: ProjectId,
      name: string,
    ) => Effect.Effect<StoredResourceInstance | null>;
    readonly declaredNames: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<string>>;
    readonly setSelection: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      mode: WorktreeChoice,
      chosenBy: string,
    ) => Effect.Effect<
      StoredSelection,
      ResourceDefinitionNotFoundError | ResourceSelectionRefusedError
    >;
    readonly ownSelections: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyMap<ResourceDefinitionId, number>>;
    readonly ownDatabases: (
      worktreeId: WorktreeId,
      purpose?: "own" | "base",
    ) => Effect.Effect<ReadonlyMap<ResourceDefinitionId, OwnDatabaseOrigin>>;
    readonly ownDatabaseRemovals: (
      worktreeId: WorktreeId,
    ) => Effect.Effect<ReadonlyArray<OwnDatabaseRemoval>>;
    /** Active own and base databases on a project server, including names for archive refusals. */
    readonly ownDatabasesForResource: (definitionId: ResourceDefinitionId) => Effect.Effect<
      ReadonlyArray<{
        readonly worktreeId: WorktreeId;
        readonly worktreeName: string;
        readonly purpose: "own" | "base";
      }>
    >;
    /** Reserves a retry path; archive refresh invalidates an earlier check before saving live data. */
    readonly reserveRemovalDump: (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      dumpName: string,
      at: Date,
      refresh?: boolean,
      purpose?: "own" | "base",
    ) => Effect.Effect<void>;
    readonly checkRemovalDump: (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      at: Date,
      purpose?: "own" | "base",
    ) => Effect.Effect<void>;
    readonly removeOwnDatabase: (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      at: Date,
      purpose?: "own" | "base",
    ) => Effect.Effect<void>;
    readonly recordOwnDatabase: (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      origin: OwnDatabaseOrigin["kind"],
      purpose?: "own" | "base",
    ) => Effect.Effect<void>;
  }
>()("@mend/db/ResourcesRepo") {}

const instanceWhere = (id: ResourceDefinitionId, worktreeId: WorktreeId | null) =>
  and(
    eq(resourceInstances.resourceId, id),
    worktreeId === null
      ? isNull(resourceInstances.worktreeId)
      : eq(resourceInstances.worktreeId, worktreeId),
  );
const ownKey = (
  worktreeId: WorktreeId,
  definitionId: ResourceDefinitionId,
  purpose: "own" | "base",
) =>
  and(
    eq(resourceOwnDatabases.worktreeId, worktreeId),
    eq(resourceOwnDatabases.definitionId, definitionId),
    eq(resourceOwnDatabases.purpose, purpose),
  );
const decodeSpec = Schema.decodeUnknownEffect(ResourceDefinition);
const toInstance = Effect.fnUntraced(function* (
  identity: StoredResourceIdentity,
  row: typeof resourceInstances.$inferSelect,
) {
  const spec = yield* decodeSpec(row.spec).pipe(Effect.orDie);
  const image = pinImage(spec.image, row.imageDigest);
  if (image === null)
    return yield* Effect.die(
      new Error(`resource ${identity.id} pins another digest than its image`),
    );
  return {
    id: identity.id,
    projectId: identity.projectId,
    worktreeId: row.worktreeId,
    spec,
    image,
    specDigest: row.specDigest,
    imageDigest: row.imageDigest,
    startedBy: row.startedBy,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
  } satisfies StoredResourceInstance;
});

/** Writes serialize with project removal; no database lock spans a registry or Core call. */
export const ResourcesRepoLive: Layer.Layer<ResourcesRepo, never, MendDB> = Layer.effect(
  ResourcesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const fence = (tx: Pick<typeof db, "select">, projectId: ProjectId, name: string) =>
      Effect.gen(function* () {
        const [project] = yield* tx
          .select({
            marked: sql<boolean>`removal_fence_marked(${projects.removalPhase}, ${projects.removalSince})`,
            removed: projects.removedAt,
          })
          .from(projects)
          .where(eq(projects.id, projectId))
          .for("no key update");
        if (project === undefined || project.marked || project.removed !== null)
          return yield* new ResourceDefinitionRefusedError({
            name,
            refusals: [
              {
                key: "project",
                message: "is being removed or was removed · restore it before starting resources",
              },
            ],
          });
      });
    const queryErrorsDie = {
      EffectDrizzleQueryError: (error: unknown) => Effect.die(error),
      SqlError: (error: unknown) => Effect.die(error),
    };
    const listIdentities = (projectId: ProjectId) =>
      db
        .select()
        .from(resourceDefinitions)
        .where(eq(resourceDefinitions.projectId, projectId))
        .orderBy(asc(resourceDefinitions.createdAt), asc(resourceDefinitions.name))
        .pipe(Effect.orDie);
    const ensureIdentity = (projectId: ProjectId, name: string) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* fence(tx, projectId, name);
            const [row] = yield* tx
              .insert(resourceDefinitions)
              .values({
                id: ResourceDefinitionId.make(`rdef_${crypto.randomUUID()}`),
                projectId,
                name,
              })
              .onConflictDoUpdate({
                target: [resourceDefinitions.projectId, resourceDefinitions.name],
                set: { name },
              })
              .returning();
            if (row === undefined)
              return yield* Effect.die("resource identity insert returned no row");
            return row;
          }),
        )
        .pipe(Effect.catchTags(queryErrorsDie));
    const remember = (
      projectId: ProjectId,
      resourceId: ResourceDefinitionId,
      worktreeId: WorktreeId | null,
      spec: ResourceDefinition,
      imageDigest: ImageDigest,
      by: string,
    ) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* fence(tx, projectId, spec.name);
            const [identity] = yield* tx
              .select()
              .from(resourceDefinitions)
              .where(
                and(
                  eq(resourceDefinitions.id, resourceId),
                  eq(resourceDefinitions.projectId, projectId),
                ),
              )
              .for("update");
            if (identity === undefined) return yield* Effect.die("resource identity is absent");
            const others = yield* tx
              .select({ spec: resourceInstances.spec })
              .from(resourceInstances)
              .innerJoin(
                resourceDefinitions,
                eq(resourceInstances.resourceId, resourceDefinitions.id),
              )
              .where(eq(resourceDefinitions.projectId, projectId));
            const definitions = yield* Effect.forEach(others, (row) =>
              decodeSpec(row.spec).pipe(Effect.orDie),
            );
            const refusals = [
              ...resourceDefinitionRefusals(spec),
              ...envCollisionRefusals([
                ...definitions.filter((other) => other.name !== spec.name),
                spec,
              ])
                .filter((entry) => entry.resource === spec.name)
                .map((entry) => entry.refusal),
            ];
            if (pinImage(spec.image, imageDigest) === null)
              refusals.push({ key: "image", message: `names another digest than ${imageDigest}` });
            if (refusals.length > 0)
              return yield* new ResourceDefinitionRefusedError({ name: spec.name, refusals });
            const values = {
              spec: yield* Schema.encodeEffect(ResourceDefinition)(spec).pipe(Effect.orDie),
              specDigest: resourceSpecDigest(spec),
              imageDigest,
              startedBy: by,
            };
            const [held] = yield* tx
              .select()
              .from(resourceInstances)
              .where(instanceWhere(resourceId, worktreeId));
            const [row] =
              held === undefined
                ? yield* tx
                    .insert(resourceInstances)
                    .values({ resourceId, worktreeId, ...values })
                    .returning()
                : yield* tx
                    .update(resourceInstances)
                    .set({ ...values, startedAt: sql`now()`, updatedAt: sql`now()` })
                    .where(instanceWhere(resourceId, worktreeId))
                    .returning();
            if (row === undefined)
              return yield* Effect.die("resource instance write returned no row");
            return yield* toInstance(identity, row);
          }),
        )
        .pipe(Effect.catchTags(queryErrorsDie));
    const removeInstance = (resourceId: ResourceDefinitionId, worktreeId: WorktreeId | null) =>
      db
        .delete(resourceInstances)
        .where(instanceWhere(resourceId, worktreeId))
        .pipe(Effect.orDie, Effect.asVoid);
    const listForProject = Effect.fn("ResourcesRepo.listForProject")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select({ identity: resourceDefinitions, instance: resourceInstances })
        .from(resourceDefinitions)
        .innerJoin(resourceInstances, eq(resourceDefinitions.id, resourceInstances.resourceId))
        .where(eq(resourceDefinitions.projectId, projectId))
        .orderBy(asc(resourceDefinitions.createdAt))
        .pipe(Effect.orDie);
      return yield* Effect.forEach(rows, ({ identity, instance }) =>
        toInstance(identity, instance),
      );
    });
    const byName = (projectId: ProjectId, name: string) =>
      listForProject(projectId).pipe(
        Effect.map(
          (rows) =>
            rows.find((row) => row.spec.name === name && row.worktreeId === null) ??
            rows.find((row) => row.spec.name === name) ??
            null,
        ),
      );
    const declaredNames = (projectId: ProjectId) =>
      listIdentities(projectId).pipe(Effect.map((rows) => rows.map((row) => row.name)));
    const setSelection = (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      mode: WorktreeChoice,
      chosenBy: string,
    ) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [identity] = yield* tx
              .select()
              .from(resourceDefinitions)
              .where(
                and(
                  eq(resourceDefinitions.id, definitionId),
                  eq(resourceDefinitions.projectId, projectId),
                ),
              )
              .for("update");
            if (identity === undefined)
              return yield* new ResourceDefinitionNotFoundError({ id: definitionId });
            const [worktree] = yield* tx
              .select()
              .from(worktrees)
              .where(and(eq(worktrees.id, worktreeId), eq(worktrees.projectId, projectId)));
            if (worktree === undefined)
              return yield* new ResourceSelectionRefusedError({
                definitionId,
                name: identity.name,
                refusal: { key: "worktree", message: "is not a worktree of this project" },
              });
            const [row] = yield* tx
              .insert(resourceSelections)
              .values({ worktreeId, definitionId, mode, chosenBy })
              .onConflictDoUpdate({
                target: [resourceSelections.worktreeId, resourceSelections.definitionId],
                set: { mode, chosenBy, chosenAt: sql`now()` },
              })
              .returning();
            if (row === undefined)
              return yield* Effect.die("resource selection write returned no row");
            return row;
          }),
        )
        .pipe(Effect.catchTags(queryErrorsDie));
    const ownDatabases = Effect.fn("ResourcesRepo.ownDatabases")(function* (
      worktreeId: WorktreeId,
      purpose: "own" | "base" = "own",
    ) {
      const rows = yield* db
        .select()
        .from(resourceOwnDatabases)
        .where(
          and(
            eq(resourceOwnDatabases.worktreeId, worktreeId),
            eq(resourceOwnDatabases.purpose, purpose),
            isNull(resourceOwnDatabases.removedAt),
          ),
        )
        .pipe(Effect.orDie);
      return new Map(
        rows.map((row): readonly [ResourceDefinitionId, OwnDatabaseOrigin] => [
          row.definitionId,
          { kind: row.origin, at: row.madeAt },
        ]),
      );
    });

    const ownDatabaseRemovals = (worktreeId: WorktreeId) =>
      db
        .select()
        .from(resourceOwnDatabases)
        .where(eq(resourceOwnDatabases.worktreeId, worktreeId))
        .pipe(
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((row) => ({
              worktreeId: row.worktreeId,
              definitionId: row.definitionId,
              purpose: row.purpose,
              dumpName: row.removalDumpName,
              dumpAt: row.removalDumpAt,
              checkedAt: row.removalCheckedAt,
              removedAt: row.removedAt,
            })),
          ),
        );
    const ownDatabasesForResource = (definitionId: ResourceDefinitionId) =>
      db
        .select({
          worktreeId: worktrees.id,
          worktreeName: worktrees.name,
          purpose: resourceOwnDatabases.purpose,
        })
        .from(resourceOwnDatabases)
        .innerJoin(worktrees, eq(worktrees.id, resourceOwnDatabases.worktreeId))
        .where(
          and(
            eq(resourceOwnDatabases.definitionId, definitionId),
            isNull(resourceOwnDatabases.removedAt),
          ),
        )
        .orderBy(asc(worktrees.name), asc(worktrees.id))
        .pipe(Effect.orDie);
    const reserveRemovalDump = (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      dumpName: string,
      at: Date,
      refresh = false,
      purpose: "own" | "base" = "own",
    ) =>
      db
        .update(resourceOwnDatabases)
        .set({
          removalDumpName: dumpName,
          removalDumpAt: at,
          ...(refresh ? { removalCheckedAt: null } : {}),
        })
        .where(
          and(
            ownKey(worktreeId, definitionId, purpose),
            isNull(resourceOwnDatabases.removedAt),
            ...(refresh ? [] : [isNull(resourceOwnDatabases.removalDumpName)]),
          ),
        )
        .pipe(Effect.orDie, Effect.asVoid);
    const checkRemovalDump = (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      at: Date,
      purpose: "own" | "base" = "own",
    ) =>
      db
        .update(resourceOwnDatabases)
        .set({ removalCheckedAt: at })
        .where(
          and(
            ownKey(worktreeId, definitionId, purpose),
            isNull(resourceOwnDatabases.removalCheckedAt),
          ),
        )
        .pipe(Effect.orDie, Effect.asVoid);
    const removeOwnDatabase = (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      at: Date,
      purpose: "own" | "base" = "own",
    ) =>
      db
        .update(resourceOwnDatabases)
        .set({ removedAt: at })
        .where(
          and(ownKey(worktreeId, definitionId, purpose), isNull(resourceOwnDatabases.removedAt)),
        )
        .pipe(Effect.orDie, Effect.asVoid);

    const recordOwnDatabase = Effect.fn("ResourcesRepo.recordOwnDatabase")(function* (
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      origin: OwnDatabaseOrigin["kind"],
      purpose: "own" | "base" = "own",
    ) {
      yield* db
        .insert(resourceOwnDatabases)
        .values({ worktreeId, definitionId, origin, purpose })
        .onConflictDoUpdate({
          target: [
            resourceOwnDatabases.worktreeId,
            resourceOwnDatabases.definitionId,
            resourceOwnDatabases.purpose,
          ],
          set: {
            origin,
            madeAt: sql`now()`,
            removalDumpName: null,
            removalDumpAt: null,
            removalCheckedAt: null,
            removedAt: null,
          },
        })
        .pipe(Effect.orDie);
    });

    const bindingRows = Effect.fn("ResourcesRepo.bindingRows")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId,
    ): Effect.fn.Return<ResourceBindingRows> {
      const resources = yield* listIdentities(projectId);
      const instances = yield* listForProject(projectId);
      const [worktree] = yield* db
        .select({ uses: worktrees.usesProjectResources })
        .from(worktrees)
        .where(and(eq(worktrees.id, worktreeId), eq(worktrees.projectId, projectId)))
        .pipe(Effect.orDie);
      const selections = yield* db
        .select()
        .from(resourceSelections)
        .where(eq(resourceSelections.worktreeId, worktreeId))
        .pipe(Effect.orDie);
      return {
        worktreeId,
        usesProjectResources: worktree?.uses ?? false,
        resources,
        instances: instances.map((row) => ({
          resourceId: row.id,
          worktreeId: row.worktreeId,
          spec: row.spec,
        })),
        selections: selections.map((row) => ({ resourceId: row.definitionId, mode: row.mode })),
        ownDatabases: new Set((yield* ownDatabases(worktreeId)).keys()),
      };
    });
    const listWithChoices = Effect.fn("ResourcesRepo.listWithChoices")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
    ) {
      const instances = yield* listForProject(projectId);
      if (worktreeId === null)
        return instances.map((definition) => ({
          definition,
          choice: definition.worktreeId === null ? ("project" as const) : ("worktree" as const),
        }));
      const rows = yield* bindingRows(projectId, worktreeId);
      return rows.resources.flatMap((identity): ReadonlyArray<DefinitionWithChoice> => {
        const choice = choiceInEffect(
          rows.selections.find((row) => row.resourceId === identity.id)?.mode ?? null,
          rows.usesProjectResources,
        );
        const project = instances.find((row) => row.id === identity.id && row.worktreeId === null);
        const own = instances.find(
          (row) => row.id === identity.id && row.worktreeId === worktreeId,
        );
        const definition = choice === "worktree" ? (own ?? project) : (project ?? own);
        return definition === undefined ? [] : [{ definition, choice }];
      });
    });
    const ownSelections = (projectId: ProjectId) =>
      db
        .select({ definitionId: resourceOwnDatabases.definitionId, n: sql<number>`count(*)::int` })
        .from(resourceOwnDatabases)
        .innerJoin(
          resourceDefinitions,
          eq(resourceDefinitions.id, resourceOwnDatabases.definitionId),
        )
        .where(
          and(
            eq(resourceDefinitions.projectId, projectId),
            eq(resourceOwnDatabases.purpose, "own"),
            isNull(resourceOwnDatabases.removedAt),
          ),
        )
        .groupBy(resourceOwnDatabases.definitionId)
        .pipe(
          Effect.orDie,
          Effect.map((rows) => new Map(rows.map((row) => [row.definitionId, row.n]))),
        );
    return {
      ensureIdentity,
      remember,
      removeInstance,
      listForProject,
      listIdentities,
      listWithChoices,
      bindingRows,
      byName,
      declaredNames,
      setSelection,
      ownSelections,
      ownDatabases,
      recordOwnDatabase,
      ownDatabaseRemovals,
      ownDatabasesForResource,
      reserveRemovalDump,
      checkRemovalDump,
      removeOwnDatabase,
    };
  }),
);
