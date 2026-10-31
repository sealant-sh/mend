import {
  ProjectId,
  ResourceDatabaseId,
  ResourceDefinitionId,
  ResourceInstanceId,
  WorktreeId,
} from "@mend/domain";
import {
  changesWhatOwnIs,
  defaultChoiceFor,
  type ImageDigest,
  isDatabasePreset,
  type OwnTarget,
  pinImage,
  resourceDeclarationRefusals,
  ResourceDefinitionInput,
  ResourceRefusal,
  type ResourceSettingsState,
  ResourceSpecDigest,
  resourceSpecDigest,
  selectionRefusal,
  SelectionRevision,
  type SettingsDefinition,
  type WorktreeChoice,
  WorktreeSelection,
} from "@mend/domain/workbench";
import { and, asc, eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import {
  projects,
  resourceDefinitions,
  resourceSelections,
  worktrees,
} from "../schema/workbench.ts";

/** A definition as a project's settings hold it (ADR 0019); a `mend.toml` table is not one. */
export interface StoredResourceDefinition {
  readonly id: ResourceDefinitionId;
  readonly projectId: ProjectId;
  /** The spec as it was added, its image as written. */
  readonly spec: ResourceDefinitionInput;
  /** The spec's digest when it was added: what its readers saw. */
  readonly specDigest: ResourceSpecDigest;
  /** The digest the image resolved to when it was added. */
  readonly imageDigest: ImageDigest;
  /** The image as it runs, pinned to `imageDigest`: `postgres:17@sha256:…`. */
  readonly image: string;
  /** Whoever added it last, by account id. */
  readonly addedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A definition as a person adds it: the spec, and the digest its image resolved to. */
export interface AddedDefinition {
  readonly spec: ResourceDefinitionInput;
  readonly imageDigest: ImageDigest;
}

/** A selection as a person asks for it; the repo mints an `own` target and numbers the revision. */
export type SelectionChoice = { readonly mode: WorktreeChoice };

export interface DefinitionWithChoice {
  readonly definition: StoredResourceDefinition;
  /** The listed worktree's stored choice; null when it made none, or no worktree was listed. */
  readonly choice: WorktreeChoice | null;
}

/** A definition as its reader saw it: removing it holds only while it still is. */
export interface DefinitionVersion {
  readonly id: ResourceDefinitionId;
  readonly digest: ResourceSpecDigest;
}

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
  { id: ResourceDefinitionId },
) {}

/** The definition changed after its reader saw it, so the write that assumed it did not happen. */
export class ResourceDefinitionStaleError extends Schema.TaggedError<ResourceDefinitionStaleError>()(
  "ResourceDefinitionStaleError",
  {
    definitionId: ResourceDefinitionId,
    expected: ResourceSpecDigest,
    current: ResourceSpecDigest,
  },
) {}

export class ResourceSelectionRefusedError extends Schema.TaggedError<ResourceSelectionRefusedError>()(
  "ResourceSelectionRefusedError",
  { definitionId: ResourceDefinitionId, name: Schema.String, refusal: ResourceRefusal },
) {}

export class ResourcesRepo extends Context.Service<
  ResourcesRepo,
  {
    /**
     * Adds `added` under its name, or replaces that name's definition, refused as
     * `resourceDeclarationRefusals` says under the project's lock, and refused on `image` when the
     * spec's image names another digest. The same spec and pin twice is one write. A new scope or
     * preset re-defaults each worktree's selection.
     */
    readonly declare: (
      projectId: ProjectId,
      added: AddedDefinition,
      addedBy: string,
    ) => Effect.Effect<StoredResourceDefinition, ResourceDefinitionRefusedError>;
    /** Removes the definition while it holds the spec its remover read, and answers it. */
    readonly removeIfCurrent: (
      projectId: ProjectId,
      version: DefinitionVersion,
    ) => Effect.Effect<
      StoredResourceDefinition,
      ResourceDefinitionNotFoundError | ResourceDefinitionStaleError
    >;
    readonly listForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<StoredResourceDefinition>>;
    /**
     * How many worktrees hold each of the project's definitions as `own`; a definition none holds
     * is absent. One query, and nothing written.
     */
    readonly ownSelections: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyMap<ResourceDefinitionId, number>>;
    /**
     * Each definition, with `worktreeId`'s stored choice of it, read as it is, writing no default.
     * Two queries.
     */
    readonly listWithChoices: (
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
    ) => Effect.Effect<ReadonlyArray<DefinitionWithChoice>>;
    readonly byName: (
      projectId: ProjectId,
      name: string,
    ) => Effect.Effect<StoredResourceDefinition | null>;
    /**
     * The names of the project's definitions, by name; a spec that no longer decodes is named too.
     * Nothing archives a resource yet, so a project that has one is not removed (ADR 0019, step
     * 4). A declaration made while the project's removal mark stands is refused, so a removal
     * that took its mark first reads every name that will exist.
     */
    readonly declaredNames: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<string>>;
    /**
     * The worktree's selection of one of the project's definitions, set from the default when it
     * has none or the policy refuses the one it has; null for a worktree resource. Another
     * project's definition is not found.
     */
    readonly ensureSelection: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
    ) => Effect.Effect<
      StoredSelection | null,
      ResourceDefinitionNotFoundError | ResourceSelectionRefusedError
    >;
    /** A changed choice takes the next revision; the same choice again changes nothing. */
    readonly setSelection: (
      projectId: ProjectId,
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

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete">;
type DefinitionRow = typeof resourceDefinitions.$inferSelect;
type SelectionRow = typeof resourceSelections.$inferSelect;

const decodeSpec = Schema.decodeUnknownEffect(ResourceDefinitionInput);
const encodeSpec = Schema.encodeEffect(ResourceDefinitionInput);
const decodeSelection = Schema.decodeUnknownEffect(WorktreeSelection);

const toDefinition = Effect.fnUntraced(function* (row: DefinitionRow) {
  const spec = yield* decodeSpec(row.spec).pipe(Effect.orDie);
  const image = pinImage(spec.image, row.imageDigest);
  if (image === null) {
    return yield* Effect.die(new Error(`definition ${row.id} pins another digest than its image`));
  }
  return {
    id: row.id,
    projectId: row.projectId,
    spec,
    specDigest: row.specDigest,
    imageDigest: row.imageDigest,
    image,
    addedBy: row.addedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } satisfies StoredResourceDefinition;
});

const toSelection = (row: SelectionRow) =>
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

/** A new `own`: a database on the project instance, or an instance of its own. */
const newOwnTarget = (spec: ResourceDefinitionInput): OwnTarget =>
  isDatabasePreset(spec)
    ? { kind: "database", database: ResourceDatabaseId.make(`rdb_${crypto.randomUUID()}`) }
    : { kind: "instance", instance: ResourceInstanceId.make(`rins_${crypto.randomUUID()}`) };

const withRevision = (
  spec: ResourceDefinitionInput,
  mode: WorktreeChoice,
  revision: number,
): WorktreeSelection =>
  mode === "own"
    ? { mode, revision: SelectionRevision.make(revision), target: newOwnTarget(spec) }
    : { mode, revision: SelectionRevision.make(revision) };

/** The columns of `selection`, an `own` target among them. */
const selectionColumns = (selection: WorktreeSelection) => ({
  mode: selection.mode,
  revision: selection.revision,
  ownTarget: selection.mode === "own" ? selection.target : null,
});

/** A typed failure survives a transaction; a database error is a defect. */
const queryErrorsDie = {
  EffectDrizzleQueryError: (error: unknown) => Effect.die(error),
  SqlError: (error: unknown) => Effect.die(error),
};

/** The definition, row-locked: every write to it and its selections takes this. */
const lockDefinition = Effect.fn("ResourcesRepo.lockDefinition")(function* (
  tx: Tx,
  id: ResourceDefinitionId,
) {
  const [row] = yield* tx
    .select()
    .from(resourceDefinitions)
    .where(eq(resourceDefinitions.id, id))
    .for("update");
  if (row === undefined) return yield* new ResourceDefinitionNotFoundError({ id });
  return yield* toDefinition(row);
});

const worktreeProject = (tx: Tx, worktreeId: WorktreeId) =>
  tx
    .select({ projectId: worktrees.projectId })
    .from(worktrees)
    .where(eq(worktrees.id, worktreeId))
    .pipe(Effect.map(([row]) => row?.projectId ?? null));

/**
 * The project's definition, locked, once the worktree is known to be one of the project's. Another
 * project's definition is not found, the same as a missing one, so its name is never said.
 */
const lockForWorktree = Effect.fn("ResourcesRepo.lockForWorktree")(function* (
  tx: Tx,
  projectId: ProjectId,
  worktreeId: WorktreeId,
  definitionId: ResourceDefinitionId,
) {
  const definition = yield* lockDefinition(tx, definitionId);
  if (definition.projectId !== projectId) {
    return yield* new ResourceDefinitionNotFoundError({ id: definitionId });
  }
  if ((yield* worktreeProject(tx, worktreeId)) !== projectId) {
    return yield* new ResourceSelectionRefusedError({
      definitionId,
      name: definition.spec.name,
      refusal: {
        key: "worktree",
        message: `is not a worktree of the project that declares @${definition.spec.name}`,
      },
    });
  }
  return definition;
});

const storedSelection = (tx: Tx, worktreeId: WorktreeId, definitionId: ResourceDefinitionId) =>
  tx
    .select()
    .from(resourceSelections)
    .where(
      and(
        eq(resourceSelections.worktreeId, worktreeId),
        eq(resourceSelections.definitionId, definitionId),
      ),
    )
    .pipe(Effect.map(([row]) => row ?? null));

/** Writes `selection` as the worktree's, over what it had, and returns the row it wrote. */
const writeSelection = Effect.fn("ResourcesRepo.writeSelection")(function* (
  tx: Tx,
  stored: SelectionRow | null,
  key: { readonly worktreeId: WorktreeId; readonly definitionId: ResourceDefinitionId },
  selection: WorktreeSelection,
  chosenBy: string | null,
) {
  const columns = { ...selectionColumns(selection), chosenBy };
  const [row] =
    stored === null
      ? yield* tx
          .insert(resourceSelections)
          .values({ ...key, ...columns })
          .returning()
      : yield* tx
          .update(resourceSelections)
          .set({ ...columns, chosenAt: sql`now()` })
          .where(
            and(
              eq(resourceSelections.worktreeId, key.worktreeId),
              eq(resourceSelections.definitionId, key.definitionId),
            ),
          )
          .returning();
  if (row === undefined) return yield* Effect.die(new Error("a selection write returned no row"));
  return yield* toSelection(row);
});

/** What refuses a declaration before any rule: a removal's mark, or a removed project (0167). */
type ProjectFence = "removing" | "removed";

const fenceRefusal = (spec: ResourceDefinitionInput, fence: ProjectFence) =>
  new ResourceDefinitionRefusedError({
    name: spec.name,
    refusals: [
      {
        key: "project",
        message:
          fence === "removed"
            ? "was removed · restore it to declare resources"
            : "is being removed · declare it again if the removal stops",
      },
    ],
  });

/**
 * Under the definition's lock: what a new scope or preset does to each worktree's selection, once
 * `resourceDeclarationRefusals` found no worktree holding it as `own`.
 */
const redefaultSelections = Effect.fn("ResourcesRepo.redefaultSelections")(function* (
  tx: Tx,
  existing: StoredResourceDefinition,
  spec: ResourceDefinitionInput,
) {
  const mode = defaultChoiceFor(spec);
  if (mode === null) {
    yield* tx.delete(resourceSelections).where(eq(resourceSelections.definitionId, existing.id));
    return;
  }
  const rows = yield* tx
    .select()
    .from(resourceSelections)
    .where(eq(resourceSelections.definitionId, existing.id));
  for (const row of rows) {
    yield* writeSelection(tx, row, row, withRevision(spec, mode, row.revision + 1), null);
  }
});

/**
 * The project's row, locked in every state: it orders every declaration and a removal taking its
 * mark (0166), so each sees the other. Answers the fence that refuses a declaration, or null; a
 * mark that lapsed is a removal that stopped, and a removed project (0167) is marked for good.
 */
const lockProject = Effect.fn("ResourcesRepo.lockProject")(function* (
  tx: Tx,
  projectId: ProjectId,
) {
  const [project] = yield* tx
    .select({
      removing: sql<boolean>`removal_fence_marked(${projects.removalPhase}, ${projects.removalSince})`,
      removed: sql<boolean>`${projects.removedAt} IS NOT NULL`,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("no key update");
  if (project === undefined) {
    return yield* Effect.die(new Error(`project ${projectId} does not exist`));
  }
  const fence: ProjectFence | null = !project.removing
    ? null
    : project.removed
      ? "removed"
      : "removing";
  return fence;
});

/** The definition settings hold under `name`, row-locked; null for none. */
const lockByName = (tx: Tx, projectId: ProjectId, name: string) =>
  tx
    .select()
    .from(resourceDefinitions)
    .where(and(eq(resourceDefinitions.projectId, projectId), eq(resourceDefinitions.name, name)))
    .for("update")
    .pipe(Effect.map(([row]) => row ?? null));

/**
 * The project's settings as the rules decide against them (`ResourceSettingsState`): each
 * definition and how many worktrees hold it as `own`. Read under the project's lock and that of
 * the definition under the name decided.
 */
const settingsStateIn = Effect.fn("ResourcesRepo.settingsStateIn")(function* (
  tx: Tx,
  projectId: ProjectId,
) {
  const rows = yield* tx
    .select()
    .from(resourceDefinitions)
    .where(eq(resourceDefinitions.projectId, projectId));
  const owning = yield* tx
    .select({
      definitionId: resourceSelections.definitionId,
      owning: sql<number>`count(*)::int`,
    })
    .from(resourceSelections)
    .innerJoin(resourceDefinitions, eq(resourceDefinitions.id, resourceSelections.definitionId))
    .where(and(eq(resourceDefinitions.projectId, projectId), eq(resourceSelections.mode, "own")))
    .groupBy(resourceSelections.definitionId);
  const definitions = yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (row): Effect.fn.Return<SettingsDefinition> {
      const { id, spec, specDigest } = yield* toDefinition(row);
      return {
        spec,
        digest: specDigest,
        owning: owning.find((each) => each.definitionId === id)?.owning ?? 0,
      };
    }),
  );
  return { projectId, definitions } satisfies ResourceSettingsState;
});

/** Stores `added` under its name, its refusals decided under these locks, unless a removal holds its mark. */
const writeDeclarationIn = Effect.fn("ResourcesRepo.writeDeclarationIn")(function* (
  tx: Tx,
  projectId: ProjectId,
  added: AddedDefinition,
  addedBy: string,
) {
  const { spec, imageDigest } = added;
  const fence = yield* lockProject(tx, projectId);
  if (fence !== null) return yield* fenceRefusal(spec, fence);
  const encoded = yield* encodeSpec(spec).pipe(Effect.orDie);
  const specDigest = resourceSpecDigest(spec);
  const held = yield* lockByName(tx, projectId, spec.name);
  if (held === null) {
    const [inserted] = yield* tx
      .insert(resourceDefinitions)
      .values({
        id: ResourceDefinitionId.make(`rdef_${crypto.randomUUID()}`),
        projectId,
        name: spec.name,
        scope: spec.scope,
        preset: spec.preset,
        spec: encoded,
        specDigest,
        imageDigest,
        addedBy,
      })
      .returning();
    if (inserted === undefined) {
      return yield* Effect.die(new Error("a declared definition was not stored"));
    }
    return yield* toDefinition(inserted);
  }
  const existing = yield* toDefinition(held);
  if (existing.specDigest === specDigest && existing.imageDigest === imageDigest) return existing;
  if (changesWhatOwnIs(existing.spec, spec)) {
    yield* redefaultSelections(tx, existing, spec);
  }
  const [updated] = yield* tx
    .update(resourceDefinitions)
    .set({
      scope: spec.scope,
      preset: spec.preset,
      spec: encoded,
      specDigest,
      imageDigest,
      addedBy,
      updatedAt: sql`now()`,
    })
    .where(eq(resourceDefinitions.id, existing.id))
    .returning();
  if (updated === undefined) {
    return yield* Effect.die(new Error("a declared definition was not stored"));
  }
  return yield* toDefinition(updated);
});

/** Under the transaction: declares `added` as `declare` says. */
const declareIn = Effect.fn("ResourcesRepo.declareIn")(function* (
  tx: Tx,
  projectId: ProjectId,
  added: AddedDefinition,
  addedBy: string,
) {
  const { spec, imageDigest } = added;
  if (pinImage(spec.image, imageDigest) === null) {
    return yield* new ResourceDefinitionRefusedError({
      name: spec.name,
      refusals: [{ key: "image", message: `names another digest than ${imageDigest}` }],
    });
  }
  yield* lockProject(tx, projectId);
  yield* lockByName(tx, projectId, spec.name);
  const refusals = resourceDeclarationRefusals(yield* settingsStateIn(tx, projectId), spec);
  if (refusals.length > 0) {
    return yield* new ResourceDefinitionRefusedError({ name: spec.name, refusals });
  }
  return yield* writeDeclarationIn(tx, projectId, added, addedBy);
});

export const ResourcesRepoLive: Layer.Layer<ResourcesRepo, never, MendDB> = Layer.effect(
  ResourcesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

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

    const declare = (projectId: ProjectId, added: AddedDefinition, addedBy: string) =>
      db
        .transaction((tx) => declareIn(tx, projectId, added, addedBy))
        .pipe(Effect.catchTags(queryErrorsDie));

    const removeIfCurrent = Effect.fn("ResourcesRepo.removeIfCurrent")(function* (
      projectId: ProjectId,
      version: DefinitionVersion,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const definition = yield* lockDefinition(tx, version.id);
            if (definition.projectId !== projectId) {
              return yield* new ResourceDefinitionNotFoundError({ id: version.id });
            }
            if (definition.specDigest !== version.digest) {
              return yield* new ResourceDefinitionStaleError({
                definitionId: version.id,
                expected: version.digest,
                current: definition.specDigest,
              });
            }
            yield* tx.delete(resourceDefinitions).where(eq(resourceDefinitions.id, version.id));
            return definition;
          }),
        )
        .pipe(Effect.catchTags(queryErrorsDie));
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

    const ownSelections = Effect.fn("ResourcesRepo.ownSelections")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select({
          definitionId: resourceSelections.definitionId,
          owning: sql<number>`count(*)::int`,
        })
        .from(resourceSelections)
        .innerJoin(resourceDefinitions, eq(resourceDefinitions.id, resourceSelections.definitionId))
        .where(
          and(eq(resourceDefinitions.projectId, projectId), eq(resourceSelections.mode, "own")),
        )
        .groupBy(resourceSelections.definitionId)
        .pipe(Effect.orDie);
      return new Map(rows.map((row) => [row.definitionId, row.owning]));
    });

    const listWithChoices = Effect.fn("ResourcesRepo.listWithChoices")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
    ) {
      const definitions = yield* listForProject(projectId);
      if (definitions.length === 0 || worktreeId === null) {
        return definitions.map((definition) => ({ definition, choice: null }));
      }
      const choices = new Map(
        (yield* db
          .select({
            definitionId: resourceSelections.definitionId,
            mode: resourceSelections.mode,
          })
          .from(resourceSelections)
          .where(eq(resourceSelections.worktreeId, worktreeId))
          .pipe(Effect.orDie)).map((row) => [row.definitionId, row.mode]),
      );
      return definitions.map(
        (definition): DefinitionWithChoice => ({
          definition,
          choice: choices.get(definition.id) ?? null,
        }),
      );
    });

    const declaredNames = Effect.fn("ResourcesRepo.declaredNames")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select({ name: resourceDefinitions.name })
        .from(resourceDefinitions)
        .where(eq(resourceDefinitions.projectId, projectId))
        .orderBy(asc(resourceDefinitions.name))
        .pipe(Effect.orDie);
      return rows.map((row) => row.name);
    });

    const ensureSelection = Effect.fn("ResourcesRepo.ensureSelection")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const { spec } = yield* lockForWorktree(tx, projectId, worktreeId, definitionId);
            const mode = defaultChoiceFor(spec);
            if (mode === null) return null;
            const stored = yield* storedSelection(tx, worktreeId, definitionId);
            if (stored !== null) {
              const current = yield* toSelection(stored);
              if (selectionRefusal(spec, current.selection) === null) return current;
            }
            const revision = stored === null ? 0 : stored.revision + 1;
            return yield* writeSelection(
              tx,
              stored,
              { worktreeId, definitionId },
              withRevision(spec, mode, revision),
              null,
            );
          }),
        )
        .pipe(Effect.catchTags(queryErrorsDie));
    });

    const setSelection = Effect.fn("ResourcesRepo.setSelection")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      definitionId: ResourceDefinitionId,
      choice: SelectionChoice,
      chosenBy: string,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const { spec } = yield* lockForWorktree(tx, projectId, worktreeId, definitionId);
            const stored = yield* storedSelection(tx, worktreeId, definitionId);
            const revision = stored === null ? 0 : stored.revision + 1;
            const wanted = withRevision(spec, choice.mode, revision);
            const refusal = selectionRefusal(spec, wanted);
            if (refusal !== null) {
              return yield* new ResourceSelectionRefusedError({
                definitionId,
                name: spec.name,
                refusal,
              });
            }
            if (stored !== null && stored.mode === choice.mode) {
              const current = yield* toSelection(stored);
              if (selectionRefusal(spec, current.selection) === null) {
                // The same choice keeps its revision and target; a person choosing the default
                // still owns the choice from now on.
                return stored.chosenBy !== null
                  ? current
                  : yield* writeSelection(tx, stored, stored, current.selection, chosenBy);
              }
            }
            return yield* writeSelection(
              tx,
              stored,
              { worktreeId, definitionId },
              wanted,
              chosenBy,
            );
          }),
        )
        .pipe(Effect.catchTags(queryErrorsDie));
    });

    return {
      declare,
      removeIfCurrent,
      listForProject,
      listWithChoices,
      ownSelections,
      byName,
      declaredNames,
      ensureSelection,
      setSelection,
    };
  }),
);
