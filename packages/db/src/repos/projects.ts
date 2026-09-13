import { PgClient } from "@effect/sql-pg";
import { ProjectId, WorkspaceImage, type Sha } from "@mend/domain";
import { Project, type AutomationChoice, type GitAuthMode } from "@mend/domain/workbench";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { projects } from "../schema/workbench.ts";

export class ProjectNotFoundError extends Schema.TaggedErrorClass<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    projectId: Schema.String,
  },
) {}

export interface NewProject {
  readonly name: string;
  readonly originUrl: string | null;
  readonly storePath: string;
  readonly defaultBranch: string;
  readonly adoptedSha: Sha | null;
  readonly gitAuthMode: GitAuthMode;
}

/** The index of adopted repositories (plan §5.2); the store itself is git on disk. */
export class ProjectsRepo extends Context.Service<
  ProjectsRepo,
  {
    readonly create: (project: NewProject) => Effect.Effect<Project>;
    readonly byId: (id: ProjectId) => Effect.Effect<Project, ProjectNotFoundError>;
    readonly byName: (name: string) => Effect.Effect<Project | null>;
    readonly list: () => Effect.Effect<ReadonlyArray<Project>>;
    /** The project's stance on the cascade switches (settings → project), replaced together. */
    readonly setAutomation: (
      id: ProjectId,
      choices: {
        readonly autoTour: AutomationChoice;
        readonly autoSuggest: AutomationChoice;
        readonly autoName: AutomationChoice;
        readonly backgroundSessions: AutomationChoice;
      },
    ) => Effect.Effect<Project, ProjectNotFoundError>;
    /** How host-side git authenticates to this project's remote (docs/GIT-ACCESS.md). */
    readonly setGitAuthMode: (
      id: ProjectId,
      mode: GitAuthMode,
    ) => Effect.Effect<Project, ProjectNotFoundError>;
    /** The project's workspace-image override; null returns it to the Settings default. */
    readonly setWorkspaceImage: (
      id: ProjectId,
      image: WorkspaceImage | null,
    ) => Effect.Effect<Project, ProjectNotFoundError>;
    /** Whether sessions here receive the launching user's dotfiles. */
    readonly setApplyDotfiles: (
      id: ProjectId,
      applyDotfiles: boolean,
    ) => Effect.Effect<Project, ProjectNotFoundError>;
    /** Whether sessions inherit the launching user's skills in addition to project skills. */
    readonly setInheritUserSkills: (
      id: ProjectId,
      inheritUserSkills: boolean,
    ) => Effect.Effect<Project, ProjectNotFoundError>;
    /** How many hot workspaces to keep ready for new sessions (0 = none). */
    readonly setHotSessions: (
      id: ProjectId,
      hotSessions: number,
    ) => Effect.Effect<Project, ProjectNotFoundError>;
    /** The install command (null = detect from the base tree's lockfile). */
    readonly setInstallCommand: (
      id: ProjectId,
      installCommand: string | null,
    ) => Effect.Effect<Project, ProjectNotFoundError>;
    /** Hard delete — sessions and everything under them cascade. */
    readonly remove: (id: ProjectId) => Effect.Effect<void>;
  }
>()("@mend/db/ProjectsRepo") {}

const decodeWorkspaceImage = Schema.decodeUnknownSync(WorkspaceImage);

const toProject = (row: typeof projects.$inferSelect): Project =>
  new Project({
    ...row,
    workspaceImage: row.workspaceImage === null ? null : decodeWorkspaceImage(row.workspaceImage),
  });

export const ProjectsRepoLive: Layer.Layer<ProjectsRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    ProjectsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const sql = yield* PgClient.PgClient;

      const create = Effect.fn("ProjectsRepo.create")(function* (project: NewProject) {
        const [row] = yield* db
          .insert(projects)
          .values({ id: ProjectId.make(crypto.randomUUID()), ...project })
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("project insert returned no row");
        const created = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: created.id });
        return created;
      });

      const byId = Effect.fn("ProjectsRepo.byId")(function* (id: ProjectId) {
        const [row] = yield* db
          .select()
          .from(projects)
          .where(eq(projects.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        return toProject(row);
      });

      const byName = Effect.fn("ProjectsRepo.byName")(function* (name: string) {
        const [row] = yield* db
          .select()
          .from(projects)
          .where(eq(projects.name, name))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : toProject(row);
      });

      const list = Effect.fn("ProjectsRepo.list")(function* () {
        const rows = yield* db
          .select()
          .from(projects)
          .orderBy(asc(projects.name))
          .pipe(Effect.orDie);
        return rows.map(toProject);
      });

      const setAutomation = Effect.fn("ProjectsRepo.setAutomation")(function* (
        id: ProjectId,
        choices: {
          readonly autoTour: AutomationChoice;
          readonly autoSuggest: AutomationChoice;
          readonly autoName: AutomationChoice;
          readonly backgroundSessions: AutomationChoice;
        },
      ) {
        const [row] = yield* db
          .update(projects)
          .set({ ...choices, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: id });
        return updated;
      });

      const setGitAuthMode = Effect.fn("ProjectsRepo.setGitAuthMode")(function* (
        id: ProjectId,
        mode: GitAuthMode,
      ) {
        const [row] = yield* db
          .update(projects)
          .set({ gitAuthMode: mode, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: id });
        return updated;
      });

      const setWorkspaceImage = Effect.fn("ProjectsRepo.setWorkspaceImage")(function* (
        id: ProjectId,
        image: WorkspaceImage | null,
      ) {
        const [row] = yield* db
          .update(projects)
          .set({ workspaceImage: image, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: id });
        return updated;
      });

      const setApplyDotfiles = Effect.fn("ProjectsRepo.setApplyDotfiles")(function* (
        id: ProjectId,
        applyDotfiles: boolean,
      ) {
        const [row] = yield* db
          .update(projects)
          .set({ applyDotfiles, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: id });
        return updated;
      });

      const setInheritUserSkills = Effect.fn("ProjectsRepo.setInheritUserSkills")(function* (
        id: ProjectId,
        inheritUserSkills: boolean,
      ) {
        const [row] = yield* db
          .update(projects)
          .set({ inheritUserSkills, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: id });
        return updated;
      });

      const setHotSessions = Effect.fn("ProjectsRepo.setHotSessions")(function* (
        id: ProjectId,
        hotSessions: number,
      ) {
        const [row] = yield* db
          .update(projects)
          .set({ hotSessions, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: id });
        return updated;
      });

      const setInstallCommand = Effect.fn("ProjectsRepo.setInstallCommand")(function* (
        id: ProjectId,
        installCommand: string | null,
      ) {
        const [row] = yield* db
          .update(projects)
          .set({ installCommand, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: id });
        return updated;
      });

      const remove = Effect.fn("ProjectsRepo.remove")(function* (id: ProjectId) {
        yield* db.delete(projects).where(eq(projects.id, id)).pipe(Effect.orDie);
        yield* notifyEvent(sql, { type: "project", projectId: id });
      });

      return {
        create,
        byId,
        byName,
        list,
        setAutomation,
        setGitAuthMode,
        setWorkspaceImage,
        setApplyDotfiles,
        setInheritUserSkills,
        setHotSessions,
        setInstallCommand,
        remove,
      };
    }),
  );
