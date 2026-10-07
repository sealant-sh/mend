/**
 * Who speaks over the session channel in a person-layout executor (docs/adr/0016, decision 4).
 * Every process Mend starts there carries its person's own session token; the workspace's own
 * token is sealantd's, for saving the workspace's work, and git and the `mend` helper refuse it.
 */
import { Effect } from "effect";

import type { SessionCaptureApi } from "./capture-channel.ts";
import type { SessionSocketApi } from "./session-socket.ts";

/** Git or a helper route asked with the workspace's own token in a person executor. */
export const CONTAINER_TOKEN_REFUSED =
  "this workspace runs each person as their own user: git and the mend helper work from a process Mend started for a person, and the workspace's own token only saves its work";

/** A person's token for a session that is not live in the launch the token belongs to. */
export const CHANNEL_NOT_LIVE_HERE = "session channel: this session is not live in this workspace";

/**
 * A person's token for their session before its process starts in that launch's executor: only
 * their own pickups are answered (docs/adr/0016, Delivery 15).
 */
export const CHANNEL_NOT_STARTED_HERE =
  "session channel: this session's process has not started in this workspace yet; only its person's deliveries are answered";

/** A person's token for a session they may not steer. */
export const CHANNEL_MAY_NOT_ACT =
  "session channel: only the session's owner acts on this session; the owner can turn on shared control";

/** A person's token anywhere but a person executor: no such token is ever issued there. */
export const CHANNEL_TOKEN_NOT_ACCEPTED = "session channel: the session token was not accepted";

/** A command from someone other than the session's owner (docs/adr/0013). */
export const CHANNEL_OWNER_RUNS =
  "only the session owner runs commands in its workspace, even while control is shared";

/**
 * What the workspace's own token reaches in a person executor: the capture routes of its launch
 * and the pickups of its launch (every workspace write and every person's identity arrives
 * through one; a ticket carries its own binding), and nothing else. Every other route answers
 * with why.
 */
export const containerTokenRefused = (
  capture: SessionCaptureApi | undefined,
  pickup: SessionSocketApi["pickup"],
): SessionSocketApi => {
  const refused = () => Effect.die(new Error(CONTAINER_TOKEN_REFUSED));
  return {
    capture,
    pickup,
    recipes: refused,
    listServices: refused,
    runServiceRecipe: refused,
    runService: refused,
    addService: refused,
    stopService: refused,
    restartService: refused,
    stopSession: refused,
    land: refused,
    listRepositories: refused,
    addableProjects: refused,
    addRepository: refused,
    gitTransport: refused,
    gitTransportDone: () => Effect.void,
  };
};

/**
 * What a person's token reaches for a session of theirs whose process has not started in the
 * token's launch yet (docs/adr/0016, Delivery 15): the pickups bound to that person and that
 * launch, which carry their own deliveries into their home before their first process starts, and
 * nothing else.
 */
export const pickupOnly = (pickup: SessionSocketApi["pickup"]): SessionSocketApi => {
  const refused = () => Effect.die(new Error(CHANNEL_NOT_STARTED_HERE));
  return {
    capture: undefined,
    pickup,
    recipes: refused,
    listServices: refused,
    runServiceRecipe: refused,
    runService: refused,
    addService: refused,
    stopService: refused,
    restartService: refused,
    stopSession: refused,
    land: refused,
    listRepositories: refused,
    addableProjects: refused,
    addRepository: refused,
    gitTransport: refused,
    gitTransportDone: () => Effect.void,
  };
};
