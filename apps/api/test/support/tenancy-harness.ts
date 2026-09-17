import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Auth } from "@mend/auth";
import {
  AgentConversationRepo,
  FolderNotFoundError,
  FoldersRepo,
  InstanceRolesRepo,
  OrganizationsRepo,
  ProjectNotFoundError,
  ProjectsRepo,
  ReferenceNotFoundError,
  ReferencesRepo,
  ServicesRepo,
  SessionChangeNotFoundError,
  SessionNotFoundError,
  SessionProcessesRepo,
  SessionsRepo,
  SkillNotFoundError,
  SkillsRepo,
  WorktreeChangesRepo,
  WorktreeNotFoundError,
  WorktreesRepo,
} from "@mend/db";
import {
  AgentRequestId,
  AgentTurnId,
  ChangeId,
  FolderId,
  OrganizationId,
  ProjectId,
  ReferenceId,
  SealantWorkspaceId,
  ServiceId,
  SessionId,
  SessionProcessId,
  Sha,
  SkillId,
  WorktreeId,
} from "@mend/domain";
import {
  AgentRequest,
  AgentTurn,
  Change,
  Folder,
  Organization,
  Project,
  Reference,
  Service,
  Session,
  SessionProcess,
  Skill,
  SkillWithFiles,
  Worktree,
  type OrganizationRole,
  type ProjectVisibility,
} from "@mend/domain/workbench";
import { Effect, Layer, Option } from "effect";
import type * as Context from "effect/Context";

/**
 * A two-organization world for route authorization tests (docs/adr/0003):
 *
 * - organization A: alice (owner, and the instance operator), carol (member)
 * - organization B: bob (owner)
 * - dave belongs to no organization
 *
 * Projects: `shared-a` (A, shared, alice), `private-alice` (A), `private-carol` (A) and
 * `shared-b` (B, shared, bob). Each project has a worktree, a change, a session owned by its
 * creator, a shell process, a Service, a turn, an agent request and a project skill; `shared-a`
 * also has a session owned by carol.
 *
 * Every service is a recording mock: a call to anything outside the reads authorization itself
 * needs lands in `calls`, so a refused request can be checked for zero effects.
 */

export type HarnessUser = "alice" | "carol" | "bob" | "dave";
export type HarnessProject = "shared-a" | "private-alice" | "private-carol" | "shared-b";

export const USERS: Readonly<
  Record<
    HarnessUser,
    { readonly organization: "A" | "B" | null; readonly role: OrganizationRole | null }
  >
> = {
  alice: { organization: "A", role: "owner" },
  carol: { organization: "A", role: "member" },
  bob: { organization: "B", role: "owner" },
  dave: { organization: null, role: null },
};

export const OPERATORS: ReadonlySet<HarnessUser> = new Set(["alice"]);

const PROJECTS: Readonly<
  Record<
    HarnessProject,
    {
      readonly organization: "A" | "B";
      readonly visibility: ProjectVisibility;
      readonly creator: HarnessUser;
    }
  >
> = {
  "shared-a": { organization: "A", visibility: "shared", creator: "alice" },
  "private-alice": { organization: "A", visibility: "private", creator: "alice" },
  "private-carol": { organization: "A", visibility: "private", creator: "carol" },
  "shared-b": { organization: "B", visibility: "shared", creator: "bob" },
};

/** Ids of one project's fixtures; every id is derived from the project key. */
export const ids = (project: HarnessProject) => ({
  project: ProjectId.make(`project-${project}`),
  worktree: WorktreeId.make(`worktree-${project}`),
  change: ChangeId.make(`change-${project}`),
  session: SessionId.make(`session-${project}`),
  process: SessionProcessId.make(`process-${project}`),
  service: ServiceId.make(`service-${project}`),
  turn: AgentTurnId.make(`turn-${project}`),
  request: AgentRequestId.make(`request-${project}`),
  skill: SkillId.make(`skill-${project}`),
});

/** Carol's own session inside alice's shared project, alone in its own worktree. */
export const CAROL_SESSION_IN_SHARED_A = SessionId.make("session-shared-a-carol");
export const CAROL_WORKTREE_IN_SHARED_A = WorktreeId.make("worktree-shared-a-carol");
/** A pre-organizations session with no owner in `shared-a`; nobody steers it. */
export const NULL_OWNER_SESSION = SessionId.make("session-shared-a-null-owner");
/** An agent-protocol process and a UDP Service on alice's session in `shared-a`. */
export const PROTOCOL_PROCESS = SessionProcessId.make("process-shared-a-protocol");
export const UDP_SERVICE = ServiceId.make("service-shared-a-udp");
export const CAROL_USER_SKILL = SkillId.make("skill-user-carol");
/** One folder in each organization. */
export const FOLDER_A = FolderId.make("folder-org-A");
export const FOLDER_B = FolderId.make("folder-org-B");
/** One reference repository in each organization. */
export const REFERENCE_A = ReferenceId.make("reference-org-A");
export const REFERENCE_B = ReferenceId.make("reference-org-B");

const organizationIdOf = (key: "A" | "B") => OrganizationId.make(`org-${key}`);

const NOW = new Date("2026-09-17T10:00:00.000Z");

/** The reads authorization performs; everything else a handler calls is an effect. */
export const AUTHORIZATION_READS: ReadonlySet<string> = new Set([
  "organizations.membershipOf",
  "instanceRoles.isOperator",
  "projects.byId",
  "projects.listForOrganization",
  "sessions.byId",
  // The session budgets count before anything is created; a count is a read, not an effect.
  "sessions.countUnsettledForOrganization",
  "sessions.listUnsettledForOwner",
  // Worktree removal by a non-manager needs every member session's owner.
  "sessions.listForWorktree",
  "worktrees.byId",
  "changes.byId",
  "processes.byId",
  // The terminal route picks a session's current agent process before it attaches.
  "processes.listForSession",
  "services.byId",
  "conversation.byTurnId",
  "conversation.byRequestId",
  // A skill's scope decides whose access applies, so it is read first.
  "skills.byId",
  // A reference's organization decides whether an owner may manage or select it.
  "references.byId",
  "references.byIdsInOrganization",
  // A folder's organization decides whether the caller may read, change or select it.
  "folders.byId",
]);

/**
 * Wrap a mock so every method call is recorded under `name.method`, except the authorization
 * reads. Methods the implementation leaves out are recorded too, then die: a refused request
 * that reaches one still shows up as an effect.
 */
export const recording = <I, S extends object>(
  key: Context.Key<I, S>,
  name: string,
  implementation: Layer.PartialEffectful<S>,
  calls: Array<string>,
): Layer.Layer<I> => {
  const base = Effect.runSync(
    Effect.gen(function* () {
      return yield* key;
    }).pipe(Effect.provide(Layer.mock(key, implementation))),
  );
  // Layer.mock's proxy answers every property; its target holds only what was implemented.
  const implemented = new Set(Reflect.ownKeys(base));
  const proxied = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      const label = `${name}.${property}`;
      if (!implemented.has(property)) {
        return () => {
          calls.push(label);
          return Effect.die(new Error(`the harness does not implement ${label}`));
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: ReadonlyArray<unknown>) => {
        if (!AUTHORIZATION_READS.has(label)) calls.push(label);
        return value.apply(target, args);
      };
    },
  });
  return Layer.succeed(key, proxied);
};

export interface TenancyWorld {
  readonly root: string;
  readonly calls: Array<string>;
  readonly projects: ReadonlyMap<ProjectId, Project>;
  readonly sessions: ReadonlyMap<SessionId, Session>;
  readonly worktrees: ReadonlyMap<WorktreeId, Worktree>;
  readonly changes: ReadonlyMap<ChangeId, Change>;
  readonly processes: ReadonlyMap<SessionProcessId, SessionProcess>;
  readonly services: ReadonlyMap<ServiceId, Service>;
  readonly skills: ReadonlyMap<SkillId, SkillWithFiles>;
  /** Flip a project's visibility, as an owner's `PUT /projects/:id/visibility` would. */
  readonly setVisibility: (project: HarnessProject, visibility: ProjectVisibility) => void;
  /** Tokens: each user's bearer is their name. */
  readonly authLayer: Layer.Layer<Auth>;
  /** The authorization reads over the world, recorded like everything else. */
  readonly accessLayers: Layer.Layer<
    | OrganizationsRepo
    | InstanceRolesRepo
    | ProjectsRepo
    | SessionsRepo
    | WorktreesRepo
    | WorktreeChangesRepo
    | SessionProcessesRepo
    | ServicesRepo
    | AgentConversationRepo
    | SkillsRepo
    | ReferencesRepo
    | FoldersRepo
  >;
  readonly dispose: () => Promise<void>;
}

const found = <K, V, E>(map: ReadonlyMap<K, V>, key: K, missing: () => E) => {
  const value = map.get(key);
  return value === undefined ? Effect.fail(missing()) : Effect.succeed(value);
};

/** A project with only its tenancy facts and store path chosen; everything else is inert. */
export const makeProject = (facts: {
  readonly id: ProjectId;
  readonly organizationId: OrganizationId;
  readonly visibility: "private" | "shared";
  readonly createdByUserId: string | null;
  readonly storePath: string;
}): Project =>
  new Project({
    ...facts,
    name: String(facts.id),
    originUrl: null,
    defaultBranch: "main",
    adoptedSha: Sha.make("0123456789abcdef"),
    autoTour: "off",
    autoSuggest: "off",
    autoName: "off",
    backgroundSessions: "off",
    gitAuthMode: "ambient",
    workspaceImage: null,
    applyDotfiles: false,
    inheritUserSkills: false,
    hotSessions: 0,
    installCommand: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

export const makeSession = (
  id: SessionId,
  project: ProjectId,
  worktree: WorktreeId,
  ownerUserId: string | null,
): Session =>
  new Session({
    id,
    projectId: project,
    worktreeId: worktree,
    harness: "codex",
    providerSessionId: null,
    label: "Tenancy harness",
    worktree: String(worktree),
    branch: `mend/${String(worktree)}`,
    baseSha: Sha.make("0123456789abcdef"),
    baseRef: "main",
    contextSnapshotId: null,
    referenceMounts: [],
    extraMounts: [],
    sealantRunId: null,
    sealantWorkspaceId: SealantWorkspaceId.make(`workspace-${String(id)}`),
    sealantSessionId: `platform-${String(id)}`,
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    workspaceImage: null,
    dotfiles: null,
    ownerUserId,
    hasTranscript: true,
    status: "completed",
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: true,
    startedAt: NOW,
    settledAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });

export const createTenancyWorld = async (): Promise<TenancyWorld> => {
  const root = await mkdtemp(join(tmpdir(), "mend-tenancy-harness-"));
  const calls: Array<string> = [];

  const organizations = new Map<"A" | "B", Organization>(
    (["A", "B"] as const).map((key) => [
      key,
      new Organization({
        id: organizationIdOf(key),
        name: `Organization ${key}`,
        createdByUserId: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ]),
  );

  const projects = new Map<ProjectId, Project>();
  const worktrees = new Map<WorktreeId, Worktree>();
  const changes = new Map<ChangeId, Change>();
  const sessions = new Map<SessionId, Session>();
  const processes = new Map<SessionProcessId, SessionProcess>();
  const services = new Map<ServiceId, Service>();
  const turns = new Map<AgentTurnId, AgentTurn>();
  const requests = new Map<AgentRequestId, AgentRequest>();
  const skills = new Map<SkillId, SkillWithFiles>();

  for (const [key, facts] of Object.entries(PROJECTS)) {
    if (!(key in PROJECTS)) continue;
    const projectKey =
      key === "shared-a" || key === "private-alice" || key === "private-carol" || key === "shared-b"
        ? key
        : null;
    if (projectKey === null) continue;
    const own = ids(projectKey);
    const organization = organizations.get(facts.organization);
    if (organization === undefined) throw new Error("harness organization missing");
    projects.set(
      own.project,
      new Project({
        ...makeProject({
          id: own.project,
          organizationId: organization.id,
          visibility: facts.visibility,
          createdByUserId: facts.creator,
          storePath: join(root, projectKey, "repo.git"),
        }),
        name: projectKey,
        originUrl: `https://example.invalid/${projectKey}.git`,
      }),
    );
    worktrees.set(
      own.worktree,
      new Worktree({
        id: own.worktree,
        projectId: own.project,
        name: projectKey,
        directory: projectKey,
        branch: `mend/${projectKey}`,
        baseSha: Sha.make("0123456789abcdef"),
        baseRef: "main",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    changes.set(
      own.change,
      new Change({
        id: own.change,
        projectId: own.project,
        worktreeId: own.worktree,
        sessionId: own.session,
        branch: `mend/${projectKey}`,
        baseSha: Sha.make("0123456789abcdef"),
        headSha: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    sessions.set(own.session, makeSession(own.session, own.project, own.worktree, facts.creator));
    processes.set(
      own.process,
      new SessionProcess({
        id: own.process,
        sessionId: own.session,
        sealantWorkspaceId: SealantWorkspaceId.make(`workspace-${projectKey}`),
        sealantSessionId: `platform-process-${projectKey}`,
        sealantRunId: null,
        launchCorrelationId: null,
        serviceId: null,
        attemptOrdinal: null,
        kind: "shell",
        harness: null,
        providerSessionId: null,
        protocolOptions: null,
        label: "shell",
        argv: ["sh"],
        status: "stopped",
        exitCode: 0,
        workspacePort: null,
        protocol: "tcp",
        hostPort: null,
        createdAt: NOW,
        exitedAt: NOW,
        updatedAt: NOW,
      }),
    );
    services.set(
      own.service,
      new Service({
        id: own.service,
        sessionId: own.session,
        name: "web",
        declarationSource: "explicit-run",
        workspacePort: 3000,
        transport: "tcp",
        browserScheme: "http",
        bindAddresses: ["127.0.0.1"],
        preferredHostPort: null,
        currentAttemptId: null,
        currentForwardId: null,
        attemptHistoryComplete: true,
        forwardHistoryComplete: true,
        observationHistoryComplete: true,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    turns.set(
      own.turn,
      new AgentTurn({
        id: own.turn,
        sessionId: own.session,
        processId: own.process,
        ordinal: 1,
        author: facts.creator,
        input: "Continue",
        status: "running",
        providerTurnId: "provider-turn",
        error: null,
        usage: null,
        createdAt: NOW,
        startedAt: NOW,
        endedAt: null,
      }),
    );
    requests.set(
      own.request,
      new AgentRequest({
        id: own.request,
        sessionId: own.session,
        processId: own.process,
        turnId: own.turn,
        kind: "command-approval",
        providerRequestId: "provider-request",
        providerItemId: null,
        title: "Run tests",
        detail: null,
        questions: null,
        status: "pending",
        decision: null,
        decidedBy: null,
        answers: null,
        createdAt: NOW,
        decidedAt: null,
      }),
    );
    skills.set(
      own.skill,
      new SkillWithFiles({
        skill: new Skill({
          id: own.skill,
          scope: "project",
          ownerUserId: null,
          projectId: own.project,
          name: `skill-${projectKey}`,
          description: "Harness skill",
          fileCount: 1,
          bytes: 1,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        }),
        files: [],
      }),
    );
  }
  const sharedA = ids("shared-a");
  const sharedAWorktree = worktrees.get(sharedA.worktree);
  if (sharedAWorktree !== undefined) {
    worktrees.set(
      CAROL_WORKTREE_IN_SHARED_A,
      new Worktree({ ...sharedAWorktree, id: CAROL_WORKTREE_IN_SHARED_A, name: "carol" }),
    );
  }
  sessions.set(
    CAROL_SESSION_IN_SHARED_A,
    makeSession(CAROL_SESSION_IN_SHARED_A, sharedA.project, CAROL_WORKTREE_IN_SHARED_A, "carol"),
  );
  sessions.set(
    NULL_OWNER_SESSION,
    makeSession(NULL_OWNER_SESSION, sharedA.project, sharedA.worktree, null),
  );
  const aliceProcess = processes.get(sharedA.process);
  if (aliceProcess !== undefined) {
    processes.set(
      PROTOCOL_PROCESS,
      new SessionProcess({
        ...aliceProcess,
        id: PROTOCOL_PROCESS,
        kind: "agent-protocol",
        harness: "codex",
        label: "codex",
        argv: ["codex", "app-server"],
      }),
    );
  }
  const aliceService = services.get(sharedA.service);
  if (aliceService !== undefined) {
    services.set(UDP_SERVICE, new Service({ ...aliceService, id: UDP_SERVICE, transport: "udp" }));
  }
  skills.set(
    CAROL_USER_SKILL,
    new SkillWithFiles({
      skill: new Skill({
        id: CAROL_USER_SKILL,
        scope: "user",
        ownerUserId: "carol",
        projectId: null,
        name: "carol-skill",
        description: "Carol's own",
        fileCount: 1,
        bytes: 1,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }),
      files: [],
    }),
  );

  const references = new Map<ReferenceId, Reference>(
    (["A", "B"] as const).map((key) => {
      const id = key === "A" ? REFERENCE_A : REFERENCE_B;
      return [
        id,
        new Reference({
          id,
          name: `effect-${key}`,
          organizationId: organizationIdOf(key),
          createdByUserId: null,
          originUrl: "https://example.invalid/effect.git",
          path: join(root, "_organizations", key, "references", id),
          pinnedRef: null,
          headSha: null,
          refreshedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ];
    }),
  );

  const folderRows = new Map<FolderId, Folder>(
    (["A", "B"] as const).map((key) => {
      const id = key === "A" ? FOLDER_A : FOLDER_B;
      return [
        id,
        new Folder({
          id,
          organizationId: organizationIdOf(key),
          name: `docs-${key.toLowerCase()}`,
          path: join(root, "_organizations", key, "folders", id),
          createdByUserId: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ];
    }),
  );

  const authLayer = Layer.succeed(Auth, {
    handler: () => Effect.succeed(new Response(null, { status: 404 })),
    issuePasswordReset: () => Effect.die("unused"),
    getSession: (headers: Headers) => {
      const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const known = token === "alice" || token === "carol" || token === "bob" || token === "dave";
      return Effect.succeed(
        known
          ? Option.some({
              user: { id: token, email: `${token}@example.invalid`, name: token },
              expiresAt: new Date("2026-09-18T10:00:00.000Z"),
            })
          : Option.none(),
      );
    },
  });

  const membershipOf = (userId: string) => {
    const facts =
      userId === "alice" || userId === "carol" || userId === "bob" || userId === "dave"
        ? USERS[userId]
        : null;
    const organization =
      facts === null || facts.organization === null
        ? undefined
        : organizations.get(facts.organization);
    return facts === null || facts.role === null || organization === undefined
      ? null
      : { organization, role: facts.role, joinedAt: NOW };
  };

  const accessLayers = Layer.mergeAll(
    recording(
      OrganizationsRepo,
      "organizations",
      {
        membershipOf: (userId) => Effect.succeed(membershipOf(userId)),
      },
      calls,
    ),
    recording(
      InstanceRolesRepo,
      "instanceRoles",
      {
        isOperator: (userId) =>
          Effect.succeed(
            (userId === "alice" || userId === "carol" || userId === "bob" || userId === "dave") &&
              OPERATORS.has(userId),
          ),
      },
      calls,
    ),
    recording(
      ProjectsRepo,
      "projects",
      {
        byId: (id) => found(projects, id, () => new ProjectNotFoundError({ projectId: id })),
        listForOrganization: (organizationId) =>
          Effect.succeed(
            [...projects.values()].filter((project) => project.organizationId === organizationId),
          ),
      },
      calls,
    ),
    recording(
      SessionsRepo,
      "sessions",
      {
        byId: (id) => found(sessions, id, () => new SessionNotFoundError({ sessionId: id })),
        listForWorktree: (worktreeId) =>
          Effect.succeed([...sessions.values()].filter((row) => row.worktreeId === worktreeId)),
        listActive: () => Effect.succeed([...sessions.values()]),
        listUnsettled: () => Effect.succeed([...sessions.values()]),
        // What the session budgets count (docs/adr/0004): every session in the world is unsettled.
        countUnsettledForOrganization: (organizationId) =>
          Effect.succeed(
            [...sessions.values()].filter(
              (row) => projects.get(row.projectId)?.organizationId === organizationId,
            ).length,
          ),
        listUnsettledForOwner: (userId) =>
          Effect.succeed([...sessions.values()].filter((row) => row.ownerUserId === userId)),
        setSharedControl: (id, enabledByUserId) =>
          Effect.gen(function* () {
            const row = yield* found(
              sessions,
              id,
              () => new SessionNotFoundError({ sessionId: id }),
            );
            const updated = new Session({
              ...row,
              sharedControlEnabledByUserId: enabledByUserId,
              sharedControlEnabledAt: enabledByUserId === null ? null : NOW,
            });
            sessions.set(id, updated);
            return updated;
          }),
      },
      calls,
    ),
    recording(
      WorktreesRepo,
      "worktrees",
      {
        byId: (id) => found(worktrees, id, () => new WorktreeNotFoundError({ id })),
      },
      calls,
    ),
    recording(
      WorktreeChangesRepo,
      "changes",
      {
        byId: (id) => found(changes, id, () => new SessionChangeNotFoundError({ id })),
      },
      calls,
    ),
    recording(
      SessionProcessesRepo,
      "processes",
      {
        byId: (id) => Effect.succeed(processes.get(id) ?? null),
        // The terminal route reads a session's current agent before attaching.
        listForSession: (sessionId) =>
          Effect.succeed([...processes.values()].filter((row) => row.sessionId === sessionId)),
      },
      calls,
    ),
    recording(
      ServicesRepo,
      "services",
      {
        byId: (id) => Effect.succeed(services.get(id) ?? null),
        listAll: () => Effect.succeed([...services.values()]),
      },
      calls,
    ),
    recording(
      AgentConversationRepo,
      "conversation",
      {
        byTurnId: (id) => Effect.succeed(turns.get(id) ?? null),
        byRequestId: (id) => Effect.succeed(requests.get(id) ?? null),
      },
      calls,
    ),
    recording(
      FoldersRepo,
      "folders",
      { byId: (id) => found(folderRows, id, () => new FolderNotFoundError({ folderId: id })) },
      calls,
    ),
    recording(
      ReferencesRepo,
      "references",
      {
        byId: (id) => found(references, id, () => new ReferenceNotFoundError({ referenceId: id })),
        byIdsInOrganization: (organizationId, requested) =>
          Effect.succeed(
            [...references.values()].filter(
              (row) => row.organizationId === organizationId && requested.includes(row.id),
            ),
          ),
      },
      calls,
    ),
    recording(
      SkillsRepo,
      "skills",
      {
        byId: (id) => found(skills, id, () => new SkillNotFoundError({ skillId: id })),
      },
      calls,
    ),
  );

  return {
    root,
    calls,
    projects,
    sessions,
    worktrees,
    changes,
    processes,
    services,
    skills,
    setVisibility: (key, visibility) => {
      const row = projects.get(ids(key).project);
      if (row !== undefined) projects.set(row.id, new Project({ ...row, visibility }));
    },
    authLayer,
    accessLayers,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
};
