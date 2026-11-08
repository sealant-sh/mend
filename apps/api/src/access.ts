import { type AuthenticatedSession, CurrentUser, NotFound } from "@mend/api-contracts";
import {
  InstanceRolesRepo,
  type OrganizationMembership,
  OrganizationsRepo,
  type SignIn,
  ProjectsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  SessionsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import type {
  ChangeId,
  OrganizationId,
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
import { Effect, Layer, Option } from "effect";
import * as Context from "effect/Context";
import { HttpServerRequest } from "effect/http";

import { RemovedProjectWork } from "./removal-refusal.ts";

/**
 * Who acts, and so which of their organizations decides (docs/adr/0003, "Organization
 * switching"). A person acting through a client is a sign-in, and acts in the organization that
 * sign-in has active: anything elsewhere answers like a missing resource, even to a member of
 * both. Work done on a known resource's behalf (a Slack link, a page grant) names the
 * organization it acts in.
 */
export type Actor = SignIn | { readonly userId: string; readonly organizationId: OrganizationId };

/** The sign-in behind an HTTP request. */
export const signInOf = (caller: AuthenticatedSession): SignIn => ({
  userId: caller.user.id,
  credential: caller.credential ?? null,
});

const viewerFrom = (userId: string, membership: OrganizationMembership | null): Viewer | null =>
  membership === null
    ? null
    : { userId, organizationId: membership.organization.id, role: membership.role };

/**
 * Who may see what (docs/adr/0003-organizations-and-tenancy.md). Every project-scoped route
 * resolves its row through here instead of a repository, so the visibility rule lives in one
 * place. A project the caller cannot see answers `NotFound` exactly like a missing one, and a
 * worktree, change, session, process or Service inherits its project's answer. The id in that
 * `NotFound` is always the id the caller supplied, never a parent's.
 *
 * Every check happens before any effect: resolve here first, then act.
 *
 * A removed project reads as missing, except to an HTTP request that would change something in
 * it (any method but GET and HEAD) from a person who can see it in Removed projects: that request
 * is refused, as the database's removal fence refuses a start, with a defect the error boundary
 * answers `409 RemovalInProgress` saying to restore it (`RemovedProjectWork`).
 */
export class ProjectAccess extends Context.Service<
  ProjectAccess,
  {
    /** The caller's active organization and role there, or null for an account in none. */
    readonly viewer: () => Effect.Effect<Viewer | null, never, CurrentUser>;
    /** The same for any actor: a route that authenticated outside the HTTP API, a Slack link. */
    readonly viewerOf: (actor: Actor) => Effect.Effect<Viewer | null>;
    readonly project: (id: ProjectId) => Effect.Effect<Project, NotFound, CurrentUser>;
    readonly projectAs: (actor: Actor, id: ProjectId) => Effect.Effect<Project, NotFound>;
    /** Settings, removal and launch inputs: an owner, or the member who created the project. */
    readonly manageProject: (id: ProjectId) => Effect.Effect<Project, NotFound, CurrentUser>;
    /** Private or shared: owners only. */
    readonly changeVisibility: (id: ProjectId) => Effect.Effect<Project, NotFound, CurrentUser>;
    readonly worktree: (id: WorktreeId) => Effect.Effect<Worktree, NotFound, CurrentUser>;
    readonly change: (id: ChangeId) => Effect.Effect<Change, NotFound, CurrentUser>;
    readonly session: (id: SessionId) => Effect.Effect<Session, NotFound, CurrentUser>;
    /**
     * `session` as the session view reads it: the row with the people live in its executor
     * (docs/adr/0016, decision 13), in the same query.
     */
    readonly sessionView: (id: SessionId) => Effect.Effect<Session, NotFound, CurrentUser>;
    readonly sessionAs: (actor: Actor, id: SessionId) => Effect.Effect<Session, NotFound>;
    /**
     * `sessionAs` for an account as a member of the session's own organization: a grant minted
     * for one session, whose holder's sign-in is not at hand.
     */
    readonly sessionAsMember: (userId: string, id: SessionId) => Effect.Effect<Session, NotFound>;
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
    /** The same, for any actor. */
    readonly visibleProjectsOf: (actor: Actor) => Effect.Effect<ReadonlyArray<Project>>;
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

const READS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

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

    const viewerOf = Effect.fn("ProjectAccess.viewerOf")(function* (actor: Actor) {
      return viewerFrom(
        actor.userId,
        "organizationId" in actor
          ? yield* organizations.membershipIn(actor.organizationId, actor.userId)
          : yield* organizations.activeMembership(actor),
      );
    });

    const viewer = Effect.fn("ProjectAccess.viewer")(function* () {
      return yield* viewerOf(signInOf(yield* CurrentUser));
    });

    /** Dies with `RemovedProjectWork` when the request would change a removed project `viewer` sees. */
    const refuseRemovedWork = (projectId: ProjectId, caller: Viewer) =>
      Effect.gen(function* () {
        const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
        if (Option.isNone(request) || READS.has(request.value.method)) return;
        const kept = yield* projects.removedById(projectId);
        if (kept !== null && canSeeProject(kept.project, caller))
          return yield* Effect.die(new RemovedProjectWork({ state: kept.state }));
      });

    /** The project row when `allowed` holds for the viewer; `NotFound` for `requested` otherwise. */
    const guarded = (
      actor: Actor,
      projectId: ProjectId,
      requested: string,
      allowed: (project: Project, viewer: Viewer) => boolean,
    ) =>
      Effect.gen(function* () {
        const found = yield* viewerOf(actor);
        if (found === null) return yield* new NotFound({ id: requested });
        const row = yield* projects
          .byId(projectId)
          .pipe(
            Effect.catchTag("ProjectNotFoundError", () =>
              Effect.flatMap(refuseRemovedWork(projectId, found), () =>
                Effect.fail(new NotFound({ id: requested })),
              ),
            ),
          );
        if (!allowed(row, found)) return yield* new NotFound({ id: requested });
        return row;
      });

    const caller = Effect.gen(function* () {
      return signInOf(yield* CurrentUser);
    });

    const projectAs = Effect.fn("ProjectAccess.projectAs")(function* (actor: Actor, id: ProjectId) {
      return yield* guarded(actor, id, id, canSeeProject);
    });

    const project = Effect.fn("ProjectAccess.project")(function* (id: ProjectId) {
      return yield* projectAs(yield* caller, id);
    });

    const manageProject = Effect.fn("ProjectAccess.manageProject")(function* (id: ProjectId) {
      return yield* guarded(yield* caller, id, id, canManageProject);
    });

    const changeVisibility = Effect.fn("ProjectAccess.changeVisibility")(function* (id: ProjectId) {
      return yield* guarded(yield* caller, id, id, canChangeVisibility);
    });

    const worktree = Effect.fn("ProjectAccess.worktree")(function* (id: WorktreeId) {
      const row = yield* worktrees.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      yield* guarded(yield* caller, row.projectId, id, canSeeProject);
      return row;
    });

    const change = Effect.fn("ProjectAccess.change")(function* (id: ChangeId) {
      const row = yield* changes.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      yield* guarded(yield* caller, row.projectId, id, canSeeProject);
      return row;
    });

    const sessionAs = Effect.fn("ProjectAccess.sessionAs")(function* (actor: Actor, id: SessionId) {
      const row = yield* sessions.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      yield* guarded(actor, row.projectId, id, canSeeProject);
      return row;
    });

    const sessionAsMember = Effect.fn("ProjectAccess.sessionAsMember")(function* (
      userId: string,
      id: SessionId,
    ) {
      const row = yield* sessions.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
      const parent = yield* projects
        .byId(row.projectId)
        .pipe(Effect.mapError(() => new NotFound({ id })));
      yield* guarded(
        { userId, organizationId: parent.organizationId },
        row.projectId,
        id,
        canSeeProject,
      );
      return row;
    });

    const session = Effect.fn("ProjectAccess.session")(function* (id: SessionId) {
      return yield* sessionAs(yield* caller, id);
    });

    const sessionView = Effect.fn("ProjectAccess.sessionView")(function* (id: SessionId) {
      const actor = yield* caller;
      const row = yield* sessions.viewById(id).pipe(Effect.mapError(() => new NotFound({ id })));
      yield* guarded(actor, row.projectId, id, canSeeProject);
      return row;
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
      actor: Actor,
    ) {
      const found = yield* viewerOf(actor);
      if (found === null) return [];
      const rows = yield* projects.listForOrganization(found.organizationId);
      return rows.filter((row) => canSeeProject(row, found));
    });

    const visibleProjects = Effect.fn("ProjectAccess.visibleProjects")(function* () {
      return yield* visibleProjectsOf(yield* caller);
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
      if (!(yield* roles.isOperator((yield* CurrentUser).user.id))) {
        return yield* new NotFound({ id });
      }
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
      sessionView,
      sessionAs,
      sessionAsMember,
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
