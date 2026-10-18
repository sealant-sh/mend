import { PgClient } from "@effect/sql-pg";
import { SkillId, type ProjectId } from "@mend/domain";
import {
  SKILL_MAX_PER_SCOPE,
  Skill,
  SkillWithFiles,
  skillBundleBytes,
  validateSkillBundle,
} from "@mend/domain/workbench";
import { asc, eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { projects, skills } from "../schema/workbench.ts";
import { ProjectNotFoundError } from "./projects.ts";

export class SkillNotFoundError extends Schema.TaggedError<SkillNotFoundError>()(
  "SkillNotFoundError",
  { skillId: Schema.String },
) {}

export class SkillInvalidError extends Schema.TaggedError<SkillInvalidError>()(
  "SkillInvalidError",
  { message: Schema.String },
) {}

export class SkillDuplicateNameError extends Schema.TaggedError<SkillDuplicateNameError>()(
  "SkillDuplicateNameError",
  { name: Schema.String },
) {}

export class SkillLimitError extends Schema.TaggedError<SkillLimitError>()("SkillLimitError", {
  limit: Schema.Int,
}) {}

export class SkillStaleWriteError extends Schema.TaggedError<SkillStaleWriteError>()(
  "SkillStaleWriteError",
  { skillId: Schema.String, currentRevision: Schema.Int },
) {}

/** Which library a write lands in: the account's own, or a project's. */
export type SkillOwner =
  | { readonly scope: "user"; readonly userId: string }
  | { readonly scope: "project"; readonly projectId: ProjectId };

export interface SkillBundleInput {
  readonly name: string;
  readonly description: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
}

/** What one `sync` did, name by name — the CLI renders this verbatim. */
export interface SkillSyncReport {
  readonly created: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly unchanged: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export type SkillWriteError =
  | SkillInvalidError
  | SkillDuplicateNameError
  | SkillLimitError
  | ProjectNotFoundError;

/**
 * Skill libraries (skill.ts in @mend/domain): bundles of agent instruction
 * files, one row each, files as jsonb. Reads split summary (`Skill`, no
 * contents) from bundle (`SkillWithFiles`); the launch path reads both
 * libraries at once through `forLaunch`.
 */
export class SkillsRepo extends Context.Service<
  SkillsRepo,
  {
    readonly listForUser: (userId: string) => Effect.Effect<ReadonlyArray<Skill>>;
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<Skill>>;
    readonly byId: (skillId: SkillId) => Effect.Effect<SkillWithFiles, SkillNotFoundError>;
    readonly create: (
      owner: SkillOwner,
      input: SkillBundleInput,
    ) => Effect.Effect<SkillWithFiles, SkillWriteError>;
    /** Replace the bundle wholesale; `expectedRevision` guards concurrent editors. */
    readonly update: (
      skillId: SkillId,
      input: SkillBundleInput & { readonly expectedRevision: number },
    ) => Effect.Effect<
      SkillWithFiles,
      SkillNotFoundError | SkillInvalidError | SkillDuplicateNameError | SkillStaleWriteError
    >;
    readonly remove: (skillId: SkillId) => Effect.Effect<void, SkillNotFoundError>;
    /**
     * Reconcile a whole library against an uploaded set (`mend skills push`):
     * create-or-replace by name, unchanged bundles left untouched, and with
     * `prune` everything the upload no longer carries is removed. The upload
     * is the intent — no per-row revision checks.
     */
    readonly sync: (
      owner: SkillOwner,
      bundles: ReadonlyArray<SkillBundleInput>,
      options: { readonly prune: boolean },
    ) => Effect.Effect<SkillSyncReport, SkillWriteError>;
    /**
     * Both libraries as one launch read: the owner's user skills and the
     * project's, full bundles. A null owner (a pre-ownership session) gets
     * project skills only.
     */
    readonly forLaunch: (
      ownerUserId: string | null,
      projectId: ProjectId,
    ) => Effect.Effect<{
      readonly user: ReadonlyArray<SkillWithFiles>;
      readonly project: ReadonlyArray<SkillWithFiles>;
    }>;
  }
>()("@mend/db/SkillsRepo") {}

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete">;

const toSkill = (row: typeof skills.$inferSelect): Skill =>
  new Skill({
    id: row.id,
    scope: row.scope,
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    fileCount: row.files.length,
    bytes: skillBundleBytes(row.files),
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const toBundle = (row: typeof skills.$inferSelect): SkillWithFiles =>
  new SkillWithFiles({ skill: toSkill(row), files: row.files });

const validateBundle = (input: SkillBundleInput): Effect.Effect<void, SkillInvalidError> => {
  const issue = validateSkillBundle(input);
  return issue === null ? Effect.void : Effect.fail(new SkillInvalidError({ message: issue }));
};

const ownerFilter = (owner: SkillOwner) =>
  owner.scope === "user"
    ? eq(skills.ownerUserId, owner.userId)
    : eq(skills.projectId, owner.projectId);

const ownerColumns = (owner: SkillOwner) =>
  owner.scope === "user"
    ? { scope: "user" as const, ownerUserId: owner.userId, projectId: null }
    : { scope: "project" as const, ownerUserId: null, projectId: owner.projectId };

/** Bundles store canonically path-sorted, so equality is order-insensitive by construction. */
const sortFiles = <F extends { readonly path: string }>(files: ReadonlyArray<F>): Array<F> =>
  files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const sameBundle = (row: typeof skills.$inferSelect, input: SkillBundleInput): boolean => {
  const sorted = sortFiles(input.files);
  return (
    row.description === input.description &&
    row.files.length === sorted.length &&
    row.files.every(
      (file, index) =>
        sorted[index]?.path === file.path && sorted[index]?.contents === file.contents,
    )
  );
};

/** Project-scoped writes name a project that must exist; a bogus id is a 404, not a 500. */
const checkOwner = (tx: Tx, owner: SkillOwner) =>
  Effect.gen(function* () {
    if (owner.scope !== "project") return;
    const [row] = yield* tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, owner.projectId))
      .limit(1)
      .pipe(Effect.orDie);
    if (row === undefined) {
      return yield* new ProjectNotFoundError({ projectId: owner.projectId });
    }
  });

const readLibrary = (tx: Tx, owner: SkillOwner) =>
  tx.select().from(skills).where(ownerFilter(owner)).orderBy(asc(skills.name)).pipe(Effect.orDie);

// The scope CHECK constraint guarantees exactly one owner column is set.
const ownerOf = (row: typeof skills.$inferSelect): Effect.Effect<SkillOwner> =>
  row.ownerUserId !== null
    ? Effect.succeed({ scope: "user", userId: row.ownerUserId })
    : row.projectId !== null
      ? Effect.succeed({ scope: "project", projectId: row.projectId })
      : Effect.die("skill row violates its scope check");

export const SkillsRepoLive: Layer.Layer<SkillsRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    SkillsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const sqlClient = yield* PgClient.PgClient;

      /** Skill changes affect future launches; project-scoped ones ping the project's watchers. */
      const notify = (owner: SkillOwner) =>
        owner.scope === "project"
          ? notifyEvent(sqlClient, { type: "project", projectId: owner.projectId })
          : Effect.void;

      const listForUser = Effect.fn("SkillsRepo.listForUser")(function* (userId: string) {
        const rows = yield* readLibrary(db, { scope: "user", userId });
        return rows.map(toSkill);
      });

      const listForProject = Effect.fn("SkillsRepo.listForProject")(function* (
        projectId: ProjectId,
      ) {
        const rows = yield* readLibrary(db, { scope: "project", projectId });
        return rows.map(toSkill);
      });

      const byId = Effect.fn("SkillsRepo.byId")(function* (skillId: SkillId) {
        const [row] = yield* db
          .select()
          .from(skills)
          .where(eq(skills.id, skillId))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new SkillNotFoundError({ skillId });
        return toBundle(row);
      });

      const insertBundle = (tx: Tx, owner: SkillOwner, input: SkillBundleInput) =>
        Effect.gen(function* () {
          const [created] = yield* tx
            .insert(skills)
            .values({
              id: SkillId.make(crypto.randomUUID()),
              ...ownerColumns(owner),
              name: input.name,
              description: input.description,
              files: sortFiles(input.files),
            })
            .returning()
            .pipe(Effect.orDie);
          if (created === undefined) return yield* Effect.die("skill insert returned no row");
          return created;
        });

      const create = Effect.fn("SkillsRepo.create")(function* (
        owner: SkillOwner,
        input: SkillBundleInput,
      ) {
        yield* validateBundle(input);
        const result = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* checkOwner(tx, owner);
              const existing = yield* readLibrary(tx, owner);
              if (existing.some((row) => row.name === input.name)) {
                return yield* new SkillDuplicateNameError({ name: input.name });
              }
              if (existing.length + 1 > SKILL_MAX_PER_SCOPE) {
                return yield* new SkillLimitError({ limit: SKILL_MAX_PER_SCOPE });
              }
              return toBundle(yield* insertBundle(tx, owner, input));
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
        yield* notify(owner);
        return result;
      });

      const update = Effect.fn("SkillsRepo.update")(function* (
        skillId: SkillId,
        input: SkillBundleInput & { readonly expectedRevision: number },
      ) {
        yield* validateBundle(input);
        const { bundle, owner } = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [current] = yield* tx
                .select()
                .from(skills)
                .where(eq(skills.id, skillId))
                .for("update")
                .pipe(Effect.orDie);
              if (current === undefined) return yield* new SkillNotFoundError({ skillId });
              if (current.revision !== input.expectedRevision) {
                return yield* new SkillStaleWriteError({
                  skillId,
                  currentRevision: current.revision,
                });
              }
              const rowOwner = yield* ownerOf(current);
              const siblings = yield* readLibrary(tx, rowOwner);
              if (siblings.some((row) => row.id !== skillId && row.name === input.name)) {
                return yield* new SkillDuplicateNameError({ name: input.name });
              }
              const [updated] = yield* tx
                .update(skills)
                .set({
                  name: input.name,
                  description: input.description,
                  files: sortFiles(input.files),
                  revision: current.revision + 1,
                  updatedAt: yield* DateTime.nowAsDate,
                })
                .where(eq(skills.id, skillId))
                .returning()
                .pipe(Effect.orDie);
              if (updated === undefined) return yield* Effect.die("skill update lost the row");
              return { bundle: toBundle(updated), owner: rowOwner };
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
        yield* notify(owner);
        return bundle;
      });

      const remove = Effect.fn("SkillsRepo.remove")(function* (skillId: SkillId) {
        const owner = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [current] = yield* tx
                .select()
                .from(skills)
                .where(eq(skills.id, skillId))
                .limit(1)
                .pipe(Effect.orDie);
              if (current === undefined) return yield* new SkillNotFoundError({ skillId });
              yield* tx.delete(skills).where(eq(skills.id, skillId)).pipe(Effect.orDie);
              return yield* ownerOf(current);
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
        yield* notify(owner);
      });

      const sync = Effect.fn("SkillsRepo.sync")(function* (
        owner: SkillOwner,
        bundles: ReadonlyArray<SkillBundleInput>,
        options: { readonly prune: boolean },
      ) {
        for (const bundle of bundles) {
          yield* validateBundle(bundle);
        }
        const names = new Set(bundles.map((bundle) => bundle.name));
        if (names.size !== bundles.length) {
          return yield* new SkillInvalidError({ message: "the upload repeats a skill name" });
        }
        if (bundles.length > SKILL_MAX_PER_SCOPE) {
          return yield* new SkillLimitError({ limit: SKILL_MAX_PER_SCOPE });
        }
        const report = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* checkOwner(tx, owner);
              const existing = yield* readLibrary(tx, owner);
              const byName = new Map(existing.map((row) => [row.name, row] as const));
              const kept = options.prune
                ? 0
                : existing.filter((row) => !names.has(row.name)).length;
              if (kept + bundles.length > SKILL_MAX_PER_SCOPE) {
                return yield* new SkillLimitError({ limit: SKILL_MAX_PER_SCOPE });
              }
              const created: string[] = [];
              const updated: string[] = [];
              const unchanged: string[] = [];
              const removed: string[] = [];
              for (const bundle of bundles) {
                const current = byName.get(bundle.name);
                if (current === undefined) {
                  yield* insertBundle(tx, owner, bundle);
                  created.push(bundle.name);
                  continue;
                }
                if (sameBundle(current, bundle)) {
                  unchanged.push(bundle.name);
                  continue;
                }
                yield* tx
                  .update(skills)
                  .set({
                    description: bundle.description,
                    files: sortFiles(bundle.files),
                    revision: current.revision + 1,
                    updatedAt: yield* DateTime.nowAsDate,
                  })
                  .where(eq(skills.id, current.id))
                  .pipe(Effect.orDie);
                updated.push(bundle.name);
              }
              if (options.prune) {
                for (const row of existing) {
                  if (names.has(row.name)) continue;
                  yield* tx.delete(skills).where(eq(skills.id, row.id)).pipe(Effect.orDie);
                  removed.push(row.name);
                }
              }
              return { created, updated, unchanged, removed };
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
        yield* notify(owner);
        return report;
      });

      const forLaunch = Effect.fn("SkillsRepo.forLaunch")(function* (
        ownerUserId: string | null,
        projectId: ProjectId,
      ) {
        const userRows =
          ownerUserId === null
            ? []
            : yield* readLibrary(db, { scope: "user", userId: ownerUserId });
        const projectRows = yield* readLibrary(db, { scope: "project", projectId });
        return { user: userRows.map(toBundle), project: projectRows.map(toBundle) };
      });

      return { listForUser, listForProject, byId, create, update, remove, sync, forLaunch };
    }),
  );
