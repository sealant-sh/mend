import { PgClient } from "@effect/sql-pg";
import { ProjectEnvironmentVariableId, type ProjectId } from "@mend/domain";
import {
  formatProjectEnvironmentIssue,
  PROJECT_ENV_MAX_ENTRIES,
  PROJECT_ENV_MAX_TOTAL_BYTES,
  ProjectEnvironmentSnapshot,
  ProjectEnvironmentVariable,
  projectEnvironmentBytes,
  validateProjectEnvironmentName,
  validateProjectEnvironmentValue,
} from "@mend/domain/workbench";
import { asc, eq, sql as drizzleSql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { projectEnvironmentVariables, projects } from "../schema/workbench.ts";
import { ProjectNotFoundError } from "./projects.ts";

/** Name or value refused by the policy. Field + rule + wording only — never the value. */
export class ProjectEnvironmentInvalidInputError extends Schema.TaggedErrorClass<ProjectEnvironmentInvalidInputError>()(
  "ProjectEnvironmentInvalidInputError",
  {
    issues: Schema.Array(
      Schema.Struct({
        field: Schema.Literals(["name", "value"]),
        rule: Schema.String,
        message: Schema.String,
      }),
    ),
  },
) {}

export class ProjectEnvironmentDuplicateNameError extends Schema.TaggedErrorClass<ProjectEnvironmentDuplicateNameError>()(
  "ProjectEnvironmentDuplicateNameError",
  { name: Schema.String },
) {}

export class ProjectEnvironmentLimitError extends Schema.TaggedErrorClass<ProjectEnvironmentLimitError>()(
  "ProjectEnvironmentLimitError",
  {
    kind: Schema.Literals(["entries", "bytes"]),
    limit: Schema.Int,
  },
) {}

export class ProjectEnvironmentVariableNotFoundError extends Schema.TaggedErrorClass<ProjectEnvironmentVariableNotFoundError>()(
  "ProjectEnvironmentVariableNotFoundError",
  { variableId: Schema.String },
) {}

/** The row moved since the caller read it; the browser draft survives, the write does not. */
export class ProjectEnvironmentStaleWriteError extends Schema.TaggedErrorClass<ProjectEnvironmentStaleWriteError>()(
  "ProjectEnvironmentStaleWriteError",
  {
    variableId: Schema.String,
    currentRevision: Schema.Int,
  },
) {}

/** A persisted row no longer parses (rule only — the stored value never enters diagnostics). */
export class ProjectEnvironmentCorruptRecordError extends Schema.TaggedErrorClass<ProjectEnvironmentCorruptRecordError>()(
  "ProjectEnvironmentCorruptRecordError",
  {
    variableId: Schema.String,
    rule: Schema.String,
  },
) {}

export interface ProjectEnvironmentVariableInput {
  readonly name: string;
  readonly value: string;
}

export interface ProjectEnvironmentMutation {
  readonly variable: ProjectEnvironmentVariable;
  /** New aggregate revision after this mutation. */
  readonly revision: number;
}

export type ProjectEnvironmentWriteError =
  | ProjectNotFoundError
  | ProjectEnvironmentInvalidInputError
  | ProjectEnvironmentDuplicateNameError
  | ProjectEnvironmentLimitError;

/**
 * Project environment variables (`docs/archive/plans/project-environment-variables.md`). Every mutation locks
 * the owning project row `FOR UPDATE`, re-checks the complete aggregate under that lock (unique
 * name, entry count, total bytes), applies the row change, and bumps
 * `projects.environment_revision` before commit — two concurrent creates at the final slot
 * serialize on the lock, and a launch snapshot read observes wholly-before or wholly-after state.
 * Values never appear in errors, events, or logs; subscribers get a pointer and refetch.
 */
export class ProjectEnvironmentRepo extends Context.Service<
  ProjectEnvironmentRepo,
  {
    /** One coherent read: aggregate revision + name-sorted rows in a single statement. */
    readonly snapshot: (
      projectId: ProjectId,
    ) => Effect.Effect<
      ProjectEnvironmentSnapshot,
      ProjectNotFoundError | ProjectEnvironmentCorruptRecordError
    >;
    readonly create: (
      projectId: ProjectId,
      input: ProjectEnvironmentVariableInput,
    ) => Effect.Effect<ProjectEnvironmentMutation, ProjectEnvironmentWriteError>;
    /** Atomic value edit and/or rename of one stable ID; requires the last-seen row revision. */
    readonly update: (
      projectId: ProjectId,
      variableId: ProjectEnvironmentVariableId,
      input: ProjectEnvironmentVariableInput & { readonly expectedRevision: number },
    ) => Effect.Effect<
      ProjectEnvironmentMutation,
      | ProjectEnvironmentWriteError
      | ProjectEnvironmentVariableNotFoundError
      | ProjectEnvironmentStaleWriteError
    >;
    readonly remove: (
      projectId: ProjectId,
      variableId: ProjectEnvironmentVariableId,
      expectedRevision: number,
    ) => Effect.Effect<
      { readonly revision: number },
      | ProjectNotFoundError
      | ProjectEnvironmentVariableNotFoundError
      | ProjectEnvironmentStaleWriteError
    >;
    /** Create-or-replace by NAME (the `.env` load path); no revision check — the file is the intent. */
    readonly upsertByName: (
      projectId: ProjectId,
      input: ProjectEnvironmentVariableInput,
    ) => Effect.Effect<
      ProjectEnvironmentMutation & { readonly action: "created" | "updated" },
      ProjectEnvironmentWriteError
    >;
  }
>()("@mend/db/ProjectEnvironmentRepo") {}

type VariableRow = typeof projectEnvironmentVariables.$inferSelect;

/**
 * The query surface the helpers need — satisfied structurally by both the root client and the
 * transaction handle inside `db.transaction((tx) => …)`.
 */
type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete">;

const toVariable = (
  row: VariableRow,
): Effect.Effect<ProjectEnvironmentVariable, ProjectEnvironmentCorruptRecordError> => {
  // Rows were validated on write; a row that no longer parses is data corruption, reported by
  // rule only — the stored value must not ride the diagnostic.
  const nameIssue = validateProjectEnvironmentName(row.name);
  const valueIssue = nameIssue ?? validateProjectEnvironmentValue(row.value);
  if (valueIssue !== null) {
    return Effect.fail(
      new ProjectEnvironmentCorruptRecordError({ variableId: row.id, rule: valueIssue.rule }),
    );
  }
  return Effect.succeed(new ProjectEnvironmentVariable(row));
};

const validateInput = (
  input: ProjectEnvironmentVariableInput,
): Effect.Effect<void, ProjectEnvironmentInvalidInputError> => {
  const issues: Array<{
    readonly field: "name" | "value";
    readonly rule: string;
    readonly message: string;
  }> = [];
  const nameIssue = validateProjectEnvironmentName(input.name);
  if (nameIssue !== null) {
    issues.push({
      field: "name",
      rule: nameIssue.rule,
      message: formatProjectEnvironmentIssue(nameIssue),
    });
  }
  const valueIssue = validateProjectEnvironmentValue(input.value);
  if (valueIssue !== null) {
    issues.push({
      field: "value",
      rule: valueIssue.rule,
      message: formatProjectEnvironmentIssue(valueIssue),
    });
  }
  return issues.length === 0
    ? Effect.void
    : Effect.fail(new ProjectEnvironmentInvalidInputError({ issues }));
};

/** Lock the owning project row; the aggregate revision rides back with the lock. */
const lockProject = (tx: Tx, projectId: ProjectId) =>
  Effect.gen(function* () {
    const [row] = yield* tx
      .select({ environmentRevision: projects.environmentRevision })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update")
      .pipe(Effect.orDie);
    if (row === undefined) return yield* new ProjectNotFoundError({ projectId });
    return row.environmentRevision;
  });

const readAggregate = (tx: Tx, projectId: ProjectId) =>
  tx
    .select()
    .from(projectEnvironmentVariables)
    .where(eq(projectEnvironmentVariables.projectId, projectId))
    .orderBy(asc(projectEnvironmentVariables.name))
    .pipe(Effect.orDie);

const checkLimits = (entries: ReadonlyArray<{ readonly name: string; readonly value: string }>) =>
  Effect.gen(function* () {
    if (entries.length > PROJECT_ENV_MAX_ENTRIES) {
      return yield* new ProjectEnvironmentLimitError({
        kind: "entries",
        limit: PROJECT_ENV_MAX_ENTRIES,
      });
    }
    if (projectEnvironmentBytes(entries) > PROJECT_ENV_MAX_TOTAL_BYTES) {
      return yield* new ProjectEnvironmentLimitError({
        kind: "bytes",
        limit: PROJECT_ENV_MAX_TOTAL_BYTES,
      });
    }
  });

const bumpAggregate = (tx: Tx, projectId: ProjectId) =>
  Effect.gen(function* () {
    const [row] = yield* tx
      .update(projects)
      .set({
        environmentRevision: drizzleSql`${projects.environmentRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))
      .returning({ environmentRevision: projects.environmentRevision })
      .pipe(Effect.orDie);
    if (row === undefined) return yield* Effect.die("aggregate bump lost the project row");
    return row.environmentRevision;
  });

export const ProjectEnvironmentRepoLive: Layer.Layer<
  ProjectEnvironmentRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ProjectEnvironmentRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sqlClient = yield* PgClient.PgClient;

    const snapshot = Effect.fn("ProjectEnvironmentRepo.snapshot")(function* (projectId: ProjectId) {
      // One statement — a LEFT JOIN sees the aggregate revision and its rows at the same MVCC
      // instant, so a concurrent mutation lands wholly before or wholly after this read.
      const rows = yield* db
        .select({
          environmentRevision: projects.environmentRevision,
          variable: projectEnvironmentVariables,
        })
        .from(projects)
        .leftJoin(
          projectEnvironmentVariables,
          eq(projectEnvironmentVariables.projectId, projects.id),
        )
        .where(eq(projects.id, projectId))
        .orderBy(asc(projectEnvironmentVariables.name))
        .pipe(Effect.orDie);
      const first = rows[0];
      if (first === undefined) return yield* new ProjectNotFoundError({ projectId });
      const variables = yield* Effect.forEach(
        rows.flatMap((row) => (row.variable === null ? [] : [row.variable])),
        toVariable,
      );
      return new ProjectEnvironmentSnapshot({ revision: first.environmentRevision, variables });
    });

    const create = Effect.fn("ProjectEnvironmentRepo.create")(function* (
      projectId: ProjectId,
      input: ProjectEnvironmentVariableInput,
    ) {
      yield* validateInput(input);
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            const existing = yield* readAggregate(tx, projectId);
            if (existing.some((row) => row.name === input.name)) {
              return yield* new ProjectEnvironmentDuplicateNameError({ name: input.name });
            }
            yield* checkLimits([...existing, input]);
            const [created] = yield* tx
              .insert(projectEnvironmentVariables)
              .values({
                id: ProjectEnvironmentVariableId.make(crypto.randomUUID()),
                projectId,
                name: input.name,
                value: input.value,
              })
              .returning()
              .pipe(Effect.orDie);
            if (created === undefined) return yield* Effect.die("env insert returned no row");
            const revision = yield* bumpAggregate(tx, projectId);
            return { variable: new ProjectEnvironmentVariable(created), revision };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    const update = Effect.fn("ProjectEnvironmentRepo.update")(function* (
      projectId: ProjectId,
      variableId: ProjectEnvironmentVariableId,
      input: ProjectEnvironmentVariableInput & { readonly expectedRevision: number },
    ) {
      yield* validateInput(input);
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            const existing = yield* readAggregate(tx, projectId);
            const current = existing.find((row) => row.id === variableId);
            if (current === undefined) {
              return yield* new ProjectEnvironmentVariableNotFoundError({ variableId });
            }
            if (current.revision !== input.expectedRevision) {
              return yield* new ProjectEnvironmentStaleWriteError({
                variableId,
                currentRevision: current.revision,
              });
            }
            // Rename is an atomic update of the same ID — uniqueness re-checked against the
            // aggregate minus this row. Case-only rename passes (names are case-sensitive).
            if (existing.some((row) => row.id !== variableId && row.name === input.name)) {
              return yield* new ProjectEnvironmentDuplicateNameError({ name: input.name });
            }
            yield* checkLimits([...existing.filter((row) => row.id !== variableId), input]);
            const [updated] = yield* tx
              .update(projectEnvironmentVariables)
              .set({
                name: input.name,
                value: input.value,
                revision: current.revision + 1,
                updatedAt: new Date(),
              })
              .where(eq(projectEnvironmentVariables.id, variableId))
              .returning()
              .pipe(Effect.orDie);
            if (updated === undefined) return yield* Effect.die("env update lost the row");
            const revision = yield* bumpAggregate(tx, projectId);
            return { variable: new ProjectEnvironmentVariable(updated), revision };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    const remove = Effect.fn("ProjectEnvironmentRepo.remove")(function* (
      projectId: ProjectId,
      variableId: ProjectEnvironmentVariableId,
      expectedRevision: number,
    ) {
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            const [current] = yield* tx
              .select()
              .from(projectEnvironmentVariables)
              .where(eq(projectEnvironmentVariables.id, variableId))
              .limit(1)
              .pipe(Effect.orDie);
            if (current === undefined || current.projectId !== projectId) {
              return yield* new ProjectEnvironmentVariableNotFoundError({ variableId });
            }
            if (current.revision !== expectedRevision) {
              return yield* new ProjectEnvironmentStaleWriteError({
                variableId,
                currentRevision: current.revision,
              });
            }
            yield* tx
              .delete(projectEnvironmentVariables)
              .where(eq(projectEnvironmentVariables.id, variableId))
              .pipe(Effect.orDie);
            const revision = yield* bumpAggregate(tx, projectId);
            return { revision };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    const upsertByName = Effect.fn("ProjectEnvironmentRepo.upsertByName")(function* (
      projectId: ProjectId,
      input: ProjectEnvironmentVariableInput,
    ) {
      yield* validateInput(input);
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            const existing = yield* readAggregate(tx, projectId);
            const current = existing.find((row) => row.name === input.name);
            yield* checkLimits([...existing.filter((row) => row.name !== input.name), input]);
            if (current === undefined) {
              const [created] = yield* tx
                .insert(projectEnvironmentVariables)
                .values({
                  id: ProjectEnvironmentVariableId.make(crypto.randomUUID()),
                  projectId,
                  name: input.name,
                  value: input.value,
                })
                .returning()
                .pipe(Effect.orDie);
              if (created === undefined) return yield* Effect.die("env insert returned no row");
              const revision = yield* bumpAggregate(tx, projectId);
              return {
                variable: new ProjectEnvironmentVariable(created),
                revision,
                action: "created" as const,
              };
            }
            const [updated] = yield* tx
              .update(projectEnvironmentVariables)
              .set({ value: input.value, revision: current.revision + 1, updatedAt: new Date() })
              .where(eq(projectEnvironmentVariables.id, current.id))
              .returning()
              .pipe(Effect.orDie);
            if (updated === undefined) return yield* Effect.die("env update lost the row");
            const revision = yield* bumpAggregate(tx, projectId);
            return {
              variable: new ProjectEnvironmentVariable(updated),
              revision,
              action: "updated" as const,
            };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    return { snapshot, create, update, remove, upsertByName };
  }),
);
