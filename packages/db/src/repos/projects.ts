import { PgClient } from "@effect/sql-pg";
import { type OrganizationId, type ProjectId, WorkspaceImage, type Sha } from "@mend/domain";
import {
  Project,
  redactNullableUrlCredentials,
  type AutomationChoice,
  type GitAuthMode,
  type ProjectVisibility,
} from "@mend/domain/workbench";
import { and, asc, eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { projects, organizationMembers } from "../schema/workbench.ts";
import { isUniqueViolation, uniqueViolationConstraint } from "./unique-violation.ts";

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    projectId: Schema.String,
  },
) {}

/** The organization already has a project with that name. */
export class ProjectNameTakenError extends Schema.TaggedError<ProjectNameTakenError>()(
  "ProjectNameTakenError",
  { name: Schema.String },
) {}

export class ScratchProjectExistsError extends Schema.TaggedError<ScratchProjectExistsError>()(
  "ScratchProjectExistsError",
  { userId: Schema.String },
) {}

export class ProjectPublicationUnconfirmed extends Schema.TaggedError<ProjectPublicationUnconfirmed>()(
  "ProjectPublicationUnconfirmed",
  { projectId: Schema.String, cause: Schema.Defect() },
) {}

/** Publication rolled back before COMMIT was sent: nothing is registered, so the store may go. */
export class ProjectNotPublished extends Schema.TaggedError<ProjectNotPublished>()(
  "ProjectNotPublished",
  { projectId: Schema.String, cause: Schema.Defect() },
) {}

export class ProjectMembershipChanged extends Schema.TaggedError<ProjectMembershipChanged>()(
  "ProjectMembershipChanged",
  {},
) {}

export class ScratchProjectPrivate extends Schema.TaggedError<ScratchProjectPrivate>()(
  "ScratchProjectPrivate",
  {},
) {}

export interface InitializedProject {
  readonly id: ProjectId;
  readonly organizationId: OrganizationId;
  readonly createdByUserId: string;
  readonly name: string;
  readonly storePath: string;
  /** The branch and commit the store created; the commit is the README's. */
  readonly defaultBranch: string;
  readonly headSha: Sha;
  readonly gitAuthMode: GitAuthMode;
  readonly purpose: "named" | "scratch";
}

export interface NewProject {
  /** Minted by the caller: new stores are laid out by project id. */
  readonly id: ProjectId;
  readonly organizationId: OrganizationId;
  readonly visibility: ProjectVisibility;
  readonly createdByUserId: string;
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
    readonly byScratchOwner: (userId: string) => Effect.Effect<Project | null>;
    readonly publishInitialized: (
      project: InitializedProject,
    ) => Effect.Effect<
      Project,
      | ProjectNameTakenError
      | ScratchProjectExistsError
      | ProjectNotPublished
      | ProjectPublicationUnconfirmed
      | ProjectMembershipChanged
    >;
    readonly create: (project: NewProject) => Effect.Effect<Project, ProjectNameTakenError>;
    readonly byId: (id: ProjectId) => Effect.Effect<Project, ProjectNotFoundError>;
    /** Names are unique within an organization, not across the instance. */
    readonly byName: (
      organizationId: OrganizationId,
      name: string,
    ) => Effect.Effect<Project | null>;
    /** Every project on the instance, for machine work (sweeps, pools). Never a caller's list. */
    readonly listAll: () => Effect.Effect<ReadonlyArray<Project>>;
    /** The organization's projects, by name, before any visibility filter. */
    readonly listForOrganization: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<Project>>;
    /** `private` (creator only) or `shared` (the organization). */
    readonly setVisibility: (
      id: ProjectId,
      visibility: ProjectVisibility,
    ) => Effect.Effect<Project, ProjectNotFoundError | ScratchProjectPrivate>;
    /** Hand a project to another account: an owner taking over a departed member's project. */
    readonly setCreatedBy: (
      id: ProjectId,
      userId: string,
    ) => Effect.Effect<Project, ProjectNotFoundError>;
    /** The project's stance on the cascade switches (instance → organization → project), replaced together. */
    readonly setAutomation: (
      id: ProjectId,
      choices: {
        readonly autoTour: AutomationChoice;
        readonly autoSuggest: AutomationChoice;
        readonly autoName: AutomationChoice;
        readonly backgroundSessions: AutomationChoice;
        /** "Land when a turn completes"; absent keeps the project's stance. */
        readonly autoLand?: AutomationChoice;
      },
    ) => Effect.Effect<Project, ProjectNotFoundError>;
    /** "Land when a turn completes" (docs/adr/0007-landing.md), over the Settings default. */
    readonly setAutoLand: (
      id: ProjectId,
      choice: AutomationChoice,
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
    /** Whether a zsh launch writes Mend's default shell profile where no file exists. */
    readonly setDefaultShellProfile: (
      id: ProjectId,
      defaultShellProfile: boolean,
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
    /** "Automatic install": whether Mend runs an install command for this project at all. */
    readonly setInstallEnabled: (
      id: ProjectId,
      installEnabled: boolean,
    ) => Effect.Effect<Project, ProjectNotFoundError>;
    /** Hard delete — sessions and everything under them cascade. */
    readonly remove: (id: ProjectId) => Effect.Effect<void>;
  }
>()("@mend/db/ProjectsRepo") {}

const decodeWorkspaceImage = Schema.decodeUnknownSync(WorkspaceImage);

// Every project read reaches everyone who can see the project: a credential in the URL never
// leaves here, whatever an older server stored.
const toProject = ({
  removalPhase: _phase,
  removalId: _id,
  removalSince: _since,
  ...row
}: typeof projects.$inferSelect): Project =>
  new Project({
    ...row,
    originUrl: redactNullableUrlCredentials(row.originUrl),
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
          .values({ ...project, originUrl: redactNullableUrlCredentials(project.originUrl) })
          .returning()
          .pipe(
            Effect.catchTag("EffectDrizzleQueryError", (error) =>
              isUniqueViolation(error)
                ? Effect.fail(new ProjectNameTakenError({ name: project.name }))
                : Effect.die(error),
            ),
          );
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

      const byName = Effect.fn("ProjectsRepo.byName")(function* (
        organizationId: OrganizationId,
        name: string,
      ) {
        const [row] = yield* db
          .select()
          .from(projects)
          .where(and(eq(projects.organizationId, organizationId), eq(projects.name, name)))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : toProject(row);
      });

      const byScratchOwner = Effect.fn("ProjectsRepo.byScratchOwner")(function* (userId: string) {
        const [row] = yield* db
          .select()
          .from(projects)
          .where(eq(projects.scratchOwnerUserId, userId))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : toProject(row);
      });

      const publishInitialized = Effect.fn("ProjectsRepo.publishInitialized")(function* (
        project: InitializedProject,
      ) {
        const { purpose, headSha, ...input } = project;
        // Set when the body succeeds: only a failure after that can be a COMMIT with an unknown
        // outcome, and an uncertain COMMIT must never cause the caller to delete a registered store.
        let commitRequested = false;
        const confirm = (cause: unknown) =>
          db
            .select()
            .from(projects)
            .where(eq(projects.id, project.id))
            .limit(1)
            .pipe(
              Effect.mapError(
                (readCause) =>
                  new ProjectPublicationUnconfirmed({
                    projectId: project.id,
                    cause: { publication: cause, read: readCause },
                  }),
              ),
              Effect.flatMap(([row]) =>
                row === undefined ||
                row.organizationId !== project.organizationId ||
                row.createdByUserId !== project.createdByUserId ||
                row.name !== project.name ||
                row.storePath !== project.storePath
                  ? Effect.fail(new ProjectPublicationUnconfirmed({ projectId: project.id, cause }))
                  : Effect.succeed(toProject(row)),
              ),
            );
        // Some row holds a colliding key, so the store it names may be registered after all.
        const unpublished = (
          cause: unknown,
        ): Effect.Effect<Project, ProjectNotPublished | ProjectPublicationUnconfirmed> =>
          commitRequested || uniqueViolationConstraint(cause) !== null
            ? confirm(cause)
            : Effect.fail(new ProjectNotPublished({ projectId: project.id, cause }));
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const [member] = yield* db
                .select()
                .from(organizationMembers)
                .where(
                  and(
                    eq(organizationMembers.userId, project.createdByUserId),
                    eq(organizationMembers.organizationId, project.organizationId),
                  ),
                )
                .for("share");
              if (member === undefined) return yield* new ProjectMembershipChanged({});
              const [row] = yield* db
                .insert(projects)
                .values({
                  ...input,
                  visibility: "private",
                  originUrl: null,
                  adoptedSha: headSha,
                  scratchOwnerUserId: purpose === "scratch" ? project.createdByUserId : null,
                })
                .returning();
              if (row === undefined) return yield* Effect.die("project insert returned no row");
              const created = toProject(row);
              yield* notifyEvent(sql, { type: "project", projectId: created.id });
              commitRequested = true;
              return created;
            }),
          )
          .pipe(
            Effect.catch(
              (
                cause,
              ): Effect.Effect<
                Project,
                | ProjectNameTakenError
                | ScratchProjectExistsError
                | ProjectMembershipChanged
                | ProjectNotPublished
                | ProjectPublicationUnconfirmed
              > => {
                if (cause instanceof ProjectMembershipChanged) return Effect.fail(cause);
                switch (uniqueViolationConstraint(cause)) {
                  case "projects_organization_name_key":
                    return Effect.fail(new ProjectNameTakenError({ name: project.name }));
                  case "projects_scratch_owner_key":
                    return Effect.fail(
                      new ScratchProjectExistsError({ userId: project.createdByUserId }),
                    );
                  default:
                    return unpublished(cause);
                }
              },
            ),
            Effect.catchDefect(unpublished),
          );
      });

      const listAll = Effect.fn("ProjectsRepo.listAll")(function* () {
        const rows = yield* db
          .select()
          .from(projects)
          .orderBy(asc(projects.name))
          .pipe(Effect.orDie);
        return rows.map(toProject);
      });

      const listForOrganization = Effect.fn("ProjectsRepo.listForOrganization")(function* (
        organizationId: OrganizationId,
      ) {
        const rows = yield* db
          .select()
          .from(projects)
          .where(eq(projects.organizationId, organizationId))
          .orderBy(asc(projects.name))
          .pipe(Effect.orDie);
        return rows.map(toProject);
      });

      const setVisibility = Effect.fn("ProjectsRepo.setVisibility")(function* (
        id: ProjectId,
        visibility: ProjectVisibility,
      ) {
        const current = yield* byId(id);
        if (visibility === "shared" && current.scratchOwnerUserId !== null)
          return yield* new ScratchProjectPrivate({});
        const [row] = yield* db
          .update(projects)
          .set({ visibility, updatedAt: yield* DateTime.nowAsDate })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: updated.id });
        return updated;
      });

      const setCreatedBy = Effect.fn("ProjectsRepo.setCreatedBy")(function* (
        id: ProjectId,
        userId: string,
      ) {
        // Recovery transfers the content, not the departed person's scratch identity.
        const [row] = yield* db
          .update(projects)
          .set({
            createdByUserId: userId,
            scratchOwnerUserId: null,
            updatedAt: yield* DateTime.nowAsDate,
          })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: updated.id });
        return updated;
      });

      const setAutomation = Effect.fn("ProjectsRepo.setAutomation")(function* (
        id: ProjectId,
        choices: {
          readonly autoTour: AutomationChoice;
          readonly autoSuggest: AutomationChoice;
          readonly autoName: AutomationChoice;
          readonly backgroundSessions: AutomationChoice;
          readonly autoLand?: AutomationChoice;
        },
      ) {
        const { autoLand, ...cascade } = choices;
        const [row] = yield* db
          .update(projects)
          .set({
            ...cascade,
            ...(autoLand === undefined ? {} : { autoLand }),
            updatedAt: yield* DateTime.nowAsDate,
          })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: id });
        return updated;
      });

      const setAutoLand = Effect.fn("ProjectsRepo.setAutoLand")(function* (
        id: ProjectId,
        choice: AutomationChoice,
      ) {
        const [row] = yield* db
          .update(projects)
          .set({ autoLand: choice, updatedAt: yield* DateTime.nowAsDate })
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
          .set({ gitAuthMode: mode, updatedAt: yield* DateTime.nowAsDate })
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
          .set({ workspaceImage: image, updatedAt: yield* DateTime.nowAsDate })
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
          .set({ applyDotfiles, updatedAt: yield* DateTime.nowAsDate })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: id });
        return updated;
      });

      const setDefaultShellProfile = Effect.fn("ProjectsRepo.setDefaultShellProfile")(function* (
        id: ProjectId,
        defaultShellProfile: boolean,
      ) {
        const [row] = yield* db
          .update(projects)
          .set({ defaultShellProfile, updatedAt: yield* DateTime.nowAsDate })
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
          .set({ inheritUserSkills, updatedAt: yield* DateTime.nowAsDate })
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
          .set({ hotSessions, updatedAt: yield* DateTime.nowAsDate })
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
          .set({ installCommand, updatedAt: yield* DateTime.nowAsDate })
          .where(eq(projects.id, id))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new ProjectNotFoundError({ projectId: id });
        const updated = toProject(row);
        yield* notifyEvent(sql, { type: "project", projectId: id });
        return updated;
      });

      const setInstallEnabled = Effect.fn("ProjectsRepo.setInstallEnabled")(function* (
        id: ProjectId,
        installEnabled: boolean,
      ) {
        const [row] = yield* db
          .update(projects)
          .set({ installEnabled, updatedAt: yield* DateTime.nowAsDate })
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
        publishInitialized,
        byScratchOwner,
        byId,
        byName,
        listAll,
        listForOrganization,
        setVisibility,
        setCreatedBy,
        setAutomation,
        setAutoLand,
        setGitAuthMode,
        setWorkspaceImage,
        setApplyDotfiles,
        setDefaultShellProfile,
        setInheritUserSkills,
        setHotSessions,
        setInstallCommand,
        setInstallEnabled,
        remove,
      };
    }),
  );
