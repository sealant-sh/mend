// The pure half of the verify stack (stack.mjs): what a source spec means, what each image is named,
// which environment a Docker client gets, how memory is read. Nothing here runs a process, reads
// the network, a clock or a file, so all of it is unit-tested (lib.test.mjs).

import { createHash } from "node:crypto";
import { posix } from "node:path";

/** The three repositories a stack builds, and where a ref of each is fetched from. */
export const REPOSITORIES = {
  mend: { url: "https://github.com/sealant-sh/mend.git", addedAs: null },
  sealant: { url: "https://github.com/sealant-sh/sealant.git", addedAs: "sealant" },
  sealantd: { url: "https://github.com/sealant-sh/sealantd.git", addedAs: "sealantd" },
};

/** Where `mend repo add <name>` puts a repository in a session (docs/adr/0011). */
export const SESSION_REPOS = "/workspace/repos";

/** The roots a session's executor saves (docs/adr/0002, 0016): nothing of a stack may live there. */
export const CAPTURE_ROOTS = ["/workspace"];

/** Every image, container and volume the stack makes carries this label. */
export const STACK_LABEL = "dev.mend.verify-stack";

// The stack's own containers and volumes are named `verify-stack-…`, never `mend-…` or `mend_…`:
// `mend server setup` claims that namespace for its Compose project and refuses to install beside a
// container in it that it did not make (apps/cli/src/server-docker-volumes.ts `refuseOldData`).

/** The Docker volume that holds the inner server's configuration and secrets. */
export const STATE_VOLUME = "verify-stack-state";

/**
 * The stack's claim on a daemon: a container created before anything else, whose name Docker keeps
 * unique, so two starts on one daemon cannot both pass. `down` removes it last.
 */
export const OWNER_CONTAINER = "verify-stack-owner";

/** The containers the stack runs beside the inner server's own. */
export const RELAY_CONTAINER = "verify-stack-relay";
export const FIXTURE_CONTAINER = "verify-stack-fixture";
export const FIXTURE_VOLUME = "verify-stack-fixture";

/** The inner server's Compose project and network (`name: mend` in compose.v2.yaml). */
export const COMPOSE_PROJECT = "mend";
export const COMPOSE_NETWORK = "mend_default";

/** The inner server's container port; Compose names its service `mend`. */
export const INNER_WEB_PORT = 3105;

/** The base the fixture project's sessions run on: git, node and npm, no Docker service. */
export const FIXTURE_BASE_IMAGE = "node:26-bookworm";
export const FIXTURE_PROJECT = "verify-fixture";

/** The Docker CLI the inner CLI image carries: the version Core's worker and Mend's bundle pin. */
export const DOCKER_CLI_IMAGE = "docker:27.5.1-cli";

/** The first account of every inner server. `.invalid` never resolves. */
export const INNER_ACCOUNT_EMAIL = "verifier@verify-stack.invalid";

const REF = /^[A-Za-z0-9._/-]+$/;

/**
 * What one `--mend|--sealant|--sealantd <spec>` names:
 * - `pinned`: no build; the release Mend's own pins name (Core and sealantd only);
 * - `#123` or `pr:123`: the pull request's head on GitHub;
 * - a path (`.`, `/…`, `~/…`, `./…`): that working tree as it is, uncommitted files included;
 * - anything else: a branch, tag or commit on GitHub.
 */
export function parseSource(repository, spec) {
  if (!Object.hasOwn(REPOSITORIES, repository)) throw new Error(`unknown repository ${repository}`);
  const value = String(spec ?? "").trim();
  if (value === "") throw new Error(`--${repository} needs a value`);
  if (value === "pinned") {
    if (repository === "mend")
      throw new Error("--mend pinned: the stack builds Mend from source; pass a path or a ref");
    return { repository, kind: "pinned" };
  }
  const pr = /^(?:#|pr:)(\d+)$/.exec(value);
  if (pr) return { repository, kind: "pr", number: Number(pr[1]) };
  if (value === "." || value.startsWith("/") || value.startsWith("./") || value.startsWith("~/"))
    return { repository, kind: "worktree", path: value };
  if (!REF.test(value) || value.includes("..") || value.startsWith("-"))
    throw new Error(`--${repository} ${value}: not a branch, tag, commit, #PR or path`);
  return { repository, kind: "ref", ref: value };
}

/** The spec a repository gets when none is passed: the session's copy when there is one, else main. */
export function defaultSpec(repository, { mendRoot, sessionRepos }) {
  if (repository === "mend") return mendRoot;
  const added = REPOSITORIES[repository].addedAs;
  return sessionRepos.includes(added) ? posix.join(SESSION_REPOS, added) : "main";
}

/** What `git fetch` asks GitHub for. A full commit sha is fetched as itself. */
export function fetchRefspec(source) {
  if (source.kind === "pr") return `refs/pull/${source.number}/head`;
  // A full sha is fetched as itself (GitHub serves any reachable commit); a name as the ref.
  if (source.kind === "ref") return source.ref;
  throw new Error(`a ${source.kind} source is not fetched`);
}

/** How a resolved source reads in a report: `sealant #345 @ 1a2b3c4d5e6f (tree 9f8e…)`. */
export function describeSource(resolved) {
  if (resolved.kind === "pinned") return `${resolved.repository} pinned (the release Mend pins)`;
  const what =
    resolved.kind === "pr"
      ? `#${resolved.number}`
      : resolved.kind === "ref"
        ? resolved.ref
        : `${resolved.path}${resolved.dirty ? " (uncommitted changes included)" : ""}`;
  return `${resolved.repository} ${what} @ ${resolved.commit.slice(0, 12)} (tree ${resolved.tree.slice(0, 12)})`;
}

/** One digest for several inputs: what an image built from them is tagged with. */
export function digestOf(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${String(part).length}:${part}`);
  return hash.digest("hex");
}

const short = (tree) => tree.slice(0, 12);

/**
 * The images a stack builds. Upstream images are tagged by their source tree, so the same tree is
 * built once per Docker daemon. Mend's image is tagged by its tree and every upstream image id,
 * because the bundle copies them in. `mend server setup` pins `ghcr.io/sealant-sh/mend:<version>`
 * (deploy/docker/compose.v2.yaml), so the bundle carries that name: a `-verify.` version is never
 * published, so the name cannot meet a release.
 */
export function imageNames({ mend, sealant, sealantd }, { cliVersion, upstreamIds }) {
  const core = sealant.kind === "pinned" ? null : short(sealant.tree);
  const daemon = sealantd.kind === "pinned" ? null : short(sealantd.tree);
  const bundle = digestOf(mend.tree, ...upstreamIds).slice(0, 12);
  return {
    sealantd: daemon === null ? null : `mend-verify/sealantd:${daemon}`,
    sealantApi: core === null ? null : `mend-verify/sealant-api:${core}`,
    sealantWorker: core === null ? null : `mend-verify/sealant-worker:${core}`,
    sealantSshGateway: core === null ? null : `mend-verify/sealant-ssh-gateway:${core}`,
    cli: `mend-verify/mend-cli:${short(mend.tree)}`,
    version: verifyVersion(cliVersion, bundle),
    mend: `ghcr.io/sealant-sh/mend:${verifyVersion(cliVersion, bundle)}`,
  };
}

/**
 * The bundle's version: the Mend source's own release line, marked as a verify build. A release
 * part keeps any version comparison the server or the CLI makes meaningful; the `t` keeps the
 * identifier alphanumeric (a numeric one may not start with 0).
 */
export function verifyVersion(cliVersion, digest) {
  const release = /^(\d+\.\d+\.\d+)/.exec(String(cliVersion));
  if (!release) throw new Error(`apps/cli/package.json has no version: ${cliVersion}`);
  if (!/^[0-9a-f]{6,}$/.test(digest)) throw new Error(`not a digest: ${digest}`);
  return `${release[1]}-verify.t${digest}`;
}

/** The build arguments Mend's root Dockerfile takes, as preview.yml passes them. */
export function mendBuildArgs(images) {
  return {
    MEND_VERSION: images.version,
    ...(images.sealantApi === null
      ? {}
      : {
          SEALANT_API_IMAGE: images.sealantApi,
          SEALANT_WORKER_IMAGE: images.sealantWorker,
          SEALANT_SSH_GATEWAY_IMAGE: images.sealantSshGateway,
        }),
    ...(images.sealantd === null ? {} : { MEND_PREVIEW_SEALANTD_IMAGE: images.sealantd }),
  };
}

/** The images a Compose file names that setup does not build: pulled before an offline setup. */
export function composeImages(composeYaml) {
  const images = new Set();
  for (const match of composeYaml.matchAll(/^\s+image:\s*(\S+)\s*$/gm)) {
    const image = match[1].replace(/^["']|["']$/g, "");
    if (!image.includes("$")) images.add(image);
  }
  return [...images].toSorted();
}

/**
 * The environment of every Docker client the stack runs: the daemon and nothing else. No `MEND_*`
 * (the session's own token and channel), no harness login, no SSH agent, no Git configuration, and
 * a Docker configuration of its own, so no registry credential of the session's person is used.
 */
export function dockerClientEnvironment(source, { home, dockerConfig }) {
  const keep = ["PATH", "DOCKER_HOST", "TMPDIR", "LANG"];
  return {
    ...Object.fromEntries(keep.flatMap((key) => (source[key] ? [[key, source[key]]] : []))),
    HOME: home,
    DOCKER_CONFIG: dockerConfig,
    DOCKER_BUILDKIT: "1",
    BUILDKIT_PROGRESS: "plain",
    SSH_AUTH_SOCK: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The name a session's Docker sidecar answers to on the workspace's network (Core's adapter). */
export const SESSION_SIDECAR_HOST = "docker";

/**
 * Where the browser and the session reach the inner web. In a session the daemon is the workspace's
 * Docker sidecar, `tcp://docker:2375`, on a network only the workspace shares: a port the relay
 * publishes on every interface there is reachable from the workspace and nowhere else, and on
 * loopback it would be reachable from nowhere. Any other daemon, a TCP one included, gets loopback
 * only: an all-interface publish there could put the inner web on a network.
 */
export function relayEndpoint(dockerHost, port) {
  if (dockerHost) {
    let url;
    try {
      url = new URL(dockerHost);
    } catch {
      throw new Error(`DOCKER_HOST ${dockerHost} is not a URL`);
    }
    if (url.protocol === "tcp:" && url.hostname === SESSION_SIDECAR_HOST)
      return { publish: `0.0.0.0:${port}:${INNER_WEB_PORT}`, host: url.hostname, port };
    if (url.protocol === "tcp:")
      return { publish: `127.0.0.1:${port}:${INNER_WEB_PORT}`, host: url.hostname, port };
    if (url.protocol !== "unix:")
      throw new Error(`DOCKER_HOST ${url.protocol}// is not supported: tcp:// or unix:// only`);
  }
  return { publish: `127.0.0.1:${port}:${INNER_WEB_PORT}`, host: "127.0.0.1", port };
}

/**
 * The browser origins the inner server trusts: the URL a person opens through
 * `mend service connect <name> --port <port>` (its `--url`), its 127.0.0.1 spelling, and the relay
 * as the session sees it, so a browser running in the session signs in too.
 */
export function innerOrigins(relay) {
  const url = `http://localhost:${relay.port}`;
  const extra = [`http://127.0.0.1:${relay.port}`];
  if (relay.host !== "127.0.0.1") extra.push(`http://${relay.host}:${relay.port}`);
  return { url, extra };
}

/** True when `path` is a capture root or inside one: a stack's private files never go there. */
export function insideCaptureRoot(path) {
  const normalized = posix.normalize(path);
  return CAPTURE_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

/**
 * What each container of the inner stack carries of the outer session's secrets: nothing, or the
 * places one appears (`<container> env|command|labels`). `secrets` are values, never printed.
 */
export function isolationFindings(containers, secrets) {
  const values = secrets.filter((value) => typeof value === "string" && value.length >= 8);
  const findings = [];
  for (const container of containers) {
    const name = String(container.Name ?? container.Id ?? "?").replace(/^\//, "");
    const places = {
      env: (container.Config?.Env ?? []).join("\n"),
      command: [...(container.Config?.Entrypoint ?? []), ...(container.Config?.Cmd ?? [])].join(
        " ",
      ),
      labels: JSON.stringify(container.Config?.Labels ?? {}),
    };
    for (const [place, text] of Object.entries(places))
      if (values.some((value) => text.includes(value))) findings.push(`${name} ${place}`);
  }
  return findings;
}

/**
 * Proportional set size per process, from `<pss kB> <command>` lines, largest first, with the sum.
 * PSS charges each shared page to its sharers once, so the sum is what the processes hold together.
 */
export function parseMemory(text) {
  const processes = [];
  for (const line of text.split("\n")) {
    const match = /^(\d+)\s+(.*)$/.exec(line.trim());
    if (match) processes.push({ kb: Number(match[1]), command: match[2].trim() });
  }
  processes.sort((a, b) => b.kb - a.kb);
  return { totalKb: processes.reduce((sum, item) => sum + item.kb, 0), processes };
}

/** The shell a memory probe runs: one `<pss kB> <command>` line per process it can read. */
export const MEMORY_PROBE = [
  "for p in /proc/[0-9]*; do",
  "  s=$(awk '/^Pss:/{print $2}' \"$p/smaps_rollup\" 2>/dev/null)",
  '  [ -n "$s" ] || continue',
  "  c=$(tr '\\0' ' ' < \"$p/cmdline\" 2>/dev/null | cut -c1-80)",
  '  [ -n "$c" ] || c="[$(cat "$p/comm" 2>/dev/null)]"',
  '  echo "$s $c"',
  "done",
].join("\n");

/** `1536000` kB as `1.46 GiB`. */
export function formatKb(kb) {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GiB`;
  return `${Math.round(kb / 1024)} MiB`;
}

/** `83.4` seconds as `1 min 23 s`. */
export function formatSeconds(seconds) {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/**
 * What a cache directory keeps: the `keep` newest entries by modification time; the rest go. Pure
 * over `[{ name, mtimeMs }]`, so the retention rule is tested without a disk.
 */
export function beyondRetention(entries, keep) {
  return entries
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(keep)
    .map((entry) => entry.name);
}

// ─── what the stack made: the ledger ────────────────────────────────────────

/** The prefix of every container and volume the stack itself names. */
export const VERIFIER_PREFIX = "verify-stack-";

/**
 * A volume's identity: its name and its creation time. A volume has no id, and one removed and made
 * again under its name is another volume. (Containers and networks are known by their ids.)
 */
export const volumeIdentity = (volume) => `${volume.name}\u0000${volume.createdAt}`;

// What the stack makes on a daemon is shaped by `mend server setup` and the inner Sealant: Compose
// project `mend` (its containers, its `mend_…` volumes and network), the volumes setup claims, and an
// inner session's `sealant-<run>` container, its `-docker` sidecar and its `-network`. A session's
// Docker daemon is shared with its agent and its person, so a recording window takes only what has
// that shape, and a teardown removes only what was both recorded and has it (`planTeardown`).
const SESSION_CONTAINER = /^sealant-[a-z0-9][a-z0-9_.-]*$/i;
const SESSION_NETWORK = /^sealant-[a-z0-9][a-z0-9_.-]*-network$/i;
const PRODUCT_VOLUME = /^(mend-(store|control|garage)|mend_.+)$/;
const COMPOSE_NETWORK_NAME = /^mend_.+$/;

/**
 * What a recording window may take, by kind, from snapshot entries (`{ id, name, compose }` for a
 * container, `{ id, name }` for a network, `{ name, createdAt }` for a volume):
 * - `install` (`up`): the inner server's and its sessions' shapes;
 * - `session` (`mend`, `check`): an inner session's only.
 */
export const SHAPES = {
  install: {
    container: (item) => item.compose === COMPOSE_PROJECT || SESSION_CONTAINER.test(item.name),
    network: (item) => COMPOSE_NETWORK_NAME.test(item.name) || SESSION_NETWORK.test(item.name),
    volume: (item) => PRODUCT_VOLUME.test(item.name),
  },
  session: {
    container: (item) => SESSION_CONTAINER.test(item.name),
    network: (item) => SESSION_NETWORK.test(item.name),
    volume: () => false,
  },
};

/**
 * What appeared on the daemon between two snapshots and has the window's `shape`: the entries a
 * recording window adds to the stack's ledger, by identity (container and network ids, volume
 * identities). Anything else that appeared (another client's database, say) is not the stack's.
 */
export function madeSince(before, after, shape = SHAPES.install) {
  const containers = new Set(before.containers.map((item) => item.id));
  const networks = new Set(before.networks.map((item) => item.id));
  const volumes = new Set(before.volumes.map(volumeIdentity));
  return {
    containers: after.containers
      .filter((item) => !containers.has(item.id) && shape.container(item))
      .map((item) => item.id),
    networks: after.networks
      .filter((item) => !networks.has(item.id) && shape.network(item))
      .map((item) => item.id),
    volumes: after.volumes.filter(
      (volume) => !volumes.has(volumeIdentity(volume)) && shape.volume(volume),
    ),
  };
}

/** The ledger entries of several windows, as one. */
export function mergeLedgers(ledgers) {
  const containers = new Set();
  const networks = new Set();
  const volumes = new Map();
  for (const ledger of ledgers) {
    for (const id of ledger.containers ?? []) containers.add(id);
    for (const id of ledger.networks ?? []) networks.add(id);
    for (const volume of ledger.volumes ?? []) volumes.set(volumeIdentity(volume), volume);
  }
  return { containers: [...containers], networks: [...networks], volumes: [...volumes.values()] };
}

const nameOf = (item) => String(item.Name ?? "").replace(/^\//, "");
const labelsOf = (item) => item.Config?.Labels ?? item.Labels ?? {};
/** The stack's own infrastructure: its label and its name prefix, both. */
const own = (item) =>
  labelsOf(item)[STACK_LABEL] === "1" && nameOf(item).startsWith(VERIFIER_PREFIX);
/** Docker's own networks, which every daemon has. */
const PREDEFINED_NETWORKS = new Set(["bridge", "host", "none"]);
/** `docker inspect` output as snapshot entries, which the shapes read. */
const entry = {
  container: (item) => ({
    id: item.Id,
    name: nameOf(item),
    compose: labelsOf(item)["com.docker.compose.project"] ?? "",
  }),
  network: (item) => ({ id: item.Id, name: nameOf(item) }),
  volume: (item) => ({ name: item.Name, createdAt: item.CreatedAt }),
};
/** Names the stack's resources take, which another server or client may share: reported only. */
const looksLikeTheStacks = (kind, item) =>
  labelsOf(item)[STACK_LABEL] !== undefined ||
  nameOf(item).startsWith(VERIFIER_PREFIX) ||
  SHAPES.install[kind](entry[kind](item));

/**
 * What a teardown removes, from the stack's ledger and `docker inspect` of what is on the daemon
 * now (containers, volumes, networks):
 * - the stack's own infrastructure (its label and its prefix, both);
 * - what the ledger recorded, by an identity that still matches exactly (any of a volume name's
 *   recorded creation times), and that has the stack's shape (`SHAPES.install`).
 * Nothing is followed from there: not a network, a mount, a label or a path. Left alone, with the
 * commands that remove each by hand (`leftAlone`, by `reason`):
 * - `made again`: a volume of a recorded name whose creation time is none recorded;
 * - `not the stack's shape`: recorded, but shaped like nothing the stack makes;
 * - `not recorded`: shaped like the stack's (or carrying its label or prefix alone), never recorded.
 * The owner container is never in it: the teardown that holds it removes it, last, by id.
 */
export function planTeardown({ ledger, containers, volumes, networks }) {
  const recorded = {
    containers: new Set(ledger.containers),
    networks: new Set(ledger.networks),
    volumes: new Set(ledger.volumes.map(volumeIdentity)),
    volumeNames: new Set(ledger.volumes.map((volume) => volume.name)),
  };
  const plan = { containers: [], volumes: [], networks: [], leftAlone: [] };
  const leave = (kind, item, reason) =>
    plan.leftAlone.push({
      kind,
      id: kind === "volume" ? item.Name : item.Id,
      name: nameOf(item),
      reason,
    });
  for (const item of containers.filter((container) => nameOf(container) !== OWNER_CONTAINER)) {
    const shaped = SHAPES.install.container(entry.container(item));
    if (own(item) || (recorded.containers.has(item.Id) && shaped)) plan.containers.push(item);
    else if (recorded.containers.has(item.Id)) leave("container", item, "not the stack's shape");
    else if (looksLikeTheStacks("container", item)) leave("container", item, "not recorded");
  }
  for (const item of volumes) {
    const known = recorded.volumes.has(volumeIdentity(entry.volume(item)));
    const shaped = SHAPES.install.volume(entry.volume(item));
    if (own(item) || (known && shaped)) plan.volumes.push(item);
    else if (known) leave("volume", item, "not the stack's shape");
    else if (recorded.volumeNames.has(item.Name)) leave("volume", item, "made again");
    else if (looksLikeTheStacks("volume", item)) leave("volume", item, "not recorded");
  }
  for (const item of networks.filter((network) => !PREDEFINED_NETWORKS.has(nameOf(network)))) {
    const shaped = SHAPES.install.network(entry.network(item));
    if (recorded.networks.has(item.Id) && shaped) plan.networks.push(item);
    else if (recorded.networks.has(item.Id)) leave("network", item, "not the stack's shape");
    else if (looksLikeTheStacks("network", item)) leave("network", item, "not recorded");
  }
  return plan;
}

/** How to remove by hand what a teardown left alone: one command per kind. */
export function manualRemoval(items) {
  const of = (kind) => items.filter((item) => item.kind === kind).map((item) => item.id);
  return [
    ["docker rm --force", of("container")],
    ["docker volume rm", of("volume")],
    ["docker network rm", of("network")],
  ]
    .filter(([, ids]) => ids.length > 0)
    .map(([command, ids]) => `${command} ${ids.join(" ")}`);
}
