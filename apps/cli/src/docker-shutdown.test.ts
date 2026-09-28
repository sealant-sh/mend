import { describe, expect, it } from "vitest";

import {
  type DockerDaemonFacts,
  dockerdFactsOf,
  dockerShutdownCheck,
  dockerShutdownSetupLine,
  type HostFile,
  observeDockerd,
  parseDockerInfo,
  type ProcView,
  readShutdownTimeout,
} from "./docker-shutdown.ts";

const NATIVE = { operatingSystem: "Ubuntu 24.04.1 LTS", securityOptions: ["name=seccomp"] };
const DESKTOP = { operatingSystem: "Docker Desktop", securityOptions: ["name=seccomp"] };
const ROOTLESS = {
  operatingSystem: "Ubuntu 24.04.1 LTS",
  securityOptions: ["name=seccomp,profile=builtin", "name=rootless"],
};

const facts = (
  overrides: Partial<DockerDaemonFacts> & {
    readonly files?: Readonly<Record<string, HostFile>>;
  } = {},
): DockerDaemonFacts => ({
  info: NATIVE,
  dockerdArgv: ["/usr/bin/dockerd", "-H", "fd://"],
  home: "/home/op",
  xdgConfigHome: null,
  readFile: (file) => overrides.files?.[file] ?? { kind: "absent" },
  ...overrides,
});

const json = (value: unknown): HostFile => ({ kind: "read", text: JSON.stringify(value) });

describe("the Docker daemon's shutdown timeout", () => {
  it("a dockerd observed without the flag or the key reads the 15 s default, below the capture grace, with the fix", () => {
    const reading = readShutdownTimeout(facts());
    expect(dockerShutdownCheck(reading)).toEqual({
      label: "docker",
      state: "todo",
      detail:
        "shutdown-timeout 15 s · dockerd default · not set in /etc/docker/daemon.json · below the 3600 s capture grace",
      fix: 'set "shutdown-timeout": 3600 in /etc/docker/daemon.json, then restart dockerd',
    });
    expect(dockerShutdownSetupLine(reading)).toBe(
      'Docker shutdown-timeout is 15 s (dockerd default · not set in /etc/docker/daemon.json), below the 3600 s capture grace: a host restart or daemon stop kills capture workspaces after 15 s, before they save. To raise it: set "shutdown-timeout": 3600 in /etc/docker/daemon.json, then restart dockerd.',
    );
  });

  it("daemon.json at 3600 covers the grace: ok, and setup says nothing", () => {
    const reading = readShutdownTimeout(
      facts({ files: { "/etc/docker/daemon.json": json({ "shutdown-timeout": 3600 }) } }),
    );
    expect(dockerShutdownCheck(reading)).toEqual({
      label: "docker",
      state: "ok",
      detail: "shutdown-timeout 3600 s · /etc/docker/daemon.json · covers the 3600 s capture grace",
      fix: null,
    });
    expect(dockerShutdownSetupLine(reading)).toBeNull();
  });

  it("the daemon's --config-file is the one read", () => {
    const reading = readShutdownTimeout(
      facts({
        dockerdArgv: ["/nix/store/x/dockerd", "--config-file=/nix/store/y-daemon.json"],
        files: { "/nix/store/y-daemon.json": json({ "shutdown-timeout": 60 }) },
      }),
    );
    expect(dockerShutdownCheck(reading).detail).toBe(
      "shutdown-timeout 60 s · /nix/store/y-daemon.json · below the 3600 s capture grace",
    );
  });

  it("the --shutdown-timeout flag wins over daemon.json, and its fix names the flag", () => {
    const reading = readShutdownTimeout(
      facts({
        dockerdArgv: ["dockerd", "--shutdown-timeout", "30"],
        files: { "/etc/docker/daemon.json": json({ "shutdown-timeout": 3600 }) },
      }),
    );
    expect(dockerShutdownCheck(reading)).toEqual({
      label: "docker",
      state: "todo",
      detail: "shutdown-timeout 30 s · dockerd --shutdown-timeout · below the 3600 s capture grace",
      fix: "raise dockerd --shutdown-timeout to 3600, then restart dockerd",
    });
    expect(
      readShutdownTimeout(facts({ dockerdArgv: ["dockerd", "--shutdown-timeout=7200"] })),
    ).toMatchObject({ kind: "observed", seconds: 7200, fromFlag: true });
  });

  it("what could not be read is not observed, never fine", () => {
    const unreadable = readShutdownTimeout(
      facts({ files: { "/etc/docker/daemon.json": { kind: "unreadable" } } }),
    );
    expect(dockerShutdownCheck(unreadable)).toEqual({
      label: "docker",
      state: "todo",
      detail: "shutdown-timeout not observed · /etc/docker/daemon.json unreadable",
      fix: null,
    });
    expect(dockerShutdownSetupLine(unreadable)).toContain("not observed");
    // No dockerd process seen here and no key in the file: a flag may still set it.
    expect(dockerShutdownCheck(readShutdownTimeout(facts({ dockerdArgv: null }))).detail).toBe(
      "shutdown-timeout not observed · no dockerd process observed here · not set in /etc/docker/daemon.json",
    );
    expect(dockerShutdownCheck(readShutdownTimeout(facts({ info: null }))).detail).toBe(
      "shutdown-timeout not observed · docker info did not answer",
    );
    expect(
      readShutdownTimeout(
        facts({ files: { "/etc/docker/daemon.json": { kind: "read", text: "{" } } }),
      ),
    ).toEqual({ kind: "unknown", why: "/etc/docker/daemon.json is not JSON" });
  });

  it("Docker Desktop is read from ~/.docker/daemon.json, whatever dockerd runs beside it", () => {
    const unset = readShutdownTimeout(facts({ info: DESKTOP, dockerdArgv: null }));
    expect(dockerShutdownCheck(unset)).toEqual({
      label: "docker",
      state: "todo",
      detail:
        "shutdown-timeout 15 s · dockerd default · not set in /home/op/.docker/daemon.json · below the 3600 s capture grace",
      fix: 'set "shutdown-timeout": 3600 in /home/op/.docker/daemon.json, then restart Docker Desktop',
    });
    const set = readShutdownTimeout(
      facts({
        info: DESKTOP,
        // A native dockerd on the same host is not the daemon that answered.
        dockerdArgv: ["dockerd", "--shutdown-timeout", "5"],
        files: { "/home/op/.docker/daemon.json": json({ "shutdown-timeout": 3600 }) },
      }),
    );
    expect(dockerShutdownCheck(set).state).toBe("ok");
  });

  it("a rootless daemon is read from its own daemon.json and restarted as the user's unit", () => {
    const reading = readShutdownTimeout(facts({ info: ROOTLESS, xdgConfigHome: "/home/op/.xdg" }));
    expect(dockerShutdownCheck(reading).fix).toBe(
      'set "shutdown-timeout": 3600 in /home/op/.xdg/docker/daemon.json, then systemctl --user restart docker',
    );
  });

  it("reads docker info's JSON, and nothing else", () => {
    expect(
      parseDockerInfo(
        JSON.stringify({ OperatingSystem: "Docker Desktop", SecurityOptions: ["a"] }),
      ),
    ).toEqual({ operatingSystem: "Docker Desktop", securityOptions: ["a"] });
    expect(parseDockerInfo("Docker Engine - Community")).toBeNull();
    expect(parseDockerInfo(JSON.stringify({ ServerVersion: "29" }))).toBeNull();
  });
});

/** One process in a fake `/proc`. */
interface FakeProcess {
  readonly argv: ReadonlyArray<string>;
  /** Its network namespace's `/proc/<pid>/net/unix` rows: [inode, path, listening]. */
  readonly sockets?: ReadonlyArray<readonly [string, string, boolean]>;
  /** `NSpid:` — more than one entry is a nested PID namespace (a container). */
  readonly nsPid?: string;
  /** Its fds' link targets; absent reads as unreadable (a root daemon, read as a user). */
  readonly fds?: Readonly<Record<string, string>>;
}

const unixTable = (rows: ReadonlyArray<readonly [string, string, boolean]>): string =>
  [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    ...rows.map(
      ([inode, bound, listening]) =>
        `0000000000000000: 00000002 00000000 ${listening ? "00010000" : "00000000"} 0001 01 ${inode} ${bound}`,
    ),
  ].join("\n");

const fakeProc = (
  processes: Readonly<Record<string, FakeProcess>>,
  self: ReadonlyArray<readonly [string, string, boolean]>,
): ProcView => ({
  list: (dir) => {
    if (dir === "/proc") return ["1", ...Object.keys(processes), "self"];
    const fds = /^\/proc\/(\d+)\/fd$/.exec(dir)?.[1];
    const table = fds === undefined ? undefined : processes[fds]?.fds;
    return table === undefined ? null : Object.keys(table);
  },
  read: (file) => {
    if (file === "/proc/self/net/unix") return unixTable(self);
    if (file === "/proc/1/cmdline") return "/sbin/init\0";
    const [, pid, rest] = /^\/proc\/(\d+)\/(.+)$/.exec(file) ?? [];
    const process = pid === undefined ? undefined : processes[pid];
    if (process === undefined) return null;
    if (rest === "cmdline") return `${process.argv.join("\0")}\0`;
    if (rest === "net/unix") return unixTable(process.sockets ?? []);
    if (rest === "status") return `Name:\tdockerd\nNSpid:\t${process.nsPid ?? pid}\n`;
    return null;
  },
  link: (file) => {
    const [, pid, fd] = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(file) ?? [];
    return pid === undefined || fd === undefined ? null : (processes[pid]?.fds?.[fd] ?? null);
  },
});

/** The host's own daemon: systemd-activated, its socket in the host's network namespace. */
const HOST_DOCKERD: FakeProcess = {
  argv: ["/usr/bin/dockerd", "-H", "fd://", "--config-file=/etc/docker/host.json"],
  sockets: [["8416", "/run/docker.sock", true]],
};
/** A workspace's Docker: dockerd inside a container, its own /var/run/docker.sock. */
const CONTAINER_DOCKERD: FakeProcess = {
  argv: ["dockerd", "--host=unix:///var/run/docker.sock"],
  sockets: [["5555", "/var/run/docker.sock", true]],
  nsPid: "900\t57",
};

describe("which dockerd the docker client talks to", () => {
  it("a host with two daemons reads the one serving the client's socket, not the first in /proc (e2e run 3)", () => {
    const proc = fakeProc({ "900": CONTAINER_DOCKERD, "2052": HOST_DOCKERD }, [
      ["8416", "/run/docker.sock", true],
    ]);
    // The first dockerd in /proc is the container's; the client's socket is the host's.
    expect(observeDockerd(proc, "unix:///var/run/docker.sock")).toEqual({
      kind: "observed",
      pid: "2052",
      argv: HOST_DOCKERD.argv,
    });
    // And the doctor reads that daemon's own --config-file.
    const reading = readShutdownTimeout(
      facts({
        ...dockerdFactsOf(observeDockerd(proc, "unix:///var/run/docker.sock")),
        files: { "/etc/docker/host.json": json({ "shutdown-timeout": 3600 }) },
      }),
    );
    expect(dockerShutdownCheck(reading)).toMatchObject({
      state: "ok",
      detail: "shutdown-timeout 3600 s · /etc/docker/host.json · covers the 3600 s capture grace",
    });
  });

  it("follows DOCKER_HOST to a second daemon on the host, by its -H", () => {
    const second: FakeProcess = {
      argv: ["dockerd", "-H", "unix:///run/docker-b.sock", "--shutdown-timeout=7200"],
      sockets: [
        ["8416", "/run/docker.sock", true],
        ["8420", "/run/docker-b.sock", true],
      ],
    };
    const proc = fakeProc({ "2052": HOST_DOCKERD, "3100": second }, [
      ["8416", "/run/docker.sock", true],
      ["8420", "/run/docker-b.sock", true],
    ]);
    expect(observeDockerd(proc, "unix:///run/docker-b.sock")).toMatchObject({ pid: "3100" });
    expect(observeDockerd(proc, "unix:///var/run/docker.sock")).toMatchObject({ pid: "2052" });
  });

  it("takes the daemon holding the socket among its fds when they can be read", () => {
    const a: FakeProcess = {
      argv: ["dockerd", "-H", "fd://"],
      sockets: [["8416", "/run/docker.sock", true]],
      fds: { "3": "socket:[9999]" },
    };
    const b: FakeProcess = {
      argv: ["dockerd", "-H", "fd://", "--shutdown-timeout=3600"],
      sockets: [["8416", "/run/docker.sock", true]],
      fds: { "3": "socket:[8416]" },
    };
    const proc = fakeProc({ "10": a, "11": b }, [["8416", "/run/docker.sock", true]]);
    expect(observeDockerd(proc, "unix:///var/run/docker.sock")).toMatchObject({ pid: "11" });
  });

  it("guesses nothing when it cannot tell, and the doctor says so", () => {
    const twin: FakeProcess = { argv: ["dockerd"], sockets: [["8416", "/run/docker.sock", true]] };
    const proc = fakeProc({ "10": twin, "11": twin }, [["8416", "/run/docker.sock", true]]);
    const observation = observeDockerd(proc, "unix:///var/run/docker.sock");
    expect(observation).toEqual({
      kind: "unresolved",
      why: "2 dockerd processes · could not tell which serves /run/docker.sock",
    });
    expect(
      dockerShutdownCheck(readShutdownTimeout(facts(dockerdFactsOf(observation)))).detail,
    ).toBe(
      "shutdown-timeout not observed · 2 dockerd processes · could not tell which serves /run/docker.sock",
    );
    // A daemon elsewhere: the local ones are not it.
    expect(observeDockerd(proc, "ssh://op@build-host")).toEqual({
      kind: "unresolved",
      why: "docker talks to ssh://op@build-host · not a socket on this machine",
    });
    // Only a container's daemon here: not the one the client reaches.
    expect(
      observeDockerd(
        fakeProc({ "900": CONTAINER_DOCKERD }, [["8416", "/run/docker.sock", true]]),
        "unix:///var/run/docker.sock",
      ),
    ).toEqual({
      kind: "unresolved",
      why: "1 dockerd process · none observed serving /run/docker.sock",
    });
    expect(observeDockerd(fakeProc({}, []), "unix:///var/run/docker.sock")).toEqual({
      kind: "none",
    });
  });

  it("a rootless daemon, in its own network namespace, is found by its socket path", () => {
    const rootless: FakeProcess = {
      argv: ["dockerd"],
      sockets: [["7000", "/run/user/1000/docker.sock", true]],
    };
    const proc = fakeProc({ "2052": HOST_DOCKERD, "4100": rootless }, [
      ["8416", "/run/docker.sock", true],
    ]);
    expect(observeDockerd(proc, "unix:///run/user/1000/docker.sock")).toMatchObject({
      pid: "4100",
    });
  });
});
