import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionsGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import {
  AgentConversationRepo,
  CheckpointsRepo,
  FollowUpsRepo,
  ProjectNotFoundError,
  ProjectServiceRecipesRepo,
  ProjectsRepo,
  ServiceForwardsRepo,
  ServiceObservationsRepo,
  ServicesRepo,
  SessionNotFoundError,
  SessionProcessesRepo,
  SessionsRepo,
  SettingsRepo,
  UserDotfilesRepo,
  WorktreeChangesRepo,
} from "@mend/db";
import {
  AgentRequestId,
  AgentTurnId,
  ChangeId,
  CheckpointId,
  FollowUpId,
  ProjectId,
  ReviewSliceId,
  SealantWorkspaceId,
  ServiceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  AgentRequest,
  AgentTurn,
  Checkpoint,
  DiffDigest,
  FollowUp,
  Project,
  Service,
  ServiceView,
  Session,
  SessionProcess,
} from "@mend/domain/workbench";
import { JobRunner } from "@mend/jobs";
import { SealantClient } from "@mend/sealant";
import { FollowUpDelivery, SessionEngine, WorktreeReads } from "@mend/sessions";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";

import { AuthMiddlewareLive } from "../../src/routes/api-live.ts";
import { ServiceTunnelRoutes } from "../../src/routes/service-tunnel.ts";
import { TtyRoutes } from "../../src/routes/tty.ts";
import { SessionsGroupLive } from "../../src/routes/workbench.ts";
import { SessionSteering, SessionSteeringLive } from "../../src/session-steering.ts";

export interface RouteHarnessUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly token: string;
}

export interface RouteHarnessEffects {
  readonly calls: Array<string>;
  readonly clear: () => void;
}

export interface RouteHarnessDiagnostics {
  readonly firstUserIdCalls: () => number;
}

export interface RouteHarnessFixtures {
  readonly session: Session;
  readonly nullOwnerSession: Session;
  readonly process: SessionProcess;
  readonly protocolProcess: SessionProcess;
  readonly service: Service;
  readonly udpService: Service;
  readonly turn: AgentTurn;
  readonly request: AgentRequest;
}

export interface RouteHarnessSeed {
  readonly session: (input: {
    readonly id: string;
    readonly ownerUserId: string | null;
  }) => Session;
  readonly process: (input: {
    readonly id: string;
    readonly sessionId: string;
    readonly kind?: "shell" | "agent-protocol";
  }) => SessionProcess;
  readonly service: (input: {
    readonly id: string;
    readonly sessionId: string;
    readonly transport?: "tcp" | "udp";
  }) => Service;
}

export interface RouteHarness {
  readonly users: Readonly<Record<string, RouteHarnessUser>>;
  readonly diagnostics: RouteHarnessDiagnostics;
  readonly effects: RouteHarnessEffects;
  readonly fixtures: RouteHarnessFixtures;
  readonly seed: RouteHarnessSeed;
  readonly request: (userName: string, path: string, init?: RequestInit) => Promise<Response>;
  readonly rawRequest: (userName: string, path: string) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

export interface RouteHarnessOptions {
  readonly users?: ReadonlyArray<RouteHarnessUser>;
  readonly firstUserName?: string;
}

type RouteServices =
  | AgentConversationRepo
  | Auth
  | CheckpointsRepo
  | FollowUpDelivery
  | FollowUpsRepo
  | JobRunner
  | ProjectServiceRecipesRepo
  | ProjectsRepo
  | SealantClient
  | ServiceForwardsRepo
  | ServiceObservationsRepo
  | ServicesRepo
  | SessionEngine
  | SessionProcessesRepo
  | SessionSteering
  | SessionsRepo
  | SettingsRepo
  | UserDotfilesRepo
  | WorktreeChangesRepo
  | WorktreeReads;

const NOW = new Date("2026-09-17T10:00:00.000Z");
const PROJECT_ID = ProjectId.make("project-route-harness");
const WORKTREE_ID = WorktreeId.make("worktree-route-harness");
const SESSION_ID = SessionId.make("session-alice");
const NULL_OWNER_SESSION_ID = SessionId.make("session-fallback");
const PROCESS_ID = SessionProcessId.make("process-alice");
const PROTOCOL_PROCESS_ID = SessionProcessId.make("process-protocol-alice");
const SERVICE_ID = ServiceId.make("service-alice");
const UDP_SERVICE_ID = ServiceId.make("service-udp-alice");
const TURN_ID = AgentTurnId.make("turn-alice");
const REQUEST_ID = AgentRequestId.make("request-alice");

const defaultUsers: ReadonlyArray<RouteHarnessUser> = [
  {
    id: "alice",
    email: "alice@example.invalid",
    name: "Alice",
    token: "alice-token",
  },
  { id: "bob", email: "bob@example.invalid", name: "Bob", token: "bob-token" },
];

const makeSession = (id: SessionId, ownerUserId: string | null): Session =>
  new Session({
    id,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    harness: "codex",
    providerSessionId: null,
    label: "Route harness",
    worktree: "route-harness",
    branch: "mend/route-harness",
    baseSha: Sha.make("0123456789abcdef"),
    baseRef: "main",
    contextSnapshotId: null,
    referenceMounts: [],
    extraMounts: [],
    sealantRunId: null,
    sealantWorkspaceId: SealantWorkspaceId.make("workspace-alice"),
    sealantSessionId: "platform-session-alice",
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

const makeProcess = (
  id: SessionProcessId = PROCESS_ID,
  sessionId: SessionId = SESSION_ID,
  kind: "shell" | "agent-protocol" = "shell",
): SessionProcess =>
  new SessionProcess({
    id,
    sessionId,
    sealantWorkspaceId: SealantWorkspaceId.make("workspace-alice"),
    sealantSessionId: "platform-process-alice",
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind,
    harness: kind === "agent-protocol" ? "codex" : null,
    providerSessionId: null,
    protocolOptions: null,
    label: kind === "agent-protocol" ? "codex" : "shell",
    argv: kind === "agent-protocol" ? ["codex", "app-server"] : ["sh"],
    status: "stopped",
    exitCode: 0,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: NOW,
    exitedAt: NOW,
    updatedAt: NOW,
  });

const makeService = (
  id: ServiceId = SERVICE_ID,
  sessionId: SessionId = SESSION_ID,
  transport: "tcp" | "udp" = "tcp",
): Service =>
  new Service({
    id,
    sessionId,
    name: "web",
    declarationSource: "explicit-run",
    workspacePort: 3000,
    transport,
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
  });

const makeTurn = (): AgentTurn =>
  new AgentTurn({
    id: TURN_ID,
    sessionId: SESSION_ID,
    processId: PROCESS_ID,
    ordinal: 1,
    author: "alice",
    input: "Check the change",
    status: "running",
    providerTurnId: "provider-turn",
    error: null,
    usage: null,
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  });

const makeRequest = (): AgentRequest =>
  new AgentRequest({
    id: REQUEST_ID,
    sessionId: SESSION_ID,
    processId: PROCESS_ID,
    turnId: TURN_ID,
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
  });

const makeCheckpoint = (): Checkpoint =>
  new Checkpoint({
    id: CheckpointId.make("checkpoint-route-harness"),
    worktreeId: WORKTREE_ID,
    sessionId: SESSION_ID,
    ordinal: 1,
    ref: "refs/mend/checkpoints/worktree-route-harness/1",
    sha: Sha.make("fedcba9876543210"),
    sealantRunId: null,
    seq: 0n,
    trigger: "user-mark",
    createdAt: NOW,
  });

const makeFollowUp = (): FollowUp =>
  new FollowUp({
    id: FollowUpId.make("follow-up-route-harness"),
    sessionId: SESSION_ID,
    changeId: ChangeId.make("change-route-harness"),
    reviewSliceId: ReviewSliceId.make("slice-route-harness"),
    checkpointAId: CheckpointId.make("checkpoint-a"),
    checkpointBId: CheckpointId.make("checkpoint-b"),
    diffDigest: DiffDigest.make("0".repeat(64)),
    commentIds: [],
    idempotencyKey: "delivery-key",
    instruction: "Address the review",
    status: "delivered",
    deliveryProcessId: null,
    deliverySealantRunId: null,
    deliveryError: null,
    deliveryStartedAt: NOW,
    createdAt: NOW,
    deliveredAt: NOW,
  });

const serviceView = (service: Service): ServiceView =>
  new ServiceView({
    service,
    attempts: [],
    currentForward: null,
    previousForward: null,
    latestObservation: null,
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    endpoints: [],
    previousEndpoints: [],
  });

export const createRouteHarness = async (
  options: RouteHarnessOptions = {},
): Promise<RouteHarness> => {
  const users = options.users ?? defaultUsers;
  const usersByName: Record<string, RouteHarnessUser> = {};
  const usersByToken = new Map<string, RouteHarnessUser>();
  for (const user of users) {
    usersByName[user.id] = user;
    usersByToken.set(user.token, user);
  }
  const firstUser = usersByName[options.firstUserName ?? "alice"];
  if (firstUser === undefined) throw new Error("The route harness needs a valid first user");

  const calls: Array<string> = [];
  let firstUserIdCalls = 0;
  const root = await mkdtemp(join(tmpdir(), "mend-route-harness-"));
  const project = new Project({
    id: PROJECT_ID,
    name: "route-harness",
    originUrl: "https://example.invalid/route-harness.git",
    storePath: join(root, "repo.git"),
    defaultBranch: "main",
    adoptedSha: Sha.make("0123456789abcdef"),
    autoTour: "off",
    autoSuggest: "off",
    autoName: "off",
    backgroundSessions: "off",
    gitAuthMode: "ambient",
    workspaceImage: null,
    applyDotfiles: true,
    inheritUserSkills: true,
    hotSessions: 0,
    installCommand: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const session = makeSession(SESSION_ID, "alice");
  const nullOwnerSession = makeSession(NULL_OWNER_SESSION_ID, null);
  const sessions = new Map<SessionId, Session>([
    [session.id, session],
    [nullOwnerSession.id, nullOwnerSession],
  ]);
  const process = makeProcess();
  const protocolProcess = makeProcess(PROTOCOL_PROCESS_ID, SESSION_ID, "agent-protocol");
  const service = makeService();
  const udpService = makeService(UDP_SERVICE_ID, SESSION_ID, "udp");
  const turn = makeTurn();
  const request = makeRequest();
  const checkpoint = makeCheckpoint();
  const followUp = makeFollowUp();
  const view = serviceView(service);
  const processes = new Map<SessionProcessId, SessionProcess>([
    [process.id, process],
    [protocolProcess.id, protocolProcess],
  ]);
  const services = new Map<ServiceId, Service>([
    [service.id, service],
    [udpService.id, udpService],
  ]);

  const authLayer: Layer.Layer<Auth> = Layer.succeed(Auth, {
    handler: () => Effect.succeed(new Response(null, { status: 404 })),
    getSession: (headers) => {
      const authorization = headers.get("authorization");
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
      const user = token === null ? undefined : usersByToken.get(token);
      return Effect.succeed(
        user === undefined
          ? Option.none()
          : Option.some({
              user: { id: user.id, email: user.email, name: user.name },
              expiresAt: new Date("2026-09-18T10:00:00.000Z"),
            }),
      );
    },
  });

  const sessionsLayer: Layer.Layer<SessionsRepo> = Layer.mock(SessionsRepo, {
    byId: (id) => {
      const found = sessions.get(id);
      return found === undefined
        ? Effect.fail(new SessionNotFoundError({ sessionId: id }))
        : Effect.succeed(found);
    },
    setLabel: (id, label) =>
      Effect.sync(() => {
        calls.push("repo.setLabel");
        const current = sessions.get(id);
        if (current !== undefined) sessions.set(id, new Session({ ...current, label }));
      }),
    remove: (id) =>
      Effect.sync(() => {
        calls.push("repo.remove");
        sessions.delete(id);
      }),
  });

  const dependencies = Layer.mergeAll(
    authLayer,
    sessionsLayer,
    Layer.mock(UserDotfilesRepo, {
      firstUserId: () =>
        Effect.sync(() => {
          firstUserIdCalls += 1;
          return firstUser.id;
        }),
    }),
    Layer.mock(SessionProcessesRepo, {
      byId: (id) => Effect.succeed(processes.get(id) ?? null),
      listForSession: (sessionId) =>
        Effect.succeed(
          Array.from(processes.values()).filter((candidate) => candidate.sessionId === sessionId),
        ),
      listForService: () => Effect.succeed([]),
      listLive: () => Effect.succeed([]),
    }),
    Layer.mock(ServicesRepo, {
      byId: (id) => Effect.succeed(services.get(id) ?? null),
      listForSession: () => Effect.succeed([]),
      listAll: () => Effect.succeed([]),
    }),
    Layer.mock(AgentConversationRepo, {
      byTurnId: (id) => Effect.succeed(id === turn.id ? turn : null),
      byRequestId: (id) => Effect.succeed(id === request.id ? request : null),
    }),
    Layer.mock(ProjectsRepo, {
      byId: (id) =>
        Effect.sync(() => {
          calls.push("projects.byId");
          return id === project.id ? project : null;
        }).pipe(
          Effect.flatMap((found) =>
            found === null
              ? Effect.fail(new ProjectNotFoundError({ projectId: id }))
              : Effect.succeed(found),
          ),
        ),
    }),
    Layer.mock(CheckpointsRepo, { listForWorktree: () => Effect.succeed([]) }),
    Layer.mock(WorktreeChangesRepo, { byWorktree: () => Effect.succeed(null) }),
    Layer.mock(ServiceForwardsRepo, {
      listOpen: () => Effect.succeed([]),
      byId: () => Effect.succeed(null),
    }),
    Layer.mock(ServiceObservationsRepo, { latestForService: () => Effect.succeed(null) }),
    Layer.mock(ProjectServiceRecipesRepo, { listForProject: () => Effect.succeed([]) }),
    Layer.mock(FollowUpsRepo, { activeForSession: () => Effect.succeed(null) }),
    Layer.mock(SettingsRepo, {}),
    Layer.mock(JobRunner, {}),
    Layer.mock(SealantClient, {
      getWorkspace: () =>
        Effect.sync(() => {
          calls.push("sealant.getWorkspace");
          throw new Error("Unexpected Sealant call in the route harness");
        }),
    }),
    Layer.mock(WorktreeReads, {}),
    Layer.mock(FollowUpDelivery, {
      deliver: () =>
        Effect.sync(() => {
          calls.push("followUp.deliver");
          return followUp;
        }),
    }),
    Layer.mock(SessionEngine, {
      submitTurn: () => Effect.sync(() => (calls.push("engine.submitTurn"), turn)),
      interruptTurn: () => Effect.sync(() => void calls.push("engine.interruptTurn")),
      respondRequest: () => Effect.sync(() => (calls.push("engine.respondRequest"), request)),
      openShell: () => Effect.sync(() => (calls.push("engine.openShell"), process)),
      stopShell: () => Effect.sync(() => (calls.push("engine.stopShell"), process)),
      renameShell: () => Effect.sync(() => (calls.push("engine.renameShell"), process)),
      addService: () => Effect.sync(() => (calls.push("engine.addService"), view)),
      runService: () => Effect.sync(() => (calls.push("engine.runService"), view)),
      runServiceRecipe: () => Effect.sync(() => (calls.push("engine.runServiceRecipe"), view)),
      restartService: () => Effect.sync(() => (calls.push("engine.restartService"), view)),
      stopService: () => Effect.sync(() => (calls.push("engine.stopService"), view)),
      stop: () => Effect.sync(() => void calls.push("engine.stop")),
      checkpointNow: (id) =>
        sessions.has(id)
          ? Effect.sync(() => (calls.push("engine.checkpointNow"), checkpoint))
          : Effect.fail(new SessionNotFoundError({ sessionId: id })),
      handoff: () => Effect.sync(() => (calls.push("engine.handoff"), session)),
      resumeSession: () => Effect.sync(() => (calls.push("engine.resumeSession"), session)),
      launch: () => Effect.sync(() => (calls.push("engine.launch"), session)),
      launchProtocol: () => Effect.sync(() => (calls.push("engine.launchProtocol"), session)),
    }),
  );

  const SessionsApi = HttpApi.make("mend").add(sessionsGroup).prefix("/api");
  const authMiddlewareLayer = AuthMiddlewareLive.pipe(Layer.provide(authLayer));
  const apiLayer = HttpApiBuilder.layer(SessionsApi).pipe(
    Layer.provide(SessionsGroupLive),
    Layer.provide(authMiddlewareLayer),
    Layer.provide(HttpServer.layerServices),
  );
  const routeDependencies = Layer.merge(
    dependencies,
    SessionSteeringLive.pipe(Layer.provide(dependencies)),
  );
  const runtime = ManagedRuntime.make(routeDependencies);
  const requestContext = await runtime.runPromise(Effect.context<RouteServices>());
  const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
  const rawLayer = Layer.merge(TtyRoutes, ServiceTunnelRoutes).pipe(
    Layer.provide(HttpServer.layerServices),
    Layer.provide(routeDependencies),
  );
  const { handler: rawHandler, dispose: disposeRaw } = HttpRouter.toWebHandler(rawLayer, {
    disableLogger: true,
  });

  const authenticatedRequest = (
    userName: string,
    path: string,
    init: RequestInit = {},
  ): Request => {
    const user = usersByName[userName];
    if (user === undefined) throw new Error(`Unknown route harness user: ${userName}`);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${user.token}`);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return new Request(`http://api.internal${path}`, { ...init, headers });
  };

  return {
    users: usersByName,
    diagnostics: { firstUserIdCalls: () => firstUserIdCalls },
    effects: { calls, clear: () => calls.splice(0, calls.length) },
    fixtures: {
      session,
      nullOwnerSession,
      process,
      protocolProcess,
      service,
      udpService,
      turn,
      request,
    },
    seed: {
      session: ({ id, ownerUserId }) => {
        const seeded = makeSession(SessionId.make(id), ownerUserId);
        sessions.set(seeded.id, seeded);
        return seeded;
      },
      process: ({ id, sessionId, kind = "shell" }) => {
        const seeded = makeProcess(SessionProcessId.make(id), SessionId.make(sessionId), kind);
        processes.set(seeded.id, seeded);
        return seeded;
      },
      service: ({ id, sessionId, transport = "tcp" }) => {
        const seeded = makeService(ServiceId.make(id), SessionId.make(sessionId), transport);
        services.set(seeded.id, seeded);
        return seeded;
      },
    },
    request: (userName, path, init = {}) =>
      handler(authenticatedRequest(userName, path, init), requestContext),
    rawRequest: (userName, path) => rawHandler(authenticatedRequest(userName, path)),
    dispose: async () => {
      await dispose();
      await disposeRaw();
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
};
