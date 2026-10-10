// Who owns the stack on a Docker daemon, who may take it down, and when. Docker, the clock and
// process liveness are passed in, so every case is tested without a daemon (lifecycle.test.mjs),
// and the processes that use this are tested against a fake one (lifecycle.e2e.test.mjs).
//
// A generation is one start's stack. It begins when the start creates the owner container
// (OWNER_CONTAINER), labelled with a claim id made for that start alone; Docker keeps container
// names unique, so one generation exists at a time. It ends when its owner container is removed,
// and only a teardown of that generation removes it, last.
//
// A teardown first creates a lock container named for the generation (TEARDOWN_PREFIX + claim id),
// then checks that the daemon's owner is still that generation, then removes. While a teardown
// holds the lock and the owner exists, no other teardown of the generation can act and no new start
// can be admitted, so what it removes can only be its generation's: there is no window between the
// check and the removal in which a replacement could appear. The product's own resources have
// fixed names that cannot carry a generation (`mend-store`, `mend_default`, …), so this exclusion,
// not a label, is what keeps a stale teardown off a replacement's.

import { OWNER_CONTAINER, STACK_LABEL } from "./lib.mjs";

/** The label that names the start a claim belongs to. */
export const CLAIM_LABEL = `${STACK_LABEL}.claim`;

/** A generation's teardown lock: this prefix and the claim id. */
export const TEARDOWN_PREFIX = "verify-stack-teardown-";

/** Who holds a teardown lock: `<pid>:<start time>` of the process that created it. */
export const HOLDER_LABEL = `${STACK_LABEL}.teardown-holder`;

/** Waits between retries of a lookup or a teardown that failed or found another at work. */
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
 * Take generation `claimId` down, alone: `"removed"`; `"gone"` when no generation is up (an
 * earlier teardown finished it); `"not-ours"` when the daemon's owner is another generation, and
 * nothing is touched; `"busy"` when a live process holds this generation's teardown. A lock whose
 * holder is no longer alive (`holderAlive`) is cleared and taken. `removeResources(ownerId)` removes
 * the generation's resources and then its owner container by that id; it runs only while this
 * call holds the lock and the owner is this generation.
 */
export async function removeGeneration({
  docker,
  claimId,
  image,
  holder,
  holderAlive,
  removeResources,
}) {
  const lock = `${TEARDOWN_PREFIX}${claimId}`;
  let lockId = null;
  for (let attempt = 0; lockId === null; attempt += 1) {
    try {
      lockId = (
        await docker([
          "create",
          "--name",
          lock,
          "--label",
          `${HOLDER_LABEL}=${holder}`,
          "--network",
          "none",
          image,
          "true",
        ])
      ).trim();
    } catch (error) {
      const existing = await containerNamed(docker, lock);
      if (existing === null) {
        // Released between the create and the look: take it again, a few times at most.
        if (attempt >= 3) throw error;
        continue;
      }
      if (holderAlive(existing.Config?.Labels?.[HOLDER_LABEL] ?? "")) return "busy";
      await docker(["rm", "--force", existing.Id]);
    }
  }
  try {
    const owner = await currentClaim(docker);
    if (owner.state === "absent") return "gone";
    if (owner.claim !== claimId) return "not-ours";
    await removeResources(owner.id);
    return "removed";
  } finally {
    // A lock this leaves behind names a holder that is gone; the next teardown clears it.
    await docker(["rm", "--force", lockId]).catch(() => undefined);
  }
}

/**
 * A watchdog's whole life. It waits while the supervisor lives; then `claimed()` settles whether
 * this start ever held a claim (it resolves only once any claim attempt in flight has finished, so
 * a slow create still gets its watcher); then `remove()` (a `removeGeneration`) runs until the
 * generation is down, gone, or someone else's, retried after a failure or while another teardown
 * of it works (RETRY_DELAYS_MS).
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
    log(
      `teardown ${outcome === "busy" ? "held by another process" : outcome}; again in ${delay} ms`,
    );
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
