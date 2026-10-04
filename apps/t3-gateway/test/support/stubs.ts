import { AuthSessionId } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BEARER_TTL_MS, GRANTED_SCOPES } from "../../src/auth.ts";
import { gateDeviceCalls } from "../../src/device-gate.ts";
import type { PersonHub } from "../../src/hub.ts";
import { MendUnavailable, type MendClient } from "../../src/mend-client.ts";
import { EMPTY_SHELL_SNAPSHOT } from "../../src/shell.ts";
import type { BearerSession } from "../../src/state.ts";
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
  events: () =>
    Stream.fail(new MendUnavailable({ operation: "GET /api/events", status: null, cause: null })),
};

/** A hub with nothing in it. */
export const emptyHub: PersonHub = {
  shellSnapshot: Effect.succeed(EMPTY_SHELL_SNAPSHOT),
  subscribeShell: Effect.succeed({ snapshot: EMPTY_SHELL_SNAPSHOT, changes: Stream.never }),
  isRefused: () => false,
  refusal: () => Effect.never,
  mend: gateDeviceCalls(unreachableMend, () => Effect.void),
  threadSnapshot: () => Effect.succeed(null),
  subscribeThread: () => Effect.succeed(null),
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
