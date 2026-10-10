import {
  AssetCreateUrlInput,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceMutation,
  RpcScopeAuthorization,
  ServerSettingsPatch,
  WS_METHODS,
  authScopeRequiredResponse,
  requiredScopesForServerSettingsPatch,
  type AuthEnvironmentScope,
  type WsRpcGroup,
} from "@mend/t3-contracts";
import {
  CLIENT_GUARDED_RPC_SCOPES,
  clientRpcRequiredScopes,
} from "@mend/t3-contracts/client-rpc-permissions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

/**
 * The scope each RPC requires, as t3code's own server declares it at the pinned tag
 * (`RPC_REQUIRED_SCOPES` in t3:apps/server/src/auth/RpcAuthorization.ts, MIT, T3 Tools Inc.).
 * t3code puts its `RpcScopeAuthorization` middleware on every method of `WsRpcGroup`; the gateway
 * serves it from this map, and a refusal names the scope from it, so neither drifts from what a
 * t3code client expects. A method the pin adds without a scope here is a type error.
 */
export type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

export const RPC_REQUIRED_SCOPES = {
  ...CLIENT_GUARDED_RPC_SCOPES,
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateProvider]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthStart]: AuthProvidersManageScope,
  [WS_METHODS.providerConsumeResetCredit]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthComplete]: AuthProvidersManageScope,
  [WS_METHODS.chatGptReconnectProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptImportProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptHandoffSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.codexAuthCallbackSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthRespond]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthLogout]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallStart]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.providerInstallRemove]: AuthProvidersManageScope,
  [WS_METHODS.serverUpdateServer]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpdateServerWithProgress]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCommitDesktopUpdate]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpsertKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverGetStorageCleanupReport]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateSettings]: AuthSettingsWriteScope,
  [WS_METHODS.serverSearchAcpRegistry]: AuthOrchestrationReadScope,
  [WS_METHODS.serverPrepareAcpRegistryAgent]: AuthProvidersManageScope,
  [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: AuthProvidersManageScope,
  [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: AuthProvidersManageScope,
  [WS_METHODS.serverListAcpRegistrySessions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverImportAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDeleteAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListAcpRegistryProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSetAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverDisableAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverLogoutAcpRegistry]: AuthProvidersManageScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetTraceDiagnostics]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetProcessDiagnostics]: AuthDiagnosticsReadScope,
  // Load-balancing new threads reads host load; that is part of operating
  // threads, not of inspecting diagnostics.
  [WS_METHODS.serverGetHostResources]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessResourceHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetResourceTelemetryHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRetryResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetUsageSummary]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRefreshUsageRates]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverSignalProcess]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.serverReportHostPowerState]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverGetBackgroundPolicy]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksList]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.secretsAnswerRequest]: AuthOrchestrationOperateScope,
  // Delivery logs hold request bodies, so they need the same scope as the URL.
  [WS_METHODS.scheduledTasksListWebhookDeliveries]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksGetWebhookDelivery]: AuthOrchestrationOperateScope,
  [WS_METHODS.cloudGetRelayClientStatus]: AuthRelayReadScope,
  [WS_METHODS.cloudInstallRelayClient]: AuthRelayWriteScope,
  [WS_METHODS.pullRequestsList]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsListStats]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSummary]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRouting]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRoutingIdentity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsStack]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLinkedThreads]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsPreview]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChecks]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsThreadComments]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDiffFileContents]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsFilesViewed]: AuthOrchestrationReadScope,
  // Read scope like the reads it un-caches: refreshing is part of reading, and a read-only
  // client pressing refresh must not be told it may not look again.
  [WS_METHODS.pullRequestsInvalidate]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsReportState]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSubscribeRefreshes]: AuthOrchestrationReadScope,
  // The candidate list is a read like the detail beside it; asking somebody for a review is a
  // write like every other one.
  [WS_METHODS.pullRequestsReviewerCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLabelCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeProjectClones]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsListEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsReadFile]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchContents]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsWriteFile]: AuthFilesystemWriteScope,
  [WS_METHODS.projectsEnsureScratch]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateNew]: AuthOrchestrationOperateScope,
  [WS_METHODS.shellOpenInEditor]: AuthOrchestrationOperateScope,
  [WS_METHODS.filesystemBrowse]: AuthFilesystemReadScope,
  [WS_METHODS.agentSessionsScan]: AuthOrchestrationReadScope,
  [WS_METHODS.agentSessionsImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.assetsPersistChatAttachments]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsCreateUploadUrl]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerUploadFeedback]: AuthOrchestrationOperateScope,
  // An app's tool calls can change things on its server, like a user action.
  [WS_METHODS.mcpAppsCallTool]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpAppsToolInfo]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsReadResource]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsUpdateModelContext]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeWorktreeSetup]: AuthOrchestrationReadScope,
  [WS_METHODS.worktreeSetupCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [WS_METHODS.reviewGetDiffPreview]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffFileContents]: AuthFilesystemReadScope,
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalObserve]: AuthTerminalReadScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalRestart]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalEvents]: AuthTerminalReadScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalReadScope,
  [WS_METHODS.previewOpen]: AuthPreviewOperateScope,
  [WS_METHODS.previewNavigate]: AuthPreviewOperateScope,
  [WS_METHODS.previewResize]: AuthPreviewOperateScope,
  [WS_METHODS.previewAdjust]: AuthPreviewOperateScope,
  [WS_METHODS.previewRefresh]: AuthPreviewOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewClearProfile]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportProfiles]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportStatus]: AuthPreviewOperateScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeDiscoveredLocalServers]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.deviceTestHost]: AuthSettingsWriteScope,
  [WS_METHODS.deviceList]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceShutdown]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeDeviceState]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeAuthAccess]: AuthAccessReadScope,
  [WS_METHODS.subscribeBackgroundPolicy]: AuthOrchestrationReadScope,
} as const satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>;

const isWsRpcMethod = (tag: string): tag is WsRpcMethod => Object.hasOwn(RPC_REQUIRED_SCOPES, tag);

const decodeAssetUrlInput = Schema.decodeUnknownOption(AssetCreateUrlInput);
const decodeSettingsUpdate = Schema.decodeUnknownOption(
  Schema.Struct({
    patch: ServerSettingsPatch,
    providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
  }),
);

/** A workspace or media file behind an asset URL is a filesystem read, as t3code rules. */
const assetUrlScopes = (payload: unknown): ReadonlyArray<AuthEnvironmentScope> =>
  Option.match(decodeAssetUrlInput(payload), {
    onNone: () => [AuthOrchestrationReadScope],
    onSome: ({ resource }) =>
      resource._tag === "workspace-file" ||
      resource._tag === "media-file" ||
      resource._tag === "draft-workspace-file"
        ? [AuthFilesystemReadScope]
        : [AuthOrchestrationReadScope],
  });

/**
 * A settings update needs the scopes its patch touches, and `providers:manage` with a provider
 * mutation; one carrying only a provider mutation needs only that (t3code's
 * `requiredScopesForSettingsUpdate`). A payload that does not decode needs `settings:write`.
 */
const settingsUpdateScopes = (payload: unknown): ReadonlyArray<AuthEnvironmentScope> =>
  Option.match(decodeSettingsUpdate(payload), {
    onNone: () => [AuthSettingsWriteScope],
    onSome: (update) => {
      const scopes = requiredScopesForServerSettingsPatch(update.patch);
      if (update.providerInstanceMutation === undefined) return scopes;
      return Object.values(update.patch).every((value) => value === undefined)
        ? [AuthProvidersManageScope]
        : [...new Set([...scopes, AuthProvidersManageScope])];
    },
  });

/**
 * The scopes one call needs, by t3code's rule at the pin (`requiredScopesForRpcCall`): the
 * methods whose scope depends on their input, then the client-guarded ones, then the map. A tag
 * outside the group (never sent by a client of the pin) needs a scope no bearer holds.
 */
export const requiredScopesFor = (
  method: string,
  payload: unknown,
): ReadonlyArray<AuthEnvironmentScope> => {
  if (!isWsRpcMethod(method)) return [AuthAccessWriteScope];
  if (method === WS_METHODS.serverRetryResourceTelemetry) {
    return [AuthEnvironmentMaintainScope, AuthDiagnosticsReadScope];
  }
  if (method === WS_METHODS.assetsCreateUrl) return assetUrlScopes(payload);
  if (method === WS_METHODS.serverUpdateSettings) return settingsUpdateScopes(payload);
  const guarded = clientRpcRequiredScopes(method, payload);
  return guarded.length > 0 ? guarded : [RPC_REQUIRED_SCOPES[method]];
};

/** t3code's refusal for a scope the token lacks, decodable by clients from before permissions. */
export const missingScope = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    ...authScopeRequiredResponse(requiredScope),
  });

/** Authorizes every RPC on one socket against the scopes its bearer was granted. */
export const rpcScopeAuthorizationLayer = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): Layer.Layer<RpcScopeAuthorization> =>
  Layer.succeed(RpcScopeAuthorization)((effect, { rpc, payload }) => {
    const lacking = requiredScopesFor(rpc._tag, payload).find((scope) => !scopes.includes(scope));
    return lacking === undefined ? effect : Effect.fail(missingScope(lacking));
  });
