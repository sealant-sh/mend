import {
  ProjectId,
  ProjectRemovalFenceId,
  ResourceApprovalId,
  ResourceDatabaseId,
  ResourceDefinitionId,
  ResourceInstanceId,
  ResourceProposalId,
  WorktreeId,
} from "@mend/domain";
import {
  defaultChoiceFor,
  envCollisionRefusals,
  type ImageDigest,
  imageDigestOf,
  isDatabasePreset,
  type OwnTarget,
  pinImage,
  ResourceDefinitionInput,
  resourceDefinitionRefusals,
  ResourceRefusal,
  ResourceSpecDigest,
  resourceSpecDigest,
  selectionRefusal,
  SelectionRevision,
  type WorktreeChoice,
  WorktreeSelection,
} from "@mend/domain/workbench";
import { and, asc, desc, eq, inArray, isNull, max, or, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import {
  projectRemovalFences,
  projects,
  resourceApprovals,
  resourceDefinitions,
  resourceProposals,
  resourceSelections,
  worktrees,
} from "../schema/workbench.ts";

/** A definition as a project's settings hold it (ADR 0019); a `mend.toml` proposal is not one. */
export interface StoredResourceDefinition {
  readonly id: ResourceDefinitionId;
  readonly projectId: ProjectId;
  readonly spec: ResourceDefinitionInput;
  /** The spec's digest when it was declared: what an approver reads and approves. */
  readonly specDigest: ResourceSpecDigest;
  readonly declaredBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One approved spec of a definition, its image pinned to the digest it resolved to. It approves
 * the declared spec `definitionDigest`, whenever the definition has it again.
 */
export interface ResourceApproval {
  readonly id: ResourceApprovalId;
  readonly definitionId: ResourceDefinitionId;
  /** Null for the project (a manager's); a worktree for that worktree only (decision G4). */
  readonly worktreeId: WorktreeId | null;
  readonly revision: number;
  readonly definitionDigest: ResourceSpecDigest;
  /** The digest of `spec`, the pinned spec that runs. */
  readonly digest: ResourceSpecDigest;
  readonly spec: ResourceDefinitionInput;
  readonly approvedBy: string;
  readonly approvedAt: Date;
}

export interface ApprovalRequest {
  readonly definitionId: ResourceDefinitionId;
  /** The declared spec's digest, as the approver read it. */
  readonly digest: ResourceSpecDigest;
  /** What the definition's image resolved to; resolving it is the caller's (ADR 0019, step 4). */
  readonly imageDigest: ImageDigest;
  /** Null approves for the project; a worktree approves a worktree resource for it alone. */
  readonly worktreeId: WorktreeId | null;
  readonly approvedBy: string;
}

export interface AdoptionRequest {
  readonly projectId: ProjectId;
  /** The spec its approver read, as they read it. */
  readonly spec: ResourceDefinitionInput;
  /** What settings held under the spec's name when it was read; null for nothing. */
  readonly settings: DefinitionVersion | null;
  readonly imageDigest: ImageDigest;
  readonly worktreeId: WorktreeId | null;
  readonly approvedBy: string;
}

/** An approval as its approver asks for it, before anything is resolved or written. */
export type ApprovalLookup = Pick<
  AdoptionRequest,
  "projectId" | "spec" | "settings" | "worktreeId"
>;

export interface Adopted {
  readonly definition: StoredResourceDefinition;
  readonly approval: ResourceApproval;
  /** False when the approval was made before, so its image is not what was just resolved. */
  readonly made: boolean;
}

/** A selection as a person asks for it; the repo mints an `own` target and numbers the revision. */
export type SelectionChoice = { readonly mode: WorktreeChoice };

/** A definition a member proposed in settings: never the project's until a manager adopts it. */
export interface StoredResourceProposal {
  readonly id: ResourceProposalId;
  readonly projectId: ProjectId;
  readonly spec: ResourceDefinitionInput;
  readonly specDigest: ResourceSpecDigest;
  readonly proposedBy: string;
  readonly proposedAt: Date;
}

export interface DefinitionWithApproval {
  readonly definition: StoredResourceDefinition;
  readonly approval: ResourceApproval | null;
  /** The listed worktree's stored choice; null when it made none, or no worktree was listed. */
  readonly choice: WorktreeChoice | null;
}

/** A definition as its reader saw it: removing or replacing it holds only while it still is. */
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

/** The spec changed after the approver read it: what they approved is not what would run. */
export class ResourceApprovalStaleError extends Schema.TaggedError<ResourceApprovalStaleError>()(
  "ResourceApprovalStaleError",
  {
    definitionId: ResourceDefinitionId,
    approving: ResourceSpecDigest,
    current: ResourceSpecDigest,
  },
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

/** Settings changed under the name since its approver read them, so nothing was adopted. */
export class ResourceSettingsStaleError extends Schema.TaggedError<ResourceSettingsStaleError>()(
  "ResourceSettingsStaleError",
  { name: Schema.String },
) {}

export class ResourceSelectionRefusedError extends Schema.TaggedError<ResourceSelectionRefusedError>()(
  "ResourceSelectionRefusedError",
  { definitionId: ResourceDefinitionId, refusal: ResourceRefusal },
) {}

/** Nothing archives a resource yet, so a project that has one is not removed (ADR 0019, step 4). */
export class ProjectHasResourcesError extends Schema.TaggedError<ProjectHasResourcesError>()(
  "ProjectHasResourcesError",
  { projectId: ProjectId, names: Schema.Array(Schema.String) },
) {}

export class ResourcesRepo extends Context.Service<
  ResourcesRepo,
  {
    /**
     * Declares `spec` under its name, or replaces that name's spec; the same spec twice is one
     * write. A new scope or preset re-defaults each worktree's selection, and is refused while a
     * worktree holds the resource as `own`.
     */
    readonly declare: (
      projectId: ProjectId,
      spec: ResourceDefinitionInput,
      declaredBy: string,
    ) => Effect.Effect<StoredResourceDefinition, ResourceDefinitionRefusedError>;
    /** Removes the definition while it holds the spec its remover read, and answers it. */
    readonly removeIfCurrent: (
      projectId: ProjectId,
      version: DefinitionVersion,
    ) => Effect.Effect<
      StoredResourceDefinition,
      ResourceDefinitionNotFoundError | ResourceDefinitionStaleError
    >;
    /**
     * Keeps `spec` as `proposedBy`'s proposal, apart from the project's definitions; the same
     * author proposing the same spec again gets the row they have.
     */
    readonly propose: (
      projectId: ProjectId,
      spec: ResourceDefinitionInput,
      proposedBy: string,
    ) => Effect.Effect<StoredResourceProposal, ResourceDefinitionRefusedError>;
    readonly proposals: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<StoredResourceProposal>>;
    readonly proposalById: (
      projectId: ProjectId,
      id: ResourceProposalId,
    ) => Effect.Effect<StoredResourceProposal | null>;
    /** Removes the proposal; false when the project holds none by that id. */
    readonly withdrawProposal: (
      projectId: ProjectId,
      id: ResourceProposalId,
    ) => Effect.Effect<boolean>;
    readonly listForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<StoredResourceDefinition>>;
    /**
     * Each definition with the latest approval of the spec it holds as read: a manager's for the
     * project, or, for a worktree resource, `worktreeId`'s own (decision G4); and `worktreeId`'s
     * stored choice, read as it is, writing no default. Three queries.
     */
    readonly listWithApprovals: (
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
    ) => Effect.Effect<ReadonlyArray<DefinitionWithApproval>>;
    readonly byName: (
      projectId: ProjectId,
      name: string,
    ) => Effect.Effect<StoredResourceDefinition | null>;
    /**
     * Fences the project against new definitions for one removal, unless it has one: then it names
     * them and sets no fence. Each removal holds its own fence, so the project stays fenced while
     * any removal is in flight. A fence goes with the project's row, or with
     * `liftProjectRemovalFence` of the fence its removal was given.
     */
    readonly fenceProjectRemoval: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectRemovalFenceId, ProjectHasResourcesError>;
    readonly liftProjectRemovalFence: (fence: ProjectRemovalFenceId) => Effect.Effect<void>;
    /**
     * Approves the declared spec the approver read, pinned, as the current approval of that spec;
     * approving it again with the image it already pins is one row.
     */
    readonly approve: (
      request: ApprovalRequest,
    ) => Effect.Effect<
      ResourceApproval,
      ResourceDefinitionNotFoundError | ResourceApprovalStaleError | ResourceDefinitionRefusedError
    >;
    /**
     * Declares `spec` and approves it, pinned, in one transaction, while settings still hold under
     * its name what its approver read (`settings`, null for nothing), or `spec` itself. An
     * approval of this spec for this target already made is the one answered: nothing repins it.
     */
    readonly adoptAndApprove: (
      request: AdoptionRequest,
    ) => Effect.Effect<
      Adopted,
      | ResourceSettingsStaleError
      | ResourceDefinitionNotFoundError
      | ResourceApprovalStaleError
      | ResourceDefinitionRefusedError
    >;
    /**
     * The approval already made of `spec` for exactly this target, while settings hold `spec` under
     * its name and still hold what its approver read, checked as `adoptAndApprove` checks; null
     * when there is none yet, so the caller resolves the image and adopts.
     */
    readonly approvalAsRead: (
      lookup: ApprovalLookup,
    ) => Effect.Effect<Adopted | null, ResourceSettingsStaleError>;
    /**
     * The latest approval of the definition's spec as declared now, for the project or for
     * `worktreeId`; null until that spec is approved.
     */
    readonly currentApproval: (
      definitionId: ResourceDefinitionId,
      worktreeId: WorktreeId | null,
    ) => Effect.Effect<ResourceApproval | null, ResourceDefinitionNotFoundError>;
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

const toDefinition = (row: DefinitionRow) =>
  decodeSpec(row.spec).pipe(
    Effect.map(
      (spec): StoredResourceDefinition => ({
        id: row.id,
        projectId: row.projectId,
        spec,
        specDigest: row.specDigest,
        declaredBy: row.declaredBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    ),
    Effect.orDie,
  );

const toProposal = (row: typeof resourceProposals.$inferSelect) =>
  decodeSpec(row.spec).pipe(
    Effect.map(
      (spec): StoredResourceProposal => ({
        id: row.id,
        projectId: row.projectId,
        spec,
        specDigest: row.specDigest,
        proposedBy: row.proposedBy,
        proposedAt: row.proposedAt,
      }),
    ),
    Effect.orDie,
  );

const toApproval = (row: typeof resourceApprovals.$inferSelect) =>
  decodeSpec(row.spec).pipe(
    Effect.map((spec): ResourceApproval => ({ ...row, spec })),
    Effect.orDie,
  );

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

/** The definition, row-locked: every write to it, its approvals and its selections takes this. */
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

const fenceRefusal = (spec: ResourceDefinitionInput) =>
  new ResourceDefinitionRefusedError({
    name: spec.name,
    refusals: [
      {
        key: "project",
        message: "is being removed · declare it again if the removal stops",
      },
    ],
  });

/** Under the definition's lock: what a new scope or preset does to each worktree's selection. */
const redefaultSelections = Effect.fn("ResourcesRepo.redefaultSelections")(function* (
  tx: Tx,
  existing: StoredResourceDefinition,
  spec: ResourceDefinitionInput,
) {
  const rows = yield* tx
    .select()
    .from(resourceSelections)
    .where(eq(resourceSelections.definitionId, existing.id));
  const owning = rows.filter((row) => row.mode === "own").length;
  if (owning > 0) {
    return yield* new ResourceDefinitionRefusedError({
      name: spec.name,
      refusals: [
        {
          key: existing.spec.scope === spec.scope ? "preset" : "scope",
          message:
            owning === 1
              ? `changes what own is, and 1 worktree holds @${spec.name} as own, with data of its own · switch it to shared or off first`
              : `changes what own is, and ${owning} worktrees hold @${spec.name} as own, with data of their own · switch them to shared or off first`,
        },
      ],
    });
  }
  const mode = defaultChoiceFor(spec);
  if (mode === null) {
    yield* tx.delete(resourceSelections).where(eq(resourceSelections.definitionId, existing.id));
    return;
  }
  for (const row of rows) {
    yield* writeSelection(tx, row, row, withRevision(spec, mode, row.revision + 1), null);
  }
});

/** Whether a manager approved, for the project, an image with this digest for any of its resources. */
const projectApprovedImage = (tx: Tx, projectId: ProjectId, imageDigest: ImageDigest) =>
  tx
    .select({ spec: resourceApprovals.spec })
    .from(resourceApprovals)
    .innerJoin(resourceDefinitions, eq(resourceDefinitions.id, resourceApprovals.definitionId))
    .where(and(eq(resourceDefinitions.projectId, projectId), isNull(resourceApprovals.worktreeId)))
    .pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeSpec(row.spec))),
      Effect.orDie,
      Effect.map((specs) => specs.some((spec) => imageDigestOf(spec.image) === imageDigest)),
    );

/** A project resource is approved for the project, never one worktree; null when `spec` may be. */
export const approvalScopeRefusal = (
  spec: ResourceDefinitionInput,
  worktreeId: WorktreeId | null,
): ResourceRefusal | null =>
  worktreeId !== null && spec.scope !== "worktree"
    ? {
        key: "worktree",
        message: `is one worktree, and @${spec.name} is a project resource, approved for the project`,
      }
    : null;

/** Why `request` may not approve a worktree resource for its worktree, or null when it may. */
const worktreeApprovalRefusal = Effect.fn("ResourcesRepo.worktreeApprovalRefusal")(function* (
  tx: Tx,
  definition: StoredResourceDefinition,
  worktreeId: WorktreeId,
  imageDigest: ImageDigest,
) {
  const scope = approvalScopeRefusal(definition.spec, worktreeId);
  if (scope !== null) return scope;
  if ((yield* worktreeProject(tx, worktreeId)) !== definition.projectId) {
    return {
      key: "worktree",
      message: `is not a worktree of the project that declares @${definition.spec.name}`,
    };
  }
  if (!(yield* projectApprovedImage(tx, definition.projectId, imageDigest))) {
    return {
      key: "image",
      message: `is ${imageDigest}, which no manager approved for this project`,
    };
  }
  return null;
});

/** Under the transaction: declares `spec` as `declare` says. */
const declareIn = Effect.fn("ResourcesRepo.declareIn")(function* (
  tx: Tx,
  projectId: ProjectId,
  spec: ResourceDefinitionInput,
  declaredBy: string,
) {
  const refusals = resourceDefinitionRefusals(spec);
  if (refusals.length > 0) {
    return yield* new ResourceDefinitionRefusedError({ name: spec.name, refusals });
  }
  const encoded = yield* encodeSpec(spec).pipe(Effect.orDie);
  const specDigest = resourceSpecDigest(spec);
  // The project's row lock orders declarations and the removal fence: each sees the other.
  const [project] = yield* tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("no key update");
  if (project === undefined) {
    return yield* Effect.die(new Error(`project ${projectId} does not exist`));
  }
  const [fence] = yield* tx
    .select({ id: projectRemovalFences.id })
    .from(projectRemovalFences)
    .where(eq(projectRemovalFences.projectId, projectId))
    .limit(1);
  if (fence !== undefined) return yield* fenceRefusal(spec);

  const others = yield* tx
    .select()
    .from(resourceDefinitions)
    .where(eq(resourceDefinitions.projectId, projectId));
  const declared = yield* Effect.forEach(
    others.filter((row) => row.name !== spec.name),
    toDefinition,
  );
  const collisions = envCollisionRefusals([
    ...declared.map((definition) => definition.spec),
    spec,
  ]).flatMap(({ resource, refusal }) => (resource === spec.name ? [refusal] : []));
  if (collisions.length > 0) {
    return yield* new ResourceDefinitionRefusedError({
      name: spec.name,
      refusals: collisions,
    });
  }

  const sameName = others.find((row) => row.name === spec.name);
  if (sameName === undefined) {
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
        declaredBy,
      })
      .returning();
    if (inserted === undefined) {
      return yield* Effect.die(new Error("a declared definition was not stored"));
    }
    return yield* toDefinition(inserted);
  }
  const existing = yield* lockDefinition(tx, sameName.id).pipe(
    Effect.catchTag("ResourceDefinitionNotFoundError", Effect.die),
  );
  if (existing.specDigest === specDigest) return existing;
  if (existing.spec.scope !== spec.scope || existing.spec.preset !== spec.preset) {
    yield* redefaultSelections(tx, existing, spec);
  }
  const [updated] = yield* tx
    .update(resourceDefinitions)
    .set({
      scope: spec.scope,
      preset: spec.preset,
      spec: encoded,
      specDigest,
      declaredBy,
      updatedAt: sql`now()`,
    })
    .where(eq(resourceDefinitions.id, existing.id))
    .returning();
  if (updated === undefined) {
    return yield* Effect.die(new Error("a declared definition was not stored"));
  }
  return yield* toDefinition(updated);
});

/** Under the transaction: approves as `approve` says. */
const approveIn = Effect.fn("ResourcesRepo.approveIn")(function* (
  tx: Tx,
  request: ApprovalRequest,
) {
  const { definitionId, digest, imageDigest, worktreeId, approvedBy } = request;
  const definition = yield* lockDefinition(tx, definitionId);
  const { spec } = definition;
  if (definition.specDigest !== digest) {
    return yield* new ResourceApprovalStaleError({
      definitionId,
      approving: digest,
      current: definition.specDigest,
    });
  }
  const refuse = (refusals: ReadonlyArray<ResourceRefusal>) =>
    new ResourceDefinitionRefusedError({ name: spec.name, refusals });
  const image = pinImage(spec.image, imageDigest);
  if (image === null) {
    return yield* refuse([{ key: "image", message: `names another digest than ${imageDigest}` }]);
  }
  const pinned: ResourceDefinitionInput = { ...spec, image };
  const refusals = resourceDefinitionRefusals(pinned);
  if (refusals.length > 0) return yield* refuse(refusals);
  if (worktreeId !== null) {
    const refusal = yield* worktreeApprovalRefusal(tx, definition, worktreeId, imageDigest);
    if (refusal !== null) return yield* refuse([refusal]);
  }

  // Under the definition's lock: the latest approval of this declared spec, here, is the
  // one that runs. It is returned when it already pins this image; otherwise a new
  // revision is, so a spec declared again or a tag that moved back becomes current.
  const pinnedDigest = resourceSpecDigest(pinned);
  const [latestHere] = yield* tx
    .select()
    .from(resourceApprovals)
    .where(
      and(
        eq(resourceApprovals.definitionId, definitionId),
        eq(resourceApprovals.definitionDigest, digest),
        worktreeId === null
          ? isNull(resourceApprovals.worktreeId)
          : eq(resourceApprovals.worktreeId, worktreeId),
      ),
    )
    .orderBy(desc(resourceApprovals.revision))
    .limit(1);
  if (latestHere?.digest === pinnedDigest) return yield* toApproval(latestHere);
  const [latest] = yield* tx
    .select({ revision: max(resourceApprovals.revision) })
    .from(resourceApprovals)
    .where(eq(resourceApprovals.definitionId, definitionId));
  const [inserted] = yield* tx
    .insert(resourceApprovals)
    .values({
      id: ResourceApprovalId.make(`rapr_${crypto.randomUUID()}`),
      definitionId,
      worktreeId,
      revision: (latest?.revision ?? 0) + 1,
      definitionDigest: digest,
      digest: pinnedDigest,
      spec: yield* encodeSpec(pinned).pipe(Effect.orDie),
      approvedBy,
    })
    .returning();
  if (inserted === undefined) return yield* Effect.die(new Error("approval not stored"));
  return yield* toApproval(inserted);
});

/** The latest approval of declared spec `digest` for exactly this target. */
const exactApprovalIn = (
  tx: Tx,
  definitionId: ResourceDefinitionId,
  digest: ResourceSpecDigest,
  worktreeId: WorktreeId | null,
) =>
  tx
    .select()
    .from(resourceApprovals)
    .where(
      and(
        eq(resourceApprovals.definitionId, definitionId),
        eq(resourceApprovals.definitionDigest, digest),
        worktreeId === null
          ? isNull(resourceApprovals.worktreeId)
          : eq(resourceApprovals.worktreeId, worktreeId),
      ),
    )
    .orderBy(desc(resourceApprovals.revision))
    .limit(1)
    .pipe(Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(null) : toApproval(row))));

/**
 * The definition settings hold under the spec's name, row-locked, while it is what the approver
 * read; null when they hold none. The project's row lock orders this against every declaration.
 */
const heldAsRead = Effect.fn("ResourcesRepo.heldAsRead")(function* (
  tx: Tx,
  lookup: ApprovalLookup,
) {
  const { projectId, spec, settings } = lookup;
  const digest = resourceSpecDigest(spec);
  yield* tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("no key update");
  const [held] = yield* tx
    .select()
    .from(resourceDefinitions)
    .where(
      and(eq(resourceDefinitions.projectId, projectId), eq(resourceDefinitions.name, spec.name)),
    )
    .for("update");
  // A read of a definition holds only for that definition, at the digest read or already at
  // `spec`'s; a read of none holds while there is none, or `spec` itself on a retry.
  const asRead =
    settings === null
      ? held === undefined || held.specDigest === digest
      : held?.id === settings.id &&
        (held.specDigest === settings.digest || held.specDigest === digest);
  if (!asRead) return yield* new ResourceSettingsStaleError({ name: spec.name });
  return held === undefined ? null : yield* toDefinition(held);
});

/** Adopts and approves as `adoptAndApprove` says: one transaction, settings checked under lock. */
const adoptIn = Effect.fn("ResourcesRepo.adoptIn")(function* (tx: Tx, request: AdoptionRequest) {
  const { projectId, spec } = request;
  yield* heldAsRead(tx, request);
  const definition = yield* declareIn(tx, projectId, spec, request.approvedBy);
  const digest = definition.specDigest;
  const existing = yield* exactApprovalIn(tx, definition.id, digest, request.worktreeId);
  if (existing !== null) return { definition, approval: existing, made: false };
  const approval = yield* approveIn(tx, {
    definitionId: definition.id,
    digest,
    imageDigest: request.imageDigest,
    worktreeId: request.worktreeId,
    approvedBy: request.approvedBy,
  });
  return { definition, approval, made: true };
});

/** `approvalAsRead`, under the locks `adoptIn` takes. */
const approvalAsReadIn = Effect.fn("ResourcesRepo.approvalAsReadIn")(function* (
  tx: Tx,
  lookup: ApprovalLookup,
) {
  const held = yield* heldAsRead(tx, lookup);
  if (held === null || held.specDigest !== resourceSpecDigest(lookup.spec)) return null;
  const approval = yield* exactApprovalIn(tx, held.id, held.specDigest, lookup.worktreeId);
  return approval === null ? null : { definition: held, approval, made: false };
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

    const declare = (projectId: ProjectId, spec: ResourceDefinitionInput, declaredBy: string) =>
      db
        .transaction((tx) => declareIn(tx, projectId, spec, declaredBy))
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

    const propose = Effect.fn("ResourcesRepo.propose")(function* (
      projectId: ProjectId,
      spec: ResourceDefinitionInput,
      proposedBy: string,
    ) {
      const refusals = resourceDefinitionRefusals(spec);
      if (refusals.length > 0) {
        return yield* new ResourceDefinitionRefusedError({ name: spec.name, refusals });
      }
      const specDigest = resourceSpecDigest(spec);
      // One statement: the author's row for this spec is locked and answered, or a new one is
      // stored, so a withdrawal committing meanwhile cannot leave the proposal unanswered.
      const [stored] = yield* db
        .insert(resourceProposals)
        .values({
          id: ResourceProposalId.make(`rprop_${crypto.randomUUID()}`),
          projectId,
          name: spec.name,
          spec: yield* encodeSpec(spec).pipe(Effect.orDie),
          specDigest,
          proposedBy,
        })
        .onConflictDoUpdate({
          target: [
            resourceProposals.projectId,
            resourceProposals.proposedBy,
            resourceProposals.specDigest,
          ],
          set: { specDigest },
        })
        .returning()
        .pipe(Effect.orDie);
      if (stored === undefined) return yield* Effect.die(new Error("a proposal was not stored"));
      return yield* toProposal(stored);
    });

    const proposals = Effect.fn("ResourcesRepo.proposals")(function* (projectId: ProjectId) {
      const rows = yield* db
        .select()
        .from(resourceProposals)
        .where(eq(resourceProposals.projectId, projectId))
        .orderBy(asc(resourceProposals.name), asc(resourceProposals.proposedAt))
        .pipe(Effect.orDie);
      return yield* Effect.forEach(rows, toProposal);
    });

    const proposalById = Effect.fn("ResourcesRepo.proposalById")(function* (
      projectId: ProjectId,
      id: ResourceProposalId,
    ) {
      const [row] = yield* db
        .select()
        .from(resourceProposals)
        .where(and(eq(resourceProposals.projectId, projectId), eq(resourceProposals.id, id)))
        .pipe(Effect.orDie);
      return row === undefined ? null : yield* toProposal(row);
    });

    const withdrawProposal = Effect.fn("ResourcesRepo.withdrawProposal")(function* (
      projectId: ProjectId,
      id: ResourceProposalId,
    ) {
      const removed = yield* db
        .delete(resourceProposals)
        .where(and(eq(resourceProposals.projectId, projectId), eq(resourceProposals.id, id)))
        .returning({ id: resourceProposals.id })
        .pipe(Effect.orDie);
      return removed.length > 0;
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

    const listWithApprovals = Effect.fn("ResourcesRepo.listWithApprovals")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId | null,
    ) {
      const definitions = yield* listForProject(projectId);
      if (definitions.length === 0) return [];
      const forProject = isNull(resourceApprovals.worktreeId);
      const rows = yield* db
        .select()
        .from(resourceApprovals)
        .where(
          and(
            inArray(
              resourceApprovals.definitionId,
              definitions.map((definition) => definition.id),
            ),
            worktreeId === null
              ? forProject
              : or(forProject, eq(resourceApprovals.worktreeId, worktreeId)),
          ),
        )
        .orderBy(desc(resourceApprovals.revision))
        .pipe(Effect.orDie);
      const choices = new Map(
        worktreeId === null
          ? []
          : (yield* db
              .select({
                definitionId: resourceSelections.definitionId,
                mode: resourceSelections.mode,
              })
              .from(resourceSelections)
              .where(eq(resourceSelections.worktreeId, worktreeId))
              .pipe(Effect.orDie)).map((row) => [row.definitionId, row.mode]),
      );
      return yield* Effect.forEach(
        definitions,
        Effect.fnUntraced(function* (definition): Effect.fn.Return<DefinitionWithApproval> {
          // Bound to the digest listed, so a spec declared since cannot borrow its approval.
          const row = rows.find(
            (approval) =>
              approval.definitionId === definition.id &&
              approval.definitionDigest === definition.specDigest &&
              (approval.worktreeId === null || definition.spec.scope === "worktree"),
          );
          return {
            definition,
            approval: row === undefined ? null : yield* toApproval(row),
            choice: choices.get(definition.id) ?? null,
          };
        }),
      );
    });

    const fenceProjectRemoval = Effect.fn("ResourcesRepo.fenceProjectRemoval")(function* (
      projectId: ProjectId,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // Waits for a declaration in flight, then reads what it stored. Names only, so a spec
            // that no longer decodes still refuses by name.
            yield* tx
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.id, projectId))
              .for("no key update");
            const declared = yield* tx
              .select({ name: resourceDefinitions.name })
              .from(resourceDefinitions)
              .where(eq(resourceDefinitions.projectId, projectId))
              .orderBy(asc(resourceDefinitions.name));
            if (declared.length > 0) {
              return yield* new ProjectHasResourcesError({
                projectId,
                names: declared.map((row) => row.name),
              });
            }
            const id = ProjectRemovalFenceId.make(`rfen_${crypto.randomUUID()}`);
            yield* tx.insert(projectRemovalFences).values({ id, projectId });
            return id;
          }),
        )
        .pipe(Effect.catchTags(queryErrorsDie));
    });

    const liftProjectRemovalFence = Effect.fn("ResourcesRepo.liftProjectRemovalFence")(function* (
      fence: ProjectRemovalFenceId,
    ) {
      yield* db
        .delete(projectRemovalFences)
        .where(eq(projectRemovalFences.id, fence))
        .pipe(Effect.orDie);
    });

    const approve = (request: ApprovalRequest) =>
      db.transaction((tx) => approveIn(tx, request)).pipe(Effect.catchTags(queryErrorsDie));

    const adoptAndApprove = (request: AdoptionRequest) =>
      db.transaction((tx) => adoptIn(tx, request)).pipe(Effect.catchTags(queryErrorsDie));

    const approvalAsRead = (lookup: ApprovalLookup) =>
      db.transaction((tx) => approvalAsReadIn(tx, lookup)).pipe(Effect.catchTags(queryErrorsDie));

    const currentApproval = Effect.fn("ResourcesRepo.currentApproval")(function* (
      definitionId: ResourceDefinitionId,
      worktreeId: WorktreeId | null,
    ) {
      const [definition] = yield* db
        .select({ specDigest: resourceDefinitions.specDigest })
        .from(resourceDefinitions)
        .where(eq(resourceDefinitions.id, definitionId))
        .pipe(Effect.orDie);
      if (definition === undefined) {
        return yield* new ResourceDefinitionNotFoundError({ id: definitionId });
      }
      const forProject = isNull(resourceApprovals.worktreeId);
      const [row] = yield* db
        .select()
        .from(resourceApprovals)
        .where(
          and(
            eq(resourceApprovals.definitionId, definitionId),
            eq(resourceApprovals.definitionDigest, definition.specDigest),
            worktreeId === null
              ? forProject
              : or(forProject, eq(resourceApprovals.worktreeId, worktreeId)),
          ),
        )
        .orderBy(desc(resourceApprovals.revision))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : yield* toApproval(row);
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
              return yield* new ResourceSelectionRefusedError({ definitionId, refusal });
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
      propose,
      proposals,
      proposalById,
      withdrawProposal,
      listForProject,
      listWithApprovals,
      byName,
      fenceProjectRemoval,
      liftProjectRemovalFence,
      approve,
      adoptAndApprove,
      approvalAsRead,
      currentApproval,
      ensureSelection,
      setSelection,
    };
  }),
);
