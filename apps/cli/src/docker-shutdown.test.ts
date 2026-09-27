import { describe, expect, it } from "vitest";

import {
  type DockerDaemonFacts,
  dockerShutdownCheck,
  dockerShutdownSetupLine,
  type HostFile,
  parseDockerInfo,
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
