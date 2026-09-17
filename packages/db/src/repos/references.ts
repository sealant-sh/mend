import { ReferenceId, type OrganizationId, type ProjectId, type Sha } from "@mend/domain";
import { Reference } from "@mend/domain/workbench";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { projectReferences, referenceRepos } from "../schema/workbench.ts";

export class ReferenceNotFoundError extends Schema.TaggedErrorClass<ReferenceNotFoundError>()(
  "ReferenceNotFoundError",
  {
    referenceId: Schema.String,
  },
) {}

export interface NewReference {
  /** Minted by the caller: the clone directory is keyed by it. */
  readonly id: ReferenceId;
  readonly organizationId: OrganizationId;
  readonly createdByUserId: string;
  readonly name: string;
  readonly originUrl: string;
  readonly path: string;
  readonly pinnedRef: string | null;
  readonly headSha: Sha | null;
}

/**
 * The index of reference clones (plan §17, decided 2026-08-01) — table
 * `reference_repos` (`references` is reserved SQL). Each belongs to an organization
 * (docs/adr/0003-organizations-and-tenancy.md); the clones themselves are git on disk under the
 * store's `_organizations/<id>/references/`; selection is per project.
 */
export class ReferencesRepo extends Context.Service<
  ReferencesRepo,
  {
    readonly create: (reference: NewReference) => Effect.Effect<Reference>;
    readonly byId: (id: ReferenceId) => Effect.Effect<Reference, ReferenceNotFoundError>;
    readonly byName: (
      organizationId: OrganizationId,
      name: string,
    ) => Effect.Effect<Reference | null>;
    readonly listForOrganization: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<Reference>>;
    /** The requested references that belong to the organization; others are left out. */
    readonly byIdsInOrganization: (
      organizationId: OrganizationId,
      ids: ReadonlyArray<ReferenceId>,
    ) => Effect.Effect<ReadonlyArray<Reference>>;
    readonly remove: (id: ReferenceId) => Effect.Effect<void>;
    /** After a refresh: the clone's HEAD as just observed. */
    readonly setHead: (id: ReferenceId, headSha: Sha) => Effect.Effect<void>;
    /** The references this project's sessions mount, in name order. */
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<Reference>>;
    /** Replace the project's selection wholesale — the UI edits it as a set. */
    readonly setForProject: (
      projectId: ProjectId,
      referenceIds: ReadonlyArray<ReferenceId>,
    ) => Effect.Effect<void>;
  }
>()("@mend/db/ReferencesRepo") {}

const toReference = (row: typeof referenceRepos.$inferSelect): Reference => new Reference(row);

export const ReferencesRepoLive: Layer.Layer<ReferencesRepo, never, MendDB> = Layer.effect(
  ReferencesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const create = Effect.fn("ReferencesRepo.create")(function* (reference: NewReference) {
      const [row] = yield* db
        .insert(referenceRepos)
        .values({ ...reference, refreshedAt: new Date() })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("reference insert returned no row");
      return toReference(row);
    });

    const byId = Effect.fn("ReferencesRepo.byId")(function* (id: ReferenceId) {
      const [row] = yield* db
        .select()
        .from(referenceRepos)
        .where(eq(referenceRepos.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new ReferenceNotFoundError({ referenceId: id });
      return toReference(row);
    });

    const byName = Effect.fn("ReferencesRepo.byName")(function* (
      organizationId: OrganizationId,
      name: string,
    ) {
      const [row] = yield* db
        .select()
        .from(referenceRepos)
        .where(
          and(eq(referenceRepos.organizationId, organizationId), eq(referenceRepos.name, name)),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toReference(row);
    });

    const listForOrganization = Effect.fn("ReferencesRepo.listForOrganization")(function* (
      organizationId: OrganizationId,
    ) {
      const rows = yield* db
        .select()
        .from(referenceRepos)
        .where(eq(referenceRepos.organizationId, organizationId))
        .orderBy(asc(referenceRepos.name))
        .pipe(Effect.orDie);
      return rows.map(toReference);
    });

    const byIdsInOrganization = Effect.fn("ReferencesRepo.byIdsInOrganization")(function* (
      organizationId: OrganizationId,
      ids: ReadonlyArray<ReferenceId>,
    ) {
      if (ids.length === 0) return [];
      const rows = yield* db
        .select()
        .from(referenceRepos)
        .where(
          and(
            eq(referenceRepos.organizationId, organizationId),
            inArray(referenceRepos.id, [...ids]),
          ),
        )
        .pipe(Effect.orDie);
      return rows.map(toReference);
    });

    const remove = Effect.fn("ReferencesRepo.remove")(function* (id: ReferenceId) {
      yield* db.delete(referenceRepos).where(eq(referenceRepos.id, id)).pipe(Effect.orDie);
    });

    const setHead = Effect.fn("ReferencesRepo.setHead")(function* (id: ReferenceId, head: Sha) {
      const now = new Date();
      yield* db
        .update(referenceRepos)
        .set({ headSha: head, refreshedAt: now, updatedAt: now })
        .where(eq(referenceRepos.id, id))
        .pipe(Effect.orDie);
    });

    const listForProject = Effect.fn("ReferencesRepo.listForProject")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select({ reference: referenceRepos })
        .from(referenceRepos)
        .innerJoin(projectReferences, eq(projectReferences.referenceId, referenceRepos.id))
        .where(eq(projectReferences.projectId, projectId))
        .orderBy(asc(referenceRepos.name))
        .pipe(Effect.orDie);
      return rows.map(({ reference }) => toReference(reference));
    });

    const setForProject = Effect.fn("ReferencesRepo.setForProject")(function* (
      projectId: ProjectId,
      referenceIds: ReadonlyArray<ReferenceId>,
    ) {
      yield* db
        .delete(projectReferences)
        .where(eq(projectReferences.projectId, projectId))
        .pipe(Effect.orDie);
      if (referenceIds.length === 0) return;
      yield* db
        .insert(projectReferences)
        .values(referenceIds.map((referenceId) => ({ projectId, referenceId })))
        .onConflictDoNothing()
        .pipe(Effect.orDie);
    });

    return {
      create,
      byId,
      byName,
      listForOrganization,
      byIdsInOrganization,
      remove,
      setHead,
      listForProject,
      setForProject,
    };
  }),
);
