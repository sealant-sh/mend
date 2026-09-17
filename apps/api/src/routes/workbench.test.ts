import { projectsGroup, ProjectDetail } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import {
  HotWorkspacesRepo,
  InstanceRolesRepo,
  OrganizationsRepo,
  ProjectNotFoundError,
  ProjectsRepo,
  ServiceForwardsRepo,
  ServicesRepo,
  SessionProcessesRepo,
  SessionsRepo,
  UserGitAccessRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import { OrganizationId, ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import {
  Organization,
  Project,
  Session,
  Worktree,
  type SessionStatus,
} from "@mend/domain/workbench";
import { JobRunner } from "@mend/jobs";
import { SealantClient } from "@mend/sealant";
import { SessionEngine, WorktreeReads } from "@mend/sessions";
import { AgentBridge, MendKeys, Store } from "@mend/store";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";

import { ProjectAccess, ProjectAccessLive } from "../access.ts";
import { AuthMiddlewareLive } from "./api-live.ts";
import { Gh } from "./github.ts";
import { ProjectsGroupLive } from "./workbench.ts";

const PROJECT_ID = ProjectId.make("project-visible");
const OTHER_PROJECT_ID = ProjectId.make("project-other");
const WORKTREE_ID = WorktreeId.make("worktree-visible");
const OTHER_WORKTREE_ID = WorktreeId.make("worktree-other");
const AUTHORIZATION = "Bearer project-detail-test";
const NOW = new Date("2026-09-12T10:00:00.000Z");

const project = (id: ProjectId, name: string): Project =>
  new Project({
    id,
    name,
    organizationId: OrganizationId.make("org-test"),
    visibility: "shared",
    createdByUserId: null,
    originUrl: `https://example.invalid/${name}.git`,
    storePath: `/store/${name}/repo.git`,
    defaultBranch: "main",
    adoptedSha: Sha.make("0123456789abcdef"),
    autoTour: "inherit",
    autoSuggest: "inherit",
    autoName: "inherit",
    backgroundSessions: "inherit",
    gitAuthMode: "ambient",
    workspaceImage: null,
    applyDotfiles: true,
    inheritUserSkills: true,
    hotSessions: 0,
    installCommand: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

const worktree = (id: WorktreeId, projectId: ProjectId, name: string): Worktree =>
  new Worktree({
    id,
    projectId,
    name,
    directory: name,
    branch: `mend/${name}`,
    baseSha: Sha.make("0123456789abcdef"),
    baseRef: "main",
    createdAt: NOW,
    updatedAt: NOW,
  });

interface SessionInput {
  readonly id: string;
  readonly status: SessionStatus;
  readonly hasTranscript: boolean | null;
  readonly projectId?: ProjectId;
  readonly worktreeId?: WorktreeId;
}

const session = ({
  id,
  status,
  hasTranscript,
  projectId = PROJECT_ID,
  worktreeId = WORKTREE_ID,
}: SessionInput): Session =>
  new Session({
    id: SessionId.make(id),
    projectId,
    worktreeId,
    harness: "codex",
    providerSessionId: null,
    label: id,
    worktree: worktreeId === WORKTREE_ID ? "visible" : "other",
    branch: worktreeId === WORKTREE_ID ? "mend/visible" : "mend/other",
    baseSha: Sha.make("0123456789abcdef"),
    baseRef: "main",
    contextSnapshotId: null,
    referenceMounts: [],
    extraMounts: [],
    sealantRunId: null,
    sealantWorkspaceId: null,
    sealantSessionId: null,
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    workspaceImage: null,
    dotfiles: null,
    ownerUserId: "user-project-detail",
    hasTranscript,
    status,
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: true,
    startedAt: NOW,
    settledAt: status === "completed" || status === "failed" || status === "stopped" ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  });

interface TestWorld {
  readonly projects: ReadonlyArray<Project>;
  readonly sessions: ReadonlyArray<Session>;
  readonly worktrees: ReadonlyArray<Worktree>;
}

const projectsLayer = (world: TestWorld): Layer.Layer<ProjectsRepo> =>
  Layer.mock(ProjectsRepo, {
    byId: (id) => {
      const found = world.projects.find((candidate) => candidate.id === id);
      return found === undefined
        ? Effect.fail(new ProjectNotFoundError({ projectId: id }))
        : Effect.succeed(found);
    },
    byName: (organizationId, name) =>
      Effect.succeed(
        world.projects.find(
          (candidate) => candidate.organizationId === organizationId && candidate.name === name,
        ) ?? null,
      ),
    listAll: () => Effect.succeed(world.projects),
  });

const sessionsLayer = (world: TestWorld): Layer.Layer<SessionsRepo> =>
  Layer.mock(SessionsRepo, {
    byId: (id) => {
      const found = world.sessions.find((candidate) => candidate.id === id);
      return found === undefined ? Effect.die(`Unknown test session ${id}`) : Effect.succeed(found);
    },
    listForProject: (projectId) =>
      Effect.succeed(world.sessions.filter((candidate) => candidate.projectId === projectId)),
    listForWorktree: (worktreeId) =>
      Effect.succeed(world.sessions.filter((candidate) => candidate.worktreeId === worktreeId)),
  });

const worktreesLayer = (world: TestWorld): Layer.Layer<WorktreesRepo> =>
  Layer.mock(WorktreesRepo, {
    byId: (id) => {
      const found = world.worktrees.find((candidate) => candidate.id === id);
      return found === undefined
        ? Effect.die(`Unknown test worktree ${id}`)
        : Effect.succeed(found);
    },
    listForProject: (projectId) =>
      Effect.succeed(world.worktrees.filter((candidate) => candidate.projectId === projectId)),
  });

const changesLayer: Layer.Layer<WorktreeChangesRepo> = Layer.mock(WorktreeChangesRepo, {
  annotationsForProject: () => Effect.succeed([]),
});

const processesLayer: Layer.Layer<SessionProcessesRepo> = Layer.mock(SessionProcessesRepo, {
  listForSessions: () => Effect.succeed([]),
});

const authLayer: Layer.Layer<Auth> = Layer.succeed(Auth, {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  getSession: (headers) =>
    Effect.succeed(
      headers.get("authorization") === AUTHORIZATION
        ? Option.some({
            user: {
              id: "user-project-detail",
              email: "project-detail@example.invalid",
              name: "Project detail test",
            },
            expiresAt: new Date("2026-09-13T10:00:00.000Z"),
          })
        : Option.none(),
    ),
});

type ProjectRouteServices =
  | ProjectsRepo
  | AgentBridge
  | Store
  | UserGitAccessRepo
  | MendKeys
  | SessionsRepo
  | WorktreeChangesRepo
  | SessionProcessesRepo
  | WorktreesRepo
  | ServicesRepo
  | ServiceForwardsRepo
  | SessionEngine
  | HotWorkspacesRepo
  | SealantClient
  | JobRunner
  | WorktreeReads
  | Gh
  | OrganizationsRepo
  | InstanceRolesRepo
  | ProjectAccess;

type UnusedProjectRouteServices = Exclude<
  ProjectRouteServices,
  | ProjectsRepo
  | SessionsRepo
  | WorktreeChangesRepo
  | SessionProcessesRepo
  | WorktreesRepo
  | ProjectAccess
>;

const unusedProjectRouteLayers: Layer.Layer<UnusedProjectRouteServices> = Layer.mergeAll(
  Layer.mock(AgentBridge, { socketPath: () => "/unused/project-detail-agent-bridge.sock" }),
  Layer.mock(Store, {}),
  Layer.mock(UserGitAccessRepo, {}),
  Layer.mock(MendKeys, {}),
  Layer.mock(ServicesRepo, {}),
  Layer.mock(ServiceForwardsRepo, {}),
  Layer.mock(SessionEngine, {}),
  Layer.mock(HotWorkspacesRepo, {}),
  Layer.mock(SealantClient, {}),
  Layer.mock(JobRunner, {}),
  Layer.mock(WorktreeReads, {}),
  Layer.mock(Gh, {}),
  Layer.mock(InstanceRolesRepo, {}),
  Layer.mock(OrganizationsRepo, {
    membershipOf: () =>
      Effect.succeed({
        organization: new Organization({
          id: OrganizationId.make("org-test"),
          name: "Test",
          createdByUserId: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
        role: "owner",
        joinedAt: new Date(0),
      }),
  }),
);

const ProjectsApi = HttpApi.make("mend").add(projectsGroup).prefix("/api");
const decodeProjectDetail = Schema.decodeUnknownSync(ProjectDetail);

const makeWorld = (
  sessions: ReadonlyArray<Session>,
  worktrees: ReadonlyArray<Worktree> = [worktree(WORKTREE_ID, PROJECT_ID, "visible")],
): TestWorld => ({
  projects: [project(PROJECT_ID, "visible"), project(OTHER_PROJECT_ID, "other")],
  sessions: [
    ...sessions,
    session({
      id: "other-project-session",
      projectId: OTHER_PROJECT_ID,
      worktreeId: OTHER_WORKTREE_ID,
      status: "completed",
      hasTranscript: true,
    }),
  ],
  worktrees: [...worktrees, worktree(OTHER_WORKTREE_ID, OTHER_PROJECT_ID, "other")],
});

const requestProject = async (
  world: TestWorld,
  path = `/api/projects/${PROJECT_ID}`,
  authorization: string | null = AUTHORIZATION,
  init: RequestInit = {},
): Promise<{ readonly response: Response; readonly detail: ProjectDetail | null }> => {
  const projectRouteDependencies = ProjectAccessLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        projectsLayer(world),
        sessionsLayer(world),
        worktreesLayer(world),
        changesLayer,
        processesLayer,
        unusedProjectRouteLayers,
      ),
    ),
  );
  const authMiddlewareLayer = AuthMiddlewareLive.pipe(Layer.provide(authLayer));
  const apiLayer = HttpApiBuilder.layer(ProjectsApi).pipe(
    Layer.provide(ProjectsGroupLive),
    Layer.provide(authMiddlewareLayer),
    Layer.provide(HttpServer.layerServices),
  );
  const dependenciesRuntime = ManagedRuntime.make(projectRouteDependencies);
  const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });

  try {
    const requestContext = await dependenciesRuntime.runPromise(
      Effect.context<ProjectRouteServices>(),
    );
    const headers = new Headers(init.headers);
    if (authorization !== null) headers.set("authorization", authorization);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await handler(
      new Request(`http://api.internal${path}`, { ...init, headers }),
      requestContext,
    );
    if (response.status !== 200) return { response, detail: null };
    const body: unknown = await response.json();
    return { response, detail: decodeProjectDetail(body) };
  } finally {
    await dispose();
    await dependenciesRuntime.dispose();
  }
};

const visibleIds = (detail: ProjectDetail): ReadonlyArray<string> =>
  detail.sessions.map((row) => row.id);

describe("GET /projects/:id response", () => {
  it("returns an empty project response without inventing hidden sessions", async () => {
    const { response, detail } = await requestProject(makeWorld([], []));

    expect(response.status).toBe(200);
    expect(detail?.project.id).toBe(PROJECT_ID);
    expect(detail?.sessions).toEqual([]);
    expect(detail?.hiddenEndedSessions).toBe(0);
    expect(detail?.worktrees).toEqual([]);
  });

  it("reports zero while preserving live, captured, and unclassified sessions", async () => {
    const rows = [
      session({ id: "running", status: "running", hasTranscript: false }),
      session({ id: "captured", status: "failed", hasTranscript: true }),
      session({ id: "unclassified", status: "completed", hasTranscript: null }),
    ];
    const { detail } = await requestProject(makeWorld(rows));

    expect(detail?.hiddenEndedSessions).toBe(0);
    expect(detail === null ? [] : visibleIds(detail)).toEqual([
      "running",
      "captured",
      "unclassified",
    ]);
  });

  it("hides and counts one ended session without a captured transcript", async () => {
    const rows = [
      session({ id: "hidden", status: "completed", hasTranscript: false }),
      session({ id: "captured", status: "completed", hasTranscript: true }),
    ];
    const { detail } = await requestProject(makeWorld(rows));

    expect(detail?.hiddenEndedSessions).toBe(1);
    expect(detail === null ? [] : visibleIds(detail)).toEqual(["captured"]);
    expect(detail?.worktreeAnnotations[0]?.sessions).toBe(1);
  });

  it("hides and counts multiple ended sessions while retaining every live state", async () => {
    const rows = [
      session({ id: "hidden-completed", status: "completed", hasTranscript: false }),
      session({ id: "starting", status: "starting", hasTranscript: false }),
      session({ id: "hidden-failed", status: "failed", hasTranscript: false }),
      session({ id: "idle", status: "idle", hasTranscript: false }),
      session({ id: "hidden-stopped", status: "stopped", hasTranscript: false }),
      session({ id: "waiting", status: "waiting", hasTranscript: false }),
    ];
    const { detail } = await requestProject(makeWorld(rows));

    expect(detail?.hiddenEndedSessions).toBe(3);
    expect(detail === null ? [] : visibleIds(detail)).toEqual(["starting", "idle", "waiting"]);
    expect(detail?.worktreeAnnotations[0]?.liveSessions).toBe(3);
  });

  it("returns the worktree and hidden count when every ended session is hidden", async () => {
    const rows = [
      session({ id: "completed", status: "completed", hasTranscript: false }),
      session({ id: "failed", status: "failed", hasTranscript: false }),
    ];
    const { detail } = await requestProject(makeWorld(rows));

    expect(detail?.sessions).toEqual([]);
    expect(detail?.hiddenEndedSessions).toBe(2);
    expect(detail?.worktrees.map((row) => row.id)).toEqual([WORKTREE_ID]);
    expect(detail?.worktreeAnnotations[0]?.sessions).toBe(0);
  });

  it("includes dead ends on request and reports that the response hid none", async () => {
    const rows = [
      session({ id: "hidden", status: "completed", hasTranscript: false }),
      session({ id: "captured", status: "completed", hasTranscript: true }),
    ];
    const { detail } = await requestProject(
      makeWorld(rows),
      `/api/projects/${PROJECT_ID}?deadEnds=include`,
    );

    expect(detail?.hiddenEndedSessions).toBe(0);
    expect(detail === null ? [] : visibleIds(detail)).toEqual(["hidden", "captured"]);
    expect(detail?.worktreeAnnotations[0]?.sessions).toBe(2);
  });

  it("keeps sessions and worktrees scoped to the requested project", async () => {
    const { detail } = await requestProject(
      makeWorld([
        session({ id: "requested-project-session", status: "completed", hasTranscript: true }),
      ]),
    );

    expect(detail?.project.id).toBe(PROJECT_ID);
    expect(detail === null ? [] : visibleIds(detail)).toEqual(["requested-project-session"]);
    expect(detail?.worktrees.map((row) => row.id)).toEqual([WORKTREE_ID]);
  });

  it("runs the route's authorization middleware", async () => {
    const { response, detail } = await requestProject(makeWorld([]), undefined, null);

    expect(response.status).toBe(401);
    expect(detail).toBeNull();
  });

  it("returns not found through the endpoint error schema", async () => {
    const { response, detail } = await requestProject(makeWorld([]), "/api/projects/missing");

    expect(response.status).toBe(404);
    expect(detail).toBeNull();
  });

  it("does not disclose an existing project's id, scope, or store path on adoption conflict", async () => {
    const world = makeWorld([]);
    const existing = world.projects[0];
    if (existing === undefined) throw new Error("The test world needs one existing project");

    const { response } = await requestProject(world, "/api/projects", AUTHORIZATION, {
      method: "POST",
      body: JSON.stringify({
        name: existing.name,
        source: "https://example.invalid/replacement.git",
      }),
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({
      _tag: "StoreFailure",
      message: `A project named "${existing.name}" already exists.`,
    });
    expect(JSON.stringify(body)).not.toContain(existing.id);
    expect(JSON.stringify(body)).not.toContain(existing.storePath);
  });
});
