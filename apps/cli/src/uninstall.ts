import * as fs from "node:fs";
import * as path from "node:path";

import {
  HOST_USER_NAMESPACE_SYSCTL_FILE,
  HOST_USER_NAMESPACE_SYSCTL_MARKER,
  HOST_USER_NAMESPACE_SYSCTL_PREVIOUS,
} from "@mend/domain/workbench";
import { stripManagedWorkspaceSshBlocks } from "@mend/workspace-ssh";

import {
  MEND_DOCKER_NAMESPACE,
  MEND_DOCKER_NAMESPACE_WITH_GARAGE,
  SERVER_VOLUME_OWNER_LABEL,
  secondaryVolumesOf,
  serverVolumeOwner,
} from "./server-docker-volumes.ts";
import { composeOverlays, T3_GATEWAY_VOLUME } from "./server-edge.ts";
import { mirrorServices } from "./server-mirrors.ts";
import {
  serverComposeArgs,
  serverProcessDeadlines,
  type ServerProcessOutput,
} from "./server-runtime.ts";
import { readServerInstallation, type ServerSetupRuntime } from "./server-setup.ts";
import { ServerRefusal, withServerStore } from "./server-store.ts";
import type { ThisMachineKeyRemoval } from "./ssh-setup.ts";

/**
 * `mend uninstall`: the one command that deletes. Three scopes, chosen up front and
 * shown as a plan before anything is touched:
 *
 * - `server`: the Docker Compose installation on this machine (its live sessions' workspaces,
 *   containers, networks, every volume it owns, its release image) and the private configuration
 *   under the config directory (identity, generations, backups).
 * - `home`: what this CLI keeps for itself (the sign-in, the workspace SSH key, the
 *   managed block in ~/.ssh/config). First, while the sign-in still works, the server
 *   removes the workspace SSH key this machine registered and revokes this terminal's
 *   device token. The account's other keys and devices are left alone.
 * - `all`: both, server first, and what else Mend put on the Docker host: the images it pulled
 *   and built, and the user-namespace sysctl file setup wrote.
 *
 * Nothing is touched until everything the plan needs answers: with Docker down, `server` and
 * `all` refuse before the first removal. The anchor volume and the identity go last, once every
 * other volume, network and workspace the installation owns is gone; anything left keeps them,
 * and is written to `uninstall-left.json`, so a second run, or a reinstall, finishes the job.
 *
 * Workspaces are this installation's when they mount its control volume (the volume carries the
 * installation's label); their Docker sidecars and networks are named after them. Nothing else
 * under the config directory is touched: a host-run store or keys root, or a file another tool
 * left there, is listed and left in place.
 */

export type UninstallScope = "all" | "server" | "home";

export interface UninstallArgs {
  readonly scope: UninstallScope | null;
  readonly yes: boolean;
}

export const UNINSTALL_USAGE = "usage: mend uninstall [--all | --server | --home] [--yes]";

/** Exactly one scope flag at most, `--yes` anywhere; anything else is a usage error. */
export const parseUninstallArgs = (
  args: ReadonlyArray<string>,
): UninstallArgs | { readonly error: string } => {
  let scope: UninstallScope | null = null;
  let yes = false;
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    const next: UninstallScope | null =
      arg === "--all" ? "all" : arg === "--server" ? "server" : arg === "--home" ? "home" : null;
    if (next === null) return { error: `${UNINSTALL_USAGE} · "${arg}" is not an option` };
    if (scope !== null && scope !== next) {
      return { error: `${UNINSTALL_USAGE} · pick one scope` };
    }
    scope = next;
  }
  return { scope, yes };
};

/** What the CLI knows about this machine, gathered once at the command boundary. */
export interface UninstallRuntime {
  readonly server: ServerSetupRuntime;
  /** `$XDG_CONFIG_HOME/mend` (or the legacy `~/.mend`): where cli.json and the ssh key live. */
  readonly cliHome: string;
  /** `~/.ssh/config`, where `mend ssh setup` keeps its managed block. */
  readonly sshConfigFile: string;
  /** The saved sign-in, when there is one. */
  readonly signedIn: { readonly url: string; readonly deviceId: string | null } | null;
  /** Revoke this terminal's device token; resolves to the failure's words, or null when done. */
  revokeDevice(): Promise<string | null>;
  /** Remove the workspace SSH keys this machine registered, and only those. */
  removeWorkspaceSshKey(): Promise<ThisMachineKeyRemoval>;
  /**
   * Clear the saved token (cli.json stays), once the server it was issued by is deleted: it can
   * never be used or revoked again. Absent: the token stays in the file.
   */
  forgetSignIn?(): void;
}

/** One workspace container of this installation's sessions. */
export interface WorkspaceHolding {
  readonly name: string;
  /** Running: a live session (or a warm standby) works in it right now. */
  readonly running: boolean;
}

/** What Docker holds for the installation's sessions: workspaces, their sidecars and networks. */
export interface DockerHoldings {
  readonly workspaces: ReadonlyArray<WorkspaceHolding>;
  /** Each workspace's Docker service (`<workspace>-docker`), labelled with its workspace. */
  readonly sidecars: ReadonlyArray<string>;
  /** Each workspace's own network (`<workspace>-network`). */
  readonly networks: ReadonlyArray<string>;
  /** The images the workspaces and sidecars run, for `all` to remove with the rest. */
  readonly images: ReadonlyArray<string>;
}

const NO_HOLDINGS: DockerHoldings = { workspaces: [], sidecars: [], networks: [], images: [] };

/** With `all`: what else Mend put on the Docker host, beside the installation itself. */
export interface HostExtras {
  /** Image references (tags) Mend pulled or built that are on the daemon now. */
  readonly images: ReadonlyArray<string>;
  /** Their size on disk, each image counted once however many tags it has. */
  readonly imageBytes: number;
  /** Docker's own words for the build cache's size; null when it holds none or did not say. */
  readonly buildCache: string | null;
  /**
   * The user-namespace sysctl file: absent, written by setup (`mend`), written by hand, or not
   * readable through Docker; with the setting that puts the kernel back once it is gone, when known.
   */
  readonly sysctl:
    | { readonly state: "absent" | "unknown" }
    | { readonly state: "mend" | "by-hand"; readonly restore: SysctlSetting | null };
}

/** One kernel setting, as `sysctl -w key=value` takes it. */
export interface SysctlSetting {
  readonly key: string;
  readonly value: string;
}

export interface ServerPlan {
  readonly version: string;
  readonly appUrl: string;
  readonly dockerContext: string;
  /** The TLS edge's host when the install runs one; its container and volumes go with the rest. */
  readonly edgeHost: string | null;
  /** The mirrors' Compose services the install runs; their containers and caches go too. */
  readonly mirrors?: ReadonlyArray<string>;
  /**
   * Whether the t3code gateway's volume goes too: it is on, or one turned off left its volume
   * behind. The volume holds paired people's Mend device tokens.
   */
  readonly t3GatewayVolume?: boolean;
  readonly generations: number;
  readonly backups: number;
  /** Why Docker did not answer on the installation's context; null or absent when it did. */
  readonly dockerProblem?: string | null;
  /** The installation's workspaces, found by the control volume they mount. */
  readonly holdings?: DockerHoldings;
  /** What an earlier `mend uninstall` could not remove, from `uninstall-left.json`. */
  readonly leftByEarlier?: ReadonlyArray<string>;
  /** With `all`: images, build cache and the sysctl file. */
  readonly extras?: HostExtras;
}

/**
 * No installation is configured here, but Docker holds what one left: volumes with Mend's
 * installation label and no anchor beside them (a partial uninstall by an earlier release).
 */
export interface LeftoversPlan {
  readonly kind: "leftovers";
  readonly dockerContext: string;
  readonly volumes: ReadonlyArray<string>;
  readonly networks: ReadonlyArray<string>;
  readonly containers: ReadonlyArray<string>;
  readonly holdings: DockerHoldings;
}

export interface HomePlan {
  readonly cliConfig: string | null;
  readonly sshDirectory: string | null;
  readonly managedSshBlocks: number;
  readonly signedIn: UninstallRuntime["signedIn"];
  /**
   * The sign-in is to the server this uninstall deletes: its device token and workspace ssh key
   * live in that server's database and go with it, so there is nothing to revoke.
   */
  readonly signedInToThisServer?: boolean;
}

export interface UninstallPlan {
  readonly scope: UninstallScope;
  /** `null` when the server is out of scope; `"none"` when nothing is installed here. */
  readonly server: ServerPlan | LeftoversPlan | "none" | null;
  readonly home: HomePlan | null;
}

/** The server files uninstall owns; the lock directory is the store's and everything else stays. */
const SERVER_FILES = ["identity.env", "active", "generations", "backups"] as const;
/** What an unfinished uninstall left, for the next run to finish. */
const LEFT_FILE = "uninstall-left.json";

/** Sealant's Docker adapter runs each workspace's Docker service from this image by default. */
const DOCKER_SERVICE_IMAGE = "docker:27.5.1-dind-rootless";
/** Sealant names the workspace images it builds `sealant-workspace-<family>[-<harness>]`. */
const WORKSPACE_IMAGE_REFERENCE = "sealant-workspace-*";
/** And labels each with the plan it was built from. */
const WORKSPACE_IMAGE_LABEL = "sh.sealant.plan-hash";
/** The Mend image's label naming the image the worker runs to guard each workspace's network. */
const NETWORK_GUARD_IMAGE_LABEL = "dev.sealant.mend.network-guard-image";
/**
 * The bundle's own Compose volumes, as Compose names them under the `mend` project. Another Compose
 * project called mend (a checkout of Mend's own repository, say) has other volumes.
 */
const BUNDLE_COMPOSE_VOLUMES = new Set(
  [
    "mend-config",
    "mend-ssh",
    "mend-postgres",
    "mend-edge-data",
    "mend-edge-config",
    "mend-npm-mirror",
    "mend-docker-mirror",
    T3_GATEWAY_VOLUME,
  ].map((volume) => `${MEND_DOCKER_NAMESPACE.project}_${volume}`),
);
/** The bundle's Compose networks: the project's default, and the edge's when it runs one. */
const BUNDLE_NETWORKS = new Set(
  ["default", "edge"].map((network) => `${MEND_DOCKER_NAMESPACE.project}_${network}`),
);
/** A Compose container a Mend generation started: its working directory is the generation's. */
const GENERATION_DIRECTORY = /\/generations\/gen-[0-9a-f-]{36}$/;
/** Every install pulls it and it has a shell: the helper that reads and removes the sysctl file. */
const HOST_HELPER_IMAGE = "postgres:17-alpine";
/** What each user-namespace setting is on a host Mend never touched. */
const SYSCTL_DEFAULTS: Readonly<Record<string, string>> = {
  "kernel.apparmor_restrict_unprivileged_userns": "1",
  "kernel.unprivileged_userns_clone": "0",
};

const DOCKER_DEADLINE_MS = serverProcessDeadlines.ordinary;
/** A name Docker would accept, and nothing that reads as an option. */
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const IMAGE_REFERENCE = /^[a-z0-9][A-Za-z0-9._/:@-]*$/;

type Run = ServerSetupRuntime["run"];

const dockerIn = (
  run: Run,
  context: string,
  args: ReadonlyArray<string>,
  timeoutMs: number = DOCKER_DEADLINE_MS,
): Promise<ServerProcessOutput> => run("docker", ["--context", context, ...args], { timeoutMs });

const detail = (output: ServerProcessOutput): string =>
  (output.error ?? output.stderr.trim()) || "no output";

const rows = (stdout: string): ReadonlyArray<ReadonlyArray<string>> =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));

/** Docker's words for a container, volume, network or image that is not there. */
const notFound = (output: ServerProcessOutput): boolean =>
  output.status !== null &&
  /no such (container|volume|network|image|object)|network \S+ not found/i.test(output.stderr);

const countEntries = (directory: string): number => {
  try {
    return fs.readdirSync(directory).length;
  } catch {
    return 0;
  }
};

const exists = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const managedBlockCount = (sshConfigFile: string): number => {
  let config: string;
  try {
    config = fs.readFileSync(sshConfigFile, "utf8");
  } catch {
    return 0;
  }
  const stripped = stripManagedWorkspaceSshBlocks(config);
  return stripped.ok ? stripped.value.removed : 0;
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const listOf = (names: ReadonlyArray<string>, shown = 3): string =>
  `${names.slice(0, shown).join(", ")}${names.length > shown ? `, and ${names.length - shown} more` : ""}`;

/** Bytes as Docker prints them (decimal units), for a plan line. */
export const formatBytes = (bytes: number): string => {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
};

// ─── reading Docker ─────────────────────────────────────────────────────────

/** Null when Docker answers on the context; otherwise its words for why not. */
export const dockerProblemOn = async (run: Run, context: string): Promise<string | null> => {
  const version = await dockerIn(run, context, [
    "version",
    "--format",
    "{{.Client.APIVersion}} {{.Server.APIVersion}}",
  ]);
  if (version.status === 0 && version.stdout.trim().split(/\s+/).length === 2) return null;
  return detail(version).split("\n").at(-1) ?? "no output";
};

/** A volume's installation label: absent volume, its owner (null when unlabelled), or why unknown. */
const volumeOwner = async (
  run: Run,
  context: string,
  name: string,
): Promise<
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly owner: string | null }
  | { readonly state: "unknown"; readonly detail: string }
> => {
  const inspected = await dockerIn(run, context, [
    "volume",
    "inspect",
    name,
    "--format",
    "{{json .}}",
  ]);
  if (inspected.status !== 0) {
    return notFound(inspected)
      ? { state: "absent" }
      : { state: "unknown", detail: detail(inspected) };
  }
  try {
    const volume: unknown = JSON.parse(inspected.stdout);
    if (typeof volume !== "object" || volume === null || !("Labels" in volume)) {
      return { state: "unknown", detail: "volume inspect said nothing of its labels" };
    }
    const labels = volume.Labels;
    if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
      return { state: "present", owner: null };
    }
    const owner: unknown = Object.entries(labels).find(
      ([key]) => key === SERVER_VOLUME_OWNER_LABEL,
    )?.[1];
    return { state: "present", owner: typeof owner === "string" ? owner : null };
  } catch {
    return { state: "unknown", detail: "volume inspect did not answer in JSON" };
  }
};

const listNamesIn = async (
  run: Run,
  context: string,
  kind: "volume" | "network" | "container",
  filters: ReadonlyArray<string>,
): Promise<ReadonlyArray<string> | { readonly problem: string }> => {
  const listed = await dockerIn(run, context, [
    kind,
    "ls",
    ...(kind === "container" ? ["--all"] : []),
    ...filters.flatMap((filter) => ["--filter", filter]),
    "--format",
    kind === "container" ? "{{.Names}}" : "{{.Name}}",
  ]);
  if (listed.status !== 0) return { problem: detail(listed) };
  return rows(listed.stdout)
    .map(([name]) => name ?? "")
    .filter((name) => DOCKER_NAME.test(name));
};

/**
 * The workspaces that mount the installation's control volume, with their Docker sidecars and
 * networks. Only call it once the volume's label proves it this installation's.
 */
export const findWorkspaces = async (
  run: Run,
  context: string,
  controlVolume: string,
): Promise<DockerHoldings | { readonly problem: string }> => {
  const mounted = await dockerIn(run, context, [
    "container",
    "ls",
    "--all",
    "--filter",
    `volume=${controlVolume}`,
    "--format",
    "{{.Names}}\t{{.State}}\t{{.Image}}",
  ]);
  if (mounted.status !== 0) return { problem: detail(mounted) };
  const workspaces = rows(mounted.stdout).flatMap(([name, state]) =>
    name !== undefined && DOCKER_NAME.test(name) ? [{ name, running: state === "running" }] : [],
  );
  const images = new Set(
    rows(mounted.stdout).flatMap(([, , image]) =>
      image !== undefined && IMAGE_REFERENCE.test(image) ? [image] : [],
    ),
  );
  if (workspaces.length === 0) return NO_HOLDINGS;
  const names = new Set(workspaces.map((workspace) => workspace.name));
  const labelled = await dockerIn(run, context, [
    "container",
    "ls",
    "--all",
    "--filter",
    "label=sealant.workspace",
    "--format",
    '{{.Names}}\t{{.Label "sealant.workspace"}}\t{{.Image}}',
  ]);
  if (labelled.status !== 0) return { problem: detail(labelled) };
  const sidecars = rows(labelled.stdout).flatMap(([name, workspace, image]) => {
    if (name === undefined || !DOCKER_NAME.test(name) || !names.has(workspace ?? "")) return [];
    if (image !== undefined && IMAGE_REFERENCE.test(image)) images.add(image);
    return [name];
  });
  const networks = await listNamesIn(run, context, "network", ["name=sealant-"]);
  if ("problem" in networks) return networks;
  const wanted = new Set([...names].map((name) => `${name}-network`));
  return {
    workspaces,
    sidecars,
    networks: networks.filter((name) => wanted.has(name)),
    images: [...images],
  };
};

/** Whatever an earlier run wrote to `uninstall-left.json`; empty when there is none. */
const readLeft = (configDir: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(configDir, LEFT_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("names" in parsed)) return [];
    const names = parsed.names;
    return Array.isArray(names)
      ? names.filter((name): name is string => typeof name === "string" && DOCKER_NAME.test(name))
      : [];
  } catch {
    return [];
  }
};

/** Read the sysctl file through a short container on the Docker host it lives on. */
const readSysctlFile = async (run: Run, context: string): Promise<HostExtras["sysctl"]> => {
  const read = await dockerIn(run, context, [
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    "none",
    "--volume",
    `${path.dirname(HOST_USER_NAMESPACE_SYSCTL_FILE)}:/host/sysctl.d:ro`,
    "--entrypoint",
    "sh",
    HOST_HELPER_IMAGE,
    "-c",
    `f=/host/sysctl.d/${path.basename(HOST_USER_NAMESPACE_SYSCTL_FILE)}; [ -e "$f" ] || exit 3; cat "$f"`,
  ]);
  if (read.status === 3) return { state: "absent" };
  if (read.status !== 0) return { state: "unknown" };
  return sysctlFileOf(read.stdout);
};

/** `key = value` → the setting, when it is one of the user-namespace settings Mend knows. */
const parseSysctl = (line: string | undefined): SysctlSetting | null => {
  const [key, value] = (line ?? "").split("=").map((part) => part.trim());
  return key !== undefined && value !== undefined && key in SYSCTL_DEFAULTS && /^\d+$/.test(value)
    ? { key, value }
    : null;
};

/**
 * What the file is and what puts the kernel back: setup's file says on its first line that setup
 * wrote it and on its second what the kernel had before; without that line, or in a file written
 * by hand, the distribution's default for the setting the file holds.
 */
export const sysctlFileOf = (content: string): HostExtras["sysctl"] => {
  const lines = content.split("\n").map((line) => line.trim());
  const previous = parseSysctl(
    lines
      .find((line) => line.startsWith(HOST_USER_NAMESPACE_SYSCTL_PREVIOUS))
      ?.slice(HOST_USER_NAMESPACE_SYSCTL_PREVIOUS.length),
  );
  const setting = parseSysctl(lines.find((line) => line !== "" && !line.startsWith("#")));
  const fallback =
    setting === null ? null : { key: setting.key, value: SYSCTL_DEFAULTS[setting.key] ?? "" };
  return {
    state: lines[0] === HOST_USER_NAMESPACE_SYSCTL_MARKER ? "mend" : "by-hand",
    restore: previous ?? fallback,
  };
};

/** What removes the file and puts the host's own setting back, run by hand. */
export const sysctlRestoreCommand = (restore: SysctlSetting | null): string =>
  `sudo rm ${HOST_USER_NAMESPACE_SYSCTL_FILE}${restore === null ? " && sudo sysctl --system" : ` && sudo sysctl -w ${restore.key}=${restore.value}`}`;

/** The images Mend pulled or built on this daemon, with their size (each image once). */
const findImages = async (
  run: Run,
  context: string,
  candidates: ReadonlyArray<string>,
): Promise<{ readonly images: ReadonlyArray<string>; readonly bytes: number }> => {
  const references = new Set(candidates);
  for (const filter of [
    `reference=${WORKSPACE_IMAGE_REFERENCE}`,
    `label=${WORKSPACE_IMAGE_LABEL}`,
  ]) {
    const listed = await dockerIn(run, context, [
      "image",
      "ls",
      "--filter",
      filter,
      "--format",
      "{{.Repository}}:{{.Tag}}\t{{.ID}}",
    ]);
    if (listed.status !== 0) continue;
    for (const [reference, id] of rows(listed.stdout)) {
      // An untagged image goes by its id.
      const name = reference?.includes("<none>") ? id : reference;
      if (name !== undefined && IMAGE_REFERENCE.test(name)) references.add(name);
    }
  }
  const images: Array<string> = [];
  const sizes = new Map<string, number>();
  for (const reference of references) {
    const inspected = await dockerIn(run, context, [
      "image",
      "inspect",
      reference,
      "--format",
      "{{.Id}}\t{{.Size}}",
    ]);
    if (inspected.status !== 0) continue;
    const [id, size] = rows(inspected.stdout)[0] ?? [];
    images.push(reference);
    if (id !== undefined) sizes.set(id, Number(size) || 0);
  }
  return { images, bytes: [...sizes.values()].reduce((sum, size) => sum + size, 0) };
};

/** Docker's build cache size, in its own words; null when there is none or it did not say. */
const buildCacheSize = async (run: Run, context: string): Promise<string | null> => {
  const df = await dockerIn(run, context, ["system", "df", "--format", "{{json .}}"]);
  if (df.status !== 0) return null;
  for (const line of df.stdout.split("\n")) {
    try {
      const entry: unknown = JSON.parse(line);
      if (
        typeof entry === "object" &&
        entry !== null &&
        "Type" in entry &&
        entry.Type === "Build Cache" &&
        "Size" in entry &&
        typeof entry.Size === "string"
      ) {
        return /^0(\.0+)?\s*B$/.test(entry.Size.trim()) ? null : entry.Size;
      }
    } catch {
      // Not a JSON line; Docker prints none, but a wrapper might.
    }
  }
  return null;
};

/** Leftovers of an install with no configuration here, on the current Docker context. */
const findLeftovers = async (run: Run): Promise<LeftoversPlan | null> => {
  const shown = await run("docker", ["context", "show"], { timeoutMs: DOCKER_DEADLINE_MS });
  const context = shown.status === 0 ? shown.stdout.trim() : "";
  if (!DOCKER_NAME.test(context)) return null;
  const labelled = await listNamesIn(run, context, "volume", [
    `label=${SERVER_VOLUME_OWNER_LABEL}`,
  ]);
  if ("problem" in labelled || labelled.length === 0) return null;
  // An anchor means an installation stands here, whoever's configuration it is: not leftovers.
  if (labelled.includes(MEND_DOCKER_NAMESPACE.store)) return null;
  const compose = `label=com.docker.compose.project=${MEND_DOCKER_NAMESPACE.project}`;
  const composeVolumes = await listNamesIn(run, context, "volume", [compose]);
  const networks = await listNamesIn(run, context, "network", [compose]);
  const composed = await dockerIn(run, context, [
    "container",
    "ls",
    "--all",
    "--filter",
    compose,
    "--format",
    '{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}',
  ]);
  const holdings = labelled.includes(MEND_DOCKER_NAMESPACE.control)
    ? await findWorkspaces(run, context, MEND_DOCKER_NAMESPACE.control)
    : NO_HOLDINGS;
  return {
    kind: "leftovers",
    dockerContext: context,
    volumes: [
      ...labelled,
      ...("problem" in composeVolumes
        ? []
        : composeVolumes.filter((name) => BUNDLE_COMPOSE_VOLUMES.has(name))),
    ],
    networks: "problem" in networks ? [] : networks.filter((name) => BUNDLE_NETWORKS.has(name)),
    containers:
      composed.status === 0
        ? rows(composed.stdout).flatMap(([name, directory]) =>
            name !== undefined &&
            DOCKER_NAME.test(name) &&
            GENERATION_DIRECTORY.test(directory ?? "")
              ? [name]
              : [],
          )
        : [],
    holdings: "problem" in holdings ? NO_HOLDINGS : holdings,
  };
};

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};
const isLoopback = (host: string): boolean =>
  ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
const portOf = (url: URL): string => url.port || (url.protocol === "https:" ? "443" : "80");

/**
 * Whether a saved sign-in is to the server at `appUrl` (or its edge): the same origin, or this
 * machine's loopback on the same port.
 */
export const signedInTo = (
  signedInUrl: string,
  appUrl: string,
  edgeHost: string | null,
): boolean => {
  const signed = parseUrl(signedInUrl);
  if (signed === null) return false;
  if (edgeHost !== null && signed.protocol === "https:" && signed.hostname === edgeHost)
    return true;
  const app = parseUrl(appUrl);
  if (app === null) return false;
  if (signed.origin === app.origin) return true;
  return isLoopback(signed.hostname) && portOf(signed) === portOf(app);
};

// ─── the plan ───────────────────────────────────────────────────────────────

/** Read what each scope would remove. The server is read under its lock; nothing changes. */
export const describeUninstall = async (
  runtime: UninstallRuntime,
  scope: UninstallScope,
): Promise<UninstallPlan> => {
  let server: UninstallPlan["server"] = null;
  const run = runtime.server.run;
  if (scope !== "home") {
    const configDir = runtime.server.configDir;
    const read = await withServerStore(
      configDir,
      async (store) => {
        const installation = readServerInstallation(store);
        if (installation._tag === "error") throw installation.error;
        const identity = store.readIdentity();
        if (identity._tag === "error") throw identity.error;
        return { installation: installation.value, identity: identity.value };
      },
      { create: false },
    );
    if (read._tag === "error") {
      // An unconfigured directory is not an error for uninstall: there is nothing to remove,
      // unless Docker holds what an earlier install left.
      if (!read.error.message.startsWith("No Mend server is configured")) throw read.error;
      server = (await findLeftovers(run)) ?? "none";
    } else if (read.value.installation === null) {
      server = exists(path.join(configDir, "identity.env"))
        ? {
            version: "(no active generation)",
            appUrl: "",
            dockerContext: "",
            edgeHost: null,
            generations: countEntries(path.join(configDir, "generations")),
            backups: countEntries(path.join(configDir, "backups")),
          }
        : ((await findLeftovers(run)) ?? "none");
    } else {
      const { config, directory } = read.value.installation;
      const context = config.dockerContext;
      const dockerProblem = await dockerProblemOn(run, context);
      let holdings: DockerHoldings = NO_HOLDINGS;
      let t3GatewayVolume = config.t3GatewayPort !== undefined;
      let extras: HostExtras | undefined;
      if (dockerProblem === null) {
        t3GatewayVolume ||=
          (await volumeOwner(run, context, `mend_${T3_GATEWAY_VOLUME}`)).state === "present";
        const control = await volumeOwner(run, context, MEND_DOCKER_NAMESPACE.control);
        const owner =
          read.value.identity === null ? null : serverVolumeOwner(Buffer.from(read.value.identity));
        if (control.state === "present" && owner !== null && control.owner === owner) {
          const found = await findWorkspaces(run, context, MEND_DOCKER_NAMESPACE.control);
          if (!("problem" in found)) holdings = found;
        }
        if (scope === "all") {
          const composed = await run(
            "docker",
            serverComposeArgs(
              { directory, dockerContext: context, overlays: composeOverlays(config) },
              ["config", "--images"],
            ),
            { timeoutMs: DOCKER_DEADLINE_MS },
          );
          const mendImage = `ghcr.io/sealant-sh/mend:${config.serverVersion}`;
          const guard = await dockerIn(run, context, [
            "image",
            "inspect",
            mendImage,
            "--format",
            `{{index .Config.Labels "${NETWORK_GUARD_IMAGE_LABEL}"}}`,
          ]);
          const candidates = [
            ...(composed.status === 0 ? composed.stdout.split(/\s+/) : []),
            ...(guard.status === 0 ? [guard.stdout.trim()] : []),
            DOCKER_SERVICE_IMAGE,
            ...holdings.images,
          ].filter((image) => IMAGE_REFERENCE.test(image) && image !== mendImage);
          const found = await findImages(run, context, [...new Set(candidates)]);
          extras = {
            images: found.images,
            imageBytes: found.bytes,
            buildCache: await buildCacheSize(run, context),
            sysctl: await readSysctlFile(run, context),
          };
        }
      }
      server = {
        version: config.serverVersion,
        appUrl: config.appUrl,
        dockerContext: context,
        edgeHost: config.edgeHost ?? null,
        mirrors: mirrorServices(config.mirrors),
        t3GatewayVolume,
        generations: countEntries(path.join(configDir, "generations")),
        backups: countEntries(path.join(configDir, "backups")),
        dockerProblem,
        holdings,
        leftByEarlier: readLeft(configDir),
        ...(extras === undefined ? {} : { extras }),
      };
    }
  }
  let home: HomePlan | null = null;
  if (scope !== "server") {
    const cliConfig = path.join(runtime.cliHome, "cli.json");
    const sshDirectory = path.join(runtime.cliHome, "ssh");
    home = {
      cliConfig: exists(cliConfig) ? cliConfig : null,
      sshDirectory: exists(sshDirectory) ? sshDirectory : null,
      managedSshBlocks: managedBlockCount(runtime.sshConfigFile),
      signedIn: runtime.signedIn,
      signedInToThisServer:
        runtime.signedIn !== null &&
        isInstallation(server) &&
        server.appUrl !== "" &&
        signedInTo(runtime.signedIn.url, server.appUrl, server.edgeHost),
    };
  }
  return { scope, server, home };
};

const isInstallation = (server: UninstallPlan["server"]): server is ServerPlan =>
  server !== null && server !== "none" && !("kind" in server);

const isLeftovers = (server: UninstallPlan["server"]): server is LeftoversPlan =>
  server !== null && server !== "none" && "kind" in server;

/** Why the plan cannot run as asked, before anything is touched; null when it can. */
export const planRefusal = (plan: UninstallPlan): string | null => {
  if (!isInstallation(plan.server) || plan.server.dockerProblem == null) return null;
  return `Docker is not answering on context ${plan.server.dockerContext} (${plan.server.dockerProblem}), so nothing was removed. Start Docker and run mend uninstall again${plan.scope === "all" ? ", or run mend uninstall --home to remove only this machine's files" : ""}.`;
};

const workspaceLines = (holdings: DockerHoldings, context: string): ReadonlyArray<string> => {
  if (holdings.workspaces.length === 0) return [];
  const running = holdings.workspaces.filter((workspace) => workspace.running);
  const names = holdings.workspaces.map((workspace) => workspace.name);
  return [
    `sessions ${running.length === 0 ? "none live" : `${plural(running.length, "live session")}`} · ${plural(names.length, "workspace container")} on docker context ${context} (${listOf(names)})`,
    `         ${running.length === 0 ? "they are removed" : "uninstall stops them, then removes them"} with their Docker services, volumes and networks; unsaved work in them is lost`,
  ];
};

/** The plan as the terminal shows it before asking: one line per thing that goes. */
export const planLines = (plan: UninstallPlan, configDir: string): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  if (plan.server === "none") {
    lines.push(`server   none installed under ${configDir}`);
  } else if (isLeftovers(plan.server)) {
    const { dockerContext, volumes, networks, containers, holdings } = plan.server;
    lines.push(
      `server   none configured under ${configDir}, but docker context ${dockerContext} holds what an earlier Mend install left:`,
    );
    if (containers.length > 0) lines.push(`         containers ${containers.join(", ")}`);
    lines.push(`         volumes ${volumes.join(", ")}`);
    if (networks.length > 0) lines.push(`         networks ${networks.join(", ")}`);
    lines.push(...workspaceLines(holdings, dockerContext));
  } else if (plan.server !== null) {
    const { version, appUrl, dockerContext, edgeHost, generations, backups } = plan.server;
    lines.push(
      `server   Mend ${version}${appUrl === "" ? "" : ` at ${appUrl}`}${dockerContext === "" ? "" : ` · docker context ${dockerContext}`}`,
    );
    if (dockerContext !== "") {
      const mirrors = plan.server.mirrors ?? [];
      const edge = [...(edgeHost === null ? [] : ["edge"]), ...mirrors];
      const edgeVolumes = [
        ...(edgeHost === null ? [] : ["mend-edge-data", "mend-edge-config"]),
        ...mirrors.map((service) => `mend-${service}`),
        // The t3code gateway's state, with paired people's device tokens, when it is there.
        ...(plan.server.t3GatewayVolume === true ? [T3_GATEWAY_VOLUME] : []),
      ];
      lines.push(
        `         containers ${["mend", "postgres", "garage", ...edge].join(", ")} · volumes ${[MEND_DOCKER_NAMESPACE_WITH_GARAGE.store, ...secondaryVolumesOf(MEND_DOCKER_NAMESPACE_WITH_GARAGE), "mend-config", "mend-ssh", "mend-postgres", ...edgeVolumes].join(", ")} · image ghcr.io/sealant-sh/mend:${version}${edgeHost === null ? "" : ` · the edge for ${edgeHost}`}`,
      );
    }
    lines.push(
      `         ${configDir}: identity.env, active, ${plural(generations, "generation")}, ${plural(backups, "backup")}`,
    );
    lines.push(...workspaceLines(plan.server.holdings ?? NO_HOLDINGS, dockerContext));
    const left = plan.server.leftByEarlier ?? [];
    if (left.length > 0)
      lines.push(`         left by an earlier mend uninstall: ${left.join(", ")}`);
    const extras = plan.server.extras;
    if (extras !== undefined) {
      if (extras.images.length > 0) {
        lines.push(
          `images   ${plural(extras.images.length, "image")} Mend pulled or built, ${formatBytes(extras.imageBytes)}: ${listOf(extras.images, 4)}`,
        );
      }
      if (extras.buildCache !== null) {
        lines.push(
          `         Docker's build cache, ${extras.buildCache}: shared by every build on this daemon, so uninstall asks about it separately`,
        );
      }
      if (extras.sysctl.state === "mend") {
        lines.push(
          `host     ${HOST_USER_NAMESPACE_SYSCTL_FILE}, which setup wrote${extras.sysctl.restore === null ? "" : `; ${extras.sysctl.restore.key} goes back to ${extras.sysctl.restore.value}`}`,
        );
      } else if (extras.sysctl.state === "by-hand") {
        lines.push(
          `host     ${HOST_USER_NAMESPACE_SYSCTL_FILE} stays: setup did not write it (to restore the default: ${sysctlRestoreCommand(extras.sysctl.restore)})`,
        );
      }
    }
  }
  if (plan.home !== null) {
    const parts: Array<string> = [];
    if (plan.home.cliConfig !== null) {
      parts.push(
        plan.home.signedIn === null
          ? plan.home.cliConfig
          : `${plan.home.cliConfig} (signed in to ${plan.home.signedIn.url})`,
      );
    }
    if (plan.home.sshDirectory !== null) parts.push(plan.home.sshDirectory);
    if (plan.home.managedSshBlocks > 0) {
      parts.push(`${plural(plan.home.managedSshBlocks, "managed block")} in ~/.ssh/config`);
    }
    if (plan.home.signedIn !== null && plan.home.signedInToThisServer !== true) {
      parts.push(`this machine's workspace ssh key on ${plan.home.signedIn.url}, if registered`);
    }
    lines.push(parts.length === 0 ? "home     nothing of Mend's here" : `home     ${parts[0]}`);
    for (const part of parts.slice(1)) lines.push(`         ${part}`);
  }
  return lines;
};

/** True when the plan deletes repositories, worktrees or a database: the typed confirmation gate. */
export const planDeletesData = (plan: UninstallPlan): boolean =>
  plan.server !== null && plan.server !== "none";

/** True when there is nothing at all to remove. */
export const planIsEmpty = (plan: UninstallPlan): boolean =>
  (plan.server === null || plan.server === "none") &&
  (plan.home === null ||
    (plan.home.cliConfig === null &&
      plan.home.sshDirectory === null &&
      plan.home.managedSshBlocks === 0));

// ─── carrying it out ────────────────────────────────────────────────────────

export interface UninstallOutcome {
  /** What could not be done, in the words a person can act on. Empty means clean. */
  readonly failures: ReadonlyArray<string>;
  /** Things left in place on purpose, each with why. */
  readonly leftovers: ReadonlyArray<string>;
  /** Short names of what stays on this machine, for the last line; empty when nothing does. */
  readonly remaining: ReadonlyArray<string>;
}

interface Report {
  readonly write: (line: string) => void;
  readonly failures: Array<string>;
  readonly leftovers: Array<string>;
  readonly remaining: Array<string>;
}

/**
 * Remove workspace containers (with their anonymous volumes: the Docker service keeps its image
 * store in one) and then their networks. Returns the names it could not remove.
 */
const removeWorkspaces = async (
  run: Run,
  context: string,
  holdings: DockerHoldings,
  report: Report,
): Promise<ReadonlyArray<string>> => {
  const left: Array<string> = [];
  const containers = [
    ...holdings.workspaces.map((workspace) => workspace.name),
    ...holdings.sidecars,
  ];
  const removed: Array<string> = [];
  for (const name of containers) {
    const gone = await dockerIn(run, context, ["container", "rm", "-f", "-v", name], 120_000);
    if (gone.status === 0 || notFound(gone)) removed.push(name);
    else {
      left.push(name);
      report.failures.push(
        `could not remove workspace container ${name}: ${detail(gone)}. To remove it: docker --context ${context} rm -f -v ${name}`,
      );
    }
  }
  if (removed.length > 0) {
    const live = holdings.workspaces.filter(
      (workspace) => workspace.running && removed.includes(workspace.name),
    ).length;
    report.write(
      `removed ${plural(removed.length, "workspace container")}${live > 0 ? `, ${live} of them live` : ""}, with their volumes (${listOf(removed)})`,
    );
  }
  const networks: Array<string> = [];
  for (const name of holdings.networks) {
    const gone = await dockerIn(run, context, ["network", "rm", name]);
    if (gone.status === 0 || notFound(gone)) networks.push(name);
    else {
      left.push(name);
      report.failures.push(
        `could not remove network ${name}: ${detail(gone)}. To remove it: docker --context ${context} network rm ${name}`,
      );
    }
  }
  if (networks.length > 0) report.write(`removed workspace networks ${listOf(networks)}`);
  return left;
};

/** Remove named networks and volumes, each on its own, saying which went and which did not. */
const removeEach = async (
  run: Run,
  context: string,
  kind: "network" | "volume",
  names: ReadonlyArray<string>,
  report: Report,
): Promise<ReadonlyArray<string>> => {
  const left: Array<string> = [];
  const removed: Array<string> = [];
  for (const name of names) {
    const gone = await dockerIn(run, context, [kind, "rm", name]);
    if (gone.status === 0 || notFound(gone)) removed.push(name);
    else {
      left.push(name);
      report.failures.push(`could not remove ${kind} ${name}: ${detail(gone)}`);
    }
  }
  if (removed.length > 0)
    report.write(`removed ${kind}${removed.length === 1 ? "" : "s"} ${removed.join(", ")}`);
  return left;
};

const listed = (names: ReadonlyArray<string> | { readonly problem: string }, name: string) =>
  !("problem" in names) && names.includes(name);

/** The pending names from an earlier run that are still there, as workspace holdings. */
const pendingHoldings = async (
  run: Run,
  context: string,
  names: ReadonlyArray<string>,
): Promise<{ readonly holdings: DockerHoldings; readonly volumes: ReadonlyArray<string> }> => {
  if (names.length === 0) return { holdings: NO_HOLDINGS, volumes: [] };
  const containers = await listNamesIn(run, context, "container", []);
  const networks = await listNamesIn(run, context, "network", []);
  const volumes = await listNamesIn(run, context, "volume", []);
  return {
    holdings: {
      workspaces: names
        .filter((name) => listed(containers, name))
        .map((name) => ({ name, running: false })),
      sidecars: [],
      networks: names.filter((name) => listed(networks, name)),
      images: [],
    },
    volumes: names.filter((name) => listed(volumes, name)),
  };
};

const removeServer = async (
  runtime: UninstallRuntime,
  plan: ServerPlan,
  report: Report,
): Promise<"removed" | "partial" | "refused"> => {
  const { server } = runtime;
  const run = server.run;
  const configDir = server.configDir;
  let outcome: "removed" | "partial" | "refused" = "removed";
  const result = await withServerStore(
    configDir,
    async (store) => {
      const read = readServerInstallation(store);
      if (read._tag === "error") throw read.error;
      const installation = read.value;
      const identity = store.readIdentity();
      if (identity._tag === "error") throw identity.error;
      const left: Array<string> = [];
      if (installation !== null) {
        const context = installation.config.dockerContext;
        // Nothing is touched while Docker does not answer: a refusal in Mend's words.
        const problem = await dockerProblemOn(run, context);
        if (problem !== null) {
          throw new ServerRefusal(
            `Docker is not answering on context ${context} (${problem}), so nothing was removed. Start Docker and run mend uninstall again.`,
          );
        }
        const owner =
          identity.value === null ? null : serverVolumeOwner(Buffer.from(identity.value));
        const namespace =
          installation.config.bucket === "garage"
            ? MEND_DOCKER_NAMESPACE_WITH_GARAGE
            : MEND_DOCKER_NAMESPACE;
        const controlIsOurs = async (): Promise<boolean> => {
          const control = await volumeOwner(run, context, namespace.control);
          return control.state === "present" && owner !== null && control.owner === owner;
        };
        const sweepWorkspaces = async (): Promise<void> => {
          if (!(await controlIsOurs())) return;
          const found = await findWorkspaces(run, context, namespace.control);
          if ("problem" in found) {
            report.failures.push(`could not list the installation's workspaces: ${found.problem}`);
            return;
          }
          left.push(...(await removeWorkspaces(run, context, found, report)));
        };
        const target = {
          directory: installation.directory,
          dockerContext: context,
          overlays: composeOverlays(installation.config),
        };

        // The server first stops launching (its app container stops), then its sessions' workspaces
        // go, live ones included, so nothing holds the control volume or the project network.
        await run("docker", serverComposeArgs(target, ["stop", "--timeout", "30", "mend"]), {
          timeoutMs: serverProcessDeadlines.stop,
        });
        await sweepWorkspaces();
        const pending = await pendingHoldings(run, context, plan.leftByEarlier ?? []);
        left.push(...(await removeWorkspaces(run, context, pending.holdings, report)));

        // Containers, the project network and the Compose-owned volumes go together; a
        // failure here keeps the files, so the next attempt can still find the installation.
        const down = await run(
          "docker",
          serverComposeArgs(target, ["down", "--volumes", "--remove-orphans", "--timeout", "30"]),
          { timeoutMs: serverProcessDeadlines.stop },
        );
        if (down.status !== 0) {
          throw new ServerRefusal(
            `Docker did not take the server down (docker compose down: ${detail(down)}). Its volumes and files are kept; run mend uninstall again once Docker answers.`,
          );
        }
        server.writeLine(
          `removed containers ${["mend", "postgres", "garage", ...mirrorServices(installation.config.mirrors)].join(", ")} and the Compose-owned volumes`,
        );
        // A workspace the server started while it stopped.
        await sweepWorkspaces();

        // What Compose left: its project network while a workspace still held it, and the bundle's
        // volumes it could not remove. The t3code gateway's volume, with paired people's device
        // tokens, is one when the gateway was turned off: Compose no longer knows it.
        const compose = `label=com.docker.compose.project=${MEND_DOCKER_NAMESPACE.project}`;
        const networks = await listNamesIn(run, context, "network", [compose]);
        if ("problem" in networks) {
          // Unlisted is not gone: the project network counts as left, so the identity stays.
          report.failures.push(`could not list networks: ${networks.problem}`);
          left.push(`${MEND_DOCKER_NAMESPACE.project}_default`);
        } else {
          const bundle = networks.filter((name) => BUNDLE_NETWORKS.has(name));
          left.push(...(await removeEach(run, context, "network", bundle, report)));
        }
        const composeVolumes = await listNamesIn(run, context, "volume", [compose]);
        const gatewayVolume = `mend_${T3_GATEWAY_VOLUME}`;
        const gateway = await volumeOwner(run, context, gatewayVolume);
        const strayVolumes = [
          ...new Set([
            ...("problem" in composeVolumes
              ? []
              : composeVolumes.filter((name) => BUNDLE_COMPOSE_VOLUMES.has(name))),
            ...(gateway.state === "present" ? [gatewayVolume] : []),
            ...pending.volumes.filter((name) => BUNDLE_COMPOSE_VOLUMES.has(name)),
          ]),
        ];
        left.push(...(await removeEach(run, context, "volume", strayVolumes, report)));

        // The external volumes are the data. Only this installation's own label allows their
        // removal; anything else is somebody's data and stays, named. The anchor goes last.
        const owned: Array<string> = [];
        for (const name of secondaryVolumesOf(namespace)) {
          const volume = await volumeOwner(run, context, name);
          if (volume.state === "absent") continue;
          if (volume.state === "present" && owner !== null && volume.owner === owner) {
            owned.push(name);
          } else {
            report.leftovers.push(
              volume.state === "unknown"
                ? `volume ${name}: ${volume.detail}; it stays`
                : `volume ${name}: it carries another installation's label, or none, so it stays (docker --context ${context} volume inspect ${name})`,
            );
            report.remaining.push(`volume ${name}`);
          }
        }
        left.push(...(await removeEach(run, context, "volume", owned, report)));

        const image = `ghcr.io/sealant-sh/mend:${installation.config.serverVersion}`;
        const untagged = await dockerIn(run, context, ["image", "rm", image]);
        if (untagged.status === 0) server.writeLine(`removed image ${image}`);
        else if (!notFound(untagged)) {
          report.leftovers.push(`image ${image}: ${detail(untagged)}`);
          report.remaining.push(`image ${image}`);
        }

        const anchor = await volumeOwner(run, context, namespace.store);
        if (left.length > 0) {
          // Keep the anchor and the identity: they let the next run find and finish this, and a
          // reinstall over them claims what is left instead of refusing it.
          fs.writeFileSync(
            path.join(configDir, LEFT_FILE),
            `${JSON.stringify({ names: left })}\n`,
            {
              mode: 0o600,
            },
          );
          report.failures.push(
            `the uninstall is not finished: ${left.join(", ")} ${left.length === 1 ? "is" : "are"} still there. Volume ${namespace.store} and ${configDir} (identity, generations) stay so that mend uninstall can finish it; run it again, or reinstall over it with mend server setup.`,
          );
          report.remaining.push(...left, `volume ${namespace.store}`, configDir);
          outcome = "partial";
          return;
        }
        if (anchor.state === "present" && owner !== null && anchor.owner === owner) {
          left.push(...(await removeEach(run, context, "volume", [namespace.store], report)));
        } else if (anchor.state !== "absent") {
          report.leftovers.push(
            `volume ${namespace.store}: ownership could not be confirmed for this installation, so it stays (docker --context ${context} volume inspect ${namespace.store})`,
          );
          report.remaining.push(`volume ${namespace.store}`);
        }
        if (left.length > 0) {
          fs.writeFileSync(
            path.join(configDir, LEFT_FILE),
            `${JSON.stringify({ names: left })}\n`,
            {
              mode: 0o600,
            },
          );
          report.remaining.push(...left, configDir);
          outcome = "partial";
          return;
        }
      }
      // The lock directory is the store's own; its release removes it after this returns.
      for (const name of [...SERVER_FILES, LEFT_FILE]) {
        fs.rmSync(path.join(configDir, name), { recursive: true, force: true });
      }
      server.writeLine(`removed ${configDir}/{identity.env, active, generations, backups}`);
    },
    { create: false },
  );
  if (result._tag === "error") {
    report.failures.push(result.error.message);
    return "refused";
  }
  return outcome;
};

/** No configuration here: remove what an earlier install left, as the plan named it. */
const removeLeftovers = async (
  runtime: UninstallRuntime,
  plan: LeftoversPlan,
  report: Report,
): Promise<void> => {
  const run = runtime.server.run;
  const context = plan.dockerContext;
  const left: Array<string> = [];
  for (const name of plan.containers) {
    const gone = await dockerIn(run, context, ["container", "rm", "-f", "-v", name], 120_000);
    if (gone.status === 0 || notFound(gone)) report.write(`removed container ${name}`);
    else {
      left.push(name);
      report.failures.push(`could not remove container ${name}: ${detail(gone)}`);
    }
  }
  left.push(...(await removeWorkspaces(run, context, plan.holdings, report)));
  left.push(...(await removeEach(run, context, "network", plan.networks, report)));
  // Each labelled volume once more by its label at removal: nothing else's data goes.
  const volumes: Array<string> = [];
  for (const name of plan.volumes) {
    if (BUNDLE_COMPOSE_VOLUMES.has(name)) {
      volumes.push(name);
      continue;
    }
    const volume = await volumeOwner(run, context, name);
    if (volume.state === "present" && volume.owner !== null) volumes.push(name);
  }
  left.push(...(await removeEach(run, context, "volume", volumes, report)));
  if (left.length > 0) report.remaining.push(...left);
};

/** With `all`: the sysctl file setup wrote, then the images Mend pulled and built. */
const removeHostExtras = async (
  runtime: UninstallRuntime,
  context: string,
  extras: HostExtras,
  report: Report,
): Promise<void> => {
  const run = runtime.server.run;
  const sysctl = extras.sysctl;
  if (sysctl.state === "mend") {
    const { restore } = sysctl;
    const removed = await dockerIn(run, context, [
      "run",
      "--rm",
      "--pull",
      "never",
      "--privileged",
      "--network",
      "none",
      "--volume",
      `${path.dirname(HOST_USER_NAMESPACE_SYSCTL_FILE)}:/host/sysctl.d`,
      "--volume",
      "/proc/sys:/host/proc-sys",
      "--entrypoint",
      "sh",
      HOST_HELPER_IMAGE,
      "-c",
      // The marker is read again as the file goes: a file rewritten by hand since the plan stays.
      `f=/host/sysctl.d/${path.basename(HOST_USER_NAMESPACE_SYSCTL_FILE)}; [ "$(head -n 1 "$f")" = "$1" ] || exit 4; rm -f "$f" && { [ -z "$2" ] || printf '%s\\n' "$3" > "/host/proc-sys/$2"; }`,
      "mend-uninstall-userns",
      HOST_USER_NAMESPACE_SYSCTL_MARKER,
      restore === null ? "" : restore.key.replaceAll(".", "/"),
      restore === null ? "" : restore.value,
    ]);
    if (removed.status === 0) {
      report.write(
        `removed ${HOST_USER_NAMESPACE_SYSCTL_FILE}${restore === null ? "" : ` and set ${restore.key} back to ${restore.value}`}`,
      );
    } else {
      report.leftovers.push(
        `${HOST_USER_NAMESPACE_SYSCTL_FILE}: Docker could not remove it (${detail(removed)}). On the host, run: ${sysctlRestoreCommand(sysctl.restore)}`,
      );
      report.remaining.push(HOST_USER_NAMESPACE_SYSCTL_FILE);
    }
  } else if (sysctl.state === "by-hand") {
    report.leftovers.push(
      `${HOST_USER_NAMESPACE_SYSCTL_FILE}: setup did not write it, so it stays. To restore the kernel's default: ${sysctlRestoreCommand(sysctl.restore)}`,
    );
    report.remaining.push(HOST_USER_NAMESPACE_SYSCTL_FILE);
  }
  const removed: Array<string> = [];
  const kept: Array<string> = [];
  for (const image of extras.images) {
    const gone = await dockerIn(run, context, ["image", "rm", image]);
    if (gone.status === 0 || notFound(gone)) removed.push(image);
    else kept.push(image);
  }
  if (removed.length > 0) {
    report.write(`removed ${plural(removed.length, "image")} (${listOf(removed, 4)})`);
  }
  if (kept.length > 0) {
    report.leftovers.push(
      `${plural(kept.length, "image")} another container still uses: ${kept.join(", ")}`,
    );
    report.remaining.push(plural(kept.length, "image"));
  }
};

/** Clear Docker's build cache, after the plan's separate question. */
export const clearBuildCache = async (
  runtime: UninstallRuntime,
  context: string,
): Promise<string | null> => {
  const pruned = await dockerIn(
    runtime.server.run,
    context,
    ["builder", "prune", "--all", "--force"],
    serverProcessDeadlines.stop,
  );
  return pruned.status === 0 ? null : detail(pruned);
};

/** The files a server keeps under the config directory, as `server setup` writes them. */
const SERVER_OWNED = new Set<string>([...SERVER_FILES, LEFT_FILE, "server.lock"]);

const removeHome = async (
  runtime: UninstallRuntime,
  plan: HomePlan,
  report: Report,
): Promise<void> => {
  const { server } = runtime;
  if (plan.cliConfig !== null) {
    fs.rmSync(plan.cliConfig, { force: true });
    server.writeLine(`removed ${plan.cliConfig}`);
  }
  if (plan.sshDirectory !== null) {
    fs.rmSync(plan.sshDirectory, { recursive: true, force: true });
    server.writeLine(`removed ${plan.sshDirectory}`);
  }
  if (plan.managedSshBlocks > 0) {
    try {
      const before = fs.readFileSync(runtime.sshConfigFile, "utf8");
      const stripped = stripManagedWorkspaceSshBlocks(before);
      if (!stripped.ok) throw stripped.error;
      if (stripped.value.removed > 0) {
        fs.writeFileSync(runtime.sshConfigFile, stripped.value.config, { mode: 0o600 });
        server.writeLine(
          `removed ${plural(stripped.value.removed, "managed block")} from ${runtime.sshConfigFile}`,
        );
      }
    } catch (cause) {
      report.failures.push(
        `${runtime.sshConfigFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  // The directory itself goes only when nothing else lives there.
  let remaining: ReadonlyArray<string> = [];
  try {
    remaining = fs.readdirSync(runtime.cliHome);
  } catch {
    return;
  }
  if (remaining.length === 0) {
    fs.rmdirSync(runtime.cliHome);
    server.writeLine(`removed ${runtime.cliHome}`);
    return;
  }
  const serverFiles = remaining.filter((name) => SERVER_OWNED.has(name));
  const others = remaining.filter((name) => !SERVER_OWNED.has(name));
  if (serverFiles.length > 0 && !report.remaining.includes(runtime.cliHome)) {
    report.leftovers.push(
      `${runtime.cliHome}: ${serverFiles.join(", ")} ${serverFiles.length === 1 ? "is" : "are"} the server's configuration, which mend uninstall --server removes`,
    );
  }
  if (others.length > 0) {
    report.leftovers.push(
      `${runtime.cliHome}: ${others.join(", ")} ${others.length === 1 ? "is" : "are"} not Mend's CLI or server configuration (a host-run server's store or keys, or another tool's files), so ${others.length === 1 ? "it stays" : "they stay"}`,
    );
  }
  if (!report.remaining.includes(runtime.cliHome)) report.remaining.push(runtime.cliHome);
};

/** Ask the signed-in server to forget this machine's key and device, while it can still answer. */
const revokeSignIn = async (
  runtime: UninstallRuntime,
  signedIn: NonNullable<HomePlan["signedIn"]>,
  report: Report,
): Promise<void> => {
  const { url } = signedIn;
  // The key goes while the sign-in can still ask for it, before the token is revoked.
  const removal = await runtime.removeWorkspaceSshKey();
  for (const fingerprint of removal.removed) {
    report.write(
      `removed workspace ssh key ${fingerprint} on ${url} · the gateway refuses it from the next connection`,
    );
  }
  // A key that may still open workspaces is a failure, named with what removes it; the rest of
  // the uninstall still runs.
  if (removal.problem !== null) {
    const [first] = removal.stillActive;
    report.failures.push(
      first === undefined
        ? `this machine's workspace ssh key on ${url} may still be registered: ${removal.problem}. From another signed-in machine, mend ssh keys lists your keys and mend ssh keys remove <fingerprint> removes one, or use Settings → Workspace SSH`
        : `workspace ssh key ${removal.stillActive.join(", ")} is still registered on ${url}: ${removal.problem}. From another signed-in machine: mend ssh keys remove ${first}, or use Settings → Workspace SSH`,
    );
  }
  if (signedIn.deviceId !== null) {
    const failure = await runtime.revokeDevice();
    if (failure === null) report.write(`revoked this terminal's device on ${url}`);
    else {
      report.leftovers.push(
        `device token on ${url}: ${failure}. If that server still runs, end it under Settings → Devices`,
      );
    }
  }
};

/**
 * Carry the plan out. In order: what the plan needs is checked to answer before anything is
 * touched; the server goes (its workspaces first); the signed-in server, when it is another one,
 * forgets this machine's key and device; and only then do this machine's files go. A server that
 * cannot be removed leaves everything else as it was.
 */
export const executeUninstall = async (
  runtime: UninstallRuntime,
  plan: UninstallPlan,
): Promise<UninstallOutcome> => {
  const report: Report = {
    write: (line) => runtime.server.writeLine(line),
    failures: [],
    leftovers: [],
    remaining: [],
  };
  const done = (): UninstallOutcome => ({
    failures: report.failures,
    leftovers: report.leftovers,
    remaining: report.remaining,
  });
  const refusal = planRefusal(plan);
  if (refusal !== null) {
    report.failures.push(refusal);
    return done();
  }
  let serverGone = false;
  if (isInstallation(plan.server)) {
    const server = await removeServer(runtime, plan.server, report);
    if (server === "refused") return done();
    serverGone = true;
    if (server === "removed" && plan.server.extras !== undefined) {
      await removeHostExtras(runtime, plan.server.dockerContext, plan.server.extras, report);
    }
  } else if (isLeftovers(plan.server)) {
    await removeLeftovers(runtime, plan.server, report);
  }
  const signedIn = runtime.signedIn;
  const toThisServer =
    signedIn !== null &&
    isInstallation(plan.server) &&
    plan.server.appUrl !== "" &&
    signedInTo(signedIn.url, plan.server.appUrl, plan.server.edgeHost);
  if (serverGone && toThisServer && plan.home === null) {
    // The token was issued by the server just deleted: it can never be used or revoked again.
    runtime.forgetSignIn?.();
    report.write(`signed out of ${signedIn.url}: its device token went with the server`);
  }
  if (plan.home !== null) {
    if (plan.home.signedIn !== null) {
      if (toThisServer && serverGone) {
        report.write(
          `this terminal's device token and workspace ssh key on ${plan.home.signedIn.url} went with the server's database`,
        );
      } else await revokeSignIn(runtime, plan.home.signedIn, report);
    }
    await removeHome(runtime, plan.home, report);
  }
  return done();
};
