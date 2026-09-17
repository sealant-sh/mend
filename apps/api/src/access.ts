import { CurrentUser, NotFound } from "@mend/api-contracts";
import {
  ProjectsRepo,
  SessionsRepo,
  TeamsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import type { ChangeId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  canManageProject,
  canViewProject,
  type Change,
  type Project,
  type Session,
  type TeamStanding,
  type Worktree,
} from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

/**
 * Who may see what (docs/adr/0002-teams-and-project-scope.md). Every project-scoped route
 * resolves its row through here instead of the repo, so the visibility rule lives in one place:
 * a project the signed-in account cannot see answers `NotFound` — the same 404 another account's
 * device or skill answers — and a session, worktree, or change inherits its project's answer.
 * Visibility is the working permission; `manageProject` is the narrower one for removal and
 * scope changes.
 */
export class ProjectAccess extends Context.Service<
  ProjectAccess,
  {
    /** The caller's team standing — memoize per request when a handler needs it repeatedly. */
    readonly standing: () => Effect.Effect<
      { readonly userId: string; readonly standing: TeamStanding },
      never,
      CurrentUser
    >;
    readonly project: (id: ProjectId) => Effect.Effect<Project, NotFound, CurrentUser>;
    /** The project when the caller may remove it or change its scope; otherwise `NotFound`. */
    readonly manageProject: (id: ProjectId) => Effect.Effect<Project, NotFound, CurrentUser>;
    readonly session: (id: SessionId) => Effect.Effect<Session, NotFound, CurrentUser>;
    readonly worktree: (id: WorktreeId) => Effect.Effect<Worktree, NotFound, CurrentUser>;
    readonly change: (id: ChangeId) => Effect.Effect<Change, NotFound, CurrentUser>;
    /** Every project the caller can see, by name. */
    readonly visibleProjects: () => Effect.Effect<ReadonlyArray<Project>, never, CurrentUser>;
    /** Keep the rows whose project the caller can see (one standing read, one project read). */
    readonly filterByProject: <A extends { readonly projectId: ProjectId }>(
      rows: ReadonlyArray<A>,
    ) => Effect.Effect<ReadonlyArray<A>, never, CurrentUser>;
  }
>()("@mend/api/ProjectAccess") {}

export const ProjectAccessLive: Layer.Layer<
  ProjectAccess,
  never,
  ProjectsRepo | TeamsRepo | SessionsRepo | WorktreesRepo | WorktreeChangesRepo
> = Layer.effect(
  ProjectAccess,
  Effect.gen(function* () {
    const projects = yield* ProjectsRepo;
    const teams = yield* TeamsRepo;
    const sessions = yield* SessionsRepo;
    const worktrees = yield* WorktreesRepo;
    const changes = yield* WorktreeChangesRepo;

    const standing = Effect.fn("ProjectAccess.standing")(function* () {
      const caller = yield* CurrentUser;
      const userId = caller.user.id;
      return { userId, standing: yield* teams.standing(userId) };
    });

    /** The project row, or NotFound when it does not exist OR the caller cannot see it. */
    const project = Effect.fn("ProjectAccess.project")(function* (id: ProjectId) {
      const row = yield* projects.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      const who = yield* standing();
      if (!canViewProject(row, who.userId, who.standing)) return yield* new NotFound({ id });
      return row;
    });

    const manageProject = Effect.fn("ProjectAccess.manageProject")(function* (id: ProjectId) {
      const row = yield* projects.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      const who = yield* standing();
      if (!canManageProject(row, who.userId, who.standing)) return yield* new NotFound({ id });
      return row;
    });

    const session = Effect.fn("ProjectAccess.session")(function* (id: SessionId) {
      const row = yield* sessions.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      yield* project(row.projectId).pipe(Effect.mapError(() => new NotFound({ id })));
      return row;
    });

    const worktree = Effect.fn("ProjectAccess.worktree")(function* (id: WorktreeId) {
      const row = yield* worktrees.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      yield* project(row.projectId).pipe(Effect.mapError(() => new NotFound({ id })));
      return row;
    });

    const change = Effect.fn("ProjectAccess.change")(function* (id: ChangeId) {
      const row = yield* changes.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      yield* project(row.projectId).pipe(Effect.mapError(() => new NotFound({ id })));
      return row;
    });

    const visibleProjects = Effect.fn("ProjectAccess.visibleProjects")(function* () {
      const who = yield* standing();
      const rows = yield* projects.list();
      return rows.filter((row) => canViewProject(row, who.userId, who.standing));
    });

    const filterByProject = Effect.fn("ProjectAccess.filterByProject")(function* <
      A extends { readonly projectId: ProjectId },
    >(rows: ReadonlyArray<A>) {
      if (rows.length === 0) return rows;
      const visible = new Set((yield* visibleProjects()).map((row) => row.id));
      return rows.filter((row) => visible.has(row.projectId));
    });

    return {
      standing,
      project,
      manageProject,
      session,
      worktree,
      change,
      visibleProjects,
      filterByProject,
    };
  }),
);
