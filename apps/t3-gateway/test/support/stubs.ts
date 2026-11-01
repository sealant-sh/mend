import { AuthSessionId } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BEARER_TTL_MS, GRANTED_SCOPES } from "../../src/auth.ts";
import { gateDeviceCalls } from "../../src/device-gate.ts";
import { ThreadCommandRefused, type PersonHub } from "../../src/hub.ts";
import {
  MendUnavailable,
  MendRawFileUnavailable,
  MendProofMediaUnavailable,
  MendPageUnavailable,
  type MendClient,
} from "../../src/mend-client.ts";
import { NO_MODEL_PREFERENCES, settingsWith } from "../../src/model-preferences.ts";
import { RemovalKept } from "../../src/removal.ts";
import { EMPTY_SHELL_SNAPSHOT } from "../../src/shell.ts";
import type { BearerSession } from "../../src/state.ts";
import { makeTerminals } from "../../src/terminals.ts";
import { makeThreadFinder } from "../../src/thread-find.ts";
import { inlineFindParser } from "./find-parser.ts";
import { PERSON } from "./gateway.ts";

/** Stand-ins for handler tests that never reach Mend. */

const unavailable = (operation: string) =>
  Effect.fail(new MendUnavailable({ operation, status: null, cause: null }));

/** A Mend that answers nothing but an empty model catalog. */
export const unreachableMend: MendClient["Service"] = {
  claimPairing: () => unavailable("POST /api/pair"),
  checkDevice: () => Effect.succeed("accepted"),
  connectedAccounts: () => Effect.succeed([]),
  listHarnessModels: () => Effect.succeed([]),
  createProject: () => unavailable("POST /api/projects/new"),
  ensureScratchProject: () => unavailable("POST /api/projects/scratch"),
  listProjects: () => unavailable("GET /api/projects"),
  projectDetail: () => unavailable("GET /api/projects/:id"),
  listTurns: () => unavailable("GET /api/sessions/:id/turns"),
  listItems: () => unavailable("GET /api/sessions/:id/items"),
  listRequests: () => unavailable("GET /api/sessions/:id/requests"),
  sessionDetail: () => unavailable("GET /api/sessions/:id"),
  listActiveSessions: () => unavailable("GET /api/sessions"),
  conversationWait: () => unavailable("GET /api/sessions/:id/waiting"),
  workspaceRetirement: () => unavailable("GET /api/sessions/:id/workspace-retirement"),
  changeDiff: () => unavailable("GET /api/changes/:id/diff"),
  projectBranches: () => unavailable("GET /api/projects/:id/branches"),
  refreshProject: () => unavailable("POST /api/projects/:id/refresh"),
  listWorktrees: () => unavailable("GET /api/projects/:id/worktrees"),
  removeWorktree: () => unavailable("DELETE /api/worktrees/:id"),
  removeProject: () => unavailable("DELETE /api/projects/:id"),
  projectFiles: () => unavailable("GET /api/projects/:id/files"),
  listSkills: () => unavailable("GET /api/skills"),
  projectSkills: () => unavailable("GET /api/projects/:id/skills"),
  changeStats: () => unavailable("GET /api/changes/:id/stats"),
  changeLandings: () => unavailable("GET /api/changes/:id/landings"),
  land: () => unavailable("POST /api/sessions/:id/land"),
  refreshLanding: () => unavailable("POST /api/landings/:id/refresh"),
  worktreeCheckpoints: () => unavailable("GET /api/worktrees/:id"),
  worktreeDiff: () => unavailable("GET /api/worktrees/:id/diff"),
  openRawFile: () => Effect.fail(new MendRawFileUnavailable({ status: null })),
  openProofMedia: () => Effect.fail(new MendProofMediaUnavailable({ status: null })),
  pageFrame: () => Effect.fail(new MendPageUnavailable({ status: null })),
  openPage: () => Effect.fail(new MendPageUnavailable({ status: null })),
  worktreeContents: () => unavailable("GET /api/worktrees/:id/contents"),
  createSession: () => unavailable("POST /api/projects/:id/sessions"),
  joinWorktree: () => unavailable("POST /api/worktrees/:id/sessions"),
  labelSession: () => unavailable("POST /api/sessions/:id/label"),
  stopSession: () => unavailable("POST /api/sessions/:id/stop"),
  removeSession: () => unavailable("DELETE /api/sessions/:id"),
  pasteImage: () => unavailable("POST /api/sessions/:id/images"),
  openShell: () => unavailable("POST /api/sessions/:id/shell"),
  stopShell: () => unavailable("POST /api/processes/:id/stop"),
  ttyTicket: () => unavailable("POST /api/upgrade-tickets"),
  submitTurn: () => unavailable("POST /api/sessions/:id/turns"),
  launchProtocol: () => unavailable("POST /api/sessions/:id/launch"),
  steerTurn: () => unavailable("POST /api/turns/:id/steer"),
  interruptTurn: () => unavailable("POST /api/turns/:id/interrupt"),
  respondRequest: () => unavailable("POST /api/requests/:id/respond"),
  events: () =>
    Stream.fail(new MendUnavailable({ operation: "GET /api/events", status: null, cause: null })),
};

const refused = Effect.fail(
  new ThreadCommandRefused({ reason: "The empty hub has no threads.", authorization: false }),
);

/** A hub with nothing in it. */
export const emptyHub: PersonHub = {
  createProject: () => refused,
  shellSnapshot: Effect.succeed(EMPTY_SHELL_SNAPSHOT),
  subscribeShell: () =>
    Effect.succeed({
      start: { kind: "snapshot", snapshot: EMPTY_SHELL_SNAPSHOT },
      changes: Stream.never,
    }),
  isRefused: () => false,
  archivedShell: Effect.succeed({
    schemaVersion: EMPTY_SHELL_SNAPSHOT.schemaVersion,
    snapshotSequence: 0,
    projects: [],
    threads: [],
  }),
  providerChanges: Effect.succeed(Stream.never),
  refreshSkillsAt: () => Effect.succeed(null),
  workspaceSkills: () => [],
  worktreeFileOf: () => Effect.succeed(null),
  settings: () => Effect.succeed({ version: 0, settings: settingsWith(NO_MODEL_PREFERENCES) }),
  updateModelPreferences: () => Effect.succeed(settingsWith(NO_MODEL_PREFERENCES)),
  subscribeSettings: () =>
    Effect.succeed(
      Stream.make({ version: 0, settings: settingsWith(NO_MODEL_PREFERENCES) }).pipe(
        Stream.concat(Stream.never),
      ),
    ),
  subscribeArchivedShell: Effect.succeed({
    snapshot: {
      schemaVersion: EMPTY_SHELL_SNAPSHOT.schemaVersion,
      snapshotSequence: 0,
      projects: [],
      threads: [],
    },
    changes: Stream.never,
  }),
  terminals: makeTerminals({
    mend: gateDeviceCalls(unreachableMend, () => Effect.void),
    mendUrl: new URL("http://127.0.0.1:0"),
    threadSession: () => Effect.succeed(null),
  }),
  worktreeSetups: {
    stream: () => Stream.make(null).pipe(Stream.concat(Stream.never)),
    cancel: () => Effect.succeed(false),
  },
  saveProjectScripts: () => refused,
  persistImages: () => refused,
  imageOf: () => null,
  refusal: () => Effect.never,
  mend: gateDeviceCalls(unreachableMend, () => Effect.void),
  threadSnapshot: () => Effect.succeed(null),
  threadFinder: makeThreadFinder(inlineFindParser),
  subscribeThread: () => Effect.succeed(null),
  changeOfWorktree: () => Effect.succeed(null),
  locationOf: () => Effect.succeed(null),
  removeWorktree: () => Effect.fail(new RemovalKept({ reason: "The empty hub has no worktrees." })),
  removeProject: () => Effect.fail(new RemovalKept({ reason: "The empty hub has no projects." })),
  turnDiff: () => refused,
  commands: {
    send: () => refused,
    promote: () => refused,
    interrupt: () => refused,
    cancelQueued: () => refused,
    resumeQueue: () => refused,
    startQueued: () => refused,
    editQueued: () => refused,
    reorderQueued: () => refused,
    respond: () => refused,
    launch: () => refused,
    retryPreparation: () => refused,
    rename: () => refused,
    stop: () => refused,
    remove: () => refused,
    setNextMode: () => refused,
    setNextSelection: () => refused,
    setArchived: () => refused,
    setLifecycle: () => refused,
    setVisited: () => refused,
  },
};

export const testBearerSession: BearerSession = {
  sessionId: AuthSessionId.make("session-1"),
  tokenHash: "hash",
  deviceToken: "mdt_test",
  mendUser: PERSON,
  mendDeviceId: "device-1",
  scopes: GRANTED_SCOPES,
  client: { label: null, deviceType: "desktop", os: null },
  issuedAt: 0,
  expiresAt: BEARER_TTL_MS,
  revokedAt: null,
};
