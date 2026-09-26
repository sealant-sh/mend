import { PgClient } from "@effect/sql-pg";
import { ProjectSecretId, type ProjectId } from "@mend/domain";
import {
  formatProjectEnvironmentIssue,
  PROJECT_ENV_MAX_ENTRIES,
  ProjectSecret,
  ProjectSecretsSnapshot,
  validateProjectSecretName,
} from "@mend/domain/workbench";
import { asc, eq, sql as drizzleSql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { projectSecrets, projects } from "../schema/workbench.ts";
import {
  ProjectEnvironmentDuplicateNameError,
  ProjectEnvironmentInvalidInputError,
  ProjectEnvironmentLimitError,
  ProjectEnvironmentStaleWriteError,
} from "./project-environment.ts";
import { ProjectNotFoundError } from "./projects.ts";

export class ProjectSecretNotFoundError extends Schema.TaggedErrorClass<ProjectSecretNotFoundError>()(
  "ProjectSecretNotFoundError",
  { secretId: Schema.String },
) {}

/**
 * A secret as the launch path needs it: name + the SEALED value. Decryption is the caller's job
 * (`@mend/store` SecretCipher), so this package never sees plaintext.
 */
export interface SealedProjectSecret {
  readonly name: string;
  readonly sealedValue: string;
}

export interface ProjectSecretMutation {
  readonly secret: ProjectSecret;
  /** New aggregate revision after this mutation. */
  readonly revision: number;
}

export type ProjectSecretWriteError =
  | ProjectNotFoundError
  | ProjectEnvironmentInvalidInputError
  | ProjectEnvironmentDuplicateNameError
  | ProjectEnvironmentLimitError;

/**
 * Project secrets (`docs/archive/plans/project-environment-variables.md`, "Scope expansion"). Rows hold
 * ciphertext only; the API never returns a value in any shape; the value-bearing read is
 * `sealedForLaunch`, consumed once per fresh workspace launch. Same project-row lock, aggregate
 * revision, and pointer-event discipline as the plaintext set. Name validation reuses the
 * Configuration grammar with the platform's secret-lane reservations; the sealed value is not
 * re-parsed here (its plaintext bounds are checked before sealing, by the API layer).
 */
export class ProjectSecretsRepo extends Context.Service<
  ProjectSecretsRepo,
  {
    /** Names + revisions only. */
    readonly snapshot: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectSecretsSnapshot, ProjectNotFoundError>;
    /** The launch read: aggregate revision + name-sorted sealed values, one statement. */
    readonly sealedForLaunch: (
      projectId: ProjectId,
    ) => Effect.Effect<
      { readonly revision: number; readonly secrets: ReadonlyArray<SealedProjectSecret> },
      ProjectNotFoundError
    >;
    readonly create: (
      projectId: ProjectId,
      input: { readonly name: string; readonly sealedValue: string },
    ) => Effect.Effect<ProjectSecretMutation, ProjectSecretWriteError>;
    /** Replace the value and/or rename; `sealedValue` null keeps the stored value (pure rename). */
    readonly update: (
      projectId: ProjectId,
      secretId: ProjectSecretId,
      input: {
        readonly name: string;
        readonly sealedValue: string | null;
        readonly expectedRevision: number;
      },
    ) => Effect.Effect<
      ProjectSecretMutation,
      ProjectSecretWriteError | ProjectSecretNotFoundError | ProjectEnvironmentStaleWriteError
    >;
    readonly remove: (
      projectId: ProjectId,
      secretId: ProjectSecretId,
      expectedRevision: number,
    ) => Effect.Effect<
      { readonly revision: number },
      ProjectNotFoundError | ProjectSecretNotFoundError | ProjectEnvironmentStaleWriteError
    >;
    /** Create-or-replace by NAME (the `.env` load path); no revision check — the file is the intent. */
    readonly upsertByName: (
      projectId: ProjectId,
      input: { readonly name: string; readonly sealedValue: string },
    ) => Effect.Effect<
      ProjectSecretMutation & { readonly action: "created" | "updated" },
      ProjectSecretWriteError
    >;
  }
>()("@mend/db/ProjectSecretsRepo") {}

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete">;

const toSecret = (row: typeof projectSecrets.$inferSelect): ProjectSecret =>
  new ProjectSecret({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const validateName = (name: string): Effect.Effect<void, ProjectEnvironmentInvalidInputError> => {
  const issue = validateProjectSecretName(name);
  return issue === null
    ? Effect.void
    : Effect.fail(
        new ProjectEnvironmentInvalidInputError({
          issues: [
            { field: "name", rule: issue.rule, message: formatProjectEnvironmentIssue(issue) },
          ],
        }),
      );
};

const lockProject = (tx: Tx, projectId: ProjectId) =>
  Effect.gen(function* () {
    const [row] = yield* tx
      .select({ secretRevision: projects.secretRevision })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update")
      .pipe(Effect.orDie);
    if (row === undefined) return yield* new ProjectNotFoundError({ projectId });
    return row.secretRevision;
  });

const readAggregate = (tx: Tx, projectId: ProjectId) =>
  tx
    .select()
    .from(projectSecrets)
    .where(eq(projectSecrets.projectId, projectId))
    .orderBy(asc(projectSecrets.name))
    .pipe(Effect.orDie);

const bumpAggregate = (tx: Tx, projectId: ProjectId) =>
  Effect.gen(function* () {
    const [row] = yield* tx
      .update(projects)
      .set({ secretRevision: drizzleSql`${projects.secretRevision} + 1`, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning({ secretRevision: projects.secretRevision })
      .pipe(Effect.orDie);
    if (row === undefined) return yield* Effect.die("secret aggregate bump lost the project row");
    return row.secretRevision;
  });

export const ProjectSecretsRepoLive: Layer.Layer<
  ProjectSecretsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ProjectSecretsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sqlClient = yield* PgClient.PgClient;

    const readJoined = (projectId: ProjectId) =>
      db
        .select({ secretRevision: projects.secretRevision, secret: projectSecrets })
        .from(projects)
        .leftJoin(projectSecrets, eq(projectSecrets.projectId, projects.id))
        .where(eq(projects.id, projectId))
        .orderBy(asc(projectSecrets.name))
        .pipe(Effect.orDie);

    const snapshot = Effect.fn("ProjectSecretsRepo.snapshot")(function* (projectId: ProjectId) {
      const rows = yield* readJoined(projectId);
      const first = rows[0];
      if (first === undefined) return yield* new ProjectNotFoundError({ projectId });
      return new ProjectSecretsSnapshot({
        revision: first.secretRevision,
        secrets: rows.flatMap((row) => (row.secret === null ? [] : [toSecret(row.secret)])),
      });
    });

    const sealedForLaunch = Effect.fn("ProjectSecretsRepo.sealedForLaunch")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* readJoined(projectId);
      const first = rows[0];
      if (first === undefined) return yield* new ProjectNotFoundError({ projectId });
      return {
        revision: first.secretRevision,
        secrets: rows.flatMap((row) =>
          row.secret === null
            ? []
            : [{ name: row.secret.name, sealedValue: row.secret.sealedValue }],
        ),
      };
    });

    const create = Effect.fn("ProjectSecretsRepo.create")(function* (
      projectId: ProjectId,
      input: { readonly name: string; readonly sealedValue: string },
    ) {
      yield* validateName(input.name);
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            const existing = yield* readAggregate(tx, projectId);
            if (existing.some((row) => row.name === input.name)) {
              return yield* new ProjectEnvironmentDuplicateNameError({ name: input.name });
            }
            if (existing.length + 1 > PROJECT_ENV_MAX_ENTRIES) {
              return yield* new ProjectEnvironmentLimitError({
                kind: "entries",
                limit: PROJECT_ENV_MAX_ENTRIES,
              });
            }
            const [created] = yield* tx
              .insert(projectSecrets)
              .values({
                id: ProjectSecretId.make(crypto.randomUUID()),
                projectId,
                name: input.name,
                sealedValue: input.sealedValue,
              })
              .returning()
              .pipe(Effect.orDie);
            if (created === undefined) return yield* Effect.die("secret insert returned no row");
            const revision = yield* bumpAggregate(tx, projectId);
            return { secret: toSecret(created), revision };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    const update = Effect.fn("ProjectSecretsRepo.update")(function* (
      projectId: ProjectId,
      secretId: ProjectSecretId,
      input: {
        readonly name: string;
        readonly sealedValue: string | null;
        readonly expectedRevision: number;
      },
    ) {
      yield* validateName(input.name);
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            const existing = yield* readAggregate(tx, projectId);
            const current = existing.find((row) => row.id === secretId);
            if (current === undefined) return yield* new ProjectSecretNotFoundError({ secretId });
            if (current.revision !== input.expectedRevision) {
              return yield* new ProjectEnvironmentStaleWriteError({
                variableId: secretId,
                currentRevision: current.revision,
              });
            }
            if (existing.some((row) => row.id !== secretId && row.name === input.name)) {
              return yield* new ProjectEnvironmentDuplicateNameError({ name: input.name });
            }
            const [updated] = yield* tx
              .update(projectSecrets)
              .set({
                name: input.name,
                ...(input.sealedValue === null ? {} : { sealedValue: input.sealedValue }),
                revision: current.revision + 1,
                updatedAt: new Date(),
              })
              .where(eq(projectSecrets.id, secretId))
              .returning()
              .pipe(Effect.orDie);
            if (updated === undefined) return yield* Effect.die("secret update lost the row");
            const revision = yield* bumpAggregate(tx, projectId);
            return { secret: toSecret(updated), revision };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    const remove = Effect.fn("ProjectSecretsRepo.remove")(function* (
      projectId: ProjectId,
      secretId: ProjectSecretId,
      expectedRevision: number,
    ) {
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            const [current] = yield* tx
              .select()
              .from(projectSecrets)
              .where(eq(projectSecrets.id, secretId))
              .limit(1)
              .pipe(Effect.orDie);
            if (current === undefined || current.projectId !== projectId) {
              return yield* new ProjectSecretNotFoundError({ secretId });
            }
            if (current.revision !== expectedRevision) {
              return yield* new ProjectEnvironmentStaleWriteError({
                variableId: secretId,
                currentRevision: current.revision,
              });
            }
            yield* tx
              .delete(projectSecrets)
              .where(eq(projectSecrets.id, secretId))
              .pipe(Effect.orDie);
            const revision = yield* bumpAggregate(tx, projectId);
            return { revision };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    const upsertByName = Effect.fn("ProjectSecretsRepo.upsertByName")(function* (
      projectId: ProjectId,
      input: { readonly name: string; readonly sealedValue: string },
    ) {
      yield* validateName(input.name);
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockProject(tx, projectId);
            const existing = yield* readAggregate(tx, projectId);
            const current = existing.find((row) => row.name === input.name);
            if (current === undefined) {
              if (existing.length + 1 > PROJECT_ENV_MAX_ENTRIES) {
                return yield* new ProjectEnvironmentLimitError({
                  kind: "entries",
                  limit: PROJECT_ENV_MAX_ENTRIES,
                });
              }
              const [created] = yield* tx
                .insert(projectSecrets)
                .values({
                  id: ProjectSecretId.make(crypto.randomUUID()),
                  projectId,
                  name: input.name,
                  sealedValue: input.sealedValue,
                })
                .returning()
                .pipe(Effect.orDie);
              if (created === undefined) return yield* Effect.die("secret insert returned no row");
              const revision = yield* bumpAggregate(tx, projectId);
              return { secret: toSecret(created), revision, action: "created" as const };
            }
            const [updated] = yield* tx
              .update(projectSecrets)
              .set({
                sealedValue: input.sealedValue,
                revision: current.revision + 1,
                updatedAt: new Date(),
              })
              .where(eq(projectSecrets.id, current.id))
              .returning()
              .pipe(Effect.orDie);
            if (updated === undefined) return yield* Effect.die("secret update lost the row");
            const revision = yield* bumpAggregate(tx, projectId);
            return { secret: toSecret(updated), revision, action: "updated" as const };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* notifyEvent(sqlClient, { type: "project", projectId });
      return result;
    });

    return { snapshot, sealedForLaunch, create, update, remove, upsertByName };
  }),
);
