import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Check } from "./doctor.ts";

/**
 * The Docker daemon's own shutdown timeout, against the grace a capture workspace needs to save.
 *
 * A `docker stop` of a capture workspace waits for the container's own stop timeout, which Core
 * sets long enough for sealantd's final flush. The daemon's shutdown does not: when dockerd itself
 * stops (a host restart, `systemctl stop docker`, quitting Docker Desktop) it gives every container
 * its `shutdown-timeout` (15 s unless configured) and then kills it, whatever the container asked
 * for. A workspace killed there loses what it had not shipped. This reads that timeout where it
 * can be read and says what was observed; what could not be read is reported as not observed.
 */

/**
 * The stop grace Core gives a capture workspace container (Core
 * `SEALANT_DOCKER_CAPTURE_STOP_GRACE_SECONDS`, default 3600, set as its StopTimeout at create).
 */
export const DOCKER_CAPTURE_STOP_GRACE_SECONDS = 3600;

/** dockerd's `shutdown-timeout` when neither its flag nor its daemon.json sets one. */
export const DOCKERD_DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 15;

/** One configuration file as this machine answered for it. */
export type HostFile =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "read"; readonly text: string };

/** The facts `readShutdownTimeout` works from, gathered by the caller (`gatherDockerDaemonFacts`). */
export interface DockerDaemonFacts {
  /** `docker info`, parsed; null when docker did not answer or answered something unreadable. */
  readonly info: {
    readonly operatingSystem: string;
    readonly securityOptions: ReadonlyArray<string>;
  } | null;
  /**
   * The argv of the dockerd the docker client talks to (`observeDockerd`); null when none was
   * observed, or when it could not be told which one it is (`dockerdUnresolved` says why).
   */
  readonly dockerdArgv: ReadonlyArray<string> | null;
  /** Why no dockerd's argv is given although dockerd processes were seen; absent when not so. */
  readonly dockerdUnresolved?: string | null;
  readonly readFile: (file: string) => HostFile;
  readonly home: string;
  /** `$XDG_CONFIG_HOME`, when set. */
  readonly xdgConfigHome: string | null;
}

/** Which daemon answered, as far as it tells: where its `shutdown-timeout` is configured. */
export type DockerDaemonKind = "dockerd" | "rootless" | "desktop" | "orbstack";

export type ShutdownTimeoutReading =
  | {
      readonly kind: "observed";
      readonly seconds: number;
      /** Where the value came from: `dockerd --shutdown-timeout`, a daemon.json path, or the default. */
      readonly source: string;
      readonly daemon: DockerDaemonKind;
      /** The file that sets it (or would): where the fix goes. */
      readonly configPath: string;
      readonly fromFlag: boolean;
    }
  | { readonly kind: "unknown"; readonly why: string };

/** `--name=value` or `--name value` from an argv; null when absent. */
const flagValue = (argv: ReadonlyArray<string>, name: string): string | null => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    if (arg === name) return argv[index + 1] ?? "";
  }
  return null;
};

/** A duration in seconds as dockerd takes it: a non-negative integer. */
const seconds = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
};

const daemonKindOf = (info: NonNullable<DockerDaemonFacts["info"]>): DockerDaemonKind => {
  if (/docker desktop/i.test(info.operatingSystem)) return "desktop";
  if (/orbstack/i.test(info.operatingSystem)) return "orbstack";
  if (info.securityOptions.some((option) => option.includes("name=rootless"))) return "rootless";
  return "dockerd";
};

/** Where each kind of daemon keeps its daemon.json (Docker Desktop: Settings → Docker Engine). */
const defaultConfigPath = (facts: DockerDaemonFacts, daemon: DockerDaemonKind): string => {
  switch (daemon) {
    case "desktop":
      return path.join(facts.home, ".docker", "daemon.json");
    case "orbstack":
      return path.join(facts.home, ".orbstack", "config", "docker.json");
    case "rootless":
      return path.join(
        facts.xdgConfigHome ?? path.join(facts.home, ".config"),
        "docker",
        "daemon.json",
      );
    case "dockerd":
      return "/etc/docker/daemon.json";
  }
};

/**
 * The daemon's shutdown timeout, from what was observed: the running dockerd's
 * `--shutdown-timeout` flag, else its daemon.json (`--config-file`, else the daemon's default
 * location), else the dockerd default — but the default only when nothing else could set it: the
 * dockerd process was observed without the flag, or the daemon is Docker Desktop or OrbStack, whose
 * engine is configured through that one file. Anything else is `unknown`, with what was not seen.
 */
export const readShutdownTimeout = (facts: DockerDaemonFacts): ShutdownTimeoutReading => {
  if (facts.info === null) return { kind: "unknown", why: "docker info did not answer" };
  const daemon = daemonKindOf(facts.info);
  const managed = daemon === "desktop" || daemon === "orbstack";
  const argv = managed ? null : facts.dockerdArgv;
  const unresolved = facts.dockerdUnresolved ?? null;
  // Another daemon's flags or file would be read as this one's: say what was not seen instead.
  if (argv === null && !managed && unresolved !== null) return { kind: "unknown", why: unresolved };
  const configPath =
    (argv === null ? null : flagValue(argv, "--config-file")) ?? defaultConfigPath(facts, daemon);
  if (argv !== null) {
    const flag = flagValue(argv, "--shutdown-timeout");
    if (flag !== null) {
      const value = seconds(flag);
      return value === null
        ? { kind: "unknown", why: `dockerd --shutdown-timeout ${flag} unreadable` }
        : {
            kind: "observed",
            seconds: value,
            source: "dockerd --shutdown-timeout",
            daemon,
            configPath,
            fromFlag: true,
          };
    }
  }
  const file = facts.readFile(configPath);
  if (file.kind === "unreadable") return { kind: "unknown", why: `${configPath} unreadable` };
  if (file.kind === "read") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      return { kind: "unknown", why: `${configPath} is not JSON` };
    }
    const configured =
      typeof parsed === "object" && parsed !== null && "shutdown-timeout" in parsed
        ? parsed["shutdown-timeout"]
        : undefined;
    if (configured !== undefined) {
      const value = seconds(configured);
      return value === null
        ? { kind: "unknown", why: `shutdown-timeout in ${configPath} unreadable` }
        : {
            kind: "observed",
            seconds: value,
            source: configPath,
            daemon,
            configPath,
            fromFlag: false,
          };
    }
  }
  if (argv === null && !managed) {
    return {
      kind: "unknown",
      why: `no dockerd process observed here · not set in ${configPath}`,
    };
  }
  return {
    kind: "observed",
    seconds: DOCKERD_DEFAULT_SHUTDOWN_TIMEOUT_SECONDS,
    source: `dockerd default · not set in ${configPath}`,
    daemon,
    configPath,
    fromFlag: false,
  };
};

/** What restarts the daemon so a new `shutdown-timeout` takes effect. */
const restartWords = (daemon: DockerDaemonKind): string => {
  switch (daemon) {
    case "desktop":
      return "restart Docker Desktop";
    case "orbstack":
      return "restart OrbStack";
    case "rootless":
      return "systemctl --user restart docker";
    case "dockerd":
      return "restart dockerd";
  }
};

/** The one change that raises it, in the file (or flag) the value came from. */
export const raiseShutdownTimeoutWords = (
  reading: Extract<ShutdownTimeoutReading, { readonly kind: "observed" }>,
  grace: number,
): string =>
  reading.fromFlag
    ? `raise dockerd --shutdown-timeout to ${grace}, then ${restartWords(reading.daemon)}`
    : `set "shutdown-timeout": ${grace} in ${reading.configPath}, then ${restartWords(reading.daemon)}`;

/** The doctor line (`docker`): what was observed, against the capture grace. */
export const dockerShutdownCheck = (
  reading: ShutdownTimeoutReading,
  grace: number = DOCKER_CAPTURE_STOP_GRACE_SECONDS,
): Check => {
  if (reading.kind === "unknown") {
    return {
      label: "docker",
      state: "todo",
      detail: `shutdown-timeout not observed · ${reading.why}`,
      fix: null,
    };
  }
  if (reading.seconds >= grace) {
    return {
      label: "docker",
      state: "ok",
      detail: `shutdown-timeout ${reading.seconds} s · ${reading.source} · covers the ${grace} s capture grace`,
      fix: null,
    };
  }
  return {
    label: "docker",
    state: "todo",
    detail: `shutdown-timeout ${reading.seconds} s · ${reading.source} · below the ${grace} s capture grace`,
    fix: raiseShutdownTimeoutWords(reading, grace),
  };
};

/**
 * What `mend server setup` prints about it: nothing when it covers the grace; otherwise one line
 * saying what was observed and, when it is below, what a daemon shutdown does and how to raise it.
 */
export const dockerShutdownSetupLine = (
  reading: ShutdownTimeoutReading,
  grace: number = DOCKER_CAPTURE_STOP_GRACE_SECONDS,
): string | null => {
  if (reading.kind === "unknown") {
    return `Docker shutdown-timeout not observed (${reading.why}); a daemon shutdown below ${grace} s kills capture workspaces before they save. See docs/SELF-HOSTING.md.`;
  }
  if (reading.seconds >= grace) return null;
  return `Docker shutdown-timeout is ${reading.seconds} s (${reading.source}), below the ${grace} s capture grace: a host restart or daemon stop kills capture workspaces after ${reading.seconds} s, before they save. To raise it: ${raiseShutdownTimeoutWords(reading, grace)}.`;
};

/** `docker info --format '{{json .}}'` output, as the fields read here; null when unreadable. */
export const parseDockerInfo = (stdout: string): DockerDaemonFacts["info"] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("OperatingSystem" in parsed)) return null;
  const operatingSystem = parsed.OperatingSystem;
  if (typeof operatingSystem !== "string") return null;
  const options = "SecurityOptions" in parsed ? parsed.SecurityOptions : [];
  return {
    operatingSystem,
    securityOptions: Array.isArray(options)
      ? options.filter((option): option is string => typeof option === "string")
      : [],
  };
};

/** A file on this machine, as absent, unreadable or its text. */
export const readHostFile = (file: string): HostFile => {
  try {
    return { kind: "read", text: fs.readFileSync(file, "utf8") };
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable" };
  }
};

/** What `observeDockerd` reads of `/proc`: entries, file text and link targets; null where unreadable. */
export interface ProcView {
  readonly list: (dir: string) => ReadonlyArray<string> | null;
  readonly read: (file: string) => string | null;
  readonly link: (file: string) => string | null;
}

/** This machine's `/proc`. */
export const hostProcView: ProcView = {
  list: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return null;
    }
  },
  read: (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  link: (file) => {
    try {
      return fs.readlinkSync(file);
    } catch {
      return null;
    }
  },
};

/** docker's own default when neither DOCKER_HOST nor a context names another. */
export const DOCKER_DEFAULT_HOST = "unix:///var/run/docker.sock";

/** `/var/run` is `/run` on every Linux this reads: one spelling for a socket path. */
const socketPath = (file: string): string => file.replace(/^\/var\/run\//, "/run/");

/** The socket path of a `unix://` endpoint; null for anything else (tcp, ssh, npipe). */
export const unixSocketOf = (host: string): string | null =>
  host.startsWith("unix://") && host.length > "unix://".length
    ? socketPath(host.slice("unix://".length))
    : null;

/** Every `-H` / `--host` value in a dockerd argv, in order. */
const hostFlags = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const hosts: Array<string> = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    for (const name of ["-H", "--host"]) {
      if (arg === name) hosts.push(argv[index + 1] ?? "");
      else if (arg.startsWith(`${name}=`)) hosts.push(arg.slice(name.length + 1));
    }
  }
  return hosts;
};

/** The inodes of the listening sockets bound at `socket`, from a `/proc/<pid>/net/unix` text. */
const listeningInodes = (table: string, socket: string): ReadonlySet<string> => {
  const inodes = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const flags = fields[3];
    const inode = fields[6];
    const bound = fields.slice(7).join(" ");
    // __SO_ACCEPTCON: a socket something listens on.
    if (flags === undefined || inode === undefined || bound === "") continue;
    if ((Number.parseInt(flags, 16) & 0x10000) === 0) continue;
    if (socketPath(bound) === socket) inodes.add(inode);
  }
  return inodes;
};

/** Which dockerd the docker client talks to, as far as `/proc` tells. */
export type DockerdObservation =
  | { readonly kind: "observed"; readonly pid: string; readonly argv: ReadonlyArray<string> }
  | { readonly kind: "none" }
  | { readonly kind: "unresolved"; readonly why: string };

interface DockerdCandidate {
  readonly pid: string;
  readonly argv: ReadonlyArray<string>;
  /** It holds a listening socket at the client's path (its fds were readable). */
  readonly owns: boolean;
  /** Its `-H` names the client's socket. */
  readonly named: boolean;
  /** It runs in a nested PID namespace: a daemon inside a container. */
  readonly nested: boolean;
}

/**
 * The dockerd serving `host` (DOCKER_HOST, else the current context's endpoint), among every
 * dockerd in `/proc` — a host may run several: its own, a rootless one, one inside a container
 * (a workspace's Docker). A daemon is ruled out on what `/proc` shows against it: `-H` values
 * that name another socket, or a network namespace with no listening socket at that path (or
 * not the one this process sees there). Of the rest, the one holding that socket among its fds,
 * else the one whose `-H` names it, else the one outside a nested PID namespace — when exactly
 * one is left. Otherwise nothing is guessed: `unresolved` says why.
 */
export const observeDockerd = (proc: ProcView, host: string): DockerdObservation => {
  const daemons: Array<{ readonly pid: string; readonly argv: ReadonlyArray<string> }> = [];
  for (const entry of proc.list("/proc") ?? []) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = proc.read(`/proc/${entry}/cmdline`);
    if (cmdline === null) continue;
    const argv = cmdline.split("\0").filter((arg) => arg !== "");
    if (path.basename(argv[0] ?? "") === "dockerd") daemons.push({ pid: entry, argv });
  }
  if (daemons.length === 0) return { kind: "none" };
  const socket = unixSocketOf(host);
  if (socket === null) {
    return {
      kind: "unresolved",
      why: `docker talks to ${host} · not a socket on this machine`,
    };
  }
  const selfTable = proc.read("/proc/self/net/unix");
  const seenHere = selfTable === null ? new Set<string>() : listeningInodes(selfTable, socket);
  const candidates: Array<DockerdCandidate> = [];
  for (const daemon of daemons) {
    const hosts = hostFlags(daemon.argv);
    const named = hosts.some((value) => unixSocketOf(value) === socket);
    const activated = hosts.some((value) => value.startsWith("fd://"));
    if (hosts.length > 0 && !named && !activated) continue;
    const table = proc.read(`/proc/${daemon.pid}/net/unix`);
    const listening = table === null ? null : listeningInodes(table, socket);
    if (listening !== null) {
      if (listening.size === 0) continue;
      // The same path in another network namespace is another socket.
      if (seenHere.size > 0 && ![...listening].some((inode) => seenHere.has(inode))) continue;
    }
    // Its own fds, when this user may read them (a root daemon's usually not).
    const fds = proc.list(`/proc/${daemon.pid}/fd`);
    const held =
      fds === null || listening === null
        ? null
        : fds.some((fd) => {
            const target = proc.link(`/proc/${daemon.pid}/fd/${fd}`);
            const inode = target?.match(/^socket:\[(\d+)\]$/)?.[1];
            return inode !== undefined && listening.has(inode);
          });
    if (held === false) continue;
    const nsPids = proc
      .read(`/proc/${daemon.pid}/status`)
      ?.split("\n")
      .find((line) => line.startsWith("NSpid:"))
      ?.slice("NSpid:".length)
      .trim()
      .split(/\s+/);
    candidates.push({
      ...daemon,
      owns: held === true,
      named,
      nested: nsPids !== undefined && nsPids.length > 1,
    });
  }
  const narrowed = [
    (candidate: DockerdCandidate) => candidate.owns,
    (candidate: DockerdCandidate) => candidate.named,
    (candidate: DockerdCandidate) => !candidate.nested,
  ].reduce<ReadonlyArray<DockerdCandidate>>((left, prefer) => {
    const preferred = left.filter(prefer);
    return preferred.length > 0 ? preferred : left;
  }, candidates);
  const [only, ...others] = narrowed;
  if (only !== undefined && others.length === 0) {
    return { kind: "observed", pid: only.pid, argv: only.argv };
  }
  const seen = `${daemons.length} dockerd process${daemons.length === 1 ? "" : "es"}`;
  return {
    kind: "unresolved",
    why:
      only === undefined
        ? `${seen} · none observed serving ${socket}`
        : `${seen} · could not tell which serves ${socket}`,
  };
};

/** The endpoint the docker client uses: DOCKER_HOST, else the current context's, else docker's default. */
export const hostDockerEndpoint = (): string => {
  const fromEnv = process.env["DOCKER_HOST"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  const context = spawnSync(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const endpoint = context.status === 0 ? context.stdout.trim() : "";
  return endpoint === "" ? DOCKER_DEFAULT_HOST : endpoint;
};

/** The observation, as `DockerDaemonFacts` carries it. */
export const dockerdFactsOf = (
  observation: DockerdObservation,
): Pick<DockerDaemonFacts, "dockerdArgv" | "dockerdUnresolved"> => {
  switch (observation.kind) {
    case "observed":
      return { dockerdArgv: observation.argv, dockerdUnresolved: null };
    case "none":
      return { dockerdArgv: null, dockerdUnresolved: null };
    case "unresolved":
      return { dockerdArgv: null, dockerdUnresolved: observation.why };
  }
};

/** This machine's facts, with `docker info`'s stdout already in hand (null when it failed). */
export const hostDockerDaemonFacts = (infoStdout: string | null): DockerDaemonFacts => ({
  info: infoStdout === null ? null : parseDockerInfo(infoStdout),
  ...dockerdFactsOf(observeDockerd(hostProcView, hostDockerEndpoint())),
  readFile: readHostFile,
  home: os.homedir(),
  xdgConfigHome: process.env["XDG_CONFIG_HOME"] ?? null,
});

/** The doctor's read of this machine's daemon: `docker info`, bounded at 3 s. */
export const observeHostShutdownTimeout = (): ShutdownTimeoutReading => {
  const info = spawnSync("docker", ["info", "--format", "{{json .}}"], {
    encoding: "utf8",
    timeout: 3_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return readShutdownTimeout(hostDockerDaemonFacts(info.status === 0 ? info.stdout : null));
};
