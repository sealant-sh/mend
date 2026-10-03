import {
  AcpRegistryOperationError,
  AgentSessionImportProjectNotFoundError,
  AssetWorkspaceContextNotFoundError,
  AuthAccessReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  EnvironmentAuthorizationError,
  ExternalLauncherUnsupportedEditorError,
  GitManagerError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetWorkflowScriptError,
  OrchestrationSearchThreadsError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  PersistChatAttachmentsError,
  ProjectMutationError,
  ProviderSetupError,
  ProviderUploadFeedbackError,
  PullRequestOperationError,
  ScheduledTaskError,
  ServerConfig,
  ServerProviderUpdateError,
  ServerSelfUpdateError,
  ServerSettingsError,
  UsageLimitSourceError,
  VcsUnsupportedOperationError,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
  type ProviderInstanceId,
  type ThreadId,
} from "@mend/t3-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { dispatchCommand } from "./commands.ts";
import { GatewayEnvironment } from "./environment.ts";
import type { HubReadError, PersonHub } from "./hub.ts";
import { makeServerConfig, makeWelcome, providersFromMend } from "./server-config.ts";
import type { BearerSession } from "./state.ts";

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
 * - A stream for a feed of things Mend never has (terminal events, previews, devices, scheduled
 *   tasks, provider setup) stays open and never emits: there is nothing to report.
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
  WS_METHODS.serverGetConfig,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
]);

/** Streams that stay open and never emit: feeds of things Mend never has. */
export const SILENT_STREAMS: ReadonlySet<WsRpcMethod> = new Set<WsRpcMethod>([
  WS_METHODS.chatGptHandoffSubscribe,
  WS_METHODS.codexAuthCallbackSubscribe,
  WS_METHODS.providerAuthSubscribe,
  WS_METHODS.providerInstallSubscribe,
  WS_METHODS.scheduledTasksSubscribe,
  WS_METHODS.pullRequestsSubscribeRefreshes,
  WS_METHODS.subscribeProjectClones,
  WS_METHODS.subscribeWorktreeSetup,
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeTerminalMetadata,
  WS_METHODS.previewAutomationConnect,
  WS_METHODS.subscribePreviewEvents,
  WS_METHODS.subscribeDiscoveredLocalServers,
  WS_METHODS.subscribeDeviceState,
  WS_METHODS.subscribeBackgroundPolicy,
  WS_METHODS.subscribeResourceTelemetry,
]);

// ─── Refusals ────────────────────────────────────────────────────────────────

const READ = AuthOrchestrationReadScope;
const OPERATE = AuthOrchestrationOperateScope;
const TERMINAL = AuthTerminalOperateScope;

const notOfferedText = (method: string) => `Mend's t3code gateway does not offer ${method}.`;

/**
 * The refusal every method's contract allows. `requiredScope` is the scope t3code's own server
 * requires for the method (`RPC_REQUIRED_SCOPES` in t3:apps/server/src/auth/RpcAuthorization.ts);
 * no client at the pin reads it.
 */
const notOffered = (method: WsRpcMethod, requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({ message: notOfferedText(method), requiredScope });

const refuse = (method: WsRpcMethod, requiredScope: AuthEnvironmentScope) =>
  Effect.fail(notOffered(method, requiredScope));

const refuseStream = (method: WsRpcMethod, requiredScope: AuthEnvironmentScope) =>
  Stream.fail(notOffered(method, requiredScope));

const PROVIDER_SETUP_DETAIL =
  "Mend runs each harness on its person's own login. Sign in and install harnesses in Mend.";

const providerSetup = (method: WsRpcMethod, instanceId: ProviderInstanceId) =>
  Effect.fail(
    new ProviderSetupError({ instanceId, operation: method, detail: PROVIDER_SETUP_DETAIL }),
  );

const SELF_UPDATE_REASON = "The gateway updates with Mend, never from a t3code client.";

const gitManager = (method: WsRpcMethod, cwd: string) =>
  new GitManagerError({ operation: method, cwd, detail: notOfferedText(method) });

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
  /** The paired person behind this socket; every Mend call is theirs. */
  readonly session: BearerSession;
  /** The person's projection of Mend, shared with their other sockets. */
  readonly hub: PersonHub;
}

/** The orchestration read scope t3code requires for the served reads, checked as t3code does. */
const scopeCheck = (session: BearerSession, requiredScope: AuthEnvironmentScope) =>
  session.scopes.includes(requiredScope)
    ? Effect.void
    : Effect.fail(
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        }),
      );

const MODELS_SOURCE = "Mend GET /api/harnesses/models";
const encodeServerConfig = Schema.encodeEffect(Schema.toCodecJson(ServerConfig));

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

export const makeGatewayRpcHandlers = ({ environment, session, hub }: GatewayRpcInput) => {
  // Mend only through the person's gate: a 401 on any call refuses this socket's token.
  const { mend } = hub;
  const { descriptor, paths } = environment;

  /** The socket's own device token, checked on every call, then the scope it needs. */
  const authorize = (bearer: BearerSession, requiredScope: AuthEnvironmentScope) =>
    hub.isRefused(bearer.deviceToken)
      ? Effect.fail(
          new EnvironmentAuthorizationError({
            message: "Mend no longer accepts this device. Pair again from Mend.",
            requiredScope,
          }),
        )
      : scopeCheck(bearer, requiredScope);

  /**
   * The person's config. Mend's catalog is read with their device token; a revoked device
   * answers t3code's authorization error, an unreachable Mend its settings error (the client
   * retries both differently: blocked, or transient). The config is encoded here first, so a
   * mapping bug is a typed failure logged by the gateway, never a defect in the client.
   */
  const loadServerConfig = Effect.gen(function* () {
    yield* authorize(session, READ);
    const catalogs = yield* mend.listHarnessModels(session.deviceToken).pipe(
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
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const config = makeServerConfig({
      environment: descriptor,
      auth: environment.auth,
      paths,
      providers: providersFromMend(catalogs, checkedAt),
    });
    yield* encodeServerConfig(config).pipe(
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
    );
    return config;
  });

  return WsRpcGroup.of({
    // ── Served ──────────────────────────────────────────────────────────────
    [WS_METHODS.serverProbe]: () => authorize(session, READ).pipe(Effect.as({})),
    [WS_METHODS.serverGetConfig]: () => loadServerConfig,
    // A snapshot, then open: phase 0 has no provider changes to push.
    [WS_METHODS.subscribeServerConfig]: () =>
      Stream.fromEffect(
        loadServerConfig.pipe(
          Effect.map((config) => ({ version: 1 as const, type: "snapshot" as const, config })),
        ),
      ).pipe(Stream.concat(Stream.never)),
    [WS_METHODS.subscribeServerLifecycle]: () =>
      Stream.fromEffect(
        authorize(session, READ).pipe(
          Effect.as({
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: makeWelcome({ environment: descriptor, paths }),
          }),
        ),
      ).pipe(Stream.concat(Stream.never)),
    // A fresh snapshot whatever sequence the client resumes after (a snapshot is always a legal
    // reset), the catch-up marker when asked, then every change as the hub publishes it.
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* authorize(session, READ);
          const { snapshot, changes } = yield* hub.subscribeShell.pipe(
            Effect.mapError(shellReadFailure),
          );
          return Stream.make({ kind: "snapshot" as const, snapshot }).pipe(
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
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
      Effect.fail(
        new OrchestrationV2ThreadLaunchError({
          commandId: input.commandId,
          projectId: input.projectId,
          message: notOfferedText(ORCHESTRATION_V2_WS_METHODS.launchThread),
        }),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
      Effect.gen(function* () {
        yield* authorize(session, READ);
        const snapshot = yield* hub
          .threadSnapshot(input.threadId)
          .pipe(Effect.mapError(threadReadFailure(input.threadId)));
        if (snapshot === null) return yield* unknownThread(input.threadId);
        return snapshot.projection;
      }),
    // As the shell: a full snapshot whatever the client resumes after (the replay after a
    // sequence is phase 2), the marker when asked, then the thread's changes.
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* authorize(session, READ);
          const subscribed = yield* hub
            .subscribeThread(input.threadId)
            .pipe(Effect.mapError(threadReadFailure(input.threadId)));
          if (subscribed === null) return yield* unknownThread(input.threadId);
          const { snapshot, changes } = subscribed;
          return Stream.make({
            kind: "snapshot" as const,
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          }).pipe(
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
    [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: () =>
      Effect.fail(
        new OrchestrationGetTurnDiffError({
          message: notOfferedText(ORCHESTRATION_V2_WS_METHODS.getTurnDiff),
        }),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: () =>
      Effect.fail(
        new OrchestrationGetFullThreadDiffError({
          message: notOfferedText(ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff),
        }),
      ),
    [ORCHESTRATION_V2_WS_METHODS.searchThreads]: () =>
      Effect.fail(
        new OrchestrationSearchThreadsError({
          message: notOfferedText(ORCHESTRATION_V2_WS_METHODS.searchThreads),
        }),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
      Effect.fail(
        new OrchestrationV2GetShellSnapshotError({
          message: notOfferedText(ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot),
        }),
      ),
    [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: () =>
      Stream.fail(
        new OrchestrationV2GetShellSnapshotError({
          message: notOfferedText(ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell),
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

    // ── Providers: Mend's harnesses, set up in Mend ─────────────────────────
    [WS_METHODS.serverRefreshProviders]: (input) =>
      input.instanceId === undefined
        ? refuse(WS_METHODS.serverRefreshProviders, OPERATE)
        : providerSetup(WS_METHODS.serverRefreshProviders, input.instanceId),
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
    [WS_METHODS.serverUpsertKeybinding]: () => refuse(WS_METHODS.serverUpsertKeybinding, OPERATE),
    [WS_METHODS.serverRemoveKeybinding]: () => refuse(WS_METHODS.serverRemoveKeybinding, OPERATE),
    [WS_METHODS.serverGetSettings]: () => refuse(WS_METHODS.serverGetSettings, READ),
    [WS_METHODS.serverUpdateSettings]: () => refuse(WS_METHODS.serverUpdateSettings, OPERATE),
    [WS_METHODS.serverDiscoverSourceControl]: () =>
      refuse(WS_METHODS.serverDiscoverSourceControl, READ),
    [WS_METHODS.serverGetTraceDiagnostics]: () =>
      refuse(WS_METHODS.serverGetTraceDiagnostics, READ),
    [WS_METHODS.serverGetProcessDiagnostics]: () =>
      refuse(WS_METHODS.serverGetProcessDiagnostics, READ),
    [WS_METHODS.serverGetHostResources]: () => refuse(WS_METHODS.serverGetHostResources, READ),
    [WS_METHODS.serverGetProcessResourceHistory]: () =>
      refuse(WS_METHODS.serverGetProcessResourceHistory, READ),
    [WS_METHODS.serverGetResourceTelemetryHistory]: () =>
      refuse(WS_METHODS.serverGetResourceTelemetryHistory, READ),
    [WS_METHODS.serverRetryResourceTelemetry]: () =>
      refuse(WS_METHODS.serverRetryResourceTelemetry, OPERATE),
    [WS_METHODS.serverGetUsageSummary]: () => refuse(WS_METHODS.serverGetUsageSummary, READ),
    [WS_METHODS.serverRefreshUsageRates]: () => refuse(WS_METHODS.serverRefreshUsageRates, READ),
    [WS_METHODS.serverSignalProcess]: () => refuse(WS_METHODS.serverSignalProcess, OPERATE),
    [WS_METHODS.serverReportClientActivity]: () =>
      refuse(WS_METHODS.serverReportClientActivity, READ),
    [WS_METHODS.serverReportHostPowerState]: () =>
      refuse(WS_METHODS.serverReportHostPowerState, OPERATE),
    [WS_METHODS.serverGetBackgroundPolicy]: () =>
      refuse(WS_METHODS.serverGetBackgroundPolicy, READ),
    [WS_METHODS.subscribeBackgroundPolicy]: () => Stream.never,
    [WS_METHODS.subscribeResourceTelemetry]: () => Stream.never,
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
      refuse(WS_METHODS.serverAcceptAcpRegistryUrlAuth, OPERATE),
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
    [WS_METHODS.scheduledTasksSubscribe]: () => Stream.never,

    // ── T3 Connect relay ────────────────────────────────────────────────────
    [WS_METHODS.cloudGetRelayClientStatus]: () =>
      refuse(WS_METHODS.cloudGetRelayClientStatus, AuthRelayReadScope),
    [WS_METHODS.cloudInstallRelayClient]: () =>
      refuseStream(WS_METHODS.cloudInstallRelayClient, AuthRelayWriteScope),

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
      refuse(WS_METHODS.sourceControlLookupRepository, READ),
    [WS_METHODS.sourceControlCloneRepository]: () =>
      refuse(WS_METHODS.sourceControlCloneRepository, OPERATE),
    [WS_METHODS.sourceControlPublishRepository]: () =>
      refuse(WS_METHODS.sourceControlPublishRepository, OPERATE),
    [WS_METHODS.projectCloneStart]: () =>
      Effect.fail(
        new OrchestrationDispatchCommandError({
          message: notOfferedText(WS_METHODS.projectCloneStart),
        }),
      ),
    [WS_METHODS.projectCloneCancel]: () => refuse(WS_METHODS.projectCloneCancel, OPERATE),
    [WS_METHODS.projectCloneRetry]: () => refuse(WS_METHODS.projectCloneRetry, OPERATE),
    [WS_METHODS.subscribeProjectClones]: () => Stream.never,

    // ── Projects and files ──────────────────────────────────────────────────
    [WS_METHODS.projectsListEntries]: () => refuse(WS_METHODS.projectsListEntries, READ),
    [WS_METHODS.projectsReadFile]: () => refuse(WS_METHODS.projectsReadFile, READ),
    [WS_METHODS.projectsSearchContents]: () => refuse(WS_METHODS.projectsSearchContents, READ),
    [WS_METHODS.projectsSearchEntries]: () => refuse(WS_METHODS.projectsSearchEntries, READ),
    [WS_METHODS.projectsWriteFile]: () => refuse(WS_METHODS.projectsWriteFile, OPERATE),
    [WS_METHODS.projectsEnsureScratch]: () =>
      Effect.fail(
        new OrchestrationDispatchCommandError({
          message: notOfferedText(WS_METHODS.projectsEnsureScratch),
        }),
      ),
    [WS_METHODS.projectsCreateNew]: () =>
      Effect.fail(
        new OrchestrationDispatchCommandError({
          message: notOfferedText(WS_METHODS.projectsCreateNew),
        }),
      ),
    // Projects are adopted into Mend's store from Mend, never created or edited here.
    [WS_METHODS.projectsMutate]: (mutation) =>
      Effect.fail(
        new ProjectMutationError({
          commandId: mutation.commandId,
          message: "Projects are adopted and edited in Mend.",
        }),
      ),
    // Nothing opens on the machine Mend runs on.
    [WS_METHODS.shellOpenInEditor]: (input) =>
      Effect.fail(new ExternalLauncherUnsupportedEditorError({ editor: input.editor })),
    [WS_METHODS.filesystemBrowse]: () => refuse(WS_METHODS.filesystemBrowse, READ),
    [WS_METHODS.agentSessionsScan]: () => refuse(WS_METHODS.agentSessionsScan, READ),
    [WS_METHODS.agentSessionsImport]: (input) =>
      Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
    [WS_METHODS.assetsCreateUrl]: (input) =>
      Effect.fail(new AssetWorkspaceContextNotFoundError({ resource: input.resource })),
    [WS_METHODS.assetsPersistChatAttachments]: () =>
      Effect.fail(
        new PersistChatAttachmentsError({
          message: notOfferedText(WS_METHODS.assetsPersistChatAttachments),
        }),
      ),
    [WS_METHODS.attachmentsCreateUploadUrl]: () =>
      refuse(WS_METHODS.attachmentsCreateUploadUrl, OPERATE),
    [WS_METHODS.attachmentsDelete]: () => refuse(WS_METHODS.attachmentsDelete, OPERATE),

    // ── VCS and git ─────────────────────────────────────────────────────────
    [WS_METHODS.subscribeVcsStatus]: (input) =>
      Stream.fail(gitManager(WS_METHODS.subscribeVcsStatus, input.cwd)),
    [WS_METHODS.vcsRefreshStatus]: (input) =>
      Effect.fail(gitManager(WS_METHODS.vcsRefreshStatus, input.cwd)),
    [WS_METHODS.gitRunStackedAction]: (input) =>
      Stream.fail(gitManager(WS_METHODS.gitRunStackedAction, input.cwd)),
    [WS_METHODS.gitResolvePullRequest]: (input) =>
      Effect.fail(gitManager(WS_METHODS.gitResolvePullRequest, input.cwd)),
    [WS_METHODS.gitPreparePullRequestThread]: (input) =>
      Effect.fail(gitManager(WS_METHODS.gitPreparePullRequestThread, input.cwd)),
    [WS_METHODS.vcsPull]: () => refuse(WS_METHODS.vcsPull, OPERATE),
    [WS_METHODS.vcsListRefs]: () => refuse(WS_METHODS.vcsListRefs, READ),
    [WS_METHODS.vcsCreateWorktree]: () => refuse(WS_METHODS.vcsCreateWorktree, OPERATE),
    [WS_METHODS.vcsRemoveWorktree]: () => refuse(WS_METHODS.vcsRemoveWorktree, OPERATE),
    [WS_METHODS.vcsCreateRef]: () => refuse(WS_METHODS.vcsCreateRef, OPERATE),
    [WS_METHODS.vcsSwitchRef]: () => refuse(WS_METHODS.vcsSwitchRef, OPERATE),
    [WS_METHODS.vcsInit]: () => vcsUnsupported(WS_METHODS.vcsInit),
    [WS_METHODS.subscribeWorktreeSetup]: () => Stream.never,
    [WS_METHODS.worktreeSetupCancel]: () => refuse(WS_METHODS.worktreeSetupCancel, OPERATE),

    // ── Review (phase 1) ────────────────────────────────────────────────────
    [WS_METHODS.reviewGetDiffPreview]: () => vcsUnsupported(WS_METHODS.reviewGetDiffPreview),
    [WS_METHODS.reviewGetDiffFileContents]: () =>
      vcsUnsupported(WS_METHODS.reviewGetDiffFileContents),

    // ── Terminal (phase 3, over Mend's /api/tty) ────────────────────────────
    [WS_METHODS.terminalOpen]: () => refuse(WS_METHODS.terminalOpen, TERMINAL),
    [WS_METHODS.terminalAttach]: () => refuseStream(WS_METHODS.terminalAttach, TERMINAL),
    [WS_METHODS.terminalWrite]: () => refuse(WS_METHODS.terminalWrite, TERMINAL),
    [WS_METHODS.terminalResize]: () => refuse(WS_METHODS.terminalResize, TERMINAL),
    [WS_METHODS.terminalClear]: () => refuse(WS_METHODS.terminalClear, TERMINAL),
    [WS_METHODS.terminalRestart]: () => refuse(WS_METHODS.terminalRestart, TERMINAL),
    [WS_METHODS.terminalClose]: () => refuse(WS_METHODS.terminalClose, TERMINAL),
    [WS_METHODS.subscribeTerminalEvents]: () => Stream.never,
    [WS_METHODS.subscribeTerminalMetadata]: () => Stream.never,

    // ── Preview ─────────────────────────────────────────────────────────────
    [WS_METHODS.previewOpen]: () => refuse(WS_METHODS.previewOpen, OPERATE),
    [WS_METHODS.previewNavigate]: () => refuse(WS_METHODS.previewNavigate, OPERATE),
    [WS_METHODS.previewResize]: () => refuse(WS_METHODS.previewResize, OPERATE),
    [WS_METHODS.previewRefresh]: () => refuse(WS_METHODS.previewRefresh, OPERATE),
    [WS_METHODS.previewClose]: () => refuse(WS_METHODS.previewClose, OPERATE),
    [WS_METHODS.previewList]: () => refuse(WS_METHODS.previewList, READ),
    [WS_METHODS.previewReportStatus]: () => refuse(WS_METHODS.previewReportStatus, OPERATE),
    // A desktop offering itself as a browser host: the host is never asked for anything.
    [WS_METHODS.previewAutomationConnect]: () => Stream.never,
    [WS_METHODS.previewAutomationRespond]: () =>
      refuse(WS_METHODS.previewAutomationRespond, OPERATE),
    [WS_METHODS.previewAutomationFocusHost]: () =>
      refuse(WS_METHODS.previewAutomationFocusHost, OPERATE),
    [WS_METHODS.subscribePreviewEvents]: () => Stream.never,
    [WS_METHODS.subscribeDiscoveredLocalServers]: () => Stream.never,

    // ── Devices ─────────────────────────────────────────────────────────────
    [WS_METHODS.deviceConfigure]: () => refuse(WS_METHODS.deviceConfigure, OPERATE),
    [WS_METHODS.deviceList]: () => refuse(WS_METHODS.deviceList, READ),
    [WS_METHODS.deviceTestHost]: () => refuse(WS_METHODS.deviceTestHost, OPERATE),
    [WS_METHODS.deviceOpen]: () => refuse(WS_METHODS.deviceOpen, OPERATE),
    [WS_METHODS.deviceClose]: () => refuse(WS_METHODS.deviceClose, OPERATE),
    [WS_METHODS.deviceShutdown]: () => refuse(WS_METHODS.deviceShutdown, OPERATE),
    [WS_METHODS.deviceDetail]: () => refuse(WS_METHODS.deviceDetail, READ),
    [WS_METHODS.deviceAction]: () => refuse(WS_METHODS.deviceAction, OPERATE),
    [WS_METHODS.subscribeDeviceState]: () => Stream.never,
  });
};

export type GatewayRpcHandlers = ReturnType<typeof makeGatewayRpcHandlers>;

/** One socket's handlers, for the person its ticket was issued to. */
export const gatewayRpcHandlersLayer = (
  session: BearerSession,
  hub: PersonHub,
): Layer.Layer<Rpc.ToHandler<WsRpc>, never, GatewayEnvironment> =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const environment = yield* GatewayEnvironment;
      return makeGatewayRpcHandlers({ environment, session, hub });
    }),
  );
