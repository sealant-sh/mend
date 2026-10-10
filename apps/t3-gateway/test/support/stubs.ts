import { AuthSessionId } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BEARER_TTL_MS, GRANTED_SCOPES } from "../../src/auth.ts";
import { gateDeviceCalls } from "../../src/device-gate.ts";
import { ThreadCommandRefused, type PersonHub } from "../../src/hub.ts";
import { MendUnavailable, type MendClient } from "../../src/mend-client.ts";
import { EMPTY_SHELL_SNAPSHOT } from "../../src/shell.ts";
import type { BearerSession } from "../../src/state.ts";
import { makeTerminals } from "../../src/terminals.ts";
import { PERSON } from "./gateway.ts";

/** Stand-ins for handler tests that never reach Mend. */

const unavailable = (operation: string) =>
  Effect.fail(new MendUnavailable({ operation, status: null, cause: null }));

/** A Mend that answers nothing but an empty model catalog. */
export const unreachableMend: MendClient["Service"] = {
  claimPairing: () => unavailable("POST /api/pair"),
  checkDevice: () => Effect.succeed("accepted"),
  listHarnessModels: () => Effect.succeed([]),
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
  worktreeNames: () => unavailable("GET /api/projects/:id/worktrees"),
  projectFiles: () => unavailable("GET /api/projects/:id/files"),
  changeStats: () => unavailable("GET /api/changes/:id/stats"),
  worktreeCheckpoints: () => unavailable("GET /api/worktrees/:id"),
  worktreeDiff: () => unavailable("GET /api/worktrees/:id/diff"),
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
  persistImages: () => refused,
  imageOf: () => null,
  refusal: () => Effect.never,
  mend: gateDeviceCalls(unreachableMend, () => Effect.void),
  threadSnapshot: () => Effect.succeed(null),
  subscribeThread: () => Effect.succeed(null),
  changeOfWorktree: () => Effect.succeed(null),
  locationOf: () => Effect.succeed(null),
  turnDiff: () => refused,
  commands: {
    send: () => refused,
    interrupt: () => refused,
    cancelQueued: () => refused,
    resumeQueue: () => refused,
    editQueued: () => refused,
    reorderQueued: () => refused,
    respond: () => refused,
    launch: () => refused,
    rename: () => refused,
    stop: () => refused,
    remove: () => refused,
    setNextMode: () => refused,
    setArchived: () => refused,
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
