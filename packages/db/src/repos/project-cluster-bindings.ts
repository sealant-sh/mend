import { PgClient } from "@effect/sql-pg";
import { ProjectClusterBindingId, type ProjectId } from "@mend/domain";
import {
  CLUSTER_BINDING_MAX_ENTRIES,
  formatClusterBindingIssue,
  ProjectClusterBinding,
  ProjectClusterBindingsSnapshot,
  validateClusterObjectName,
  type ClusterBindingKind,
} from "@mend/domain/workbench";
import { asc, eq, sql as drizzleSql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { projectClusterBindings, projects } from "../schema/workbench.ts";
import { ProjectNotFoundError } from "./projects.ts";

/** 422 material: the object name failed the DNS-1123 grammar (or the set is full). */
export class ClusterBindingInvalidInputError extends Schema.TaggedErrorClass<ClusterBindingInvalidInputError>()(
  "ClusterBindingInvalidInputError",
  { message: Schema.String },
) {}

/** 409 material: the (kind, objectName) pair is already bound on this project. */
export class ClusterBindingDuplicateError extends Schema.TaggedErrorClass<ClusterBindingDuplicateError>()(
  "ClusterBindingDuplicateError",
  { kind: Schema.String, objectName: Schema.String },
) {}

export class ClusterBindingNotFoundError extends Schema.TaggedErrorClass<ClusterBindingNotFoundError>()(
  "ClusterBindingNotFoundError",
  { bindingId: Schema.String },
) {}

export interface ClusterBindingMutation {
  readonly binding: ProjectClusterBinding;
  /** New aggregate revision after this mutation. */
  readonly revision: number;
}

/**
 * Project cluster bindings (`.plans/cluster-env-sources.md`): name-only rows — Mend never holds
 * the bound object's keys or values, so there is no value-bearing read to guard. Same discipline
 * as the other env kinds: every mutation locks the project row `FOR UPDATE`, re-checks the
 * aggregate under the lock, bumps the shared aggregate revision (service-account changes bump the
 * same one), and emits a pointer-only event. The snapshot is one statement.
 */
export class ProjectClusterBindingsRepo extends Context.Service<
  ProjectClusterBindingsRepo,
  {
    /** Aggregate revision + kind/name-ordered bindings + the service account. Names only. */
    readonly snapshot: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectClusterBindingsSnapshot, ProjectNotFoundError>;
    readonly add: (
      projectId: ProjectId,
      input: { readonly kind: ClusterBindingKind; readonly objectName: string },
    ) => Effect.Effect<
      ClusterBindingMutation,
      ProjectNotFoundError | ClusterBindingInvalidInputError | ClusterBindingDuplicateError
    >;
    readonly remove: (
      projectId: ProjectId,
      bindingId: ProjectClusterBindingId,
    ) => Effect.Effect<
      { readonly revision: number },
      ProjectNotFoundError | ClusterBindingNotFoundError
    >;
    /** Set or clear (null) the workspace ServiceAccount; bumps the same aggregate revision. */
    readonly setServiceAccount: (
      projectId: ProjectId,
      serviceAccount: string | null,
    ) => Effect.Effect<
      { readonly serviceAccount: string | null; readonly revision: number },
      ProjectNotFoundError | ClusterBindingInvalidInputError
    >;
  }
>()("@mend/db/ProjectClusterBindingsRepo") {}

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete">;

const toBinding = (row: typeof projectClusterBindings.$inferSelect): ProjectClusterBinding =>
  new ProjectClusterBinding({
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    objectName: row.objectName,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const validateObjectName = (name: string): Effect.Effect<void, ClusterBindingInvalidInputError> => {
  const issue = validateClusterObjectName(name);
  return issue === null
    ? Effect.void
    : Effect.fail(
        new ClusterBindingInvalidInputError({ message: formatClusterBindingIssue(issue) }),
      );
};

const lockProject = (tx: Tx, projectId: ProjectId) =>
  Effect.gen(function* () {
    const [row] = yield* tx
      .select({
        clusterBindingRevision: projects.clusterBindingRevision,
        workspaceServiceAccount: projects.workspaceServiceAccount,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update")
      .pipe(Effect.orDie);
    if (row === undefined) return yield* new ProjectNotFoundError({ projectId });
    return row;
  });

const readAggregate = (tx: Tx, projectId: ProjectId) =>
  tx
    .select()
    .from(projectClusterBindings)
    .where(eq(projectClusterBindings.projectId, projectId))
    .orderBy(asc(projectClusterBindings.kind), asc(projectClusterBindings.objectName))
    .pipe(Effect.orDie);

const bumpAggregate = (tx: Tx, projectId: ProjectId) =>
  Effect.gen(function* () {
    const [row] = yield* tx
      .update(projects)
      .set({
        clusterBindingRevision: drizzleSql`${projects.clusterBindingRevision} + 1`,
        updatedAt: yield* DateTime.nowAsDate,
      })
      .where(eq(projects.id, projectId))
      .returning({ clusterBindingRevision: projects.clusterBindingRevision })
      .pipe(Effect.orDie);
    if (row === undefined) {
      return yield* Effect.die("cluster-binding aggregate bump lost the project row");
    }
    return row.clusterBindingRevision;
  });

export const ProjectClusterBindingsRepoLive: Layer.Layer<
  ProjectClusterBindingsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ProjectClusterBindingsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sqlClient = yield* PgClient.PgClient;

    const snapshot = Effect.fn("ProjectClusterBindingsRepo.snapshot")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select({
          clusterBindingRevision: projects.clusterBindingRevision,
          workspaceServiceAccount: projects.workspaceServiceAccount,
          binding: projectClusterBindings,
        })
        .from(projects)
        .leftJoin(projectClusterBindings, eq(projectClusterBindings.projectId, projects.id))
        .where(eq(projects.id, projectId))
        .orderBy(asc(projectClusterBindings.kind), asc(projectClusterBindings.objectName))
        .pipe(Effect.orDie);
      const first = rows[0];
      if (first === undefined) return yield* new ProjectNotFoundError({ projectId });
      return new ProjectClusterBindingsSnapshot({
        revision: first.clusterBindingRevision,
        bindings: rows.flatMap((row) => (row.binding === null ? [] : [toBinding(row.binding)])),
        serviceAccount: first.workspaceServiceAccount,
      });
    });

    const add = Effect.fn("ProjectClusterBindingsRepo.add")(function* (
      projectId: ProjectId,
      input: { readonly kind: ClusterBindingKind; readonly objectName: string },
    ) {
      yield* validateObjectName(input.objectName);
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            const existing = yield* readAggregate(tx, projectId);
            if (
              existing.some((row) => row.kind === input.kind && row.objectName === input.objectName)
            ) {
              return yield* new ClusterBindingDuplicateError({
                kind: input.kind,
                objectName: input.objectName,
              });
            }
            if (existing.length + 1 > CLUSTER_BINDING_MAX_ENTRIES) {
              return yield* new ClusterBindingInvalidInputError({
                message: `A project takes at most ${CLUSTER_BINDING_MAX_ENTRIES} cluster bindings (the platform's envFrom bound).`,
              });
            }
            const [created] = yield* tx
              .insert(projectClusterBindings)
              .values({
                id: ProjectClusterBindingId.make(crypto.randomUUID()),
                projectId,
                kind: input.kind,
                objectName: input.objectName,
              })
              .returning()
              .pipe(Effect.orDie);
            if (created === undefined) {
              return yield* Effect.die("cluster-binding insert returned no row");
            }
            const revision = yield* bumpAggregate(tx, projectId);
            return { binding: toBinding(created), revision };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    const remove = Effect.fn("ProjectClusterBindingsRepo.remove")(function* (
      projectId: ProjectId,
      bindingId: ProjectClusterBindingId,
    ) {
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            const [current] = yield* tx
              .select()
              .from(projectClusterBindings)
              .where(eq(projectClusterBindings.id, bindingId))
              .limit(1)
              .pipe(Effect.orDie);
            if (current === undefined || current.projectId !== projectId) {
              return yield* new ClusterBindingNotFoundError({ bindingId });
            }
            yield* tx
              .delete(projectClusterBindings)
              .where(eq(projectClusterBindings.id, bindingId))
              .pipe(Effect.orDie);
            const revision = yield* bumpAggregate(tx, projectId);
            return { revision };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    const setServiceAccount = Effect.fn("ProjectClusterBindingsRepo.setServiceAccount")(function* (
      projectId: ProjectId,
      serviceAccount: string | null,
    ) {
      if (serviceAccount !== null) yield* validateObjectName(serviceAccount);
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            yield* tx
              .update(projects)
              .set({
                workspaceServiceAccount: serviceAccount,
                updatedAt: yield* DateTime.nowAsDate,
              })
              .where(eq(projects.id, projectId))
              .pipe(Effect.orDie);
            const revision = yield* bumpAggregate(tx, projectId);
            return { serviceAccount, revision };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    return { snapshot, add, remove, setServiceAccount };
  }),
);
