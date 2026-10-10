// Who owns the stack on a Docker daemon, and when a watchdog may take it down. Docker, the clock and
// the supervisor's liveness are passed in, so every case here is tested without a daemon
// (lifecycle.test.mjs) and the processes that use it are tested against a fake one
// (lifecycle.e2e.test.mjs).
//
// A start claims the daemon with a container named OWNER_CONTAINER, labelled with a claim id made
// for that start alone. Docker keeps container names unique, so one claim exists at a time, and
// the label says whose it is. A watchdog only ever takes down the stack whose current owner
// carries its own claim id: a refused start's watchdog, or one left from an earlier start, finds
// another id and leaves that stack alone.

import { OWNER_CONTAINER, STACK_LABEL } from "./lib.mjs";

/** The label that names the start a claim belongs to. */
export const CLAIM_LABEL = `${STACK_LABEL}.claim`;

/**
 * The daemon's current claim: `{ state: "absent" }`, or `{ state: "present", id, claim }` with the
 * owner container's immutable id and its claim label. Rejects when Docker does not answer: a
 * lookup that failed says nothing about whether a claim exists.
 */
export async function currentClaim(docker) {
  const ids = (
    await docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=^${OWNER_CONTAINER}$`])
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length === 0) return { state: "absent" };
  const [item] = JSON.parse(await docker(["inspect", ids[0]]));
  if (item === undefined) throw new Error(`the owner container ${ids[0]} could not be inspected`);
  return { state: "present", id: item.Id, claim: item.Config?.Labels?.[CLAIM_LABEL] ?? null };
}

/**
 * Claim the daemon for `claimId`: true when the owner container is this start's, false when
 * another start holds it. A create that fails for any other reason rejects, and so does one whose
 * outcome Docker cannot then report.
 */
export async function claim(docker, { claimId, image }) {
  try {
    await docker([
      "create",
      "--name",
      OWNER_CONTAINER,
      "--label",
      `${STACK_LABEL}=1`,
      "--label",
      `${CLAIM_LABEL}=${claimId}`,
      "--network",
      "none",
      image,
      "true",
    ]);
    return true;
  } catch (error) {
    // Docker refuses a name in use; a create whose reply was lost may also have succeeded.
    const current = await currentClaim(docker);
    if (current.state === "present") return current.claim === claimId;
    throw error;
  }
}

/** Waits between retries of a lookup or a teardown that failed: growing, then steady. */
export const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];

/**
 * A watchdog's whole life. It waits while the supervisor lives, then:
 * - a lookup that fails is retried (RETRY_DELAYS_MS), never read as "no claim";
 * - no claim yet: waits up to `appearWithinMs` for one, since a create may still be in flight
 *   when the supervisor died; still none: `"never-claimed"`;
 * - another start's claim: `"not-ours"`, and nothing is touched;
 * - its own claim: `takeDown(owner)` until it succeeds, retried like a lookup: `"taken-down"`.
 */
export async function watch({
  docker,
  alive,
  claimId,
  takeDown,
  pause,
  now,
  log = () => {},
  appearWithinMs = 60_000,
  pollMs = 2000,
}) {
  while (alive()) await pause(pollMs);
  log("the supervisor ended");
  const deadline = now() + appearWithinMs;
  let failures = 0;
  const retry = async (what, error) => {
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
    failures += 1;
    log(`${what} failed (${error.message}); again in ${delay} ms`);
    await pause(delay);
  };
  for (;;) {
    let current;
    try {
      current = await currentClaim(docker);
    } catch (error) {
      await retry("the owner lookup", error);
      continue;
    }
    if (current.state === "absent") {
      if (now() >= deadline) return "never-claimed";
      await pause(pollMs);
      continue;
    }
    if (current.claim !== claimId) return "not-ours";
    try {
      await takeDown(current);
      return "taken-down";
    } catch (error) {
      await retry("taking the stack down", error);
    }
  }
}
