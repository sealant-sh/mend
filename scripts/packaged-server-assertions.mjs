import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const projectLabel = "com.docker.compose.project";
const canonicalVolumes = new Set(
  [
    "store",
    "control",
    "garage",
    "config",
    "ssh",
    "rabbitmq",
    "registry",
    "postgres",
    "pg",
    "etc",
  ].flatMap((part) => [`mend-${part}`, `mend_mend-${part}`, `mend_${part}`]),
);

/** Fail closed before setup, including stopped containers and orphaned persistent volumes. */
export function assertFreshDocker({ containers, networks, volumes }) {
  assert.ok(
    !containers.some((item) => item.Config?.Labels?.[projectLabel] === "mend"),
    "Refusing acceptance: existing compose project=mend container",
  );
  assert.ok(
    !networks.some(
      (item) =>
        item.Labels?.[projectLabel] === "mend" ||
        item.Name === "mend" ||
        item.Name.startsWith("mend_"),
    ),
    "Refusing acceptance: existing Mend network",
  );
  assert.ok(
    !volumes.some(
      (item) => item.Labels?.[projectLabel] === "mend" || canonicalVolumes.has(item.Name),
    ),
    "Refusing acceptance: existing canonical Mend volume",
  );
}

/** Path containment uses components, not a prefix which could match another installation. */
export function isInside(root, candidate) {
  if (typeof candidate !== "string") return false;
  const tail = relative(root, candidate);
  return tail !== "" && tail !== ".." && !tail.startsWith(`..${sep}`) && !tail.startsWith(sep);
}

/** Compose ownership needs a new immutable ID AND this run's immutable generation directory. */
export function ownsComposeContainer(container, initialIds, configRoot) {
  const labels = container.Config?.Labels ?? {};
  const directory = labels["com.docker.compose.project.working_dir"];
  const generations = join(configRoot, "generations");
  if (typeof directory !== "string") return false;
  const generation = relative(generations, directory);
  return (
    !initialIds.has(container.Id) &&
    labels[projectLabel] === "mend" &&
    /^gen-[0-9a-f-]{36}$/.test(generation) &&
    directory === join(generations, generation)
  );
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A Sealant executor container: named `sealant-<id>` and/or holding a scoped `mend-control` socket
 * volume at /run/sealant with subpath `sealant-<id>`. `<id>` is the workspace's own id, which the
 * hot pool decouples from the session's assigned `sealantWorkspaceId` (a session claims a warm
 * standby, so its container keeps the pool id) — the container cannot be pinned to a session by id.
 * Per-session proof comes from the API and the record (registered capture, flush report); this
 * predicate only recognises that a container is a Sealant executor.
 */
export function isSealantExecutor(container) {
  const name = typeof container.Name === "string" ? container.Name.replace(/^\//, "") : "";
  if (/^sealant-[0-9a-f-]+$/i.test(name)) return true;
  return (container.HostConfig?.Mounts ?? []).some(
    (mount) =>
      mount.Source === "mend-control" &&
      mount.Type === "volume" &&
      mount.Target === "/run/sealant" &&
      typeof mount.VolumeOptions?.Subpath === "string" &&
      /^sealant-[0-9a-f-]+$/i.test(mount.VolumeOptions.Subpath),
  );
}

const underRunSealant = (target) =>
  target === "/run/sealant" || (typeof target === "string" && target.startsWith("/run/sealant/"));

/**
 * A capture executor is disposable (ADR-0002): its work product ships as captures, so it mounts
 * NOTHING from `mend-store` and binds no host path — it reaches the host only through scoped
 * `mend-control` volumes under /run/sealant (the control socket and the read-only secrets file).
 * A store volume, a store bind, or any host bind is a failure, not a variant. v0.27.0's acceptance
 * demanded the store mount that capture mode removes.
 */
export function captureExecutorMountsAreValid(container) {
  const specs = container.HostConfig?.Mounts ?? [];
  const mounts = container.Mounts ?? [];
  const binds = container.HostConfig?.Binds ?? [];
  if (!Array.isArray(specs) || !Array.isArray(mounts) || !Array.isArray(binds)) return false;
  const storeSpec = specs.some(
    (mount) =>
      mount.Source === "mend-store" ||
      (mount.Type === "bind" && String(mount.Source).startsWith("/var/lib/mend/store")),
  );
  const storeActual = mounts.some(
    (mount) =>
      mount.Name === "mend-store" ||
      (mount.Type === "bind" && String(mount.Source).startsWith("/var/lib/mend/store")),
  );
  return (
    !storeSpec &&
    !storeActual &&
    binds.length === 0 &&
    specs.every((mount) => mount.Type !== "bind") &&
    mounts.every((mount) => mount.Type !== "bind") &&
    specs.every((mount) => !underRunSealant(mount.Target) || mount.Source === "mend-control") &&
    mounts.every((mount) => !underRunSealant(mount.Destination) || mount.Name === "mend-control")
  );
}

/**
 * Cleanup ownership for executors: a new Sealant executor with capture-mode mounts. A store mount
 * disqualifies it — that is somebody's data, retained. The pool decouples the container id from
 * the session, so ownership is by executor shape, not by session id; on the acceptance's fresh
 * daemon every such container is one Mend launched for our project.
 */
export function ownsWorkspaceContainer(container, initialIds) {
  return (
    !initialIds.has(container.Id) &&
    isSealantExecutor(container) &&
    captureExecutorMountsAreValid(container)
  );
}

/** The observed executor ran store-less. Failing either half names the half. */
export function assertCaptureExecutor(container) {
  assert.ok(isSealantExecutor(container), "Observed container must be a Sealant executor");
  assert.ok(
    captureExecutorMountsAreValid(container),
    "Capture executor must mount nothing from mend-store and no host path; it reaches the host only through scoped mend-control volumes under /run/sealant",
  );
}

/** A registered capture for the worktree: the API answers from a capture n ≥ 1, never the base. */
export function captureRegisteredEvidence(observation) {
  if (observation === undefined || observation === null) return false;
  assert.ok(
    typeof observation === "object" &&
      ["claimed", "observed"].includes(observation.state) &&
      ["worktree", "capture"].includes(observation.source) &&
      typeof observation.label === "string",
    "Observation stamp must be well formed",
  );
  assert.notEqual(
    observation.source,
    "worktree",
    "A capture-mode session must be observed from captures, not a live worktree",
  );
  return Number.isInteger(observation.captureN) &&
    observation.captureN >= 1 &&
    typeof observation.captureId === "string" &&
    observation.captureId.length > 0
    ? observation
    : false;
}

/**
 * The engine's flush report at a turn boundary or stop, as logged by the Mend container:
 * "session engine: capture flush · completed · observed { sessionId: '…', …, registered: n, … }".
 * Only a completed report for THIS session counts; partial, refused and timed-out flushes are
 * distinct lines and never match.
 */
export function flushReportEvidence(logText, sessionId) {
  if (typeof logText !== "string" || typeof sessionId !== "string" || !sessionId) return false;
  const pattern = /session engine: capture flush · completed · observed \{([^}]*)\}/g;
  for (const match of logText.matchAll(pattern)) {
    const body = match[1];
    if (!body.includes(`sessionId: '${sessionId}'`)) continue;
    const number = (key) => {
      const found = body.match(new RegExp(`\\b${key}: (-?\\d+|null)\\b`));
      return found === null ? undefined : found[1] === "null" ? null : Number(found[1]);
    };
    const flag = (key) => {
      const found = body.match(new RegExp(`\\b${key}: (true|false)\\b`));
      return found === null ? undefined : found[1] === "true";
    };
    const report = {
      headN: number("headN"),
      pending: number("pending"),
      registered: number("registered"),
      uploadedObjects: number("uploadedObjects"),
      fenced: flag("fenced"),
    };
    assert.ok(
      Number.isInteger(report.pending) &&
        Number.isInteger(report.registered) &&
        typeof report.fenced === "boolean",
      "Flush report must carry pending, registered and fenced",
    );
    if (report.pending === 0 && report.fenced === false && report.registered >= 1) return report;
  }
  return false;
}

export const installationOwnerLabel = "dev.sealant.mend.installation";
// The bundle's external data volumes (setup-contract.v2 volumeOwnership.externalVolumes): the CLI
// creates each with the installation label before Compose starts, so none carries Compose labels.
const externalVolumes = new Set(["mend-store", "mend-control", "mend-garage"]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Missing, nonprivate, or redirected identity is unknown, never a reason to guess an owner. */
export async function readPrivateIdentity(configRoot) {
  try {
    if (
      (await realpath(configRoot)) !== configRoot ||
      ((await lstat(configRoot)).mode & 0o077) !== 0
    )
      return undefined;
    const file = join(configRoot, "identity.env");
    const info = await lstat(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size === 0 || info.size > 64 * 1024)
      return undefined;
    return await readFile(file);
  } catch {
    return undefined;
  }
}

/**
 * First observations are immutable. A replaced volume or changed/lost identity poisons its
 * cleanup claim permanently. Externals need the persisted identity, never Compose labels or
 * container existence. This also covers a setup failure immediately after the anchor claim.
 */
export function createVolumeLedger(initialVolumes, runId) {
  const preexisting = new Set(initialVolumes.map((item) => item.Name));
  const seen = new Map();
  const claims = new Map();
  const refused = new Set();
  let owner;
  let identityChanged = false;
  const observeIdentity = (bytes) => {
    const current = bytes instanceof Uint8Array && bytes.byteLength > 0 ? digest(bytes) : undefined;
    if (owner !== undefined && current !== owner) identityChanged = true;
    if (owner === undefined) owner = current;
    return identityChanged ? undefined : current;
  };
  return {
    collect(volumes, composeVolumeNames, identityBytes) {
      const identity = observeIdentity(identityBytes);
      const present = new Set(volumes.map((volume) => volume.Name));
      for (const name of seen.keys()) if (!present.has(name)) refused.add(name);
      for (const volume of volumes) {
        const name = volume.Name;
        if (preexisting.has(name)) continue;
        const fingerprint = digest(JSON.stringify(volume));
        if (!seen.has(name)) seen.set(name, fingerprint);
        if (seen.get(name) !== fingerprint) refused.add(name);
        if (volume.Driver !== "local" || !volume.CreatedAt) refused.add(name);
        if (externalVolumes.has(name)) {
          // No fallback to Compose/fixture labels for the external data volumes.
          if (!identity || volume.Labels?.[installationOwnerLabel] !== identity) refused.add(name);
          else if (!claims.has(name)) claims.set(name, fingerprint);
        } else if (
          (composeVolumeNames.has(name) && volume.Labels?.[projectLabel] === "mend") ||
          volume.Labels?.["sh.sealant.mend.acceptance"] === runId
        ) {
          if (!claims.has(name)) claims.set(name, fingerprint);
        } else if (!claims.has(name)) {
          // A later mount does not prove who created an initially unowned volume.
          // Previously proven Compose volumes stay owned after their containers stop.
          refused.add(name);
        }
      }
    },
    names: () => [...claims.keys()],
    canRemove(volume, identityBytes) {
      const identity = observeIdentity(identityBytes);
      const fingerprint = digest(JSON.stringify(volume));
      if (claims.has(volume.Name) && claims.get(volume.Name) !== fingerprint)
        refused.add(volume.Name);
      return (
        !preexisting.has(volume.Name) &&
        !refused.has(volume.Name) &&
        claims.has(volume.Name) &&
        claims.get(volume.Name) === fingerprint &&
        (!externalVolumes.has(volume.Name) ||
          (identity !== undefined && volume.Labels?.[installationOwnerLabel] === identity))
      );
    },
  };
}

/** Deletion boundary, injected for tests. Inspection errors are never treated as absence. */
export async function cleanupOwnedVolumes(ledger, operations) {
  const names = ledger.names();
  if (!names.length) return true;
  const present = new Set(await operations.list());
  let complete = true;
  for (const name of names) {
    if (!present.has(name)) continue;
    const identity = await operations.identity();
    const inspected = await operations.inspect(name);
    if (
      !Array.isArray(inspected) ||
      inspected.length !== 1 ||
      inspected[0]?.Name !== name ||
      !ledger.canRemove(inspected[0], identity)
    ) {
      complete = false;
      continue;
    }
    // Docker has no compare-and-delete volume API. Inspect immediately before rm, never
    // force deletion, and let Docker refuse foreign users. Names alone never authorize rm.
    if (!(await operations.remove(name))) complete = false;
  }
  return complete;
}

/** Do not inherit a user's agent, Git overrides, Mend token, harness credentials, or XDG paths. */
export function isolatedClientEnvironment(source, home, dockerConfig) {
  const environment = Object.fromEntries(
    ["PATH", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"].flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  );
  return {
    ...environment,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    ...(dockerConfig ? { DOCKER_CONFIG: dockerConfig } : {}),
    SSH_AUTH_SOCK: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    CI: "1",
    NO_COLOR: "1",
  };
}

/** A completed PTY may have no exit code; never normalize that observation to zero. */
export function completedCommandEvidence(detail) {
  assert.notEqual(detail.session?.status, "failed", "Session failed");
  const agent = detail.currentAgent;
  if (agent?.status !== "exited") return false;
  assert.ok(
    agent.exitCode === null || agent.exitCode === 0,
    "Command has an observed nonzero or malformed exit code",
  );
  assert.ok(
    typeof agent.exitedAt === "string" && Number.isFinite(Date.parse(agent.exitedAt)),
    "An exited process must have an observed exit time",
  );
  return detail.session?.status === "completed" &&
    Array.isArray(detail.checkpoints) &&
    detail.checkpoints.length >= 2
    ? detail
    : false;
}

/** The health version must name the pin, not merely a reachable HTTP server. */
export function assertHealth(body, version) {
  assert.ok(
    body?.status === "ok" && body?.version === version,
    "Health must report ok and the exact Mend pin",
  );
}

/** Exact release pins only. Build metadata and mutable tags are not image version fixtures. */
function versionParts(value) {
  assert.ok(
    typeof value === "string" &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(
        value,
      ),
    "Upgrade fixtures require exact semantic versions",
  );
  const [core, ...suffix] = value.split("-");
  const pre = suffix.join("-").split(".").filter(Boolean);
  assert.ok(
    pre.every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0")),
    "Numeric prerelease identifiers must not have leading zeroes",
  );
  return { core: core.split(".").map(BigInt), pre };
}

function newerVersion(target, baseline) {
  const a = versionParts(target);
  const b = versionParts(baseline);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return y === undefined;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y);
    return xn === yn ? x > y : !xn;
  }
  return false;
}

/** Validate before the first Docker call. A half-configured upgrade must never silently skip. */
export function readUpgradeInputs(source, currentAssets, baseline) {
  const image = source.MEND_TEST_UPGRADE_IMAGE;
  const version = source.MEND_TEST_UPGRADE_VERSION;
  const assets = source.MEND_TEST_UPGRADE_ASSETS;
  if (image === undefined && version === undefined && assets === undefined) return undefined;
  assert.ok(
    image !== undefined && version !== undefined,
    "Set paired MEND_TEST_UPGRADE_IMAGE and MEND_TEST_UPGRADE_VERSION",
  );
  versionParts(version);
  assert.ok(
    image === `ghcr.io/sealant-sh/mend:${version}`,
    "Upgrade image must be the canonical Mend tag for the target version",
  );
  assert.ok(
    newerVersion(version, baseline),
    "Upgrade target must be newer than the initial MEND_TEST_VERSION",
  );
  assert.ok(
    assets === undefined || assets.trim().length > 0,
    "MEND_TEST_UPGRADE_ASSETS must be a directory path",
  );
  return { image, version, assets: resolve(assets ?? currentAssets) };
}

/** The image itself must be stamped, not only its tag or the container's health environment. */
export function assertImagePin(container, inspectedImage, image, version) {
  assert.ok(
    container?.Config?.Image === image &&
      container.Image === inspectedImage?.Id &&
      inspectedImage.Config?.Labels?.["org.opencontainers.image.version"] === version &&
      inspectedImage.Config?.Env?.filter((value) => value.startsWith("MEND_VERSION=")).join() ===
        `MEND_VERSION=${version}` &&
      container.Config.Env?.filter((value) => value.startsWith("MEND_VERSION=")).join() ===
        `MEND_VERSION=${version}`,
    "Canonical tag, image ID, OCI label and baked/runtime version must agree with the pin",
  );
}

/** Compare secret-bearing values only as booleans, never assertion diffs. */
export function assertUpgradeRetention(previous, target) {
  assert.ok(previous.target !== target.target, "Upgrade must select a new generation");
  assert.ok(previous.identity === target.identity, "Upgrade must retain installation identity");
  assert.ok(
    JSON.stringify({ ...previous.config, serverVersion: target.config.serverVersion }) ===
      JSON.stringify(target.config),
    "Upgrade must retain deployment configuration except for the explicit server pin",
  );
  const oldPin = `MEND_VERSION=${previous.config.serverVersion}`;
  const newPin = `MEND_VERSION=${target.config.serverVersion}`;
  const envLines = previous.serverEnv.split("\n");
  assert.ok(
    envLines.filter((line) => line === oldPin).length === 1,
    "Previous environment must contain one exact server pin",
  );
  assert.ok(
    envLines.map((line) => (line === oldPin ? newPin : line)).join("\n") === target.serverEnv,
    "Upgrade must retain every environment credential and setting except the server pin",
  );
}

/** Bounded diagnostic recognition. The caller gets a boolean, never stderr or secret bytes. */
export function createDiagnosticProbe(phrase) {
  let tail = "";
  let found = false;
  return {
    accept(chunk) {
      if (!phrase || found) return;
      const text = tail + chunk.toString();
      found = text.includes(phrase);
      tail = found ? "" : text.slice(-(phrase.length - 1));
    },
    matched: () => found,
  };
}

/** One public command; failure propagates without rollback, fallback, retries or success claims. */
export async function runPackagedUpgrade(target, offline, cli, collectOwned) {
  try {
    await cli(
      [
        "server",
        "upgrade",
        "--version",
        target.version,
        "--assets-dir",
        target.assets,
        ...(offline ? ["--offline"] : []),
      ],
      { timeout: 600_000 },
    );
  } finally {
    await collectOwned();
  }
}

/** Secret-free digest of all installation files, modes and symlinks. Never follows symlinks. */
export async function privateTreeFingerprint(root) {
  const entries = [];
  async function visit(path) {
    const info = await lstat(path);
    const name = relative(root, path);
    if (info.isSymbolicLink()) entries.push([name, info.mode, "link", await readlink(path)]);
    else if (info.isDirectory()) {
      entries.push([name, info.mode, "directory"]);
      for (const child of (await readdir(path)).toSorted()) await visit(join(path, child));
    } else {
      assert.ok(info.isFile(), "Installation contains an unexpected filesystem object");
      entries.push([name, info.mode, digest(await readFile(path))]);
    }
  }
  await visit(root);
  return digest(JSON.stringify(entries));
}

/** Real pg_dumpall evidence, not a restore or historical-migration claim. Never print dump bytes. */
export async function verifyUpgradeBackup(configRoot, previousGeneration, targetGeneration) {
  const backups = join(configRoot, "backups");
  const names = await readdir(backups);
  assert.ok(
    names.length === 1 && /^upgrade-[0-9a-f-]{36}$/.test(names[0]),
    "Upgrade must create exactly one recovery directory",
  );
  const directory = join(backups, names[0]);
  for (const path of [backups, directory]) {
    const info = await lstat(path);
    assert.ok(
      info.isDirectory() && (info.mode & 0o777) === 0o700,
      "Backup directories must be private and not symlinks",
    );
  }
  const files = (await readdir(directory)).toSorted();
  assert.ok(
    JSON.stringify(files) === JSON.stringify(["database.sql", "recovery.json"]),
    "Backup must be complete, with recovery record and no partial dump",
  );
  for (const name of files) {
    const info = await lstat(join(directory, name));
    assert.ok(
      info.isFile() && (info.mode & 0o777) === 0o600 && info.size > 0,
      "Backup files must be nonempty private regular files",
    );
  }
  const recovery = JSON.parse(await readFile(join(directory, "recovery.json"), "utf8"));
  assert.ok(
    recovery.previousGeneration === previousGeneration &&
      recovery.targetGeneration === targetGeneration &&
      recovery.database === "database.sql",
    "Recovery record must link the previous and target generations to the completed dump",
  );
  const sql = await readFile(join(directory, "database.sql"), "utf8");
  for (const name of ["mend", "sealant_control_plane"])
    assert.ok(
      new RegExp(`^CREATE DATABASE ${name}\\s`, "m").test(sql),
      "Cluster backup must contain both product databases",
    );
  for (const name of ["mend", "sealant", "postgres"])
    assert.ok(
      new RegExp(`^CREATE ROLE ${name};$`, "m").test(sql),
      "Cluster backup must include database roles",
    );
  assert.ok(
    /^-- PostgreSQL database cluster dump complete$/m.test(sql),
    "Cluster dump must have a completion marker",
  );
}

/** Failed commands only. Separate from the installation scratch so cleanup cannot erase evidence.
 * Never upload this directory to CI artifacts. Successful acceptance removes even expected refusals.
 */
export function createFailedCommandDiagnostics() {
  let directory;
  let sequence = 0;
  return {
    async record(metadata, stdout, stderr) {
      directory ??= mkdtemp(join(tmpdir(), "mend-packaged-failed-"));
      const root = await directory;
      const prefix = join(root, `FAILED-${++sequence}`);
      await Promise.all([
        writeFile(`${prefix}.json`, JSON.stringify(metadata), { mode: 0o600, flag: "wx" }),
        writeFile(`${prefix}.stdout`, stdout, { mode: 0o600, flag: "wx" }),
        writeFile(`${prefix}.stderr`, stderr, { mode: 0o600, flag: "wx" }),
      ]);
    },
    async finish(failed) {
      if (!directory) return undefined;
      const root = await directory;
      if (failed) return root;
      await rm(root, { recursive: true, force: true });
      return undefined;
    },
  };
}

const immutableDockerId = (value) =>
  typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);
const decimal = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 20 && !/\D/.test(value);
const stringArray = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((part) => typeof part === "string" && !part.includes("\0"));

function declaredHealthCommand(container) {
  const test = container.Config?.Healthcheck?.Test;
  if (!stringArray(test)) return undefined;
  if (test[0] === "CMD" && test.length > 1 && test[1]) return test.slice(1).join(" ");
  if (test[0] !== "CMD-SHELL" || test.length !== 2 || !test[1]) return undefined;
  const shell = container.Config.Shell;
  if (
    shell != null &&
    (!Array.isArray(shell) || (shell.length && (!stringArray(shell) || !shell[0])))
  )
    return undefined;
  return [...(shell?.length ? shell : ["/bin/sh", "-c"]), test[1]].join(" ");
}

const fail = (reason) => assert.ok(false, `Docker install events inconclusive: ${reason}`);

/**
 * Docker flattens exec argv with spaces in Action; compare that exact representation, never
 * substrings, tokenization or shell normalization. Events cannot prove the exec's initiator or
 * distinguish argv arrays with identical flattened text. This is declared-command evidence only.
 * Query bounded context around [since, until); context events do not themselves assert mutation.
 * Docker retains only 256 historical events: a full page or incomplete chain is inconclusive.
 * TimeNano is formatted as a STRING by the caller to avoid JSON's lossy nanosecond numbers.
 */
export function assertInstallDockerEvents(
  text,
  initial,
  { since, until, captureSince, captureUntil },
) {
  const bounds = [captureSince, since, until, captureUntil].map((value) => Date.parse(value));
  if (
    bounds.some((value) => !Number.isSafeInteger(value)) ||
    bounds.some((value, index) => index > 0 && value < bounds[index - 1]) ||
    bounds[1] >= bounds[2] ||
    bounds[1] - bounds[0] > 60_000 ||
    bounds[3] - bounds[2] > 10_000
  )
    fail("invalid bounded observation window");
  const [first, start, end, last] = bounds.map((value) => BigInt(value) * 1_000_000n);
  if (typeof text !== "string" || !Array.isArray(initial?.containers)) fail("malformed input");
  const rows = text.split("\n").filter((line) => line.trim());
  if (rows.length >= 256)
    fail("historical event limit reached; completeness cannot be established");
  const containers = new Map();
  for (const container of initial.containers) {
    if (!immutableDockerId(container?.Id) || containers.has(container.Id))
      fail("malformed initial inventory");
    containers.set(container.Id, declaredHealthCommand(container));
  }
  const events = rows.map((line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail("malformed event JSON");
    }
    if (
      !event ||
      typeof event.Type !== "string" ||
      typeof event.Action !== "string" ||
      !event.Actor ||
      typeof event.Actor.ID !== "string" ||
      !event.Actor.Attributes ||
      typeof event.Actor.Attributes !== "object" ||
      Array.isArray(event.Actor.Attributes) ||
      !Object.values(event.Actor.Attributes).every((value) => typeof value === "string") ||
      !decimal(event.timeNano)
    )
      fail("malformed event data");
    const time = BigInt(event.timeNano);
    if (time < first || time >= last) fail("event outside capture bounds");
    return { ...event, time, inWindow: time >= start && time < end };
  });
  for (let i = 1; i < events.length; i++)
    if (events[i].time < events[i - 1].time) fail("events out of order");
  const relevant = new Set();
  for (const event of events.filter((item) => item.inWindow)) {
    if (event.Type !== "container" || !containers.has(event.Actor.ID))
      fail("unknown resource or event type in install window");
    if (!/^(exec_create: |exec_start: |exec_die$)/.test(event.Action))
      fail("non-healthcheck lifecycle event in install window");
    if (!immutableDockerId(event.Actor.Attributes.execID)) fail("missing or malformed exec ID");
    relevant.add(event.Actor.Attributes.execID);
  }
  const chains = new Map();
  for (const event of events) {
    const id = event.Actor.Attributes.execID;
    if (!relevant.has(id)) continue;
    const command = containers.get(event.Actor.ID);
    if (event.Type !== "container" || !command)
      fail("exec has no pre-existing declared healthcheck");
    const previous = chains.get(id);
    if (previous && previous.container !== event.Actor.ID) fail("exec ID changed containers");
    if (event.Action === `exec_create: ${command}` && !previous)
      chains.set(id, { container: event.Actor.ID, phase: "created" });
    else if (event.Action === `exec_start: ${command}` && previous?.phase === "created")
      previous.phase = "started";
    else if (
      event.Action === "exec_die" &&
      previous?.phase === "started" &&
      decimal(event.Actor.Attributes.exitCode)
    )
      previous.phase = "completed";
    else fail("unknown command, unmatched exec ID or invalid healthcheck sequence");
  }
  if ([...chains.values()].some((chain) => chain.phase !== "completed"))
    fail("healthcheck sequence incomplete within bounded capture");
  return { healthchecks: chains.size };
}

/** Retain only structural Docker facts suitable for non-secret install/persistence comparisons. */
export function dockerFingerprint(snapshot) {
  return JSON.stringify({
    containers: snapshot.containers
      .map((item) => [item.Id, item.State.Status, item.State.StartedAt, item.RestartCount])
      .toSorted(),
    networks: snapshot.networks.map((item) => item.Id).toSorted(),
    volumes: snapshot.volumes.map((item) => [item.Name, item.CreatedAt]).toSorted(),
    images: snapshot.images.toSorted(),
  });
}
