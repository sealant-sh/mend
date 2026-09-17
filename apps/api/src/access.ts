import { CurrentUser, NotFound } from "@mend/api-contracts";
import {
  InstanceRolesRepo,
  OrganizationsRepo,
  ProjectsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  SessionsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import type {
  ChangeId,
  ProjectId,
  ServiceId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import {
  canChangeVisibility,
  canManageProject,
  canSeeProject,
  type Change,
  type Project,
  type Service,
  type Session,
  type SessionProcess,
  type Viewer,
  type Worktree,
} from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

/**
 * Who may see what (docs/adr/0003-organizations-and-tenancy.md). Every project-scoped route
 * resolves its row through here instead of a repository, so the visibility rule lives in one
 * place. A project the caller cannot see answers `NotFound` exactly like a missing one, and a
 * worktree, change, session, process or Service inherits its project's answer. The id in that
 * `NotFound` is always the id the caller supplied, never a parent's.
 *
 * Every check happens before any effect: resolve here first, then act.
 */
export class ProjectAccess extends Context.Service<
  ProjectAccess,
  {
    /** The caller's organization and role, or null for an account in no organization. */
    readonly viewer: () => Effect.Effect<Viewer | null, never, CurrentUser>;
    /** The same, for a route that authenticated outside the HTTP API (raw WebSocket routes). */
    readonly viewerOf: (userId: string) => Effect.Effect<Viewer | null>;
    readonly project: (id: ProjectId) => Effect.Effect<Project, NotFound, CurrentUser>;
    readonly projectAs: (userId: string, id: ProjectId) => Effect.Effect<Project, NotFound>;
    /** Settings, removal and launch inputs: an owner, or the member who created the project. */
    readonly manageProject: (id: ProjectId) => Effect.Effect<Project, NotFound, CurrentUser>;
    /** Private or shared: owners only. */
    readonly changeVisibility: (id: ProjectId) => Effect.Effect<Project, NotFound, CurrentUser>;
    readonly worktree: (id: WorktreeId) => Effect.Effect<Worktree, NotFound, CurrentUser>;
    readonly change: (id: ChangeId) => Effect.Effect<Change, NotFound, CurrentUser>;
    readonly session: (id: SessionId) => Effect.Effect<Session, NotFound, CurrentUser>;
    readonly sessionAs: (userId: string, id: SessionId) => Effect.Effect<Session, NotFound>;
    readonly process: (
      id: SessionProcessId,
    ) => Effect.Effect<
      { readonly process: SessionProcess; readonly session: Session },
      NotFound,
      CurrentUser
    >;
    readonly service: (
      id: ServiceId,
    ) => Effect.Effect<
      { readonly service: Service; readonly session: Session },
      NotFound,
      CurrentUser
    >;
    /** Every project the caller can see, by name. */
    readonly visibleProjects: () => Effect.Effect<ReadonlyArray<Project>, never, CurrentUser>;
    /** The same, for a route that authenticated outside the HTTP API. */
    readonly visibleProjectsOf: (userId: string) => Effect.Effect<ReadonlyArray<Project>>;
    readonly isOperator: (userId: string) => Effect.Effect<boolean>;
    /** Keep the rows whose project the caller can see. */
    readonly filterByProject: <A extends { readonly projectId: ProjectId }>(
      rows: ReadonlyArray<A>,
    ) => Effect.Effect<ReadonlyArray<A>, never, CurrentUser>;
    /** The caller's viewer when they own their organization; otherwise `NotFound` for `id`. */
    readonly requireOwner: (id: string) => Effect.Effect<Viewer, NotFound, CurrentUser>;
    /** Pass when the caller holds the operator role; otherwise `NotFound` for `id`. */
    readonly requireOperator: (id: string) => Effect.Effect<void, NotFound, CurrentUser>;
  }
>()("@mend/api/ProjectAccess") {}

export const ProjectAccessLive: Layer.Layer<
  ProjectAccess,
  never,
  | InstanceRolesRepo
  | OrganizationsRepo
  | ProjectsRepo
  | ServicesRepo
  | SessionProcessesRepo
  | SessionsRepo
  | WorktreeChangesRepo
  | WorktreesRepo
> = Layer.effect(
  ProjectAccess,
  Effect.gen(function* () {
    const organizations = yield* OrganizationsRepo;
    const roles = yield* InstanceRolesRepo;
    const projects = yield* ProjectsRepo;
    const sessions = yield* SessionsRepo;
    const worktrees = yield* WorktreesRepo;
    const changes = yield* WorktreeChangesRepo;
    const processes = yield* SessionProcessesRepo;
    const services = yield* ServicesRepo;

    const viewerOf = Effect.fn("ProjectAccess.viewerOf")(function* (userId: string) {
      const membership = yield* organizations.membershipOf(userId);
      if (membership === null) return null;
      const viewer: Viewer = {
        userId,
        organizationId: membership.organization.id,
        role: membership.role,
      };
      return viewer;
    });

    const viewer = Effect.fn("ProjectAccess.viewer")(function* () {
      const caller = yield* CurrentUser;
      return yield* viewerOf(caller.user.id);
    });

    /** The project row when `allowed` holds for the viewer; `NotFound` for `requested` otherwise. */
    const guarded = (
      userId: string,
      projectId: ProjectId,
      requested: string,
      allowed: (project: Project, viewer: Viewer) => boolean,
    ) =>
      Effect.gen(function* () {
        const found = yield* viewerOf(userId);
        if (found === null) return yield* new NotFound({ id: requested });
        const row = yield* projects
          .byId(projectId)
          .pipe(Effect.mapError(() => new NotFound({ id: requested })));
        if (!allowed(row, found)) return yield* new NotFound({ id: requested });
        return row;
      });

    const callerId = Effect.gen(function* () {
      const caller = yield* CurrentUser;
      return caller.user.id;
    });

    const projectAs = Effect.fn("ProjectAccess.projectAs")(function* (
      userId: string,
      id: ProjectId,
    ) {
      return yield* guarded(userId, id, id, canSeeProject);
    });

    const project = Effect.fn("ProjectAccess.project")(function* (id: ProjectId) {
      return yield* projectAs(yield* callerId, id);
    });

    const manageProject = Effect.fn("ProjectAccess.manageProject")(function* (id: ProjectId) {
      return yield* guarded(yield* callerId, id, id, canManageProject);
    });

    const changeVisibility = Effect.fn("ProjectAccess.changeVisibility")(function* (id: ProjectId) {
      return yield* guarded(yield* callerId, id, id, canChangeVisibility);
    });

    const worktree = Effect.fn("ProjectAccess.worktree")(function* (id: WorktreeId) {
      const row = yield* worktrees.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      yield* guarded(yield* callerId, row.projectId, id, canSeeProject);
      return row;
    });

    const change = Effect.fn("ProjectAccess.change")(function* (id: ChangeId) {
      const row = yield* changes.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      yield* guarded(yield* callerId, row.projectId, id, canSeeProject);
      return row;
    });

    const sessionAs = Effect.fn("ProjectAccess.sessionAs")(function* (
      userId: string,
      id: SessionId,
    ) {
      const row = yield* sessions.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      yield* guarded(userId, row.projectId, id, canSeeProject);
      return row;
    });

    const session = Effect.fn("ProjectAccess.session")(function* (id: SessionId) {
      return yield* sessionAs(yield* callerId, id);
    });

    const process = Effect.fn("ProjectAccess.process")(function* (id: SessionProcessId) {
      const row = yield* processes.byId(id);
      if (row === null) return yield* new NotFound({ id });
      const parent = yield* session(row.sessionId).pipe(
        Effect.mapError(() => new NotFound({ id })),
      );
      return { process: row, session: parent };
    });

    const service = Effect.fn("ProjectAccess.service")(function* (id: ServiceId) {
      const row = yield* services.byId(id);
      if (row === null) return yield* new NotFound({ id });
      const parent = yield* session(row.sessionId).pipe(
        Effect.mapError(() => new NotFound({ id })),
      );
      return { service: row, session: parent };
    });

    const visibleProjectsOf = Effect.fn("ProjectAccess.visibleProjectsOf")(function* (
      userId: string,
    ) {
      const found = yield* viewerOf(userId);
      if (found === null) return [];
      const rows = yield* projects.listForOrganization(found.organizationId);
      return rows.filter((row) => canSeeProject(row, found));
    });

    const visibleProjects = Effect.fn("ProjectAccess.visibleProjects")(function* () {
      return yield* visibleProjectsOf(yield* callerId);
    });

    const filterByProject = Effect.fn("ProjectAccess.filterByProject")(function* <
      A extends { readonly projectId: ProjectId },
    >(rows: ReadonlyArray<A>) {
      if (rows.length === 0) return rows;
      const visible = new Set<string>((yield* visibleProjects()).map((row) => row.id));
      return rows.filter((row) => visible.has(row.projectId));
    });

    const requireOwner = Effect.fn("ProjectAccess.requireOwner")(function* (id: string) {
      const found = yield* viewer();
      if (found === null || found.role !== "owner") return yield* new NotFound({ id });
      return found;
    });

    const requireOperator = Effect.fn("ProjectAccess.requireOperator")(function* (id: string) {
      if (!(yield* roles.isOperator(yield* callerId))) return yield* new NotFound({ id });
    });

    return {
      viewer,
      viewerOf,
      project,
      projectAs,
      manageProject,
      changeVisibility,
      worktree,
      change,
      session,
      sessionAs,
      process,
      service,
      visibleProjects,
      visibleProjectsOf,
      isOperator: roles.isOperator,
      filterByProject,
      requireOwner,
      requireOperator,
    };
  }),
);
