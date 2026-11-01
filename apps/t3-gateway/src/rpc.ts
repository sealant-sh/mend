import { projectNameFrom } from "@mend/domain/workbench";
import { ProjectId } from "@mend/t3-contracts";
import {
  AcpRegistryOperationError,
  AgentSessionImportProjectNotFoundError,
  AssetAttachmentNotFoundError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceContextNotFoundError,
  AuthAccessReadScope,
  AuthOrchestrationReadScope,
  AuthTerminalReadScope,
  EnvironmentAuthorizationError,
  ExternalLauncherUnsupportedEditorError,
  GitManagerError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetWorkflowScriptError,
  OrchestrationSearchThreadsError,
  OrchestrationV2CommandOutputError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2SearchThreadError,
  type OrchestrationV2SearchThreadInput,
  OrchestrationV2StopWorkflowError,
  PersistChatAttachmentsError,
  ProjectMutationError,
  ProviderSetupError,
  ProviderUploadFeedbackError,
  PullRequestOperationError,
  ScheduledTaskError,
  type DeviceServiceState,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviders,
  ServerSelfUpdateError,
  ServerSettingsError,
  type ServerSettings,
  type OrchestrationV2ShellStreamItem,
  UsageLimitSourceError,
  VcsUnsupportedOperationError,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
} from "@mend/t3-contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AssetUrls } from "./assets.ts";
import { dispatchCommand } from "./commands.ts";
import { GatewayEnvironment } from "./environment.ts";
import { makeFileHandlers } from "./files.ts";
import type { HubReadError, PersonHub, ProjectCreationRequest, ThreadChange } from "./hub.ts";
import { launchThread } from "./launch.ts";
import { modelPreferencesUpdateOf, type KeptSettings } from "./model-preferences.ts";
import { projectWorkspaceRootOf } from "./project-paths.ts";
import { parseProofMediaPath } from "./proof-media.ts";
import { PROJECT_UNREACHABLE, WORKTREE_UNREACHABLE } from "./removal.ts";
import { makeReviewHandlers } from "./review.ts";
import { projectActionsPatchOf, refusalOf } from "./rpc-scopes.ts";
import {
  loginsOf,
  findsInThread,
  makeServerConfig,
  makeWelcome,
  providersFromMend,
  type PersonLogins,
} from "./server-config.ts";
import type { WorkspaceSkills } from "./skills.ts";
import type { BearerSession, GatewayStateError } from "./state.ts";
import { makeVcsHandlers } from "./vcs.ts";

/**
 * The `/ws` half of a t3code environment: every method of t3code's `WsRpcGroup` (ADR 0012, "The
 * surface"). A method the server does not register answers with a defect, and a client's durable
 * subscription dies on a defect without retrying, so nothing here is left out.
 *
 * Phase 0 serves the connection itself: the config snapshot, the lifecycle welcome and the probe.
 * Phase 1 serves the shell from the person's projection hub (`hub.ts`). Every other method answers
 * as the feature it names is not offered:
 *
 * - A command or a read fails with a typed error from its own contract. Where the contract has an
 *   error whose fields can be filled truthfully, that error; otherwise
 *   `EnvironmentAuthorizationError`, which every method carries, naming the method in its message.
 * - A stream for a feed of things Mend never has (previews, provider setup, pull request
 *   refreshes) stays open and never emits: there is nothing to report. Where a client waits on
 *   the first answer before it renders (scheduled tasks, the device hub), the feed says what the
 *   gateway has instead: none, or a hub that will never run.
 * - A stream for a named thing or an action (one thread, a git action, a self-update) fails
 *   typed, as its command would.
 *
 * Phases 1 to 3 replace refusals with real handlers; the ADR's table says which.
 */

type WsRpc = RpcGroup.Rpcs<typeof WsRpcGroup>;
export type WsRpcMethod = WsRpc["_tag"];

/** The methods the gateway answers for real. */
export const SERVED_METHODS: ReadonlySet<WsRpcMethod> = new Set<WsRpcMethod>([
  WS_METHODS.serverProbe,
  WS_METHODS.agentSessionsScan,
  WS_METHODS.serverGetConfig,
  WS_METHODS.serverGetSettings,
  WS_METHODS.serverUpdateSettings,
  WS_METHODS.serverRefreshProviders,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.serverGetStorageCleanupReport,
  WS_METHODS.serverGetDatabaseStorage,
  WS_METHODS.filesystemGetMetadata,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  ORCHESTRATION_V2_WS_METHODS.getTurnItem,
  ORCHESTRATION_V2_WS_METHODS.searchThread,
  ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  ORCHESTRATION_V2_WS_METHODS.launchThread,
  ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
  ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
  WS_METHODS.assetsCreateUrl,
  WS_METHODS.assetsPersistChatAttachments,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.projectsCreateNew,
  WS_METHODS.projectsEnsureScratch,
  WS_METHODS.projectsListEntries,
  WS_METHODS.projectsReadFile,
  WS_METHODS.projectsSearchContents,
  WS_METHODS.subscribeVcsStatus,
  WS_METHODS.vcsRefreshStatus,
  WS_METHODS.vcsListRefs,
  WS_METHODS.vcsRemoveWorktree,
  // `project.delete` only; creating or editing a project is refused.
  WS_METHODS.projectsMutate,
  WS_METHODS.gitRunStackedAction,
  WS_METHODS.subscribeWorktreeSetup,
  WS_METHODS.worktreeSetupCancel,
  WS_METHODS.terminalOpen,
  WS_METHODS.terminalAttach,
  WS_METHODS.terminalObserve,
  WS_METHODS.terminalWrite,
  WS_METHODS.terminalResize,
  WS_METHODS.terminalClear,
  WS_METHODS.terminalRestart,
  WS_METHODS.terminalClose,
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeTerminalMetadata,
  WS_METHODS.reviewGetDiffPreview,
  WS_METHODS.reviewGetDiffFileContents,
  // Answered with what the gateway has: nothing to report about client activity, no scheduled
  // tasks, and a device hub that will never run. Silent, each left a page loading for good.
  WS_METHODS.serverReportClientActivity,
  WS_METHODS.scheduledTasksSubscribe,
  WS_METHODS.subscribeDeviceState,
]);

/** Streams that stay open and never emit: feeds of things Mend never has. */
export const SILENT_STREAMS: ReadonlySet<WsRpcMethod> = new Set<WsRpcMethod>([
  WS_METHODS.chatGptHandoffSubscribe,
  WS_METHODS.codexAuthCallbackSubscribe,
  WS_METHODS.providerAuthSubscribe,
  WS_METHODS.providerInstallSubscribe,
  WS_METHODS.pullRequestsSubscribeRefreshes,
  WS_METHODS.subscribeProjectClones,
  WS_METHODS.subscribePreviewEvents,
  WS_METHODS.subscribeDiscoveredLocalServers,
  WS_METHODS.subscribeBackgroundPolicy,
]);

// ─── Refusals ────────────────────────────────────────────────────────────────

const READ = AuthOrchestrationReadScope;
const TERMINAL_READ = AuthTerminalReadScope;

const notOfferedText = (method: string) => `Mend's t3code gateway does not offer ${method}.`;

/** The refusal every method's contract allows. */
const notOffered = (method: WsRpcMethod) => refusalOf(method, notOfferedText(method));

const refuse = (method: WsRpcMethod) => Effect.fail(notOffered(method));

const refuseStream = (method: WsRpcMethod) => Stream.fail(notOffered(method));

/** t3code's "nothing to report" for a status feed: `null`, then open. */
const noStatus = () => Stream.concat(Stream.make(null), Stream.never);

const PROVIDER_SETUP_DETAIL =
  "Mend runs each harness on its person's own login. Sign in and install harnesses in Mend.";

const providerSetup = (method: WsRpcMethod, instanceId: ProviderInstanceId) =>
  Effect.fail(
    new ProviderSetupError({ instanceId, operation: method, detail: PROVIDER_SETUP_DETAIL }),
  );

const SELF_UPDATE_REASON = "The gateway updates with Mend, never from a t3code client.";

/** Why t3code's branch picker cannot switch a thread's branch or make a new one. */
export const BRANCH_KEPT =
  "Mend keeps every thread on its own branch and never moves it. Start a new thread to work from another branch.";

/** Why t3code's "Pull" is refused. */
export const PULL_REFUSED = "Mend does not update a thread's worktree from origin.";

/** Why checking out a pull request into a thread is refused. */
export const PULL_REQUEST_THREAD =
  "Mend starts a thread from a project's branch. Checking out a pull request into a thread is not offered.";

const pullRequestThread = (method: WsRpcMethod, cwd: string) =>
  new GitManagerError({ operation: method, cwd, detail: PULL_REQUEST_THREAD });

const vcsUnsupported = (method: WsRpcMethod) =>
  Effect.fail(
    new VcsUnsupportedOperationError({
      operation: method,
      kind: "unknown",
      detail: notOfferedText(method),
    }),
  );

const pullRequests = (method: WsRpcMethod) =>
  Effect.fail(new PullRequestOperationError({ operation: method, detail: notOfferedText(method) }));

const scheduledTasks = (method: WsRpcMethod) =>
  Effect.fail(new ScheduledTaskError({ message: notOfferedText(method) }));

/**
 * The device hub as t3code's clients read it: set up, and failed for good, with why. A hub left
 * unreported (or reported off) opens t3code's device setup wizard on every thread, whose switch
 * Mend can never turn on; a completed one that failed shows the reason in the device panel.
 */
export const NO_DEVICE_HUB: DeviceServiceState = {
  hosts: [],
  hostStatus: "failed",
  hostStatusDetail:
    "Mend runs no simulators or emulators, so devices are not offered on this environment.",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 1,
};

const acpRegistry = (method: WsRpcMethod) =>
  Effect.fail(
    new AcpRegistryOperationError({
      reason: "registry_unavailable",
      message: notOfferedText(method),
    }),
  );

/** A thread the person has no protocol session for. */
const unknownThread = (threadId: ThreadId) =>
  new OrchestrationV2GetThreadProjectionError({
    threadId,
    message: `Thread ${threadId} is not in this environment.`,
  });

// ─── Handlers ────────────────────────────────────────────────────────────────

export interface GatewayRpcInput {
  readonly environment: GatewayEnvironment["Service"];
  /** Signs the URLs a client fetches a message's images from. */
  readonly assetUrls: AssetUrls["Service"];
  /** The paired person behind this socket; every Mend call is theirs. */
  readonly session: BearerSession;
  /** The person's projection of Mend, shared with their other sockets. */
  readonly hub: PersonHub;
  readonly clientAppVersion: string | undefined;
}

const MODELS_SOURCE = "Mend GET /api/harnesses/models";
const PREFERENCES_SOURCE = "the t3code gateway's state";
/** How long the config waits for the person's logins (Mend asks the platform) before leaving them unknown. */
const LOGINS_DEADLINE = "2 seconds";
/** What a client is shown of the providers, without when it was read: what a change is. */
const providersPrint = (providers: ReadonlyArray<ServerProvider>) =>
  JSON.stringify(providers.map(({ checkedAt: _checkedAt, ...shown }) => shown));
/** How often a subscribed client's logins are looked at again with nothing said to move them. */
const LOGINS_LOOK = "5 minutes";
const encodeServerConfig = Schema.encodeEffect(Schema.toCodecJson(ServerConfig));
const encodeServerProviders = Schema.encodeEffect(Schema.toCodecJson(ServerProviders));

/** A feed whose subscriber fell behind; the only typed failure these feeds declare. */
const fellBehind = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: "This feed fell behind; subscribe again.",
    requiredScope,
  });

/** Mend no longer takes the socket's device: t3code blocks the connection. */
const deviceRefused = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: "Mend no longer accepts this device. Pair again from Mend.",
    requiredScope,
  });

/** A device Mend refused blocks the connection; Mend not answering is a failure t3code retries. */
const shellReadFailure = (error: HubReadError) =>
  error._tag === "MendDeviceRefused"
    ? new EnvironmentAuthorizationError({
        message: "Mend no longer accepts this device. Pair again from Mend.",
        requiredScope: READ,
      })
    : new OrchestrationV2GetShellSnapshotError({ message: error.message, cause: error });

/** As `shellReadFailure`, for one thread. */
const threadReadFailure = (threadId: ThreadId) => (error: HubReadError) =>
  error._tag === "MendDeviceRefused"
    ? new EnvironmentAuthorizationError({
        message: "Mend no longer accepts this device. Pair again from Mend.",
        requiredScope: READ,
      })
    : new OrchestrationV2GetThreadProjectionError({
        threadId,
        message: error.message,
        cause: error,
      });

export const makeGatewayRpcHandlers = ({
  environment,
  assetUrls,
  session,
  hub,
  clientAppVersion,
}: GatewayRpcInput) => {
  // Mend only through the person's gate: a 401 on any call refuses this socket's token.
  const { mend } = hub;
  const { descriptor, paths } = environment;
  const review = makeReviewHandlers({ hub, mend, session });
  const files = makeFileHandlers({ hub, mend, session });
  const vcs = makeVcsHandlers({ hub, mend, session });

  /**
   * The socket's own device token, checked on every served call. The scope the call needs was
   * checked before the handler ran (`RpcScopeAuthorization`, `rpc-scopes.ts`).
   */
  const authorize = (bearer: BearerSession) =>
    hub.isRefused(bearer.deviceToken) ? Effect.fail(deviceRefused(READ)) : Effect.void;

  const projectCreation = (request: ProjectCreationRequest) =>
    Effect.gen(function* () {
      yield* authorize(session);
      if (!session.scopes.includes("orchestration:operate"))
        return yield* new EnvironmentAuthorizationError({
          message: "The authenticated token is missing required scope: orchestration:operate.",
          requiredScope: "orchestration:operate",
        });
      return yield* hub.createProject(session, request).pipe(
        Effect.mapError((error) =>
          error._tag === "MendDeviceRefused" ||
          (error._tag === "ThreadCommandRefused" && error.authorization)
            ? new EnvironmentAuthorizationError({
                message: error.message,
                requiredScope: "orchestration:operate",
              })
            : new OrchestrationDispatchCommandError({ message: error.message }),
        ),
      );
    });

  const threadToFind = (search: OrchestrationV2SearchThreadInput) =>
    Effect.gen(function* () {
      yield* authorize(session);
      const snapshot = yield* hub
        .threadSnapshot(search.threadId)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "MendDeviceRefused"
              ? deviceRefused(READ)
              : new OrchestrationV2SearchThreadError({ cause: error }),
          ),
        );
      if (snapshot === null) {
        return yield* new OrchestrationV2SearchThreadError({
          cause: unknownThread(search.threadId),
        });
      }
      return snapshot;
    });

  const settingsReadFailure = (cause: GatewayStateError) =>
    new ServerSettingsError({ settingsPath: PREFERENCES_SOURCE, operation: "read-file", cause });
  const readSettings = hub.settings(session).pipe(Effect.mapError(settingsReadFailure));
  /**
   * A feed that fell behind is let go and subscribed again, with the settings as they are now,
   * rather than failed: t3code's config subscription does not retry a typed failure, so failing it
   * would end the client's config updates until it reconnects.
   */
  const followSettings: Stream.Stream<KeptSettings, ServerSettingsError> = Stream.unwrap(
    hub.subscribeSettings(session).pipe(Effect.mapError(settingsReadFailure)),
  ).pipe(
    Stream.catchTag("SubscriberFellBehind", () => Stream.empty),
    Stream.forever,
  );
  const settingsAfter = (version: number) => {
    let last = version;
    return followSettings.pipe(
      Stream.filter((kept) => {
        if (kept.version <= last) return false;
        last = kept.version;
        return true;
      }),
      Stream.map((kept) => kept.settings),
    );
  };

  /**
   * What t3code cannot read is a typed failure logged by the gateway, never a defect in the
   * client: a config or its providers are encoded before they are sent.
   */
  const readable = <A>(encoded: Effect.Effect<unknown, Schema.SchemaError>, value: A) =>
    encoded.pipe(
      Effect.catch((cause) =>
        Effect.logError("t3 gateway built a server config t3code cannot read", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new ServerSettingsError({
                settingsPath: MODELS_SOURCE,
                operation: "normalize",
                cause,
              }),
            ),
          ),
        ),
      ),
      Effect.as(value),
    );

  /**
   * The person's providers. Mend's catalog is read with their device token; a revoked device
   * answers t3code's authorization error, an unreachable Mend its settings error (the client
   * retries both differently: blocked, or transient). Each provider carries the skills last read
   * for every workspace, and `asked`: a composer's cwd read just now.
   */
  const providersWith = (asked: ReadonlyArray<WorkspaceSkills>) =>
    Effect.gen(function* () {
      yield* authorize(session);
      const catalogRead = mend.listHarnessModels(session.deviceToken).pipe(
        Effect.catchTags({
          MendDeviceRefused: () =>
            Effect.fail(
              new EnvironmentAuthorizationError({
                message: "Mend no longer accepts this device. Pair again from Mend.",
                requiredScope: READ,
              }),
            ),
          MendUnavailable: (cause) =>
            Effect.logWarning("t3 gateway could not read Mend's model catalog", { cause }).pipe(
              Effect.andThen(
                Effect.fail(
                  new ServerSettingsError({
                    settingsPath: MODELS_SOURCE,
                    operation: "read-file",
                    cause,
                  }),
                ),
              ),
            ),
        }),
      );
      // Beside the catalog, never in front of it: a slow or failed read leaves the logins unknown.
      const loginsRead = mend.connectedAccounts(session.deviceToken).pipe(
        Effect.flatMap((accounts) =>
          Effect.map(Clock.currentTimeMillis, (now): PersonLogins => loginsOf(accounts, now)),
        ),
        Effect.timeoutOption(LOGINS_DEADLINE),
        Effect.map(Option.getOrNull),
        Effect.catch((cause) =>
          Effect.logDebug("t3 gateway could not read the person's logins", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      const [catalogs, logins] = yield* Effect.all([catalogRead, loginsRead], {
        concurrency: "unbounded",
      });
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const providers = providersFromMend(catalogs, checkedAt, logins, [
        ...hub.workspaceSkills(),
        ...asked,
      ]);
      return yield* readable(encodeServerProviders(providers), providers);
    });
  const loadProviders = providersWith([]);

  const configOf = (providers: ReadonlyArray<ServerProvider>, settings: ServerSettings) => {
    const config = makeServerConfig({
      environment: descriptor,
      auth: environment.auth,
      paths,
      providers,
      settings,
      findInThread: findsInThread(clientAppVersion),
      personId: session.mendUser.id,
      createsProjects: session.scopes.includes("orchestration:operate"),
    });
    return readable(encodeServerConfig(config), config);
  };
  const configWith = (asked: ReadonlyArray<WorkspaceSkills>) =>
    authorize(session).pipe(
      Effect.andThen(
        Effect.all([providersWith(asked), readSettings], { concurrency: "unbounded" }),
      ),
      Effect.flatMap(([providers, kept]) => configOf(providers, kept.settings)),
    );
  const loadServerConfig = configWith([]);

  return WsRpcGroup.of({
    // ── Served ──────────────────────────────────────────────────────────────
    [WS_METHODS.serverProbe]: () => authorize(session).pipe(Effect.as({})),
    [WS_METHODS.serverGetConfig]: () => loadServerConfig,
    // A snapshot, then the providers again whenever the person's logins may have moved (review
    // R650-3): Mend says their accounts changed, or the regular look finds them changed (an
    // expiry passing, a read that failed before). Sent only when something differs.
    [WS_METHODS.subscribeServerConfig]: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const opening = yield* loadProviders;
          const kept = yield* readSettings;
          const config = yield* configOf(opening, kept.settings);
          const changes = yield* hub.providerChanges;
          let last = providersPrint(config.providers);
          const updates = Stream.merge(
            changes.pipe(Stream.orElseSucceed(() => "accounts" as const)),
            Stream.tick(LOGINS_LOOK).pipe(Stream.drop(1)),
          ).pipe(
            Stream.mapEffect(() => loadProviders.pipe(Effect.orElseSucceed(() => null))),
            Stream.filter((providers): providers is ReadonlyArray<ServerProvider> => {
              if (providers === null) return false;
              const print = providersPrint(providers);
              if (print === last) return false;
              last = print;
              return true;
            }),
            Stream.map((providers) => ({
              version: 1 as const,
              type: "providerStatuses" as const,
              payload: { providers },
            })),
          );
          const settingsUpdates = settingsAfter(kept.version).pipe(
            Stream.map((settings) => ({
              version: 1 as const,
              type: "settingsUpdated" as const,
              payload: { settings },
            })),
          );
          return Stream.make({ version: 1 as const, type: "snapshot" as const, config }).pipe(
            Stream.concat(Stream.merge(updates, settingsUpdates)),
          );
        }),
      ).pipe(Stream.scoped),
    [WS_METHODS.subscribeServerLifecycle]: () =>
      Stream.fromEffect(
        authorize(session).pipe(
          Effect.as({
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: makeWelcome({ environment: descriptor, paths }),
          }),
        ),
      ).pipe(Stream.concat(Stream.never)),
    // What changed after the sequence the client resumes after, when the hub still covers it, else
    // a fresh snapshot (always a legal reset); the catch-up marker when asked; then every change
    // as the hub publishes it.
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* authorize(session);
          const { start, changes } = yield* hub
            .subscribeShell(input.afterSequence)
            .pipe(Effect.mapError(shellReadFailure));
          const opening: ReadonlyArray<OrchestrationV2ShellStreamItem> =
            start.kind === "snapshot"
              ? [{ kind: "snapshot", snapshot: start.snapshot }]
              : start.deltas;
          return Stream.fromIterable(opening).pipe(
            Stream.concat(
              input.requestCompletionMarker === true
                ? Stream.make({ kind: "synchronized" as const })
                : Stream.empty,
            ),
            // A subscriber that fell behind fails typed; t3code resubscribes for a fresh snapshot.
            Stream.concat(
              changes.pipe(
                Stream.mapError(
                  (error) => new OrchestrationV2GetShellSnapshotError({ message: error.message }),
                ),
              ),
            ),
          );
        }),
      ),

    // ── Orchestration (phase 1 and later) ───────────────────────────────────
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
      dispatchCommand(hub, session, command),
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) => launchThread(hub, session, input),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
      Effect.gen(function* () {
        yield* authorize(session);
        const snapshot = yield* hub
          .threadSnapshot(input.threadId)
          .pipe(Effect.mapError(threadReadFailure(input.threadId)));
        if (snapshot === null) return yield* unknownThread(input.threadId);
        return snapshot.projection;
      }),
    // As the shell: what changed after the client's sequence while the hub still covers it, else
    // a full snapshot, the marker when asked, then the thread's changes.
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* authorize(session);
          const subscribed = yield* hub
            .subscribeThread(input.threadId, input.afterSequence)
            .pipe(Effect.mapError(threadReadFailure(input.threadId)));
          if (subscribed === null) return yield* unknownThread(input.threadId);
          const { start, changes } = subscribed;
          const opening: ReadonlyArray<ThreadChange> =
            start.kind === "snapshot" ? [{ kind: "snapshot", ...start.snapshot }] : start.changes;
          return Stream.fromIterable(opening).pipe(
            Stream.concat(
              input.requestCompletionMarker === true
                ? Stream.make({ kind: "synchronized" as const })
                : Stream.empty,
            ),
            Stream.concat(
              changes.pipe(
                Stream.mapError(
                  (error) =>
                    new OrchestrationV2GetThreadProjectionError({
                      threadId: input.threadId,
                      message: error.message,
                    }),
                ),
              ),
            ),
          );
        }),
      ),
    // One turn's work, or the thread's up to a turn, from the worktree's checkpoint chain
    // (`turn-checkpoints.ts`); a revoked device blocks, anything else is the method's own error.
    [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: (input) =>
      Effect.gen(function* () {
        yield* authorize(session);
        const diff = yield* hub
          .turnDiff({
            session,
            threadId: input.threadId,
            fromTurnCount: input.fromTurnCount,
            toTurnCount: input.toTurnCount,
            ignoreWhitespace: input.ignoreWhitespace === true,
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "MendDeviceRefused"
                ? deviceRefused(READ)
                : new OrchestrationGetTurnDiffError({ message: error.message }),
            ),
          );
        return {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff,
        };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: (input) =>
      Effect.gen(function* () {
        yield* authorize(session);
        const diff = yield* hub
          .turnDiff({
            session,
            threadId: input.threadId,
            fromTurnCount: 0,
            toTurnCount: input.toTurnCount,
            ignoreWhitespace: input.ignoreWhitespace === true,
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "MendDeviceRefused"
                ? deviceRefused(READ)
                : new OrchestrationGetFullThreadDiffError({ message: error.message }),
            ),
          );
        return { threadId: input.threadId, fromTurnCount: 0, toTurnCount: input.toTurnCount, diff };
      }),
    // One item in full, from the thread as the gateway projects it: Mend's items are never cut.
    [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input) =>
      Effect.gen(function* () {
        yield* authorize(session);
        const snapshot = yield* hub
          .threadSnapshot(input.threadId)
          .pipe(Effect.mapError(threadReadFailure(input.threadId)));
        if (snapshot === null) return yield* unknownThread(input.threadId);
        const item = snapshot.projection.turnItems.find((turnItem) => turnItem.id === input.itemId);
        return { item: item ?? null };
      }),
    [ORCHESTRATION_V2_WS_METHODS.searchThread]: (input) =>
      threadToFind(input).pipe(
        Effect.flatMap((snapshot) => hub.threadFinder.searchThread(snapshot, input)),
      ),
    [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: (input) =>
      Stream.unwrap(
        threadToFind(input).pipe(
          Effect.map((snapshot) => hub.threadFinder.searchThreadStream(snapshot, input)),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.searchThreads]: () =>
      Effect.fail(
        new OrchestrationSearchThreadsError({
          message: notOfferedText(ORCHESTRATION_V2_WS_METHODS.searchThreads),
        }),
      ),
    // The person's archive, kept by the gateway (Mend has none).
    [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
      authorize(session).pipe(
        Effect.andThen(hub.archivedShell.pipe(Effect.mapError(shellReadFailure))),
      ),
    [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* authorize(session);
          const { snapshot, changes } = yield* hub.subscribeArchivedShell.pipe(
            Effect.mapError(shellReadFailure),
          );
          return Stream.make({ kind: "snapshot" as const, snapshot }).pipe(
            Stream.concat(
              changes.pipe(
                Stream.mapError(
                  (error) => new OrchestrationV2GetShellSnapshotError({ message: error.message }),
                ),
              ),
            ),
          );
        }),
      ),
    // Delegated workflows never run through Mend, so there is no workflow root to read from.
    [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: (input) =>
      Effect.fail(
        new OrchestrationGetWorkflowScriptError({
          reason: "root-unavailable",
          scriptPath: input.scriptPath,
        }),
      ),
    [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: (input) =>
      Effect.fail(
        new OrchestrationV2StopWorkflowError({
          threadId: input.threadId,
          subagentId: input.subagentId,
          reason: "unsupported",
        }),
      ),
    // t3code subscribes only when the descriptor offers `commandOutputStreaming`; it does not.
    [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: (input) =>
      Stream.fail(
        new OrchestrationV2CommandOutputError({
          threadId: input.threadId,
          message: notOfferedText(ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput),
        }),
      ),

    // ── Providers: Mend's harnesses, set up in Mend ─────────────────────────
    // A refresh reads the person's logins and Mend's catalog again (review R650-3); it sets up
    // nothing, as logins are Mend's. For a composer's cwd it reads the skills Mend delivers there
    // too (`skills.ts`); a cwd that is none of the person's answers an empty snapshot, kept by no
    // one, so the composer does not ask again every 10 seconds. A failed read answers none, and
    // the composer asks again after its cooldown.
    [WS_METHODS.serverRefreshProviders]: (input) =>
      Effect.gen(function* () {
        const cwd = input.cwd;
        if (cwd === undefined) return yield* loadServerConfig;
        yield* authorize(session);
        const notTheirs = yield* hub.refreshSkillsAt(session.deviceToken, cwd).pipe(
          Effect.map((workspace) => workspace === null),
          Effect.catch((cause) =>
            Effect.logWarning("t3 gateway could not read a workspace's skills", { cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
        if (!notTheirs) return yield* loadServerConfig;
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        return yield* configWith([{ cwd, checkedAt, skills: [] }]);
      }).pipe(
        Effect.map((config) => ({ providers: config.providers })),
        Effect.catchTag("ServerSettingsError", (error) =>
          Effect.fail(
            new ProviderSetupError({
              instanceId: input.instanceId ?? ProviderInstanceId.make("codex"),
              operation: "refresh",
              detail: `Mend could not answer: ${error.message}`,
            }),
          ),
        ),
      ),
    [WS_METHODS.serverUpdateProvider]: (input) =>
      Effect.fail(
        new ServerProviderUpdateError({
          provider: input.provider,
          reason: PROVIDER_SETUP_DETAIL,
        }),
      ),
    [WS_METHODS.providerConsumeResetCredit]: () =>
      Effect.fail(
        new UsageLimitSourceError({
          detail: notOfferedText(WS_METHODS.providerConsumeResetCredit),
        }),
      ),
    [WS_METHODS.providerAuthStart]: (input) =>
      providerSetup(WS_METHODS.providerAuthStart, input.instanceId),
    [WS_METHODS.providerAuthComplete]: (input) =>
      providerSetup(WS_METHODS.providerAuthComplete, input.instanceId),
    [WS_METHODS.providerAuthRespond]: (input) =>
      providerSetup(WS_METHODS.providerAuthRespond, input.instanceId),
    [WS_METHODS.providerAuthCancel]: (input) =>
      providerSetup(WS_METHODS.providerAuthCancel, input.instanceId),
    [WS_METHODS.providerAuthLogout]: (input) =>
      providerSetup(WS_METHODS.providerAuthLogout, input.instanceId),
    [WS_METHODS.chatGptReconnectProfile]: (input) =>
      providerSetup(WS_METHODS.chatGptReconnectProfile, input.instanceId),
    [WS_METHODS.chatGptImportProfile]: (input) =>
      providerSetup(WS_METHODS.chatGptImportProfile, input.instanceId),
    [WS_METHODS.providerInstallStart]: (input) =>
      providerSetup(WS_METHODS.providerInstallStart, input.instanceId),
    [WS_METHODS.providerInstallCancel]: (input) =>
      providerSetup(WS_METHODS.providerInstallCancel, input.instanceId),
    [WS_METHODS.providerInstallRemove]: (input) =>
      providerSetup(WS_METHODS.providerInstallRemove, input.instanceId),
    [WS_METHODS.chatGptHandoffSubscribe]: () => Stream.never,
    [WS_METHODS.codexAuthCallbackSubscribe]: () => Stream.never,
    [WS_METHODS.providerAuthSubscribe]: () => Stream.never,
    [WS_METHODS.providerInstallSubscribe]: () => Stream.never,
    [WS_METHODS.providerUploadFeedback]: (input) =>
      Effect.fail(new ProviderUploadFeedbackError({ threadId: input.threadId })),

    // ── The server itself ───────────────────────────────────────────────────
    [WS_METHODS.serverUpdateServer]: () =>
      Effect.fail(new ServerSelfUpdateError({ reason: SELF_UPDATE_REASON })),
    [WS_METHODS.serverUpdateServerWithProgress]: () =>
      Stream.fail(new ServerSelfUpdateError({ reason: SELF_UPDATE_REASON })),
    [WS_METHODS.serverCommitDesktopUpdate]: () =>
      Effect.fail(new ServerSelfUpdateError({ reason: SELF_UPDATE_REASON })),
    [WS_METHODS.serverUpsertKeybinding]: () => refuse(WS_METHODS.serverUpsertKeybinding),
    [WS_METHODS.serverRemoveKeybinding]: () => refuse(WS_METHODS.serverRemoveKeybinding),
    [WS_METHODS.serverGetSettings]: () =>
      authorize(session).pipe(
        Effect.andThen(readSettings),
        Effect.map((kept) => kept.settings),
      ),
    // Project actions alone, or model preferences alone; any other patch is refused. Saving project
    // actions answers the settings the gateway serves, which name no override: t3code then reads
    // the project's own scripts.
    [WS_METHODS.serverUpdateSettings]: (input) =>
      Effect.gen(function* () {
        yield* authorize(session);
        const actions = projectActionsPatchOf(input);
        if (actions !== null) {
          yield* Effect.forEach(
            Object.entries(actions),
            ([projectId, scripts]) =>
              hub.saveProjectScripts(projectId, scripts).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath: `projectScriptOverrides.${projectId}`,
                      operation: "write-file",
                      cause,
                    }),
                ),
              ),
            { discard: true },
          );
          return (yield* readSettings).settings;
        }
        const patch = modelPreferencesUpdateOf(input);
        if (patch === null) {
          return yield* refuse(WS_METHODS.serverUpdateSettings);
        }
        return yield* hub.updateModelPreferences(session, patch).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath: PREFERENCES_SOURCE,
                operation: cause._tag === "ModelPreferencesTooLarge" ? "normalize" : "write-file",
                cause,
              }),
          ),
        );
      }),
    [WS_METHODS.serverDiscoverSourceControl]: () => refuse(WS_METHODS.serverDiscoverSourceControl),
    [WS_METHODS.serverGetTraceDiagnostics]: () => refuse(WS_METHODS.serverGetTraceDiagnostics),
    [WS_METHODS.serverGetProcessDiagnostics]: () => refuse(WS_METHODS.serverGetProcessDiagnostics),
    [WS_METHODS.serverGetHostResources]: () => refuse(WS_METHODS.serverGetHostResources),
    [WS_METHODS.serverGetProcessResourceHistory]: () =>
      refuse(WS_METHODS.serverGetProcessResourceHistory),
    [WS_METHODS.serverGetResourceTelemetryHistory]: () =>
      refuse(WS_METHODS.serverGetResourceTelemetryHistory),
    [WS_METHODS.serverRetryResourceTelemetry]: () =>
      refuse(WS_METHODS.serverRetryResourceTelemetry),
    [WS_METHODS.serverGetUsageSummary]: () => refuse(WS_METHODS.serverGetUsageSummary),
    // The gateway keeps nothing a cleanup would free: there is never a report.
    [WS_METHODS.serverGetStorageCleanupReport]: noStatus,
    [WS_METHODS.serverRunStorageCleanup]: () => refuse(WS_METHODS.serverRunStorageCleanup),
    [WS_METHODS.serverGetDatabaseStorage]: noStatus,
    [WS_METHODS.serverCheckOtlpEndpoint]: () => refuse(WS_METHODS.serverCheckOtlpEndpoint),
    [WS_METHODS.serverRefreshUsageRates]: () => refuse(WS_METHODS.serverRefreshUsageRates),
    [WS_METHODS.serverSignalProcess]: () => refuse(WS_METHODS.serverSignalProcess),
    // Nothing in the gateway waits on a client being active: taken, and nothing done.
    [WS_METHODS.serverReportClientActivity]: () => authorize(session),
    [WS_METHODS.serverReportHostPowerState]: () => refuse(WS_METHODS.serverReportHostPowerState),
    [WS_METHODS.serverGetBackgroundPolicy]: () => refuse(WS_METHODS.serverGetBackgroundPolicy),
    [WS_METHODS.subscribeBackgroundPolicy]: () => Stream.never,
    // Unreachable for a client paired now: `diagnostics:read` is not granted, so t3code never
    // subscribes (`auth.ts`). One that does is refused, never left waiting.
    [WS_METHODS.subscribeResourceTelemetry]: () =>
      refuseStream(WS_METHODS.subscribeResourceTelemetry),
    // t3code's own answer to a paired client: pairing is administered in Mend, and the gateway
    // grants no access scopes.
    [WS_METHODS.subscribeAuthAccess]: () =>
      Stream.fail(
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${AuthAccessReadScope}.`,
          requiredScope: AuthAccessReadScope,
        }),
      ),

    // ── ACP registry ────────────────────────────────────────────────────────
    [WS_METHODS.serverSearchAcpRegistry]: () => acpRegistry(WS_METHODS.serverSearchAcpRegistry),
    [WS_METHODS.serverPrepareAcpRegistryAgent]: () =>
      acpRegistry(WS_METHODS.serverPrepareAcpRegistryAgent),
    [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: () =>
      acpRegistry(WS_METHODS.serverUninstallAcpRegistryManagedBinary),
    [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: () =>
      refuse(WS_METHODS.serverAcceptAcpRegistryUrlAuth),
    [WS_METHODS.serverListAcpRegistrySessions]: () =>
      acpRegistry(WS_METHODS.serverListAcpRegistrySessions),
    [WS_METHODS.serverImportAcpRegistrySession]: () =>
      acpRegistry(WS_METHODS.serverImportAcpRegistrySession),
    [WS_METHODS.serverDeleteAcpRegistrySession]: () =>
      acpRegistry(WS_METHODS.serverDeleteAcpRegistrySession),
    [WS_METHODS.serverListAcpRegistryProviders]: () =>
      acpRegistry(WS_METHODS.serverListAcpRegistryProviders),
    [WS_METHODS.serverSetAcpRegistryProvider]: () =>
      acpRegistry(WS_METHODS.serverSetAcpRegistryProvider),
    [WS_METHODS.serverDisableAcpRegistryProvider]: () =>
      acpRegistry(WS_METHODS.serverDisableAcpRegistryProvider),
    [WS_METHODS.serverLogoutAcpRegistry]: () => acpRegistry(WS_METHODS.serverLogoutAcpRegistry),

    // ── Scheduled tasks ─────────────────────────────────────────────────────
    [WS_METHODS.scheduledTasksList]: () => scheduledTasks(WS_METHODS.scheduledTasksList),
    [WS_METHODS.scheduledTasksUpsert]: () => scheduledTasks(WS_METHODS.scheduledTasksUpsert),
    [WS_METHODS.scheduledTasksSetEnabled]: () =>
      scheduledTasks(WS_METHODS.scheduledTasksSetEnabled),
    [WS_METHODS.scheduledTasksDelete]: () => scheduledTasks(WS_METHODS.scheduledTasksDelete),
    [WS_METHODS.scheduledTasksRunNow]: () => scheduledTasks(WS_METHODS.scheduledTasksRunNow),
    // No tasks, ever: the settings page lists none and a thread's details show no automations.
    // A failure would show "Could not load automations" on every thread instead.
    [WS_METHODS.scheduledTasksSubscribe]: () =>
      authorize(session).pipe(
        Effect.as(Stream.concat(Stream.make({ tasks: [] }), Stream.never)),
        Stream.unwrap,
      ),
    [WS_METHODS.scheduledTasksRotateWebhookToken]: () =>
      scheduledTasks(WS_METHODS.scheduledTasksRotateWebhookToken),
    [WS_METHODS.scheduledTasksListWebhookDeliveries]: () =>
      scheduledTasks(WS_METHODS.scheduledTasksListWebhookDeliveries),
    [WS_METHODS.scheduledTasksGetWebhookDelivery]: () =>
      scheduledTasks(WS_METHODS.scheduledTasksGetWebhookDelivery),
    // Mend asks for no secret through t3code: there is never a request to answer.
    [WS_METHODS.secretsAnswerRequest]: () => refuse(WS_METHODS.secretsAnswerRequest),

    // ── T3 Connect relay ────────────────────────────────────────────────────
    [WS_METHODS.cloudGetRelayClientStatus]: () => refuse(WS_METHODS.cloudGetRelayClientStatus),
    [WS_METHODS.cloudInstallRelayClient]: () => refuseStream(WS_METHODS.cloudInstallRelayClient),

    // ── Pull requests ───────────────────────────────────────────────────────
    [WS_METHODS.pullRequestsList]: () => pullRequests(WS_METHODS.pullRequestsList),
    [WS_METHODS.pullRequestsListStats]: () => pullRequests(WS_METHODS.pullRequestsListStats),
    [WS_METHODS.pullRequestsSummary]: () => pullRequests(WS_METHODS.pullRequestsSummary),
    [WS_METHODS.pullRequestsRouting]: () => pullRequests(WS_METHODS.pullRequestsRouting),
    [WS_METHODS.pullRequestsRoutingIdentity]: () =>
      pullRequests(WS_METHODS.pullRequestsRoutingIdentity),
    [WS_METHODS.pullRequestsStack]: () => pullRequests(WS_METHODS.pullRequestsStack),
    [WS_METHODS.pullRequestsLinkedThreads]: () =>
      pullRequests(WS_METHODS.pullRequestsLinkedThreads),
    [WS_METHODS.pullRequestsDetail]: () => pullRequests(WS_METHODS.pullRequestsDetail),
    [WS_METHODS.pullRequestsPreview]: () => pullRequests(WS_METHODS.pullRequestsPreview),
    [WS_METHODS.pullRequestsChecks]: () => pullRequests(WS_METHODS.pullRequestsChecks),
    [WS_METHODS.pullRequestsActivity]: () => pullRequests(WS_METHODS.pullRequestsActivity),
    [WS_METHODS.pullRequestsThreadComments]: () =>
      pullRequests(WS_METHODS.pullRequestsThreadComments),
    [WS_METHODS.pullRequestsDiffFileContents]: () =>
      pullRequests(WS_METHODS.pullRequestsDiffFileContents),
    [WS_METHODS.pullRequestsFilesViewed]: () => pullRequests(WS_METHODS.pullRequestsFilesViewed),
    [WS_METHODS.pullRequestsChangeBreakdown]: () =>
      pullRequests(WS_METHODS.pullRequestsChangeBreakdown),
    [WS_METHODS.pullRequestsSetFilesViewed]: () =>
      pullRequests(WS_METHODS.pullRequestsSetFilesViewed),
    [WS_METHODS.pullRequestsRunAction]: () => pullRequests(WS_METHODS.pullRequestsRunAction),
    [WS_METHODS.pullRequestsUpdate]: () => pullRequests(WS_METHODS.pullRequestsUpdate),
    [WS_METHODS.pullRequestsComment]: () => pullRequests(WS_METHODS.pullRequestsComment),
    [WS_METHODS.pullRequestsUpdateComment]: () =>
      pullRequests(WS_METHODS.pullRequestsUpdateComment),
    [WS_METHODS.pullRequestsSubmitReview]: () => pullRequests(WS_METHODS.pullRequestsSubmitReview),
    [WS_METHODS.pullRequestsReplyToThread]: () =>
      pullRequests(WS_METHODS.pullRequestsReplyToThread),
    [WS_METHODS.pullRequestsSetThreadResolution]: () =>
      pullRequests(WS_METHODS.pullRequestsSetThreadResolution),
    [WS_METHODS.pullRequestsSetReaction]: () => pullRequests(WS_METHODS.pullRequestsSetReaction),
    [WS_METHODS.pullRequestsInvalidate]: () => pullRequests(WS_METHODS.pullRequestsInvalidate),
    [WS_METHODS.pullRequestsReportState]: () => pullRequests(WS_METHODS.pullRequestsReportState),
    [WS_METHODS.pullRequestsReviewGuide]: () => pullRequests(WS_METHODS.pullRequestsReviewGuide),
    [WS_METHODS.pullRequestsGenerateReviewGuide]: () =>
      pullRequests(WS_METHODS.pullRequestsGenerateReviewGuide),
    [WS_METHODS.pullRequestsReviewerCandidates]: () =>
      pullRequests(WS_METHODS.pullRequestsReviewerCandidates),
    [WS_METHODS.pullRequestsRequestReviewers]: () =>
      pullRequests(WS_METHODS.pullRequestsRequestReviewers),
    [WS_METHODS.pullRequestsLabelCandidates]: () =>
      pullRequests(WS_METHODS.pullRequestsLabelCandidates),
    [WS_METHODS.pullRequestsSetLabels]: () => pullRequests(WS_METHODS.pullRequestsSetLabels),
    [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,

    // ── Source control and project creation ─────────────────────────────────
    [WS_METHODS.sourceControlLookupRepository]: () =>
      refuse(WS_METHODS.sourceControlLookupRepository),
    [WS_METHODS.sourceControlCloneRepository]: () =>
      refuse(WS_METHODS.sourceControlCloneRepository),
    [WS_METHODS.sourceControlPublishRepository]: () =>
      refuse(WS_METHODS.sourceControlPublishRepository),
    [WS_METHODS.projectCloneStart]: () =>
      Effect.fail(
        new OrchestrationDispatchCommandError({
          message: notOfferedText(WS_METHODS.projectCloneStart),
        }),
      ),
    [WS_METHODS.projectCloneCancel]: () => refuse(WS_METHODS.projectCloneCancel),
    [WS_METHODS.projectCloneRetry]: () => refuse(WS_METHODS.projectCloneRetry),
    [WS_METHODS.subscribeProjectClones]: () => Stream.never,

    // ── Projects and files ──────────────────────────────────────────────────
    [WS_METHODS.projectsListEntries]: (input) =>
      authorize(session).pipe(Effect.andThen(files.listEntries(input))),
    // Mend lists a worktree's files without the ones git ignores, nor their sizes, and the
    // environment does not offer `ignoredFileListing`, so a client never asks.
    [WS_METHODS.projectsListIgnoredFiles]: () => refuse(WS_METHODS.projectsListIgnoredFiles),
    [WS_METHODS.projectsReadFile]: (input) =>
      authorize(session).pipe(Effect.andThen(files.readFile(input))),
    [WS_METHODS.projectsSearchContents]: (input) =>
      authorize(session).pipe(Effect.andThen(files.searchContents(input))),
    [WS_METHODS.projectsSearchEntries]: (input) =>
      authorize(session).pipe(Effect.andThen(files.searchEntries(input))),
    [WS_METHODS.projectsWriteFile]: () => refuse(WS_METHODS.projectsWriteFile),
    [WS_METHODS.projectsEnsureScratch]: () =>
      projectCreation({ kind: "scratch" }).pipe(
        Effect.map((project) => ({ projectId: ProjectId.make(project.id) })),
      ),
    [WS_METHODS.projectsCreateNew]: (input) =>
      projectCreation({ kind: "named", name: projectNameFrom(input.name) }).pipe(
        Effect.map((project) => ({
          projectId: ProjectId.make(project.id),
          workspaceRoot: projectWorkspaceRootOf(project, session.mendUser.id),
        })),
      ),
    // Removing a project is Mend's removal, without the force t3code asks for: Mend has none
    // for a project.
    [WS_METHODS.projectsMutate]: (mutation) =>
      mutation.type === "project.delete"
        ? authorize(session).pipe(
            Effect.andThen(hub.removeProject({ session, projectId: mutation.projectId })),
            Effect.catchTags({
              RemovalKept: (kept) =>
                Effect.fail(
                  new ProjectMutationError({ commandId: mutation.commandId, message: kept.reason }),
                ),
              MendUnavailable: () =>
                Effect.fail(
                  new ProjectMutationError({
                    commandId: mutation.commandId,
                    message: PROJECT_UNREACHABLE,
                  }),
                ),
              MendDeviceRefused: () => Effect.fail(deviceRefused(READ)),
            }),
          )
        : Effect.fail(
            new ProjectMutationError({
              commandId: mutation.commandId,
              message: "Projects are adopted and edited in Mend.",
            }),
          ),
    // Nothing opens on the machine Mend runs on.
    [WS_METHODS.shellOpenInEditor]: (input) =>
      Effect.fail(new ExternalLauncherUnsupportedEditorError({ editor: input.editor })),
    [WS_METHODS.filesystemBrowse]: () => refuse(WS_METHODS.filesystemBrowse),
    [WS_METHODS.filesystemGetMetadata]: (input) =>
      authorize(session).pipe(Effect.andThen(files.getMetadata(input))),
    // Nothing to import: the gateway has no agent history of its own to scan, and Mend's projects
    // are in the shell already. t3code's onboarding then offers none.
    [WS_METHODS.agentSessionsScan]: () =>
      Effect.andThen(authorize(session), () =>
        Effect.map(DateTime.now, (now) => ({ candidates: [], scannedAt: DateTime.formatIso(now) })),
      ),
    [WS_METHODS.agentSessionsImport]: (input) =>
      Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
    [WS_METHODS.assetsCreateUrl]: (input) =>
      Effect.gen(function* () {
        yield* authorize(session);
        const resource = input.resource;
        if (resource._tag === "project-favicon") {
          const location = yield* hub
            .locationOf(resource.cwd)
            .pipe(Effect.orElseSucceed(() => null));
          if (location === null) return yield* new AssetWorkspaceContextNotFoundError({ resource });
          return {
            relativeUrl: "/api/assets/project-favicon-missing",
            expiresAt: session.expiresAt,
          };
        }
        if (resource._tag === "workspace-file" || resource._tag === "media-file") {
          if (
            !resource.path.startsWith("/") ||
            resource.path.includes("\\") ||
            resource.path.includes("\0") ||
            resource.path
              .split("/")
              .some((part) => part === "." || part === ".." || part === ".git")
          )
            return yield* new AssetWorkspaceAssetNotFoundError({ resource });
          const proof = parseProofMediaPath(resource.path);
          if (proof.kind === "invalid")
            return yield* new AssetWorkspaceAssetNotFoundError({ resource });
          if (proof.kind === "proof")
            return yield* assetUrls
              .issue(session.sessionId, proof)
              .pipe(Effect.mapError(() => new AssetWorkspaceAssetNotFoundError({ resource })));
          const file = yield* hub
            .worktreeFileOf(resource.path, resource.threadId)
            .pipe(Effect.orElseSucceed(() => null));
          if (file === null) return yield* new AssetWorkspaceContextNotFoundError({ resource });
          return yield* assetUrls
            .issue(session.sessionId, {
              kind: "file",
              worktreeId: file.worktreeId,
              path: Redacted.make(file.relativePath),
              preview: resource._tag === "media-file" ? "media" : "workspace",
            })
            .pipe(Effect.mapError(() => new AssetWorkspaceAssetNotFoundError({ resource })));
        }
        if (resource._tag !== "attachment")
          return yield* new AssetWorkspaceContextNotFoundError({ resource });
        if (resource.mimeType === "text/html" && resource.disposition === "inline")
          return yield* assetUrls
            .issue(session.sessionId, { kind: "page", pageId: resource.attachmentId })
            .pipe(Effect.mapError(() => new AssetAttachmentNotFoundError({ resource })));
        const image = hub.imageOf(resource.attachmentId);
        if (image === null) return yield* new AssetAttachmentNotFoundError({ resource });
        return yield* assetUrls
          .issue(session.sessionId, {
            kind: "image",
            imageId: image.id,
            fileName: Redacted.make(image.name),
            sizeBytes: image.sizeBytes,
          })
          .pipe(Effect.mapError(() => new AssetAttachmentNotFoundError({ resource })));
      }),
    // MCP apps run in a t3code server's own provider sessions; Mend's agents have none.
    [WS_METHODS.mcpAppsCallTool]: () => refuse(WS_METHODS.mcpAppsCallTool),
    [WS_METHODS.mcpAppsToolInfo]: () => refuse(WS_METHODS.mcpAppsToolInfo),
    [WS_METHODS.mcpAppsReadResource]: () => refuse(WS_METHODS.mcpAppsReadResource),
    [WS_METHODS.mcpAppsUpdateModelContext]: () => refuse(WS_METHODS.mcpAppsUpdateModelContext),
    [WS_METHODS.assetsPersistChatAttachments]: (input) =>
      Effect.gen(function* () {
        yield* authorize(session);
        const kept = yield* hub
          .persistImages({
            threadId: input.threadId,
            messageId: input.messageId,
            uploads: input.attachments,
          })
          .pipe(
            Effect.mapError((error) => new PersistChatAttachmentsError({ message: error.message })),
          );
        return {
          attachments: kept.map((image) => ({
            type: "image" as const,
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
          })),
        };
      }),
    [WS_METHODS.attachmentsCreateUploadUrl]: () => refuse(WS_METHODS.attachmentsCreateUploadUrl),
    [WS_METHODS.attachmentsDelete]: () => refuse(WS_METHODS.attachmentsDelete),

    // ── VCS and git ─────────────────────────────────────────────────────────
    // The thread's change, as Mend keeps it (`vcs.ts`).
    [WS_METHODS.subscribeVcsStatus]: (input) =>
      Stream.unwrap(authorize(session).pipe(Effect.as(vcs.subscribeStatus(input)))),
    [WS_METHODS.vcsRefreshStatus]: (input) =>
      authorize(session).pipe(Effect.andThen(vcs.refreshStatus(input))),
    [WS_METHODS.gitRunStackedAction]: (input) =>
      Stream.unwrap(authorize(session).pipe(Effect.as(vcs.runStackedAction(input)))),
    [WS_METHODS.gitResolvePullRequest]: (input) =>
      Effect.fail(pullRequestThread(WS_METHODS.gitResolvePullRequest, input.cwd)),
    [WS_METHODS.gitPreparePullRequestThread]: (input) =>
      Effect.fail(pullRequestThread(WS_METHODS.gitPreparePullRequestThread, input.cwd)),
    [WS_METHODS.vcsPull]: () => Effect.fail(refusalOf(WS_METHODS.vcsPull, PULL_REFUSED)),
    [WS_METHODS.vcsListRefs]: (input) =>
      authorize(session).pipe(Effect.andThen(vcs.listRefs(input))),
    [WS_METHODS.vcsCreateWorktree]: () => refuse(WS_METHODS.vcsCreateWorktree),
    // t3code's "Delete the worktree too?" once its last thread is deleted: Mend's removal, and
    // never the `force` t3code always sends.
    [WS_METHODS.vcsRemoveWorktree]: (input) =>
      authorize(session).pipe(
        Effect.andThen(hub.removeWorktree({ session, cwd: input.cwd, path: input.path })),
        Effect.catchTags({
          RemovalKept: (kept) => Effect.fail(refusalOf(WS_METHODS.vcsRemoveWorktree, kept.reason)),
          MendUnavailable: () =>
            Effect.fail(refusalOf(WS_METHODS.vcsRemoveWorktree, WORKTREE_UNREACHABLE)),
          MendDeviceRefused: () => Effect.fail(deviceRefused(READ)),
        }),
      ),
    [WS_METHODS.vcsCreateRef]: () => Effect.fail(refusalOf(WS_METHODS.vcsCreateRef, BRANCH_KEPT)),
    [WS_METHODS.vcsSwitchRef]: () => Effect.fail(refusalOf(WS_METHODS.vcsSwitchRef, BRANCH_KEPT)),
    [WS_METHODS.vcsInit]: () => vcsUnsupported(WS_METHODS.vcsInit),
    // A new worktree's preparation (`worktree-setup.ts`): the setup card, and its cancel.
    [WS_METHODS.subscribeWorktreeSetup]: (input) =>
      Stream.unwrap(
        authorize(session).pipe(
          Effect.as(
            hub.worktreeSetups.stream(input.threadId).pipe(Stream.mapError(() => fellBehind(READ))),
          ),
        ),
      ),
    [WS_METHODS.worktreeSetupCancel]: (input) =>
      authorize(session).pipe(
        Effect.andThen(hub.worktreeSetups.cancel(input.threadId)),
        Effect.map((cancelled) => ({ cancelled })),
      ),

    // ── Review: the thread's change ─────────────────────────────────────────
    [WS_METHODS.reviewGetDiffPreview]: (input) =>
      authorize(session).pipe(Effect.andThen(review.getDiffPreview(input))),
    [WS_METHODS.reviewGetDiffFileContents]: (input) =>
      authorize(session).pipe(Effect.andThen(review.getDiffFileContents(input))),

    // ── Terminal: Mend's shell beside the agent, over /api/tty (`terminals.ts`) ──
    [WS_METHODS.terminalOpen]: (input) =>
      authorize(session).pipe(Effect.andThen(hub.terminals.open(session, input))),
    [WS_METHODS.terminalAttach]: (input) =>
      Stream.unwrap(authorize(session).pipe(Effect.as(hub.terminals.attach(session, input)))),
    // Following a terminal that runs, never starting one: an attach with no `cwd` starts nothing.
    [WS_METHODS.terminalObserve]: (input) =>
      Stream.unwrap(
        authorize(session).pipe(
          Effect.as(
            hub.terminals.attach(session, {
              threadId: input.threadId,
              terminalId: input.terminalId,
            }),
          ),
        ),
      ),
    [WS_METHODS.terminalWrite]: (input) =>
      authorize(session).pipe(Effect.andThen(hub.terminals.write(input))),
    [WS_METHODS.terminalResize]: (input) =>
      authorize(session).pipe(Effect.andThen(hub.terminals.resize(input))),
    [WS_METHODS.terminalClear]: (input) =>
      authorize(session).pipe(Effect.andThen(hub.terminals.clear(input))),
    [WS_METHODS.terminalRestart]: (input) =>
      authorize(session).pipe(Effect.andThen(hub.terminals.restart(session, input))),
    [WS_METHODS.terminalClose]: (input) =>
      authorize(session).pipe(Effect.andThen(hub.terminals.close(session, input))),
    // A subscriber too slow to keep up fails typed, and t3code subscribes again.
    [WS_METHODS.subscribeTerminalEvents]: () =>
      Stream.unwrap(
        authorize(session).pipe(
          Effect.as(hub.terminals.events.pipe(Stream.mapError(() => fellBehind(TERMINAL_READ)))),
        ),
      ),
    [WS_METHODS.subscribeTerminalMetadata]: () =>
      Stream.unwrap(
        authorize(session).pipe(
          Effect.as(hub.terminals.metadata.pipe(Stream.mapError(() => fellBehind(TERMINAL_READ)))),
        ),
      ),

    // ── Preview ─────────────────────────────────────────────────────────────
    [WS_METHODS.previewOpen]: () => refuse(WS_METHODS.previewOpen),
    [WS_METHODS.previewNavigate]: () => refuse(WS_METHODS.previewNavigate),
    [WS_METHODS.previewResize]: () => refuse(WS_METHODS.previewResize),
    [WS_METHODS.previewRefresh]: () => refuse(WS_METHODS.previewRefresh),
    [WS_METHODS.previewClose]: () => refuse(WS_METHODS.previewClose),
    [WS_METHODS.previewList]: () => refuse(WS_METHODS.previewList),
    [WS_METHODS.previewReportStatus]: () => refuse(WS_METHODS.previewReportStatus),
    [WS_METHODS.previewAdjust]: () => refuse(WS_METHODS.previewAdjust),
    [WS_METHODS.previewClearProfile]: () => refuse(WS_METHODS.previewClearProfile),
    [WS_METHODS.previewReportProfiles]: () => refuse(WS_METHODS.previewReportProfiles),
    [WS_METHODS.subscribePreviewEvents]: () => Stream.never,
    [WS_METHODS.subscribeDiscoveredLocalServers]: () => Stream.never,

    // ── Devices ─────────────────────────────────────────────────────────────
    [WS_METHODS.deviceConfigure]: () => refuse(WS_METHODS.deviceConfigure),
    [WS_METHODS.deviceList]: () => refuse(WS_METHODS.deviceList),
    [WS_METHODS.deviceTestHost]: () => refuse(WS_METHODS.deviceTestHost),
    [WS_METHODS.deviceEasAccount]: () => refuse(WS_METHODS.deviceEasAccount),
    [WS_METHODS.deviceOpen]: () => refuse(WS_METHODS.deviceOpen),
    [WS_METHODS.deviceClose]: () => refuse(WS_METHODS.deviceClose),
    [WS_METHODS.deviceShutdown]: () => refuse(WS_METHODS.deviceShutdown),
    [WS_METHODS.deviceDetail]: () => refuse(WS_METHODS.deviceDetail),
    [WS_METHODS.deviceAction]: () => refuse(WS_METHODS.deviceAction),
    [WS_METHODS.subscribeDeviceState]: () =>
      authorize(session).pipe(
        Effect.as(Stream.concat(Stream.make(NO_DEVICE_HUB), Stream.never)),
        Stream.unwrap,
      ),
  });
};

export type GatewayRpcHandlers = ReturnType<typeof makeGatewayRpcHandlers>;

/** One socket's handlers, for the person its ticket was issued to. */
export const gatewayRpcHandlersLayer = (
  session: BearerSession,
  hub: PersonHub,
  clientAppVersion: string | undefined,
): Layer.Layer<Rpc.ToHandler<WsRpc>, never, GatewayEnvironment | AssetUrls> =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const environment = yield* GatewayEnvironment;
      const assetUrls = yield* AssetUrls;
      return makeGatewayRpcHandlers({ environment, assetUrls, session, hub, clientAppVersion });
    }),
  );
