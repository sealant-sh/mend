import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Check } from "./doctor.ts";

/**
 * What a Docker daemon stop does to the workspaces on it, and whether the host lets it finish.
 *
 * dockerd's own shutdown (`systemctl stop docker`, an `apt upgrade` of docker-ce, quitting Docker
 * Desktop) stops every running container with that container's own stop timeout, not with the
 * daemon's `shutdown-timeout`: it waits for the longest one, plus 5 s. systemd gives
 * `docker.service` its `TimeoutStopSec` (90 s by default) and then SIGKILLs dockerd, which leaves
 * that container running. The next start, without `live-restore`, stops it again inside "Restoring
 * containers" with the same timeout before it starts anything — Mend's own containers included,
 * while the workspace's final flush waits for them. Sealant created capture workspaces with a
 * 3600 s stop timeout until it bounded it at `WORKSPACE_STOP_TIMEOUT_SECONDS`; one of those still
 * running turns a Docker restart into an hour without Docker.
 *
 * This reads what decides it and says what was observed: the running containers' stop timeouts,
 * the systemd unit that runs the daemon, and `live-restore`.
 */

/**
 * The stop timeout Sealant gives a workspace container (Core
 * `SEALANT_DOCKER_CONTAINER_STOP_TIMEOUT_SECONDS`, default 60): what a workspace setup starts gets.
 */
export const WORKSPACE_STOP_TIMEOUT_SECONDS = 60;

/** Docker's stop timeout for a container that sets none (`default-stop-timeout` unset). */
export const DOCKER_DEFAULT_STOP_TIMEOUT_SECONDS = 10;

/** What dockerd adds to the longest stop timeout before it gives up on its own shutdown. */
export const DOCKERD_SHUTDOWN_GRACE_SECONDS = 5;

/** systemd's `DefaultTimeoutStopSec`: the limit assumed where no unit was observed. */
export const SYSTEMD_DEFAULT_STOP_SECONDS = 90;

/** Which daemon answered, as far as `docker info` tells. */
export type DockerDaemonKind = "dockerd" | "rootless" | "desktop" | "orbstack";

/** One running container's stop timeout; null when it sets none. */
export interface ContainerStopTimeout {
  readonly name: string;
  readonly stopTimeout: number | null;
}

/** The systemd unit's answer for the daemon: `systemctl show` of it. */
export interface DaemonUnit {
  /** `docker.service`, or `docker.service (user)` for a rootless daemon. */
  readonly name: string;
  readonly activeState: string;
  readonly mainPid: string;
  /** `TimeoutStopUSec` in seconds; null for `infinity`. */
  readonly timeoutStopSeconds: number | null;
}

/** The facts `readDockerStop` works from, gathered by the caller (`hostDockerDaemonFacts`). */
export interface DockerDaemonFacts {
  /** `docker info`, parsed; null when docker did not answer or answered something unreadable. */
  readonly info: {
    readonly operatingSystem: string;
    readonly securityOptions: ReadonlyArray<string>;
    readonly liveRestore: boolean;
  } | null;
  /** The pid of the dockerd the docker client talks to (`observeDockerd`); null when not observed. */
  readonly dockerdPid: string | null;
  /** The running containers' stop timeouts; null when they could not be read. */
  readonly containers: ReadonlyArray<ContainerStopTimeout> | null;
  /** The systemd unit of that kind of daemon; null when systemctl did not answer for one. */
  readonly unit: DaemonUnit | null;
}

/** The limit the host puts on a daemon stop. */
export type StopLimit =
  | { readonly kind: "observed"; readonly unit: string; readonly seconds: number | null }
  | { readonly kind: "none"; readonly why: string };

export type DockerStopReading =
  | { readonly kind: "unknown"; readonly why: string }
  | { readonly kind: "live-restore" }
  | {
      readonly kind: "observed";
      /** The longest stop timeout a daemon stop waits for. */
      readonly waitSeconds: number;
      /** Whose it is: a running container, or (setup) the workspaces it is about to start. */
      readonly longest:
        | { readonly kind: "container"; readonly name: string }
        | { readonly kind: "workspaces" }
        | null;
      readonly limit: StopLimit;
    };

const daemonKindOf = (info: NonNullable<DockerDaemonFacts["info"]>): DockerDaemonKind => {
  if (/docker desktop/i.test(info.operatingSystem)) return "desktop";
  if (/orbstack/i.test(info.operatingSystem)) return "orbstack";
  if (info.securityOptions.some((option) => option.includes("name=rootless"))) return "rootless";
  return "dockerd";
};

/**
 * The unit's limit, when it is the daemon's: active, and — for a rootful daemon whose process was
 * observed — the unit's main process is that dockerd (a rootless unit's main process is
 * rootlesskit, so it is taken as the daemon's while active).
 */
const stopLimitOf = (facts: DockerDaemonFacts, daemon: DockerDaemonKind): StopLimit => {
  if (daemon === "desktop" || daemon === "orbstack") {
    return { kind: "none", why: "no systemd unit runs this daemon" };
  }
  const unit = facts.unit;
  if (unit === null) return { kind: "none", why: "no systemd unit observed" };
  if (unit.activeState !== "active") {
    return { kind: "none", why: `${unit.name} is ${unit.activeState}` };
  }
  if (daemon === "dockerd" && facts.dockerdPid !== null && unit.mainPid !== facts.dockerdPid) {
    return { kind: "none", why: `${unit.name} is not the dockerd docker talks to` };
  }
  return { kind: "observed", unit: unit.name, seconds: unit.timeoutStopSeconds };
};

/**
 * What a daemon stop waits for and what the host allows it, from what was observed. `expected`
 * is a stop timeout about to exist (setup: the workspaces it starts), counted beside the running
 * containers'.
 */
export const readDockerStop = (
  facts: DockerDaemonFacts,
  expected: number | null = null,
): DockerStopReading => {
  if (facts.info === null) return { kind: "unknown", why: "docker info did not answer" };
  if (facts.info.liveRestore) return { kind: "live-restore" };
  if (facts.containers === null)
    return { kind: "unknown", why: "its containers could not be read" };
  let waitSeconds = expected ?? 0;
  let longest: Extract<DockerStopReading, { readonly kind: "observed" }>["longest"] =
    expected === null ? null : { kind: "workspaces" };
  for (const container of facts.containers) {
    const seconds = container.stopTimeout ?? DOCKER_DEFAULT_STOP_TIMEOUT_SECONDS;
    if (seconds > waitSeconds) {
      waitSeconds = seconds;
      longest = { kind: "container", name: container.name };
    }
  }
  return {
    kind: "observed",
    waitSeconds,
    longest,
    limit: stopLimitOf(facts, daemonKindOf(facts.info)),
  };
};

/** The seconds a daemon stop may take before the host ends it; null for no limit. */
const limitSeconds = (limit: StopLimit): number | null =>
  limit.kind === "observed" ? limit.seconds : SYSTEMD_DEFAULT_STOP_SECONDS;

/** Whether a daemon stop would outlast what the host allows. */
const outlasts = (reading: Extract<DockerStopReading, { readonly kind: "observed" }>): boolean => {
  const limit = limitSeconds(reading.limit);
  return limit !== null && reading.waitSeconds + DOCKERD_SHUTDOWN_GRACE_SECONDS >= limit;
};

const whose = (reading: Extract<DockerStopReading, { readonly kind: "observed" }>): string => {
  if (reading.longest === null) return "no container running";
  if (reading.longest.kind === "workspaces") return "a workspace's stop timeout";
  return `${reading.longest.name}'s stop timeout`;
};

/** What a daemon stop waits for. */
const stopWords = (reading: Extract<DockerStopReading, { readonly kind: "observed" }>): string =>
  reading.longest === null
    ? "no container running"
    : `a Docker stop waits up to ${reading.waitSeconds} s · ${whose(reading)}`;

const limitWords = (limit: StopLimit, ok: boolean): string => {
  if (limit.kind === "none")
    return `${limit.why} (systemd's default is ${SYSTEMD_DEFAULT_STOP_SECONDS} s)`;
  if (limit.seconds === null) return `systemd waits for ${limit.unit} without a limit`;
  return ok
    ? `systemd allows ${limit.unit} ${limit.seconds} s`
    : `systemd kills ${limit.unit} after ${limit.seconds} s, and Docker's next start waits for what it left running`;
};

/** A workspace container Sealant created, by its name (`sealant-<run>`, its sidecar `-docker`). */
const isWorkspace = (name: string): boolean => name.startsWith("sealant-");

/** The one change that lets the stop finish: stop the long container, or give the unit room. */
const fixWords = (reading: Extract<DockerStopReading, { readonly kind: "observed" }>): string => {
  const longest = reading.longest;
  if (
    longest !== null &&
    longest.kind === "container" &&
    reading.waitSeconds > WORKSPACE_STOP_TIMEOUT_SECONDS
  ) {
    return isWorkspace(longest.name)
      ? "stop that session (mend sessions, then mend stop <session>) before you restart or upgrade Docker"
      : `docker stop ${longest.name} before you restart or upgrade Docker`;
  }
  const room = reading.waitSeconds + DOCKERD_SHUTDOWN_GRACE_SECONDS + 30;
  return reading.limit.kind === "observed"
    ? `sudo systemctl edit ${reading.limit.unit.replace(" (user)", "")} and set [Service] TimeoutStopSec=${room}`
    : "stop sessions before you restart, upgrade or quit Docker";
};

/** The doctor line (`docker`): what a daemon stop waits for, against what the host allows. */
export const dockerStopCheck = (reading: DockerStopReading): Check => {
  if (reading.kind === "unknown") {
    return {
      label: "docker",
      state: "todo",
      detail: `Docker stop not observed · ${reading.why}`,
      fix: null,
    };
  }
  if (reading.kind === "live-restore") {
    return {
      label: "docker",
      state: "ok",
      detail: "live-restore on · a Docker restart leaves sessions running",
      fix: null,
    };
  }
  const ok = !outlasts(reading);
  return {
    label: "docker",
    state: ok ? "ok" : "todo",
    detail: `${stopWords(reading)} · ${limitWords(reading.limit, ok)}`,
    fix: ok ? null : fixWords(reading),
  };
};

/**
 * What `mend server setup` prints about it, counting the workspaces it is about to start: nothing
 * when a daemon stop fits what the host allows (or live-restore is on); otherwise one line.
 */
export const dockerStopSetupLine = (reading: DockerStopReading): string | null => {
  if (reading.kind === "live-restore") return null;
  if (reading.kind === "unknown") return null;
  if (!outlasts(reading)) return null;
  return `A Docker stop waits up to ${reading.waitSeconds} s (${whose(reading)}), but ${limitWords(reading.limit, false)}: a restart or upgrade of Docker with a live session leaves Docker down until that workspace ends. To avoid it: ${fixWords(reading)}.`;
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
    liveRestore: "LiveRestoreEnabled" in parsed && parsed.LiveRestoreEnabled === true,
  };
};

/** `docker inspect --format '{{.Name}}|{{json .Config.StopTimeout}}'` lines, one per container. */
export const parseContainerStopTimeouts = (stdout: string): ReadonlyArray<ContainerStopTimeout> =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const bar = line.lastIndexOf("|");
      const name = (bar < 0 ? line : line.slice(0, bar)).replace(/^\//, "");
      const value = bar < 0 ? "" : line.slice(bar + 1).trim();
      return { name, stopTimeout: /^\d+$/.test(value) ? Number(value) : null };
    });

const TIMESPAN_UNITS: Record<string, number> = {
  us: 1e-6,
  ms: 1e-3,
  s: 1,
  sec: 1,
  m: 60,
  min: 60,
  h: 3600,
  hr: 3600,
  d: 86400,
  w: 604800,
};

/** A systemd timespan as `systemctl show` prints it (`1min 30s`, `infinity`): seconds, null, or undefined when unreadable. */
export const parseSystemdTimespan = (text: string): number | null | undefined => {
  const value = text.trim();
  if (value === "infinity") return null;
  if (value === "") return undefined;
  let total = 0;
  for (const part of value.split(/\s+/)) {
    const match = /^(\d+(?:\.\d+)?)([a-z]*)$/.exec(part);
    const unit = match?.[2] === "" ? "s" : match?.[2];
    const factor = unit === undefined ? undefined : TIMESPAN_UNITS[unit];
    if (match === null || factor === undefined) return undefined;
    total += Number(match[1]) * factor;
  }
  return Math.round(total);
};

/** `systemctl show <unit> -p ActiveState -p MainPID -p TimeoutStopUSec` output; null when unreadable. */
export const parseDaemonUnit = (name: string, stdout: string): DaemonUnit | null => {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) fields.set(line.slice(0, equals), line.slice(equals + 1));
  }
  const activeState = fields.get("ActiveState");
  const timeout = parseSystemdTimespan(fields.get("TimeoutStopUSec") ?? "");
  if (activeState === undefined || timeout === undefined) return null;
  return { name, activeState, mainPid: fields.get("MainPID") ?? "", timeoutStopSeconds: timeout };
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
export const hostDockerEndpoint = (context: string | null = null): string => {
  // A named context is what docker talks to whatever DOCKER_HOST says, as with `--context`.
  const fromEnv = context === null ? process.env["DOCKER_HOST"] : undefined;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  const inspected = spawnSync(
    "docker",
    [
      "context",
      "inspect",
      ...(context === null ? [] : [context]),
      "--format",
      "{{.Endpoints.docker.Host}}",
    ],
    {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const endpoint = inspected.status === 0 ? inspected.stdout.trim() : "";
  return endpoint === "" ? DOCKER_DEFAULT_HOST : endpoint;
};

/** A command's stdout, bounded at 3 s; null when it failed. */
const runBounded = (command: string, args: ReadonlyArray<string>): string | null => {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    timeout: 3_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : null;
};
/** This machine's facts, with `docker info`'s stdout already in hand (null when it failed). */
export const hostDockerDaemonFacts = (
  infoStdout: string | null,
  context: string | null = null,
): DockerDaemonFacts => {
  const info = infoStdout === null ? null : parseDockerInfo(infoStdout);
  const contextArgs = context === null ? [] : ["--context", context];

  const ids = info === null ? null : runBounded("docker", [...contextArgs, "ps", "-q"]);
  const idList =
    ids
      ?.split("\n")
      .map((id) => id.trim())
      .filter((id) => id !== "") ?? [];
  const inspected =
    ids === null
      ? null
      : idList.length === 0
        ? ""
        : runBounded("docker", [
            ...contextArgs,
            "inspect",
            "--format",
            "{{.Name}}|{{json .Config.StopTimeout}}",
            ...idList,
          ]);
  const daemon = info === null ? null : daemonKindOf(info);
  const unitArgs = [
    "show",
    "docker.service",
    "-p",
    "ActiveState",
    "-p",
    "MainPID",
    "-p",
    "TimeoutStopUSec",
  ];
  const unitText =
    daemon === "dockerd"
      ? runBounded("systemctl", unitArgs)
      : daemon === "rootless"
        ? runBounded("systemctl", ["--user", ...unitArgs])
        : null;
  const observed = observeDockerd(hostProcView, hostDockerEndpoint(context));
  return {
    info,
    dockerdPid: observed.kind === "observed" ? observed.pid : null,
    containers: inspected === null ? null : parseContainerStopTimeouts(inspected),
    unit:
      unitText === null
        ? null
        : parseDaemonUnit(
            daemon === "rootless" ? "docker.service (user)" : "docker.service",
            unitText,
          ),
  };
};

/**
 * The doctor's read of a daemon on this machine: `docker info` through the context named, else the
 * current one, bounded at 3 s.
 */
export const observeHostDockerStop = (context: string | null = null): DockerStopReading => {
  const info = spawnSync(
    "docker",
    [...(context === null ? [] : ["--context", context]), "info", "--format", "{{json .}}"],
    {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return readDockerStop(hostDockerDaemonFacts(info.status === 0 ? info.stdout : null, context));
};
