// Who owns the stack on a Docker daemon, who may take it down, and when. Docker, the clock and
// process liveness are passed in, so every case is tested without a daemon (lifecycle.test.mjs),
// and the processes that use this are tested against a fake one (lifecycle.e2e.test.mjs).
//
// A generation is one start's stack. It begins when the start creates the owner container
// (OWNER_CONTAINER), labelled with a claim id made for that start alone; Docker keeps container
// names unique, so one generation exists at a time. It ends when its owner container is removed.
//
// Exclusion is a kernel lock, flock(2) on one file per daemon (stack.mjs `withDaemonLock`): a start
// (`serve`, `up`) holds it shared for its whole life, and every teardown holds it exclusive, and so
// do the Docker commands each of them runs (they carry the locked descriptor). The kernel releases
// it when the last of them exits, however they end. So a teardown never runs beside a start, a
// replacement is never admitted while a teardown, or a command a killed teardown left running, is
// still at work, and nothing here has to judge whether some process is still alive.

import { OWNER_CONTAINER, STACK_LABEL } from "./lib.mjs";

/** The label that names the start a claim belongs to. */
export const CLAIM_LABEL = `${STACK_LABEL}.claim`;

/** Waits between retries of a lookup or a teardown that failed. */
export const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];

/**
 * The daemon's current claim: `{ state: "absent" }`, or `{ state: "present", id, claim }` with the
 * owner container's immutable id and its claim label. Rejects when Docker does not answer: a
 * lookup that failed says nothing about whether a claim exists.
 */
export async function currentClaim(docker) {
  const item = await containerNamed(docker, OWNER_CONTAINER);
  if (item === null) return { state: "absent" };
  return { state: "present", id: item.Id, claim: item.Config?.Labels?.[CLAIM_LABEL] ?? null };
}

/** The container of that exact name, inspected, or null when there is none. Rejects on failure. */
async function containerNamed(docker, name) {
  const ids = (await docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=^${name}$`]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length === 0) return null;
  const [item] = JSON.parse(await docker(["inspect", ids[0]]));
  if (item === undefined) throw new Error(`container ${name} (${ids[0]}) could not be inspected`);
  return item;
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

/**
 * Take generation `claimId` down: `"removed"`; `"gone"` when no generation is up (an earlier
 * teardown finished it); `"not-ours"` when the daemon's owner is another generation, and nothing is
 * touched. The caller holds the daemon's lock exclusively, so nothing admits, builds or tears down
 * meanwhile. `removeResources(ownerId)` removes the generation and then its owner by that id.
 */
export async function teardownGeneration({ docker, claimId, removeResources }) {
  const owner = await currentClaim(docker);
  if (owner.state === "absent") return "gone";
  if (owner.claim !== claimId) return "not-ours";
  await removeResources(owner.id);
  return "removed";
}

/**
 * A watchdog's whole life. It waits while the supervisor lives; then `claimed()` settles whether
 * this start ever held a claim (it resolves only once any claim attempt in flight has finished, so
 * a slow create still gets its watcher); then `remove()` (a teardown under the exclusive lock) runs
 * until the generation is down, gone, or someone else's, retried after a failure (RETRY_DELAYS_MS).
 */
export async function watch({ alive, claimed, remove, pause, log = () => {}, pollMs = 2000 }) {
  while (alive()) await pause(pollMs);
  log("the supervisor ended");
  if (!(await claimed())) return "never-claimed";
  let failures = 0;
  for (;;) {
    let outcome;
    try {
      outcome = await remove();
    } catch (error) {
      outcome = `failed (${error.message})`;
    }
    if (outcome === "removed") return "taken-down";
    if (outcome === "gone" || outcome === "not-ours") return outcome;
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
    failures += 1;
    log(`teardown ${outcome}; again in ${delay} ms`);
    await pause(delay);
  }
}

/**
 * Whether this start holds a claim, once its claim attempt (if one started) has settled. An
 * attempt that rejected leaves the outcome unknown, so the daemon is asked, retried until it
 * answers: only a successful look decides.
 */
export async function settleClaim({ attempt, docker, claimId, pause, log = () => {} }) {
  if (attempt === null) return false;
  try {
    return await attempt;
  } catch (error) {
    log(`the claim's outcome is unknown (${error.message}); asking the daemon`);
  }
  for (let failures = 0; ; failures += 1) {
    try {
      const current = await currentClaim(docker);
      return current.state === "present" && current.claim === claimId;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
      log(`the owner lookup failed (${error.message}); again in ${delay} ms`);
      await pause(delay);
    }
  }
}

/**
 * Send `message` to a parent over IPC (`peer` is `process`), if it is still connected. A parent that
 * died between the check and the write fails the write (EPIPE, ECONNRESET): that is reported to
 * `log`, never thrown and never left as an unhandled `error` event, so the process sending, which
 * may hold a claim nobody else will take down, lives on.
 */
export function sendSafely(peer, message, log = () => {}) {
  if (!peer.connected) return;
  const report = (error) =>
    log(`the supervisor did not hear ${JSON.stringify(message)} (${error.code ?? error.message})`);
  try {
    peer.send(message, (error) => {
      if (error) report(error);
    });
  } catch (error) {
    report(error);
  }
}
