import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { MendDeviceRefused, type MendClient } from "./mend-client.ts";

/**
 * The one way a person's hub (and their sockets) reach Mend with a device token. Every call that
 * carries a token goes through `gateDeviceCalls`: when Mend answers 401 (`MendDeviceRefused`: the
 * device was revoked or its person deactivated), the token is refused, which closes its sockets
 * and revokes its bearers, whatever path made the call. A 403 is not a revocation in Mend: it is
 * `SessionNotSteerable` (the person may not steer that session) and stays the command's refusal.
 *
 * `GatedMend` is nominal (a private field), and only `gateDeviceCalls` builds one, so a hub cannot
 * be handed Mend's raw client.
 */

/** Mend's client minus pairing, which carries no device token. */
export type DeviceCalls = Omit<MendClient["Service"], "claimPairing">;

class GatedMendClient {
  readonly #gated = true;
  readonly checkDevice: DeviceCalls["checkDevice"];
  readonly listHarnessModels: DeviceCalls["listHarnessModels"];
  readonly listProjects: DeviceCalls["listProjects"];
  readonly projectDetail: DeviceCalls["projectDetail"];
  readonly listTurns: DeviceCalls["listTurns"];
  readonly listItems: DeviceCalls["listItems"];
  readonly listRequests: DeviceCalls["listRequests"];
  readonly sessionDetail: DeviceCalls["sessionDetail"];
  readonly listActiveSessions: DeviceCalls["listActiveSessions"];
  readonly conversationWait: DeviceCalls["conversationWait"];
  readonly workspaceRetirement: DeviceCalls["workspaceRetirement"];
  readonly changeDiff: DeviceCalls["changeDiff"];
  readonly worktreeNames: DeviceCalls["worktreeNames"];
  readonly projectFiles: DeviceCalls["projectFiles"];
  readonly changeStats: DeviceCalls["changeStats"];
  readonly createSession: DeviceCalls["createSession"];
  readonly joinWorktree: DeviceCalls["joinWorktree"];
  readonly labelSession: DeviceCalls["labelSession"];
  readonly stopSession: DeviceCalls["stopSession"];
  readonly removeSession: DeviceCalls["removeSession"];
  readonly pasteImage: DeviceCalls["pasteImage"];
  readonly submitTurn: DeviceCalls["submitTurn"];
  readonly launchProtocol: DeviceCalls["launchProtocol"];
  readonly interruptTurn: DeviceCalls["interruptTurn"];
  readonly respondRequest: DeviceCalls["respondRequest"];
  readonly events: DeviceCalls["events"];

  constructor(calls: DeviceCalls) {
    this.checkDevice = calls.checkDevice;
    this.listHarnessModels = calls.listHarnessModels;
    this.listProjects = calls.listProjects;
    this.projectDetail = calls.projectDetail;
    this.listTurns = calls.listTurns;
    this.listItems = calls.listItems;
    this.listRequests = calls.listRequests;
    this.sessionDetail = calls.sessionDetail;
    this.listActiveSessions = calls.listActiveSessions;
    this.conversationWait = calls.conversationWait;
    this.workspaceRetirement = calls.workspaceRetirement;
    this.changeDiff = calls.changeDiff;
    this.worktreeNames = calls.worktreeNames;
    this.projectFiles = calls.projectFiles;
    this.changeStats = calls.changeStats;
    this.createSession = calls.createSession;
    this.joinWorktree = calls.joinWorktree;
    this.labelSession = calls.labelSession;
    this.stopSession = calls.stopSession;
    this.removeSession = calls.removeSession;
    this.pasteImage = calls.pasteImage;
    this.submitTurn = calls.submitTurn;
    this.launchProtocol = calls.launchProtocol;
    this.interruptTurn = calls.interruptTurn;
    this.respondRequest = calls.respondRequest;
    this.events = calls.events;
  }

  /** Whether this client came through the gate; always true, for tests. */
  get gated(): boolean {
    return this.#gated;
  }
}

export type GatedMend = GatedMendClient;

/** Wraps every token-carrying call of Mend's client so a refused token is reported once seen. */
export const gateDeviceCalls = (
  mend: MendClient["Service"],
  onRefused: (token: string) => Effect.Effect<void>,
): GatedMend => {
  const guard = <A, E>(token: string, call: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    call.pipe(
      Effect.tapError((error) =>
        error instanceof MendDeviceRefused ? onRefused(token) : Effect.void,
      ),
    );

  return new GatedMendClient({
    checkDevice: (token) =>
      mend
        .checkDevice(token)
        .pipe(Effect.tap((verdict) => (verdict === "refused" ? onRefused(token) : Effect.void))),
    listHarnessModels: (token) => guard(token, mend.listHarnessModels(token)),
    listProjects: (token) => guard(token, mend.listProjects(token)),
    projectDetail: (token, projectId) => guard(token, mend.projectDetail(token, projectId)),
    listTurns: (token, sessionId) => guard(token, mend.listTurns(token, sessionId)),
    listItems: (token, sessionId, after, limit) =>
      guard(token, mend.listItems(token, sessionId, after, limit)),
    listRequests: (token, sessionId) => guard(token, mend.listRequests(token, sessionId)),
    sessionDetail: (token, sessionId) => guard(token, mend.sessionDetail(token, sessionId)),
    listActiveSessions: (token) => guard(token, mend.listActiveSessions(token)),
    conversationWait: (token, sessionId) => guard(token, mend.conversationWait(token, sessionId)),
    workspaceRetirement: (token, sessionId) =>
      guard(token, mend.workspaceRetirement(token, sessionId)),
    changeDiff: (token, changeId) => guard(token, mend.changeDiff(token, changeId)),
    worktreeNames: (token, projectId) => guard(token, mend.worktreeNames(token, projectId)),
    changeStats: (token, changeId) => guard(token, mend.changeStats(token, changeId)),
    projectFiles: (token, projectId, sessionId) =>
      guard(token, mend.projectFiles(token, projectId, sessionId)),
    submitTurn: (token, sessionId, input) => guard(token, mend.submitTurn(token, sessionId, input)),
    createSession: (token, projectId, input) =>
      guard(token, mend.createSession(token, projectId, input)),
    joinWorktree: (token, worktreeId, input) =>
      guard(token, mend.joinWorktree(token, worktreeId, input)),
    labelSession: (token, sessionId, label) =>
      guard(token, mend.labelSession(token, sessionId, label)),
    stopSession: (token, sessionId) => guard(token, mend.stopSession(token, sessionId)),
    removeSession: (token, sessionId) => guard(token, mend.removeSession(token, sessionId)),
    pasteImage: (token, sessionId, bytes) => guard(token, mend.pasteImage(token, sessionId, bytes)),
    launchProtocol: (token, sessionId, prompt, options) =>
      guard(token, mend.launchProtocol(token, sessionId, prompt, options)),
    interruptTurn: (token, turnId) => guard(token, mend.interruptTurn(token, turnId)),
    respondRequest: (token, requestId, response) =>
      guard(token, mend.respondRequest(token, requestId, response)),
    events: (token) =>
      mend
        .events(token)
        .pipe(
          Stream.tapError((error) =>
            error instanceof MendDeviceRefused ? onRefused(token) : Effect.void,
          ),
        ),
  });
};
