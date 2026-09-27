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
  /** The running dockerd's argv on this machine; null when no dockerd process was observed. */
  readonly dockerdArgv: ReadonlyArray<string> | null;
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

/** The argv of a dockerd process on this machine (Linux `/proc`); null when none is observed. */
export const observeDockerdArgv = (): ReadonlyArray<string> | null => {
  let entries: Array<string>;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let argv: Array<string>;
    try {
      argv = fs.readFileSync(path.join("/proc", entry, "cmdline"), "utf8").split("\0");
    } catch {
      continue;
    }
    if (path.basename(argv[0] ?? "") === "dockerd") return argv.filter((arg) => arg !== "");
  }
  return null;
};

/** This machine's facts, with `docker info`'s stdout already in hand (null when it failed). */
export const hostDockerDaemonFacts = (infoStdout: string | null): DockerDaemonFacts => ({
  info: infoStdout === null ? null : parseDockerInfo(infoStdout),
  dockerdArgv: observeDockerdArgv(),
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
