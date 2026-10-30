import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuditEventsRepo,
  MemberRevocationsRepo,
  BriefCommentsRepo,
  BriefsRepo,
  ChangePassesRepo,
  ChangesRepo,
  ChangeLandingsRepo,
  ChangeToursRepo,
  CheckpointsRepo,
  DevicesRepo,
  FollowUpsRepo,
  HotWorkspacesRepo,
  IssuesRepo,
  NotificationSettingsRepo,
  UserAgentLoginsRepo,
  MessageSettingsRepo,
  OrganizationSettingsRepo,
  PiProfilesRepo,
  AgentMemoryRepo,
  SecretFilesRepo,
  HarnessModelsRepo,
  ProjectClusterBindingsRepo,
  ProjectEnvironmentRepo,
  ProjectLinksRepo,
  ProjectMountsRepo,
  ProjectSecretsRepo,
  ProjectServiceRecipesRepo,
  type ProjectsRepo,
  ResourcesRepo,
  PreviewsRepo,
  PushDevice,
  PushDevicesRepo,
  type FencedRow,
  type FenceTaken,
  RemovalFenced,
  RemovalFenceId,
  RemovalFencesRepo,
  SessionAdmissionId,
  SetupRunsRepo,
  ReviewCommentsRepo,
  ReviewSlicesRepo,
  RunsRepo,
  ServiceForwardsRepo,
  ServiceObservationsRepo,
  SessionControlEventsRepo,
  SessionGitOpsRepo,
  SessionRepositoriesRepo,
  type SessionsRepo,
  SettingsRepo,
  StoreRefsRepo,
  SlackDefaultsRepo,
  SlackInstallsRepo,
  SlackLinksRepo,
  UserDotfilesRepo,
  UserEvents,
  UserGitAccessRepo,
  UserGitAuthorRepo,
  UsersRepo,
  UserFacts,
  type MendEvent,
  makeUpgradeTicketsMemory,
  UpgradeTicketsRepo,
} from "@mend/db";
import type { DotfilesRepository, SessionId } from "@mend/domain";
import {
  emptyHarnessModelCatalog,
  type Session,
  type SessionProcess,
} from "@mend/domain/workbench";
import { JobRunner } from "@mend/jobs";
import { Landing, LandingGit } from "@mend/landing";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { SealantClient, SealantClients } from "@mend/sealant";
import {
  CaptureRuntime,
  DotfilesCloner,
  FollowUpDelivery,
  ForwardAdapter,
  ResourcesLive,
  ServiceHost,
  SessionEngine,
  WorkspaceCaller,
  WorktreeReads,
} from "@mend/sessions";
import { SlackApi } from "@mend/slack/client";
import {
  AgentBridge,
  DeploymentConfig,
  DotfilesStore,
  DotfilesStoreLive,
  FolderStore,
  MendKeys,
  SecretCipher,
  Store,
  StoreConfig,
  makeSourcePolicy,
  SourcePolicy,
} from "@mend/store";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Logger,
  Tracer,
  Queue,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { ProjectAccessLive } from "../../src/access.ts";
import {
  Budgets,
  DEFAULT_BUDGET_LIMITS,
  makeBudgets,
  type BudgetLimits,
} from "../../src/budgets.ts";
import {
  ConnectionRegistry,
  makeConnectionRegistry,
  type ConnectionKind,
} from "../../src/connections.ts";
import { errorBoundary, type ErrorDetail } from "../../src/error-boundary.ts";
import { EventBus, makeEventBus } from "../../src/events-bus.ts";
import { ExposureConfig, type ExposureOutcome } from "../../src/exposure.ts";
import { GithubIdentityLive } from "../../src/github-identity.ts";
import { HandoffStartLive } from "../../src/handoff-start.ts";
import { LIVE_STATES } from "../../src/live-states.ts";
import { MemberRemovalLive } from "../../src/member-removal.ts";
import { PageViewTokens } from "../../src/page-view-tokens.ts";
import { ProjectCreationLive } from "../../src/project-creation.ts";
import { RemovalLive } from "../../src/removal.ts";
import { apiResponseHeaders } from "../../src/response-headers.ts";
import { MendApiLive } from "../../src/routes/api-live.ts";
import { EventsRoutes } from "../../src/routes/events.ts";
import { Gh } from "../../src/routes/github.ts";
import { ServiceTunnelRoutes } from "../../src/routes/service-tunnel.ts";
import { TtyRoutes } from "../../src/routes/tty.ts";
import { UrlBearers } from "../../src/routes/upgrade-tickets.ts";
import { CheckpointRequestLimit } from "../../src/routes/workbench.ts";
import { RawReadStallLimit } from "../../src/routes/worktrees.ts";
import { HostEnvironment } from "../../src/services/host-environment.ts";
import { SessionSteeringLive } from "../../src/session-steering.ts";
import { SshKeyRevoker } from "../../src/ssh-key-revocation.ts";
import { TenancyConfig } from "../../src/tenancy.ts";
import { unloggedRequests } from "../../src/unlogged-requests.ts";
import { UntracedRequestsLive } from "../../src/untraced-requests.ts";
import { createTenancyWorld, type HarnessUser, type TenancyWorld } from "./tenancy-harness.ts";
import { recording } from "./tenancy-harness.ts";

export interface TenancyApi {
  readonly world: TenancyWorld;
  /** Removal marks on worktree and project rows (`worktree:<id>`, `project:<id>`), in memory. */
  readonly removalMarks: Map<
    string,
    { readonly phase: "checking" | "deleting"; readonly id: string }
  >;
  /** Send a request as `user` (null: no credentials) and return the response. */
  readonly request: (
    user: HarnessUser | null,
    method: string,
    path: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
  ) => Promise<Response>;
  readonly postBytes: (
    user: HarnessUser | null,
    path: string,
    body: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ) => Promise<Response>;
  /** Publish one NOTIFY payload into the in-memory event bus, as Postgres would. */
  readonly notify: (event: MendEvent) => Promise<void>;
  /** Open `/api/events` as `user`; frames are read one at a time, `null` after the timeout. */
  readonly events: (user: HarnessUser | null) => Promise<{
    readonly status: number;
    readonly next: (timeoutMs?: number) => Promise<string | null>;
    readonly close: () => Promise<void>;
  }>;
  /** Send a raw (WebSocket upgrade) route request: `/api/tty` and `/api/service-tunnel`. */
  readonly rawRequest: (user: HarnessUser | null, path: string) => Promise<Response>;
  /** How often the shared listen stream behind the event bus was started and ended. */
  readonly listen: { readonly starts: number; readonly ends: number };
  /** Long-lived connections of one kind the registry holds for `user` right now. */
  readonly openConnections: (user: HarnessUser, kind: ConnectionKind) => Promise<number>;
  /** What removing a member does to their connections: close every one this process holds. */
  readonly closeConnectionsOf: (user: HarnessUser) => Promise<number>;
  readonly deviceWrites: ReadonlyArray<string>;
  /** Where the Node-served API listens on loopback, with the `node` option. */
  readonly nodeOrigin: string | undefined;
  readonly dispose: () => Promise<void>;
}

const USER_NAMES: Readonly<Record<string, string>> = {
  alice: "Alice",
  carol: "Carol",
  bob: "Bob",
  dave: "Dave",
};

/** A removal mark's key in the in-memory marks: `worktree:<id>` or `project:<id>`. */
const keyOf = (row: FencedRow) => `${row.kind}:${row.id}`;

const network = makePublicNetwork(
  Schema.decodeUnknownSync(PublicOrigin)("http://api.internal"),
  [],
);

export const clearPageViewTokens: PageViewTokens["Service"] = {
  issue: (grant) =>
    Effect.succeed({
      token: Redacted.make(`${grant.pageId}.${grant.appearance}`),
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    }),
  read: () => Effect.succeed(null),
};

/**
 * The whole Mend API over the tenancy world. Every service outside the authorization reads is a
 * recording mock with no implementation, so a handler that gets past authorization records the
 * first thing it touches and then fails; a refused request must record nothing.
 */
export const createTenancyApi = async (
  /** Budgets for this world; the defaults unless a test wants one tight enough to reach. */
  limits: Partial<BudgetLimits> = {},
  options: {
    readonly logs?: string[];
    readonly profiles?: Partial<
      Record<HarnessUser, { readonly name: string; readonly email: string }>
    >;
    readonly spans?: Tracer.Span[];
    readonly browserHeaders?: boolean;
    /** The production error boundary, in this mode; none unless stated. */
    readonly errorDetail?: ErrorDetail["Service"];
    /** Also serve the API behind the Node HTTP adapter Mend runs on, at `nodeOrigin`. */
    readonly node?: boolean;
    readonly urlBearers?: "accept" | "refuse";
    readonly pageViewTokens?: PageViewTokens["Service"];
    readonly clock?: () => number;
    /** Effect-owned request deadlines, when a test drives them with TestClock. */
    readonly effectClock?: Clock.Clock;
    /** Cancellation of this fixture's ordinary API requests, including failed timeout probes. */
    readonly requestSignal?: AbortSignal;
    /** `MEND_EXPOSURE` and its gate as this world reports them; loopback and empty unless stated. */
    readonly exposure?: {
      readonly exposure: ExposureConfig["Service"]["exposure"];
      readonly gate: ReadonlyArray<ExposureOutcome>;
      readonly t3Gateway?: ExposureConfig["Service"]["t3Gateway"];
    };
    /** Credentials that no longer stand (`session:<account>`): add one to sign that account out. */
    readonly revokedCredentials?: ReadonlySet<string>;
    /** Sessions added to the world, such as a teammate's in someone else's worktree. */
    readonly sessions?: ReadonlyArray<Session>;
    /** Processes added to the world, such as the terminal agent of one of those sessions. */
    readonly processes?: ReadonlyArray<SessionProcess>;
    /**
     * The dotfiles routes past authorization: the real store over this world's store root, each
     * account's repository kept in memory, and `cloner` for the clone a save tries first.
     */
    readonly dotfiles?: { readonly cloner: DotfilesCloner["Service"] };
    /** `MEND_TENANCY` and the source policy profile it brings; single (operator) unless stated. */
    readonly tenancy?: "single" | "multi";
    readonly sessionStore?: DeploymentConfig["Service"]["sessionStore"];
    /**
     * What a few services answer, for tests that follow a request past authorization. Each is
     * still recorded; a method left out still fails as unimplemented.
     */
    /** How long a request that takes a checkpoint may run (`CheckpointRequestLimit`). */
    readonly checkpointRequestLimit?: Duration.Duration;
    /** How long a raw body waits for its reader (`RawReadStallLimit`). */
    readonly rawReadStall?: Duration.Duration;
    /** Runs as a removal takes its mark, before anything else it reads: for races. */
    readonly beforeTake?: Effect.Effect<void>;
    readonly implement?: {
      readonly gitAccess?: Layer.PartialEffectful<UserGitAccessRepo["Service"]>;
      readonly gitAuthor?: Layer.PartialEffectful<UserGitAuthorRepo["Service"]>;
      readonly previews?: Layer.PartialEffectful<PreviewsRepo["Service"]>;
      readonly storeRefs?: Layer.PartialEffectful<StoreRefsRepo["Service"]>;
      readonly slices?: Layer.PartialEffectful<ReviewSlicesRepo["Service"]>;
      readonly workspaceCaller?: Partial<WorkspaceCaller["Service"]>;
      readonly audit?: Layer.PartialEffectful<AuditEventsRepo["Service"]>;
      readonly landings?: Layer.PartialEffectful<ChangeLandingsRepo["Service"]>;
      readonly landing?: Layer.PartialEffectful<Landing["Service"]>;
      readonly landingGit?: Layer.PartialEffectful<LandingGit["Service"]>;
      readonly gitOps?: Layer.PartialEffectful<SessionGitOpsRepo["Service"]>;
      readonly reads?: Layer.PartialEffectful<WorktreeReads["Service"]>;
      readonly checkpoints?: Layer.PartialEffectful<CheckpointsRepo["Service"]>;
      readonly engine?: Layer.PartialEffectful<SessionEngine["Service"]>;
      readonly controlEvents?: Layer.PartialEffectful<SessionControlEventsRepo["Service"]>;
      readonly jobs?: Layer.PartialEffectful<JobRunner["Service"]>;
      readonly changePasses?: Layer.PartialEffectful<ChangePassesRepo["Service"]>;
      readonly piProfiles?: Layer.PartialEffectful<PiProfilesRepo["Service"]>;
      readonly agentMemory?: Layer.PartialEffectful<AgentMemoryRepo["Service"]>;
      readonly sessionRepositories?: Layer.PartialEffectful<SessionRepositoriesRepo["Service"]>;
      readonly forwards?: Layer.PartialEffectful<ServiceForwardsRepo["Service"]>;
      readonly store?: Layer.PartialEffectful<Store["Service"]>;
      readonly secretFiles?: Layer.PartialEffectful<SecretFilesRepo["Service"]>;
      readonly cipher?: Layer.PartialEffectful<SecretCipher["Service"]>;
      readonly environment?: Layer.PartialEffectful<ProjectEnvironmentRepo["Service"]>;
      readonly secrets?: Layer.PartialEffectful<ProjectSecretsRepo["Service"]>;
      readonly resources?: Layer.PartialEffectful<ResourcesRepo["Service"]>;
      /** In place of the in-memory removal marks: Postgres's (`removal-postgres.ts`), or a part. */
      readonly removalFences?: Partial<RemovalFencesRepo["Service"]>;
      readonly setupRuns?: Layer.PartialEffectful<SetupRunsRepo["Service"]>;
      readonly users?: Layer.PartialEffectful<UsersRepo["Service"]>;
      readonly projects?: Layer.PartialEffectful<ProjectsRepo["Service"]>;
      readonly sessions?: Layer.PartialEffectful<SessionsRepo["Service"]>;
      readonly hotWorkspaces?: Layer.PartialEffectful<HotWorkspacesRepo["Service"]>;
      readonly harnessModels?: Layer.PartialEffectful<HarnessModelsRepo["Service"]>;
      /** Each account's workspace SSH keys on the platform, and the gateway it reports. */
      readonly sshKeys?: SealantClients["Service"]["sshKeys"];
      readonly workspaceSshInfo?: SealantClients["Service"]["workspaceSshInfo"];
      readonly controlPlaneFeatures?: SealantClients["Service"]["controlPlaneFeatures"];
    };
  } = {},
): Promise<TenancyApi> => {
  const world = await createTenancyWorld(
    options.sessions,
    options.processes,
    {
      ...(options.implement?.projects === undefined
        ? {}
        : { projects: options.implement.projects }),
      ...(options.implement?.sessions === undefined
        ? {}
        : { sessions: options.implement.sessions }),
    },
    options.profiles,
  );
  const ticketsLayer = Layer.mergeAll(
    Layer.succeed(
      UpgradeTicketsRepo,
      makeUpgradeTicketsMemory(options.clock, options.revokedCredentials),
    ),
    Layer.succeed(UrlBearers, { mode: options.urlBearers ?? "accept" }),
    Layer.succeed(PageViewTokens, options.pageViewTokens ?? clearPageViewTokens),
  );
  const budgetsLayer = Layer.succeed(Budgets, makeBudgets({ ...DEFAULT_BUDGET_LIMITS, ...limits }));
  const calls = world.calls;
  const deviceWrites: Array<string> = [];
  // Removal marks on the rows (RemovalFencesRepo), held in memory. A mark here never ages: it
  // refuses wherever Postgres's would, and more. What a mark's age decides is tested against
  // Postgres (`removal-postgres.ts`).
  const removalMarks = new Map<
    string,
    { readonly phase: "checking" | "deleting"; readonly id: string }
  >();
  const marked = (key: string) => removalMarks.has(key);
  const inMemoryFences: RemovalFencesRepo["Service"] = {
    take: (row) =>
      Effect.andThen(
        options.beforeTake ?? Effect.void,
        Effect.sync((): FenceTaken => {
          const exists =
            row.kind === "worktree" ? world.worktrees.has(row.id) : world.projects.has(row.id);
          if (!exists) return { _tag: "gone" };
          const projectId =
            row.kind === "project" ? row.id : world.worktrees.get(row.id)?.projectId;
          const relativeMarked =
            row.kind === "worktree"
              ? marked(`project:${projectId}`)
              : Array.from(world.worktrees.values()).some(
                  (worktree) => worktree.projectId === row.id && marked(`worktree:${worktree.id}`),
                );
          if (marked(keyOf(row)) || relativeMarked) return { _tag: "underway", stopped: null };
          const id = RemovalFenceId.make(`rmv_${crypto.randomUUID()}`);
          removalMarks.set(keyOf(row), { phase: "checking", id });
          return { _tag: "held", id };
        }),
      ),
    commit: (row, id) =>
      Effect.sync(() => {
        if (removalMarks.get(keyOf(row))?.id !== id) return false;
        removalMarks.set(keyOf(row), { phase: "deleting", id });
        return true;
      }),
    release: (row, id) =>
      Effect.sync(() => {
        if (removalMarks.get(keyOf(row))?.id === id) removalMarks.delete(keyOf(row));
      }),
    handOver: () => Effect.void,
    renew: (row, id) => Effect.sync(() => removalMarks.get(keyOf(row))?.id === id),
    admitsStart: (place) =>
      Effect.sync(
        () =>
          !marked(`project:${place.projectId}`) &&
          (place.worktreeId === null || !marked(`worktree:${place.worktreeId}`)),
      ),
    admit: (sessionId) =>
      Effect.suspend(() => {
        const session = world.sessions.get(sessionId);
        const refused =
          session !== undefined &&
          !LIVE_STATES.has(session.status) &&
          (marked(`project:${session.projectId}`) || marked(`worktree:${session.worktreeId}`));
        return refused
          ? Effect.die(new RemovalFenced(`session ${sessionId} is being removed`))
          : Effect.succeed(SessionAdmissionId.make(`adm_${sessionId}`));
      }),
    renewAdmission: () => Effect.void,
    endAdmission: () => Effect.void,
    // Its own sessions, and those the world's repositories name as holding it.
    sessionsIn: (worktreeId) =>
      Effect.gen(function* () {
        const held =
          options.implement?.sessionRepositories?.listForWorktree === undefined
            ? []
            : yield* options.implement.sessionRepositories.listForWorktree(worktreeId);
        const ids = new Set<SessionId>([
          ...Array.from(world.sessions.values())
            .filter((session) => session.worktreeId === worktreeId)
            .map((session) => session.id),
          ...held.map((row) => row.sessionId),
        ]);
        return [...ids].toSorted();
      }),
    startingIn: () => Effect.succeed([]),
  };
  const removalFences: RemovalFencesRepo["Service"] = {
    ...inMemoryFences,
    ...options.implement?.removalFences,
  };
  // Each account's saved dotfiles repository, when the world serves the dotfiles routes.
  const repositories = new Map<string, DotfilesRepository>();
  // Who turned on "Start my agents after install.sh" (docs/adr/0016).
  const startAfterInstall = new Set<string>();
  const userDotfiles: Layer.PartialEffectful<UserDotfilesRepo["Service"]> =
    options.dotfiles === undefined
      ? {}
      : {
          repository: (userId) => Effect.sync(() => repositories.get(userId) ?? null),
          setRepository: (userId, repository) =>
            Effect.sync(() => {
              if (repository === null) repositories.delete(userId);
              else repositories.set(userId, repository);
              return repository;
            }),
          startAgentsAfterInstall: (userId) => Effect.sync(() => startAfterInstall.has(userId)),
          setStartAgentsAfterInstall: (userId, value) =>
            Effect.sync(() => {
              if (value) startAfterInstall.add(userId);
              else startAfterInstall.delete(userId);
              return value;
            }),
        };
  const effects = Layer.mergeAll(
    Layer.mergeAll(
      recording(
        AuditEventsRepo,
        "audit",
        options.implement?.audit ?? { record: () => Effect.void },
        calls,
      ),
      recording(BriefCommentsRepo, "briefComments", {}, calls),
      recording(BriefsRepo, "briefs", {}, calls),
      recording(ChangePassesRepo, "changePasses", options.implement?.changePasses ?? {}, calls),
      recording(ChangesRepo, "legacyChanges", {}, calls),
      recording(ChangeLandingsRepo, "landings", options.implement?.landings ?? {}, calls),
      recording(Landing, "landing", options.implement?.landing ?? {}, calls),
      recording(LandingGit, "landingGit", options.implement?.landingGit ?? {}, calls),
      recording(SessionGitOpsRepo, "gitOps", options.implement?.gitOps ?? {}, calls),
      recording(ChangeToursRepo, "changeTours", {}, calls),
      recording(CheckpointsRepo, "checkpoints", options.implement?.checkpoints ?? {}, calls),
      recording(DevicesRepo, "devices", {}, calls),
      recording(FollowUpsRepo, "followUps", {}, calls),
      recording(HotWorkspacesRepo, "hotWorkspaces", options.implement?.hotWorkspaces ?? {}, calls),
      recording(IssuesRepo, "issues", {}, calls),
      recording(OrganizationSettingsRepo, "organizationSettings", {}, calls),
      recording(ProjectClusterBindingsRepo, "clusterBindings", {}, calls),
      recording(ProjectEnvironmentRepo, "environment", options.implement?.environment ?? {}, calls),
      recording(ProjectLinksRepo, "links", {}, calls),
      // A session's repositories (docs/adr/0010): none in these worlds, so the detail lists none.
      recording(
        SessionRepositoriesRepo,
        "sessionRepositories",
        {
          listForSession: () => Effect.succeed([]),
          listForWorktree: () => Effect.succeed([]),
          listForProject: () => Effect.succeed([]),
          ...options.implement?.sessionRepositories,
        },
        calls,
      ),
      recording(ProjectMountsRepo, "mounts", {}, calls),
      recording(ProjectSecretsRepo, "secrets", options.implement?.secrets ?? {}, calls),
      recording(ProjectServiceRecipesRepo, "recipes", {}, calls),
      recording(ResourcesRepo, "resources", options.implement?.resources ?? {}, calls),
      recording(
        PushDevicesRepo,
        "pushDevices",
        {
          register: ({ userId, deviceTokenId, token, platform }) =>
            Effect.sync(() => {
              deviceWrites.push(`register:${userId}:${deviceTokenId}:${token}`);
              return new PushDevice({ token, platform, userId });
            }),
          forget: (deviceTokenId) =>
            Effect.sync(() => {
              deviceWrites.push(`forget:${deviceTokenId}`);
            }),
        },
        calls,
      ),
      recording(ReviewCommentsRepo, "comments", {}, calls),
      recording(UserDotfilesRepo, "userDotfiles", userDotfiles, calls),
      recording(NotificationSettingsRepo, "notificationSettings", {}, calls),
      recording(MessageSettingsRepo, "messageSettings", {}, calls),
      recording(UserAgentLoginsRepo, "agentLogins", {}, calls),
    ),
    Layer.mergeAll(
      recording(ReviewSlicesRepo, "slices", options.implement?.slices ?? {}, calls),
      recording(
        SessionControlEventsRepo,
        "controlEvents",
        { record: () => Effect.void, ...options.implement?.controlEvents },
        calls,
      ),
      recording(RunsRepo, "runs", {}, calls),
      recording(ServiceForwardsRepo, "forwards", options.implement?.forwards ?? {}, calls),
      recording(PreviewsRepo, "previews", options.implement?.previews ?? {}, calls),
      recording(ServiceObservationsRepo, "observations", {}, calls),
      recording(SettingsRepo, "settings", {}, calls),
      recording(UserEvents, "userEvents", {}, calls),
      recording(UserGitAccessRepo, "gitAccess", options.implement?.gitAccess ?? {}, calls),
      recording(UserGitAuthorRepo, "gitAuthor", options.implement?.gitAuthor ?? {}, calls),
      recording(
        UsersRepo,
        "users",
        {
          byId: (id) =>
            Effect.succeed(
              id in USER_NAMES
                ? new UserFacts({
                    id,
                    name: USER_NAMES[id] ?? id,
                    email: `${id}@example.com`,
                  })
                : null,
            ),
          ...options.implement?.users,
        },
        calls,
      ),
      recording(RemovalFencesRepo, "removalFences", removalFences, calls),
      recording(
        SetupRunsRepo,
        "setupRuns",
        {
          unendedInWorktree: () => Effect.succeed(false),
          ...options.implement?.setupRuns,
        },
        calls,
      ),
      recording(JobRunner, "jobs", options.implement?.jobs ?? {}, calls),
      recording(SealantClient, "sealant", {}, calls),
      recording(ForwardAdapter, "forwards", {}, calls),
      recording(ServiceHost, "serviceHost", { hold: () => Effect.void }, calls),
      recording(
        SealantClients,
        "sealantClients",
        {
          connectedAccounts: () => {
            throw new Error("the harness does not implement sealantClients.connectedAccounts");
          },
          sshKeys:
            options.implement?.sshKeys ??
            (() => {
              throw new Error("the harness does not implement sealantClients.sshKeys");
            }),
          ...(options.implement?.workspaceSshInfo === undefined
            ? {}
            : { workspaceSshInfo: options.implement.workspaceSshInfo }),
          ...(options.implement?.controlPlaneFeatures === undefined
            ? {}
            : { controlPlaneFeatures: options.implement.controlPlaneFeatures }),
        },
        calls,
      ),
      Layer.succeed(CaptureRuntime, { enabled: false }),
      recording(FollowUpDelivery, "followUpDelivery", {}, calls),
      recording(
        SessionEngine,
        "engine",
        {
          launchUnderWay: () => false,
          // Turning shared control off cancels the turns others queued (docs/adr/0016).
          cancelSteeredTurns: () => Effect.succeed(0),
          // No migration of a pre-release shared home and no retiring executor (docs/adr/0016).
          preReleaseMemory: () => Effect.succeed(null),
          workspaceRetirement: () => Effect.succeed(null),
          steersPerPerson: () => Effect.succeed(false),
          personLayoutPossible: () => Effect.succeed(false),
          ...options.implement?.engine,
        },
        calls,
      ),
      recording(WorktreeReads, "reads", options.implement?.reads ?? {}, calls),
      // Whose identity a call about a workspace runs as: the principal in context here, since the
      // harness's platform has one user.
      recording(
        WorkspaceCaller,
        "workspaceCaller",
        {
          observe: () => (self) => self,
          mayAct: () => Effect.void,
          creatorOf: () => Effect.succeed(null),
          recorded: () => Effect.void,
          act: () => (self) => self,
          observeRun: () => (self) => self,
          observeRunStream: () => (self) => self,
          ...options.implement?.workspaceCaller,
        },
        calls,
      ),
      recording(AgentBridge, "agentBridge", { socketPath: () => "/unused/agent.sock" }, calls),
      options.dotfiles === undefined
        ? recording(DotfilesStore, "dotfilesStore", {}, calls)
        : DotfilesStoreLive.pipe(Layer.provide(Layer.succeed(StoreConfig, { root: world.root }))),
      recording(DotfilesCloner, "dotfilesCloner", options.dotfiles?.cloner ?? {}, calls),
      recording(FolderStore, "folderStore", {}, calls),
      recording(MendKeys, "keys", {}, calls),
      recording(SecretCipher, "cipher", options.implement?.cipher ?? {}, calls),
    ),
    Layer.mergeAll(
      recording(Store, "store", options.implement?.store ?? {}, calls),
      recording(StoreRefsRepo, "storeRefs", options.implement?.storeRefs ?? {}, calls),
      recording(Gh, "gh", {}, calls),
      recording(SlackApi, "slackApi", {}, calls),
      recording(SlackDefaultsRepo, "slackDefaults", {}, calls),
      recording(SlackInstallsRepo, "slackInstalls", {}, calls),
      recording(
        SlackLinksRepo,
        "slackLinks",
        // Removing a member reads their links first; nobody in this world has one.
        { listForUser: () => Effect.succeed([]) },
        calls,
      ),
      recording(HostEnvironment, "hostEnvironment", {}, calls),
      recording(PiProfilesRepo, "piProfiles", options.implement?.piProfiles ?? {}, calls),
      recording(AgentMemoryRepo, "agentMemory", options.implement?.agentMemory ?? {}, calls),
      recording(SecretFilesRepo, "secretFiles", options.implement?.secretFiles ?? {}, calls),
      recording(SshKeyRevoker, "sshKeyRevoker", {}, calls),
      recording(MemberRevocationsRepo, "memberRevocations", {}, calls),
      recording(
        HarnessModelsRepo,
        "harnessModels",
        // A launch resolves its model against the catalog; worlds that say nothing have none.
        {
          forHarness: (harness) => Effect.succeed(emptyHarnessModelCatalog(harness)),
          ...options.implement?.harnessModels,
        },
        calls,
      ),
      Layer.succeed(NetworkConfig, network),
      Layer.succeed(DeploymentConfig, {
        mode: "local",
        sessionEndpoint: undefined,
        sessionStore: options.sessionStore ?? "captured",
      }),
      Layer.succeed(StoreConfig, { root: world.root }),
      Layer.succeed(TenancyConfig, {
        mode: options.tenancy ?? "single",
        gate: Effect.succeed([]),
      }),
      Layer.succeed(ExposureConfig, {
        exposure: options.exposure?.exposure ?? "loopback",
        gate: Effect.succeed(options.exposure?.gate ?? []),
        gateWith: () => options.exposure?.gate ?? [],
        t3Gateway: options.exposure?.t3Gateway,
      }),
      // Every remote in the harness is public; the policy's own tests cover the refusals.
      Layer.succeed(
        SourcePolicy,
        makeSourcePolicy({
          profile: options.tenancy === "multi" ? "tenant" : "operator",
          allowedHosts: [],
          resolve: async () => ["140.82.112.3"],
        }),
      ),
    ),
  );
  const dependencies = Layer.mergeAll(
    world.authLayer,
    world.accessLayers,
    effects,
    options.checkpointRequestLimit === undefined
      ? Layer.empty
      : Layer.succeed(CheckpointRequestLimit, options.checkpointRequestLimit),
    options.rawReadStall === undefined
      ? Layer.empty
      : Layer.succeed(RawReadStallLimit, options.rawReadStall),
  );
  // One registry for the whole world. The API, the socket routes and the event route are separate
  // web handlers here, each building its own layers; they must still see each other's connections,
  // as they do in the one production process.
  const registry = Effect.runSync(makeConnectionRegistry);
  const connections = Layer.succeed(ConnectionRegistry, {
    register: registry.register,
    closeForUser: registry.closeForUser,
    closeForSession: registry.closeForSession,
    countFor: registry.countFor,
  });
  const authorization = Layer.mergeAll(
    ProjectAccessLive,
    SessionSteeringLive,
    GithubIdentityLive,
    MemberRemovalLive,
    HandoffStartLive,
    ResourcesLive,
    ProjectCreationLive,
    RemovalLive,
  ).pipe(
    Layer.provideMerge(ProjectAccessLive),
    Layer.provideMerge(connections),
    Layer.provideMerge(budgetsLayer),
    Layer.provideMerge(ticketsLayer),
    Layer.provideMerge(dependencies),
  );
  const apiLayer = Layer.mergeAll(
    MendApiLive,
    unloggedRequests,
    options.browserHeaders ? apiResponseHeaders : Layer.empty,
    options.errorDetail === undefined ? Layer.empty : errorBoundary(options.errorDetail),
  ).pipe(
    Layer.provideMerge(UntracedRequestsLive),
    Layer.provide(authorization),
    Layer.provide(HttpServer.layerServices),
  );
  const runtime = ManagedRuntime.make(authorization);
  const services = await runtime.runPromise(Effect.context<Layer.Success<typeof authorization>>());
  const context =
    options.effectClock === undefined
      ? services
      : Context.add(services, Clock.Clock, options.effectClock);
  const { handler, dispose } = HttpRouter.toWebHandler(
    apiLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(
          Tracer.Tracer,
          Tracer.make({
            span(spanOptions) {
              const span = Tracer.nativeTracer.span(spanOptions);
              options.spans?.push(span);
              return span;
            },
          }),
        ),
      ),
      Layer.provideMerge(
        options.logs === undefined
          ? Layer.empty
          : Logger.layer([
              Logger.make((entry) => options.logs?.push(String(Logger.formatJson.log(entry)))),
            ]),
      ),
    ),
    { disableLogger: options.logs === undefined },
  );
  const nodeScope = Effect.runSync(Scope.make());
  const nodeOrigin = options.node
    ? await Effect.runPromise(
        Layer.buildWithScope(
          HttpRouter.serve(apiLayer, {
            disableLogger: true,
            disableListenLog: true,
          }).pipe(
            Layer.provide(Layer.succeedContext(context)),
            Layer.provideMerge(
              NodeHttpServer.layer(createServer, {
                host: "127.0.0.1",
                port: 0,
              }),
            ),
          ),
          nodeScope,
        ).pipe(
          Effect.map((built) =>
            HttpServer.formatAddress(Context.get(built, HttpServer.HttpServer).address),
          ),
        ),
      )
    : undefined;
  const rawLayer = Layer.merge(TtyRoutes, ServiceTunnelRoutes).pipe(
    Layer.provide(HttpServer.layerServices),
    Layer.provide(authorization),
  );
  const raw = HttpRouter.toWebHandler(rawLayer, { disableLogger: true });
  const source = Effect.runSync(Queue.unbounded<string>());
  // The stand-in for the one LISTEN: how often it was started and ended is what a lifecycle test
  // reads, since a stream tearing down must never end it for the others.
  const listen = { starts: 0, ends: 0 };
  // Subscriptions taken from the bus so far: how `events()` knows a stream is really listening,
  // observed instead of slept for.
  const subscriptions = { taken: 0 };
  const busLayer = Layer.effect(
    EventBus,
    Effect.map(
      makeEventBus(
        Stream.fromQueue(source).pipe(
          Stream.onStart(
            Effect.sync(() => {
              listen.starts += 1;
            }),
          ),
          Stream.ensuring(
            Effect.sync(() => {
              listen.ends += 1;
            }),
          ),
        ),
      ),
      (bus) => ({
        subscribe: Effect.tap(bus.subscribe, () =>
          Effect.sync(() => {
            subscriptions.taken += 1;
          }),
        ),
      }),
    ),
  );
  const eventsLayer = EventsRoutes.pipe(
    Layer.provide(HttpServer.layerServices),
    Layer.provide(busLayer),
    Layer.provide(authorization),
  );
  // A streamed body runs on the handler's own services, not the request's context: the stream
  // reads an Effect clock only when the handler is built with it.
  const eventRoutes = HttpRouter.toWebHandler(
    options.effectClock === undefined
      ? eventsLayer
      : Layer.merge(eventsLayer, Layer.succeed(Clock.Clock, options.effectClock)),
    { disableLogger: true },
  );

  return {
    world,
    removalMarks,
    request: (user, method, path, body, extraHeaders) => {
      const headers = new Headers(extraHeaders);
      if (user !== null) headers.set("authorization", `Bearer ${user}`);
      if (body !== undefined) headers.set("content-type", "application/json");
      return handler(
        new Request(`http://api.internal${path}`, {
          method,
          headers,
          ...(options.requestSignal === undefined ? {} : { signal: options.requestSignal }),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        context,
      );
    },
    postBytes: (user, path, body, contentType, signal) => {
      const headers = new Headers({ "content-type": contentType });
      if (user !== null) headers.set("authorization", `Bearer ${user}`);
      return handler(
        new Request(`http://api.internal${path}`, {
          method: "POST",
          headers,
          body: new Uint8Array(body),
          ...(signal === undefined ? {} : { signal }),
        }),
        context,
      );
    },
    notify: (event) =>
      Effect.runPromise(
        Queue.offer(source, JSON.stringify(event)).pipe(Effect.andThen(Effect.sleep("20 millis"))),
      ),
    events: async (user) => {
      const before = subscriptions.taken;
      const controller = new AbortController();
      const response = await eventRoutes.handler(
        new Request("http://api.internal/api/events", {
          headers: user === null ? {} : { authorization: `Bearer ${user}` },
          signal: controller.signal,
        }),
        context,
      );
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      // One read at a time: a read that loses the timeout race stays in flight and is awaited
      // by the next call instead of being replaced (which would drop its chunk).
      let inFlight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
      const next = async (timeoutMs = 200): Promise<string | null> => {
        while (!pending.includes("\n\n")) {
          if (reader === undefined) return null;
          inFlight ??= reader.read();
          const chunk = await Promise.race([
            inFlight,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
          ]);
          if (chunk === null) return null;
          inFlight = null;
          if (chunk.done) return null;
          pending += decoder.decode(chunk.value);
        }
        const end = pending.indexOf("\n\n");
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        return frame;
      };
      // The subscription starts when the body is first pulled. Pull, then wait until the bus has
      // handed this stream its subscription, so nothing published after `events()` returns can
      // be missed. A refused stream never subscribes and is not waited for.
      await next(1);
      if (response.status === 200) {
        const listening = () => subscriptions.taken > before;
        const deadline = Date.now() + 5_000;
        while (!listening() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        if (!listening()) throw new Error("the event stream never subscribed");
      }
      return {
        status: response.status,
        next,
        close: async () => {
          controller.abort();
          await reader?.cancel().catch(() => undefined);
        },
      };
    },
    deviceWrites,
    listen,
    openConnections: (user, kind) => Effect.runPromise(registry.countFor(user, kind)),
    closeConnectionsOf: (user) => Effect.runPromise(registry.closeForUser(user)),
    rawRequest: (user, path) =>
      raw.handler(
        new Request(`http://api.internal${path}`, {
          headers: user === null ? {} : { authorization: `Bearer ${user}` },
        }),
        context,
      ),
    nodeOrigin,
    dispose: async () => {
      await Effect.runPromise(Scope.close(nodeScope, Exit.void));
      await dispose();
      await raw.dispose();
      await eventRoutes.dispose();
      await runtime.dispose();
      await world.dispose();
    },
  };
};
