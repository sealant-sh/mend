import { describe, expect, it } from "vitest";

import {
  type DaemonUnit,
  type DockerDaemonFacts,
  dockerStopCheck,
  dockerStopSetupLine,
  observeDockerd,
  parseContainerStopTimeouts,
  parseDaemonUnit,
  parseDockerInfo,
  parseSystemdTimespan,
  type ProcView,
  readDockerStop,
  WORKSPACE_STOP_TIMEOUT_SECONDS,
} from "./docker-shutdown.ts";

const NATIVE = {
  operatingSystem: "Ubuntu 24.04.1 LTS",
  securityOptions: ["name=seccomp"],
  liveRestore: false,
};
const DESKTOP = { ...NATIVE, operatingSystem: "Docker Desktop" };
const ROOTLESS = {
  ...NATIVE,
  securityOptions: ["name=seccomp,profile=builtin", "name=rootless"],
};

/** Ubuntu's docker-ce unit: systemd's default 90 s stop timeout. */
const UNIT: DaemonUnit = {
  name: "docker.service",
  activeState: "active",
  mainPid: "840",
  timeoutStopSeconds: 90,
};

/** The RC 2 host: a capture workspace created with the old 3600 s stop timeout, and its sidecar. */
const OLD_WORKSPACE = [
  { name: "mend-mend-1", stopTimeout: null },
  { name: "sealant-266a36ad-e169-4478-971b-41c47d820438", stopTimeout: 3600 },
  { name: "sealant-266a36ad-e169-4478-971b-41c47d820438-docker", stopTimeout: null },
];

const facts = (overrides: Partial<DockerDaemonFacts> = {}): DockerDaemonFacts => ({
  info: NATIVE,
  dockerdPid: "840",
  containers: [],
  unit: UNIT,
  ...overrides,
});

describe("what a Docker daemon stop waits for", () => {
  it("a workspace's 3600 s stop timeout outlasts systemd's 90 s: todo, stop that session first (RC 2)", () => {
    const reading = readDockerStop(facts({ containers: OLD_WORKSPACE }));
    expect(dockerStopCheck(reading)).toEqual({
      label: "docker",
      state: "todo",
      detail:
        "a Docker stop waits up to 3600 s · sealant-266a36ad-e169-4478-971b-41c47d820438's stop timeout · systemd kills docker.service after 90 s, and Docker's next start waits for what it left running",
      fix: "stop that session (mend sessions, then mend stop <session>) before you restart or upgrade Docker",
    });
    // Setup counts the workspaces it starts beside the ones running, and says it before starting.
    expect(dockerStopSetupLine(readDockerStop(facts({ containers: OLD_WORKSPACE }), 60))).toBe(
      "A Docker stop waits up to 3600 s (sealant-266a36ad-e169-4478-971b-41c47d820438's stop timeout), but systemd kills docker.service after 90 s, and Docker's next start waits for what it left running: a restart or upgrade of Docker with a live session leaves Docker down until that workspace ends. To avoid it: stop that session (mend sessions, then mend stop <session>) before you restart or upgrade Docker.",
    );
  });

  it("a workspace with the bounded stop timeout fits: ok, and setup says nothing", () => {
    const containers = [{ name: "sealant-run-1", stopTimeout: WORKSPACE_STOP_TIMEOUT_SECONDS }];
    expect(dockerStopCheck(readDockerStop(facts({ containers })))).toEqual({
      label: "docker",
      state: "ok",
      detail:
        "a Docker stop waits up to 60 s · sealant-run-1's stop timeout · systemd allows docker.service 90 s",
      fix: null,
    });
    expect(dockerStopSetupLine(readDockerStop(facts(), WORKSPACE_STOP_TIMEOUT_SECONDS))).toBeNull();
    expect(dockerStopCheck(readDockerStop(facts()))).toMatchObject({
      state: "ok",
      detail: "no container running · systemd allows docker.service 90 s",
    });
  });

  it("a unit stop timeout too short even for a bounded workspace names the unit setting", () => {
    const unit = { ...UNIT, timeoutStopSeconds: 45 };
    expect(
      dockerStopSetupLine(readDockerStop(facts({ unit }), WORKSPACE_STOP_TIMEOUT_SECONDS)),
    ).toBe(
      "A Docker stop waits up to 60 s (a workspace's stop timeout), but systemd kills docker.service after 45 s, and Docker's next start waits for what it left running: a restart or upgrade of Docker with a live session leaves Docker down until that workspace ends. To avoid it: sudo systemctl edit docker.service and set [Service] TimeoutStopSec=95.",
    );
    expect(
      dockerStopCheck(
        readDockerStop(
          facts({ unit: { ...UNIT, timeoutStopSeconds: null }, containers: OLD_WORKSPACE }),
        ),
      ),
    ).toMatchObject({
      state: "ok",
      detail: expect.stringContaining("systemd waits for docker.service without a limit"),
    });
  });

  it("live-restore leaves sessions running through a Docker restart: ok, nothing to say", () => {
    const live = facts({ info: { ...NATIVE, liveRestore: true }, containers: OLD_WORKSPACE });
    expect(dockerStopCheck(readDockerStop(live))).toEqual({
      label: "docker",
      state: "ok",
      detail: "live-restore on · a Docker restart leaves sessions running",
      fix: null,
    });
    expect(dockerStopSetupLine(readDockerStop(live, 60))).toBeNull();
  });

  it("what could not be read is not observed, never fine", () => {
    expect(dockerStopCheck(readDockerStop(facts({ info: null })))).toEqual({
      label: "docker",
      state: "todo",
      detail: "Docker stop not observed · docker info did not answer",
      fix: null,
    });
    expect(dockerStopCheck(readDockerStop(facts({ containers: null })))).toMatchObject({
      state: "todo",
      detail: "Docker stop not observed · its containers could not be read",
    });
    // No unit observed: systemd's default is the limit assumed, and said.
    expect(
      dockerStopCheck(readDockerStop(facts({ unit: null, containers: OLD_WORKSPACE }))),
    ).toMatchObject({
      state: "todo",
      detail: expect.stringContaining("no systemd unit observed (systemd's default is 90 s)"),
    });
    expect(
      dockerStopCheck(readDockerStop(facts({ unit: { ...UNIT, activeState: "inactive" } }))).detail,
    ).toBe("no container running · docker.service is inactive (systemd's default is 90 s)");
  });

  it("Docker Desktop has no unit; a rootless daemon's is the user's", () => {
    const desktop = readDockerStop(facts({ info: DESKTOP, containers: OLD_WORKSPACE }));
    expect(dockerStopCheck(desktop)).toMatchObject({
      state: "todo",
      fix: "stop that session (mend sessions, then mend stop <session>) before you restart or upgrade Docker",
    });
    expect(desktop).toMatchObject({
      limit: { kind: "none", why: "no systemd unit runs this daemon" },
    });
    const unit = { ...UNIT, name: "docker.service (user)", mainPid: "rootlesskit" };
    expect(readDockerStop(facts({ info: ROOTLESS, unit, dockerdPid: "4100" }))).toMatchObject({
      limit: { kind: "observed", unit: "docker.service (user)", seconds: 90 },
    });
    const short = { ...unit, timeoutStopSeconds: 30 };
    expect(
      dockerStopCheck(
        readDockerStop(
          facts({
            info: ROOTLESS,
            unit: short,
            containers: [{ name: "sealant-run-1", stopTimeout: 60 }],
          }),
        ),
      ).fix,
    ).toBe("sudo systemctl edit docker.service and set [Service] TimeoutStopSec=95");
  });

  it("another container's long stop timeout is named, with its own fix", () => {
    const containers = [{ name: "postgres", stopTimeout: 300 }];
    expect(dockerStopCheck(readDockerStop(facts({ containers }))).fix).toBe(
      "docker stop postgres before you restart or upgrade Docker",
    );
  });

  it("reads docker info's JSON, and nothing else", () => {
    expect(
      parseDockerInfo(
        JSON.stringify({
          OperatingSystem: "Docker Desktop",
          SecurityOptions: ["a"],
          LiveRestoreEnabled: true,
        }),
      ),
    ).toEqual({ operatingSystem: "Docker Desktop", securityOptions: ["a"], liveRestore: true });
    expect(parseDockerInfo(JSON.stringify({ OperatingSystem: "Ubuntu" }))).toEqual({
      operatingSystem: "Ubuntu",
      securityOptions: [],
      liveRestore: false,
    });
    expect(parseDockerInfo("Docker Engine - Community")).toBeNull();
    expect(parseDockerInfo(JSON.stringify({ ServerVersion: "29" }))).toBeNull();
  });

  it("reads docker inspect's stop timeouts, systemctl's timespans and its unit", () => {
    expect(
      parseContainerStopTimeouts("/sealant-run-1|3600\n/mend-mend-1|null\n\n/odd|name|60\n"),
    ).toEqual([
      { name: "sealant-run-1", stopTimeout: 3600 },
      { name: "mend-mend-1", stopTimeout: null },
      { name: "odd|name", stopTimeout: 60 },
    ]);
    expect(parseSystemdTimespan("1min 30s")).toBe(90);
    expect(parseSystemdTimespan("90s")).toBe(90);
    expect(parseSystemdTimespan("2h")).toBe(7200);
    expect(parseSystemdTimespan("500ms")).toBe(1);
    expect(parseSystemdTimespan("infinity")).toBeNull();
    expect(parseSystemdTimespan("soon")).toBeUndefined();
    expect(
      parseDaemonUnit(
        "docker.service",
        "ActiveState=active\nMainPID=840\nTimeoutStopUSec=1min 30s\n",
      ),
    ).toEqual(UNIT);
    expect(parseDaemonUnit("docker.service", "")).toBeNull();
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
    // And the unit's limit is read as that daemon's only when its main process is that one.
    const unit = { ...UNIT, mainPid: "2052" };
    expect(readDockerStop(facts({ dockerdPid: "2052", unit }))).toMatchObject({
      limit: { kind: "observed", unit: "docker.service", seconds: 90 },
    });
    expect(readDockerStop(facts({ dockerdPid: "900", unit }))).toMatchObject({
      limit: { kind: "none", why: "docker.service is not the dockerd docker talks to" },
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
