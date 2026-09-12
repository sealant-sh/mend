import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import type { PgClient } from "@effect/sql-pg";
import { Auth, AuthLive } from "@mend/auth";
import {
  AgentConversationRepoLive,
  BriefCommentsRepoLive,
  BriefsRepoLive,
  type CaptureStoreRepo,
  CaptureStoreRepoLive,
  type StoreRefsRepo,
  StoreRefsRepoLive,
  type MendDB,
  ChangePassesRepo,
  ChangePassesRepoLive,
  ProjectsRepo,
  SessionsRepo,
  WorktreeChangesRepo,
  SealantIdentityStoreLive,
  SettingsRepo,
  ChangesRepoLive,
  ChangeToursRepoLive,
  CheckpointsRepoLive,
  FollowUpsRepoLive,
  HotWorkspacesRepoLive,
  InferenceCallsRepoLive,
  IssuesRepoLive,
  MendDBLive,
  MigratorLive,
  PgLive,
  ProjectClusterBindingsRepoLive,
  ProjectEnvironmentRepoLive,
  ProjectMountsRepoLive,
  ProjectLinksRepoLive,
  ProjectSecretsRepoLive,
  ProjectServiceRecipesRepoLive,
  ProjectsRepoLive,
  PushDevicesRepoLive,
  ReferencesRepoLive,
  ReviewCommentsRepoLive,
  ReviewSlicesRepoLive,
  RunsRepoLive,
  ServiceForwardsRepoLive,
  ServiceObservationsRepoLive,
  ServicesRepoLive,
  SkillsRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
  SessionGitOpsRepoLive,
  SessionProcessesRepoLive,
  SessionRunsRepoLive,
  SessionChannelTokensRepoLive,
  SessionsRepoLive,
  SettingsRepoLive,
  UserDotfilesRepoLive,
  UserGitAccessRepoLive,
  UserEventsLive,
  UsersRepoLive,
} from "@mend/db";
import type { ChangeId, SessionId } from "@mend/domain";
import { resolveAutomation } from "@mend/domain/workbench";
import {
  BriefCompiler,
  ChangeReader,
  ChangeSuggester,
  ChangeSuggesterLive,
  ComposeTourJob,
  type InferenceError,
  CommentRouter,
  CompileBriefJob,
  FailureSummarizer,
  liveToolsLayer,
  NameSessionJob,
  ReadChangeJob,
  RouteCommentJob,
  sealantProviderLayer,
  SessionNamer,
  SessionNamerLive,
  SuggestChangeJob,
  SummarizeFailureJob,
  TourComposer,
} from "@mend/inference";
import {
  CaptureRetentionLive,
  CaptureRetentionScheduleLive,
  Dispatcher,
  JobRunner,
  ReviewPrepLive,
  runStarterLayer,
  SessionNotifierLive,
  startRunToolLayer,
  SummaryObserverLive,
  SummaryObserveWorkerLive,
} from "@mend/jobs";
import { NetworkConfig, NetworkConfigLive } from "@mend/network";
import { asSealantUser, SealantLiveFromEnv } from "@mend/sealant";
import {
  CaptureChannelLive,
  CaptureRuntimeLive,
  CaptureRuntimeOff,
  FollowUpDeliveryLive,
  FollowUpLauncherLive,
  ProtocolHostLive,
  ServiceHostLive,
  SessionEngine,
  SessionEngineLive as SessionEngineBaseLive,
  SessionChannelNetworkHostLive,
  SessionChannelRegistryLive,
  SessionSocketHostLive,
  SessionRepositoryCapturedLive,
  SessionRepositoryLocalLive,
  WorktreeReadsCapturedLive,
  WorktreeReadsColocatedLive,
} from "@mend/sessions";
import {
  type AgentBridge,
  AgentBridgeLive,
  type BlobStore,
  BlobStoreConfigLive,
  BlobStoreLive,
  DeploymentConfig,
  type DotfilesStore,
  DotfilesStoreLive,
  type MendKeys,
  MendKeysConfigLive,
  MendKeysLive,
  type SecretCipher,
  SecretCipherLive,
  type GitOpsRunner,
  GitOpsRunnerLive,
  Store,
  StoreConfig,
  DeploymentConfigLive,
} from "@mend/store";
import { Config, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { publicNetworkPolicy } from "./public-network-policy.ts";
import { MendApiLive } from "./routes/api-live.ts";
import { EventsRoutes } from "./routes/events.ts";
import { GhLive } from "./routes/github.ts";
import { WebSocketRoutes } from "./routes/websocket.ts";
import { HostEnvironmentLive } from "./services/host-environment.ts";

/**
 * The composition boundary (ARCHITECTURE.md §2): every service is wired here
 * and nowhere else. This process is the Mend API server — the typed contract,
 * auth, the WebSocket data planes, the session engine, and the workers. The
 * web app is a separate, stateless process (`apps/web`) that proxies `/api/*`
 * here. MEND_MODE (`all` default · `api` · `worker`) picks which halves run.
 */

// ─── Data: Postgres, migrated before anything reads it ─────────────────────
const DrizzleRepositoriesLive = Layer.mergeAll(
  AgentConversationRepoLive,
  UserDotfilesRepoLive,
  UserGitAccessRepoLive,
  UsersRepoLive,
  UserEventsLive,
  HotWorkspacesRepoLive,
  SessionGitOpsRepoLive,
  SessionProcessesRepoLive,
  ServicesRepoLive,
  ServiceForwardsRepoLive,
  ServiceObservationsRepoLive,
  SessionRunsRepoLive,
  CheckpointsRepoLive,
  ProjectsRepoLive,
  ProjectClusterBindingsRepoLive,
  ProjectEnvironmentRepoLive,
  ProjectMountsRepoLive,
  ProjectLinksRepoLive,
  ProjectSecretsRepoLive,
  ProjectServiceRecipesRepoLive,
  SettingsRepoLive,
  SkillsRepoLive,
  InferenceCallsRepoLive,
  FollowUpsRepoLive,
  ReviewCommentsRepoLive,
  ReviewSlicesRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
  PushDevicesRepoLive,
  ChangeToursRepoLive,
  ChangePassesRepoLive,
  ReferencesRepoLive,
  IssuesRepoLive,
  ChangesRepoLive,
  RunsRepoLive,
  BriefsRepoLive,
  BriefCommentsRepoLive,
  SessionsRepoLive,
  SessionChannelTokensRepoLive,
).pipe(Layer.provideMerge(MendDBLive));

const DatabaseLive = DrizzleRepositoriesLive.pipe(
  Layer.provideMerge(MigratorLive.pipe(Layer.provideMerge(PgLive))),
);

// ─── The central store (host-side git) + the session engine over it ────────
// One instance each: the API handlers and the worker share them (memoized —
// same layer reference, provided once at MainLive).
const StoreLive = Store.layer.pipe(Layer.provide(StoreConfig.layer));
// The per-user dotfiles store shares the same root (bare git repos under _dotfiles/).
const DotfilesStoreLayer: Layer.Layer<DotfilesStore> = DotfilesStoreLive.pipe(
  Layer.provide(StoreConfig.layer),
);
const KeysLive: Layer.Layer<MendKeys> = MendKeysLive.pipe(Layer.provide(MendKeysConfigLive));
// Project secrets are sealed at rest with a key beside the deploy key (secrets.key, 0600).
const SecretCipherLayer: Layer.Layer<SecretCipher> = SecretCipherLive.pipe(
  Layer.provide(MendKeysConfigLive),
);
// One bridge instance: the WS route attaches signers, the API and engine ask it.
const BridgeLive: Layer.Layer<AgentBridge> = AgentBridgeLive.pipe(
  Layer.provide(MendKeysConfigLive),
);
const ServiceHostLayer = ServiceHostLive;
const ProtocolHostLayer = ProtocolHostLive;
// The session channel (docs/KUBERNETES.md): one registry shared by the per-session socket host
// and the optional network listener; the deployment mode decides whether sockets are created.
const SessionChannelRegistryLayer = SessionChannelRegistryLive;
const SessionSocketHostLayer = SessionSocketHostLive.pipe(
  Layer.provide(StoreConfig.layer),
  Layer.provide(DeploymentConfigLive),
  Layer.provide(SessionChannelRegistryLayer),
);
const SessionChannelNetworkLayer = SessionChannelNetworkHostLive.pipe(
  Layer.provide(DeploymentConfigLive),
  Layer.provide(SessionChannelRegistryLayer),
);
// The session-workspace authority (identity-keyed port over Store + ProjectsRepo) and the
// identity-keyed worktree reads are selected at the boundary by MEND_SESSION_STORE (below);
// the engine takes them as requirements and never knows which adapter answers.
const SessionEngineLayer = SessionEngineBaseLive.pipe(
  Layer.provide(ProtocolHostLayer),
  Layer.provide(ServiceHostLayer),
  Layer.provide(SessionSocketHostLayer),
  Layer.provide(DotfilesStoreLayer),
  Layer.provide(DeploymentConfigLive),
);
// The capture store (docs/adr/0002-session-capture-store.md): the bucket and the git runner
// over it, plus the pointer repositories. Built only under MEND_SESSION_STORE=captured — the
// co-located default is untouched.
const CaptureStoreLayer: Layer.Layer<
  BlobStore | GitOpsRunner | CaptureStoreRepo | StoreRefsRepo,
  never,
  Store | StoreConfig | MendDB | PgClient.PgClient
> = Layer.mergeAll(
  GitOpsRunnerLive.pipe(Layer.provideMerge(BlobStoreLive.pipe(Layer.provide(BlobStoreConfigLive)))),
  CaptureStoreRepoLive,
  StoreRefsRepoLive,
);
const FollowUpLauncherLayer = FollowUpLauncherLive.pipe(Layer.provide(SessionEngineLayer));
const FollowUpDeliveryLayer = FollowUpDeliveryLive.pipe(Layer.provide(FollowUpLauncherLayer));

// ─── better-auth mounted under /api/auth ────────────────────────────────────
const AuthRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    yield* router.add("*", "/api/auth/*", (request) =>
      Effect.gen(function* () {
        const webRequest = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
        const response = yield* auth.handler(webRequest);
        return HttpServerResponse.fromWeb(response);
      }),
    );
  }),
);

// ─── HTTP: the API contract + auth + data planes on one port ───────────────
const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.int("PORT").pipe(Config.orElse(() => Config.succeed(3101)));
    const network = yield* NetworkConfig;
    return HttpRouter.serve(
      Layer.mergeAll(
        MendApiLive,
        AuthRoutes,
        EventsRoutes,
        WebSocketRoutes,
        publicNetworkPolicy(network),
      ),
    ).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })));
  }),
);

// ─── Worker: the dispatcher loop and the side-effect jobs it feeds ──────────
const decodeCompileBriefJob = Schema.decodeUnknownEffect(CompileBriefJob);
const decodeSummarizeFailureJob = Schema.decodeUnknownEffect(SummarizeFailureJob);
const decodeRouteCommentJob = Schema.decodeUnknownEffect(RouteCommentJob);
const decodeReadChangeJob = Schema.decodeUnknownEffect(ReadChangeJob);
const decodeComposeTourJob = Schema.decodeUnknownEffect(ComposeTourJob);
const decodeSuggestChangeJob = Schema.decodeUnknownEffect(SuggestChangeJob);
const decodeNameSessionJob = Schema.decodeUnknownEffect(NameSessionJob);

/** Harnesses whose native transcript the engine can parse for the first prompt. */
const NAMEABLE_HARNESSES = new Set(["claude", "codex"]);

/** The inference job workers: a failed handler dies into the engine's retry. */
const InferenceWorkersLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobs = yield* JobRunner;
    const compiler = yield* BriefCompiler;
    const summarizer = yield* FailureSummarizer;
    const router = yield* CommentRouter;
    const reader = yield* ChangeReader;
    const tourComposer = yield* TourComposer;
    const suggester = yield* ChangeSuggester;
    const passes = yield* ChangePassesRepo;
    const sessionChanges = yield* WorktreeChangesRepo;
    const sessionsForJobs = yield* SessionsRepo;
    // Inference runs on the SESSION OWNER's connected subscription (plan §9.3, docs/SEALANT-
    // IDENTITY.md): a pass over someone's change is paid for by their account, never the
    // operator's.
    const asSessionOwner =
      (sessionId: SessionId) =>
      <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        sessionsForJobs.byId(sessionId).pipe(
          Effect.option,
          Effect.flatMap((session) =>
            self.pipe(asSealantUser(Option.isSome(session) ? session.value.ownerUserId : null)),
          ),
        );
    const asChangeOwner =
      (changeId: ChangeId) =>
      <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        sessionChanges.byId(changeId).pipe(
          Effect.option,
          Effect.flatMap((change) =>
            Option.isSome(change) && change.value.sessionId !== null
              ? asSessionOwner(change.value.sessionId)(self)
              : self,
          ),
        );
    // Every change pass records its outcome — running, completed with a
    // count, or failed with the error's own words — so the review page can
    // state what ran instead of leaving "drafted nothing" and "never ran"
    // looking identical. Failures still propagate into pg-boss retry.
    const recorded = (
      kind: "tour" | "read" | "suggest",
      changeId: ChangeId,
      pass: Effect.Effect<number | void, InferenceError>,
    ) =>
      passes.begin(changeId, kind).pipe(
        Effect.andThen(pass),
        Effect.tap((findings) =>
          passes.complete(changeId, kind, typeof findings === "number" ? findings : null),
        ),
        Effect.tapError((error) => passes.fail(changeId, kind, error.message)),
      );
    yield* jobs.work("read-change", (payload) =>
      decodeReadChangeJob(payload).pipe(
        Effect.flatMap((job) =>
          asChangeOwner(job.changeId)(recorded("read", job.changeId, reader.read(job))),
        ),
        Effect.orDie,
      ),
    );
    yield* jobs.work("compose-tour", (payload) =>
      decodeComposeTourJob(payload).pipe(
        Effect.flatMap((job) =>
          asChangeOwner(job.changeId)(recorded("tour", job.changeId, tourComposer.compose(job))),
        ),
        Effect.orDie,
      ),
    );
    yield* jobs.work("suggest-change", (payload) =>
      decodeSuggestChangeJob(payload).pipe(
        Effect.flatMap((job) =>
          asChangeOwner(job.changeId)(recorded("suggest", job.changeId, suggester.suggest(job))),
        ),
        Effect.orDie,
      ),
    );
    yield* jobs.work("brief", (payload) =>
      decodeCompileBriefJob(payload).pipe(
        Effect.flatMap((job) => compiler.compile(job)),
        Effect.orDie,
      ),
    );
    yield* jobs.work("failure-brief", (payload) =>
      decodeSummarizeFailureJob(payload).pipe(
        Effect.flatMap((job) => summarizer.summarize(job)),
        Effect.orDie,
      ),
    );
    yield* jobs.work("route-comment", (payload) =>
      decodeRouteCommentJob(payload).pipe(
        Effect.flatMap((job) => router.route(job)),
        Effect.orDie,
      ),
    );
    // Session auto-naming, two payload shapes: launch-time (no prompt — poll
    // the harness's native transcript, retried with backoff until the first
    // prompt exists) and send-time (prompt inline from a Mend-owned composer —
    // name immediately, any harness). Every no-name outcome besides "no
    // prompt yet" is a quiet success — a renamed or deleted session, a
    // switched-off cascade, an unparseable harness on the transcript path.
    const namer = yield* SessionNamer;
    const sessions = yield* SessionsRepo;
    const projects = yield* ProjectsRepo;
    const settingsRepo = yield* SettingsRepo;
    const engine = yield* SessionEngine;
    const firstPromptFromTranscript = Effect.fn("firstPromptFromTranscript")(function* (
      job: NameSessionJob,
    ) {
      const transcript = yield* engine
        .transcript(job.sessionId)
        .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      const events = transcript?.events ?? [];
      const firstUserAt = events.findIndex((event) => event.kind === "user");
      const firstUser = firstUserAt === -1 ? undefined : events[firstUserAt];
      if (firstUser === undefined || firstUser.kind !== "user") {
        // Retryable by design: the user has not typed the first prompt yet.
        return yield* Effect.die(new Error("no first prompt in the transcript yet — retrying"));
      }
      const reply = events
        .slice(firstUserAt + 1)
        .find((event): event is typeof event & { kind: "assistant" } => event.kind === "assistant");
      return {
        firstUserTurn: firstUser.text,
        ...(reply === undefined ? {} : { assistantReply: reply.text }),
      };
    });
    const nameSession = Effect.fn("nameSession")(function* (job: NameSessionJob) {
      const session = yield* sessions
        .byId(job.sessionId)
        .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      if (session === null || session.label !== null) return;
      const inlinePrompt = job.firstUserTurn?.trim();
      const hasInlinePrompt = inlinePrompt !== undefined && inlinePrompt.length > 0;
      // The harness gate guards only transcript parsing — an inline prompt
      // names any harness, opencode and shell included.
      if (!hasInlinePrompt && !NAMEABLE_HARNESSES.has(session.harness)) return;
      const project = yield* projects
        .byId(session.projectId)
        .pipe(Effect.catchTag("ProjectNotFoundError", () => Effect.succeed(null)));
      if (project === null) return;
      const settings = yield* settingsRepo.get();
      if (!resolveAutomation(project.autoName, settings.autoName)) return;

      const turns = hasInlinePrompt
        ? { firstUserTurn: inlinePrompt }
        : yield* firstPromptFromTranscript(job);

      const label = yield* namer.name({
        harness: session.harness,
        projectName: project.name,
        ...turns,
      });
      const wrote = yield* sessions.setLabelIfUnset(job.sessionId, label);
      yield* Effect.annotateLogs(Effect.logInfo("session named"), {
        sessionId: job.sessionId,
        label,
        wrote,
      });
    });
    yield* jobs.work("name-session", (payload) =>
      decodeNameSessionJob(payload).pipe(
        Effect.flatMap((job) => asSessionOwner(job.sessionId)(nameSession(job))),
        Effect.orDie,
      ),
    );
  }),
);

const WorkerLive = Layer.mergeAll(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const dispatcher = yield* Dispatcher;
      yield* Effect.forkScoped(dispatcher.run());
    }),
  ),
  InferenceWorkersLive,
  // Constructing the engine resumes supervision of unsettled sessions.
  SessionEngineLayer,
  // Pushes to registered phones when a session settles or waits on the user.
  SessionNotifierLive,
  // Queues tour + suggestion passes at settle, per the automation cascade.
  ReviewPrepLive,
  // Capture mode (ADR-0002 "Review", "Retention"): the observed pass over posted summaries,
  // and the hourly retention sweep. Both are inert under the co-located store.
  SummaryObserveWorkerLive.pipe(Layer.provide(SummaryObserverLive)),
  CaptureRetentionScheduleLive.pipe(Layer.provide(CaptureRetentionLive)),
).pipe(
  Layer.provide(Dispatcher.layer),
  Layer.provide(BriefCompiler.layer),
  Layer.provide(FailureSummarizer.layer),
  Layer.provide(CommentRouter.layer),
  Layer.provide(ChangeReader.layer),
  Layer.provide(TourComposer.layer),
  Layer.provide(ChangeSuggesterLive),
  Layer.provide(SessionNamerLive),
  Layer.provide(liveToolsLayer),
  // start_run: the one tool that reaches the run machinery.
  Layer.provide(startRunToolLayer),
  // Inference runs on the user's Sealant-connected subscriptions — Mend ships no model keys.
  Layer.provide(sealantProviderLayer),
  Layer.provide(runStarterLayer),
);

const MainLive = Layer.unwrap(
  Effect.gen(function* () {
    const rawMode = yield* Config.schema(
      Schema.Literals(["all", "api", "worker", "web"]),
      "MEND_MODE",
    ).pipe(Config.orElse(() => Config.succeed("all" as const)));
    // `web` predates the api/web split; it always meant "serve HTTP, no workers".
    const mode = rawMode === "web" ? "api" : rawMode;
    const deployment = yield* DeploymentConfig;
    yield* Effect.logInfo("mend api starting").pipe(
      Effect.annotateLogs({ mode, sessionStore: deployment.sessionStore }),
    );
    const captured = deployment.sessionStore === "captured";
    const captureStore = CaptureStoreLayer.pipe(
      Layer.provide(StoreLive),
      Layer.provide(StoreConfig.layer),
      Layer.provide(DatabaseLive),
    );
    // The capture channel (routes + register hub) and the engine's view of the capture store.
    const captureChannel = CaptureChannelLive.pipe(Layer.provide(captureStore));
    const captureRuntime = captured
      ? CaptureRuntimeLive.pipe(Layer.provide(captureChannel), Layer.provide(captureStore))
      : CaptureRuntimeOff;
    // The authority and the reads, by store kind: a directory beside Mend, or the chain head.
    const sessionRepository = captured
      ? SessionRepositoryCapturedLive.pipe(
          Layer.provide(captureChannel),
          Layer.provide(captureStore),
          Layer.provide(StoreLive),
          Layer.provide(DatabaseLive),
        )
      : SessionRepositoryLocalLive.pipe(Layer.provide(StoreLive), Layer.provide(DatabaseLive));
    const worktreeReads = captured
      ? WorktreeReadsCapturedLive.pipe(Layer.provide(captureStore))
      : WorktreeReadsColocatedLive.pipe(Layer.provide(StoreLive), Layer.provide(DatabaseLive));
    const parts =
      mode === "api"
        ? ServerLive
        : mode === "worker"
          ? WorkerLive
          : Layer.merge(ServerLive, WorkerLive);
    // The network session channel is a sibling service: it serves workspaces, nothing depends
    // on it, so it must be launched explicitly rather than provided.
    return Layer.merge(parts, SessionChannelNetworkLayer).pipe(
      // Shared by the API (enqueue on comment) and the workers (one instance).
      Layer.provide(JobRunner.pgBossLayer),
      // Follow-up delivery owns persistence → process acceptance → correlation.
      Layer.provide(FollowUpDeliveryLayer),
      // The session engine and store serve both the API handlers and the worker.
      Layer.provide(SessionEngineLayer),
      // The store kind's adapters (MEND_SESSION_STORE): authority, reads, capture runtime.
      Layer.provide(Layer.mergeAll(sessionRepository, worktreeReads, captureRuntime)),
      Layer.provide(StoreLive),
      Layer.provide(StoreConfig.layer),
      Layer.provide(DeploymentConfigLive),
      // The per-user dotfiles store — the dotfiles API group reads/writes it directly.
      Layer.provide(DotfilesStoreLayer),
      // The machine's Mend git key (docs/GIT-ACCESS.md — the mend-key auth mode).
      Layer.provide(KeysLive),
      Layer.provide(SecretCipherLayer),
      // The ssh-agent bridge (decision 2) — signer presence + bridged git ops.
      Layer.provide(BridgeLive),
      // The host's GitHub CLI, behind the api's Gh service (adoption discovery).
      Layer.provide(GhLive),
      Layer.provide(HostEnvironmentLive),
      Layer.provide(AuthLive),
      Layer.provide(NetworkConfigLive),
      // One Sealant client per user, provisioned on first use (docs/SEALANT-IDENTITY.md).
      Layer.provide(SealantLiveFromEnv.pipe(Layer.provide(SealantIdentityStoreLive))),
      Layer.provide(DatabaseLive),
    );
  }),
).pipe(Layer.provide(DeploymentConfigLive));

// Graceful shutdown gets a deadline. runMain interrupts the main fiber on
// SIGTERM/SIGINT and unwinds finalizers — but an uninterruptible pending
// platform promise inside a watch fiber can wedge that unwind forever
// (docs/BUGS.md), leaving a half-dead server: HTTP gone, Service ports and
// session sockets still held, the watch runner waiting on a child that will
// never exit. The timer is unref'd: a clean unwind exits on its own first;
// the deadline only fires for a wedge, and the OS reclaims every fd.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

NodeRuntime.runMain(Layer.launch(MainLive));
