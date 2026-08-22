import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  EventsRoutes,
  GhLive,
  HostEnvironmentLive,
  KeysBridgeRoutes,
  MendApiLive,
  TtyRoutes,
} from "@mend/api";
import { Auth } from "@mend/auth";
import {
  AgentConversationRepoLive,
  BriefCommentsRepoLive,
  BriefsRepoLive,
  ChangePassesRepo,
  ChangePassesRepoLive,
  ProjectsRepo,
  SessionsRepo,
  SessionChangesRepo,
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
  ProjectEnvironmentRepoLive,
  ProjectMountsRepoLive,
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
  SessionChangesRepoLive,
  SessionGitOpsRepoLive,
  SessionProcessesRepoLive,
  SessionRunsRepoLive,
  SessionChannelTokensRepoLive,
  SessionsRepoLive,
  SettingsRepoLive,
  UserDotfilesRepoLive,
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
  Dispatcher,
  JobRunner,
  ReviewPrepLive,
  runStarterLayer,
  SessionNotifierLive,
  startRunToolLayer,
} from "@mend/jobs";
import { asSealantUser, SealantLiveFromEnv } from "@mend/sealant";
import {
  FollowUpDeliveryLive,
  FollowUpLauncherLive,
  ProtocolHostLive,
  ServiceHostLive,
  SessionEngine,
  SessionEngineLive as SessionEngineBaseLive,
  SessionChannelNetworkHostLive,
  SessionChannelRegistryLive,
  SessionSocketHostLive,
} from "@mend/sessions";
import {
  type AgentBridge,
  AgentBridgeLive,
  type DotfilesStore,
  DotfilesStoreLive,
  type MendKeys,
  MendKeysConfigLive,
  MendKeysLive,
  type SecretCipher,
  SecretCipherLive,
  Store,
  StoreConfig,
  DeploymentConfigLive,
} from "@mend/store";
import { Config, Effect, Layer, Option, Schema } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/**
 * The composition boundary (ARCHITECTURE.md §2): every service is wired here
 * and nowhere else. One process runs the web app, the API, and the workers;
 * MEND_MODE (`all` default · `web` · `worker`) splits it later without a
 * redesign.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ─── Data: Postgres, migrated before anything reads it ─────────────────────
const DrizzleRepositoriesLive = Layer.mergeAll(
  AgentConversationRepoLive,
  UserDotfilesRepoLive,
  HotWorkspacesRepoLive,
  SessionGitOpsRepoLive,
  SessionProcessesRepoLive,
  ServicesRepoLive,
  ServiceForwardsRepoLive,
  ServiceObservationsRepoLive,
  SessionRunsRepoLive,
  CheckpointsRepoLive,
  ProjectsRepoLive,
  ProjectEnvironmentRepoLive,
  ProjectMountsRepoLive,
  ProjectSecretsRepoLive,
  ProjectServiceRecipesRepoLive,
  SettingsRepoLive,
  InferenceCallsRepoLive,
  FollowUpsRepoLive,
  ReviewCommentsRepoLive,
  ReviewSlicesRepoLive,
  SessionChangesRepoLive,
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
const SessionEngineLayer = SessionEngineBaseLive.pipe(
  Layer.provide(ProtocolHostLayer),
  Layer.provide(ServiceHostLayer),
  Layer.provide(SessionSocketHostLayer),
  Layer.provide(DotfilesStoreLayer),
  Layer.provide(DeploymentConfigLive),
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

// ─── The built web app: static assets + SSR (absent in dev — vite serves it) ─
const WebAppRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const clientDir = path.join(appDir, "dist/client");
    const ssrEntry = path.join(appDir, "dist/server/server.js");
    if (!existsSync(ssrEntry)) {
      yield* Effect.logInfo("no built web app found — serving API only (dev mode)");
      return;
    }
    const ssr: { readonly fetch: (request: Request) => Promise<Response> } = yield* Effect.promise(
      async () => {
        const mod: {
          readonly default: { readonly fetch: (request: Request) => Promise<Response> };
        } = await import(pathToFileURL(ssrEntry).href);
        return mod.default;
      },
    );

    yield* router.add("*", "/*", (request) =>
      Effect.gen(function* () {
        if (request.method === "GET" || request.method === "HEAD") {
          const pathname = new URL(request.url, "http://mend.local").pathname;
          const candidate = path.join(clientDir, pathname);
          const insideClientDir = candidate.startsWith(clientDir + path.sep);
          if (insideClientDir && existsSync(candidate) && statSync(candidate).isFile()) {
            return yield* HttpServerResponse.file(candidate).pipe(Effect.orDie);
          }
        }
        const webRequest = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
        const response = yield* Effect.promise(() => ssr.fetch(webRequest));
        return HttpServerResponse.fromWeb(response);
      }),
    );
  }),
);

// ─── HTTP: the API contract + auth + web app on one port ───────────────────
const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.int("PORT").pipe(Config.orElse(() => Config.succeed(3105)));
    // Self-host posture: the instance lives behind the operator's perimeter,
    // and clients are many-origin by design (phone app, Expo web dev, LAN).
    return HttpRouter.serve(
      Layer.mergeAll(
        MendApiLive,
        AuthRoutes,
        EventsRoutes,
        TtyRoutes,
        KeysBridgeRoutes,
        WebAppRoutes,
      ),
      { middleware: HttpMiddleware.cors({ allowedOrigins: () => true, credentials: true }) },
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
    const sessionChanges = yield* SessionChangesRepo;
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
            Option.isSome(change) ? asSessionOwner(change.value.sessionId)(self) : self,
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
    const mode = yield* Config.schema(Schema.Literals(["all", "web", "worker"]), "MEND_MODE").pipe(
      Config.orElse(() => Config.succeed("all" as const)),
    );
    yield* Effect.logInfo("mend starting").pipe(Effect.annotateLogs({ mode }));
    const parts =
      mode === "web"
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
      Layer.provide(Auth.layer),
      // One Sealant client per user, provisioned on first use (docs/SEALANT-IDENTITY.md).
      Layer.provide(SealantLiveFromEnv.pipe(Layer.provide(SealantIdentityStoreLive))),
      Layer.provide(DatabaseLive),
    );
  }),
);

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
