import * as fs from "node:fs";

import { describe, expect, it } from "vitest";

import { composeOverlays } from "./server-edge.ts";
import {
  HOST_VM_COMPOSE_FILE,
  HOST_VM_COMPOSE_OVERLAY,
  type HostVmProbeRuntime,
  namesHostVm,
  observeHostVm,
  renderHostVmOverlay,
  selfTestFailure,
  sharedFilesystemLines,
} from "./server-host-vm.ts";

describe("the host VM overlay", () => {
  it("is the repository's compose.host-vm.yaml, byte for byte", () => {
    expect(HOST_VM_COMPOSE_OVERLAY).toBe(
      fs.readFileSync(
        new URL("../../../deploy/docker/compose.host-vm.yaml", import.meta.url),
        "utf8",
      ),
    );
  });

  it("comes only with a config that names host-vm", () => {
    expect(namesHostVm({})).toBe(false);
    expect(namesHostVm({ sessionRuntime: "docker" })).toBe(false);
    expect(namesHostVm({ sessionRuntimes: ["docker", "boat"] })).toBe(false);
    expect(namesHostVm({ sessionRuntime: "host-vm" })).toBe(true);
    expect(namesHostVm({ sessionRuntimes: ["docker", "host-vm"] })).toBe(true);
    // The offered list wins over the one runtime, as offeredSessionRuntimes reads it.
    expect(namesHostVm({ sessionRuntime: "host-vm", sessionRuntimes: ["docker"] })).toBe(false);
    expect(renderHostVmOverlay({ sessionRuntime: "docker" })).toBeUndefined();
    expect(renderHostVmOverlay({ sessionRuntime: "host-vm" })).toBe(HOST_VM_COMPOSE_OVERLAY);
    expect(composeOverlays({ sessionRuntime: "docker" })).not.toContain(HOST_VM_COMPOSE_FILE);
    expect(composeOverlays({ sessionRuntimes: ["docker", "host-vm"] })).toContain(
      HOST_VM_COMPOSE_FILE,
    );
  });
});

/**
 * What vm-runner 0.21.0-next.209 printed on a KVM host, and in a container without the devices,
 * shortened: each check also carries fields of its own, which setup does not read.
 */
const SELF_TEST_PASSED = JSON.stringify({
  version: 1,
  ok: true,
  checks: [
    { name: "kvm", ok: true, observed: "/dev/kvm opened read-write, KVM API 12" },
    { name: "tun", ok: true, observed: "/dev/net/tun opened" },
    { name: "nftables", ok: true, observed: "nftables v1.1.3" },
    { name: "landlock", ok: true, observed: "Landlock ABI 7 (Cloud Hypervisor needs 3)" },
    { name: "cloudHypervisor", ok: true, observed: "cloud-hypervisor v54.0" },
  ],
});
const SELF_TEST_FAILED = JSON.stringify({
  version: 1,
  ok: false,
  checks: [
    {
      name: "kvm",
      ok: false,
      observed: "/dev/kvm unavailable: No such file or directory (os error 2)",
      path: "/dev/kvm",
    },
    { name: "landlock", ok: true, observed: "Landlock ABI 7 (Cloud Hypervisor needs 3)" },
  ],
});

describe("the vm-runner self-test's report", () => {
  it("passes only on a report whose checks all passed and an exit of 0", () => {
    expect(selfTestFailure({ status: 0, stdout: `${SELF_TEST_PASSED}\n`, stderr: "" })).toBeNull();
    // An extra field Sealant adds later is no failure.
    expect(
      selfTestFailure({
        status: 0,
        stdout: JSON.stringify({ ...JSON.parse(SELF_TEST_PASSED), host: "x" }),
        stderr: "",
      }),
    ).toBeNull();
    expect(selfTestFailure({ status: 1, stdout: SELF_TEST_FAILED, stderr: "" })).toBe(
      "kvm: /dev/kvm unavailable: No such file or directory (os error 2)",
    );
    expect(selfTestFailure({ status: 1, stdout: SELF_TEST_PASSED, stderr: "killed" })).toBe(
      "the vm-runner self-test failed (killed)",
    );
  });

  it("is a failure in its own words when there is no report", () => {
    expect(selfTestFailure({ status: 125, stdout: "", stderr: "pull access denied\n" })).toBe(
      "the vm-runner self-test printed no report (pull access denied)",
    );
    expect(selfTestFailure({ status: 0, stdout: '{"version":2}', stderr: "" })).toBe(
      "the vm-runner self-test printed no report (exit 0)",
    );
    expect(
      selfTestFailure({
        status: 125,
        stdout: "",
        stderr:
          'docker: Error response from daemon: error gathering device information while adding custom device "/dev/kvm": no such file or directory.',
      }),
    ).toMatch(/^\/dev\/kvm unavailable \(docker: Error response/);
  });
});

/** A Docker host for the probes: each command's answer by its arguments, every call recorded. */
const probeRuntime = (
  answer: (args: ReadonlyArray<string>) => { status: number; stdout: string; stderr: string },
  options: { readonly platform?: NodeJS.Platform; readonly kvm?: boolean } = {},
) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runtime: HostVmProbeRuntime = {
    platform: options.platform ?? "linux",
    kvmDevice: () => options.kvm ?? true,
    run: async (_command, args) => {
      calls.push(args);
      return answer(args);
    },
    randomBytes: (size) => Buffer.alloc(size, 0xab),
  };
  return { runtime, calls };
};

const LOCAL = { context: "default", endpoint: "unix:///var/run/docker.sock", offline: false };

describe("observeHostVm", () => {
  it("looks no further than a missing /dev/kvm, or a host that is not Linux", async () => {
    for (const options of [{ kvm: false }, { platform: "darwin" as const }]) {
      const { runtime, calls } = probeRuntime(
        () => ({ status: 0, stdout: "", stderr: "" }),
        options,
      );
      expect(await observeHostVm(runtime, LOCAL)).toEqual({
        _tag: "unavailable",
        observed: "/dev/kvm unavailable",
      });
      expect(calls).toEqual([]);
    }
  });

  it("on a Docker host elsewhere, lets the self-test speak for its /dev/kvm", async () => {
    const { runtime, calls } = probeRuntime(
      () => ({
        status: 1,
        stdout: SELF_TEST_FAILED,
        stderr: "",
      }),
      { kvm: false },
    );
    expect(
      await observeHostVm(runtime, { ...LOCAL, endpoint: "ssh://ops@box.example.net" }),
    ).toMatchObject({ _tag: "unavailable", observed: expect.stringMatching(/^kvm: /) });
    expect(calls).toHaveLength(1);
  });

  it("removes the isolation check's network whether or not Docker created it", async () => {
    for (const created of [0, 1]) {
      const { runtime, calls } = probeRuntime((args) =>
        args.includes("--self-test")
          ? { status: 0, stdout: SELF_TEST_PASSED, stderr: "" }
          : args[2] === "version"
            ? { status: 0, stdout: "29.1.3\n", stderr: "" }
            : args[3] === "create"
              ? {
                  status: created,
                  stdout: "",
                  stderr: created === 0 ? "" : "invalid option gateway_mode_ipv4",
                }
              : { status: 0, stdout: "", stderr: "" },
      );
      expect((await observeHostVm(runtime, LOCAL))._tag).toBe(
        created === 0 ? "passed" : "unavailable",
      );
      expect(calls.at(-1)).toEqual([
        "--context",
        "default",
        "network",
        "rm",
        "mend-setup-isolation-check-abababab",
      ]);
    }
  });

  it("refuses an Engine older than 28 without creating anything", async () => {
    const { runtime, calls } = probeRuntime((args) =>
      args.includes("--self-test")
        ? { status: 0, stdout: SELF_TEST_PASSED, stderr: "" }
        : { status: 0, stdout: "27.5.1\n", stderr: "" },
    );
    expect(await observeHostVm(runtime, LOCAL)).toEqual({
      _tag: "unavailable",
      observed:
        "Docker Engine 27.5.1 cannot isolate a network's gateway (gateway_mode_ipv4=isolated needs Docker Engine 28 or later)",
    });
    expect(calls.map((args) => args[2])).toEqual(["run", "version"]);
  });
});

describe("sharedFilesystemLines", () => {
  const others = [
    { volume: "mend_mend-postgres", holds: "Postgres" },
    { volume: "mend-garage", holds: "Garage" },
  ];

  it("says it could not check a volume on another driver, and runs nothing more", async () => {
    const { runtime, calls } = probeRuntime((args) =>
      args[2] === "volume"
        ? {
            status: 0,
            stdout: JSON.stringify({ Driver: "rexray", Mountpoint: "", Options: null }),
            stderr: "",
          }
        : { status: 0, stdout: "", stderr: "" },
    );
    expect(await sharedFilesystemLines(runtime, "default", others, "busybox")).toEqual([
      "Could not check whether mend-vm-data shares a filesystem with the server's data: mend-vm-data uses the rexray volume driver.",
    ]);
    expect(calls.some((args) => args[2] === "run")).toBe(false);
  });

  it("says it could not check when stat fails, and never warns for it", async () => {
    const { runtime } = probeRuntime((args) =>
      args[2] === "volume"
        ? { status: 1, stdout: "", stderr: "Error response from daemon: get x: no such volume" }
        : args[2] === "info"
          ? { status: 0, stdout: "/var/lib/docker\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "stat: permission denied" },
    );
    const lines = await sharedFilesystemLines(runtime, "default", others, "busybox");
    expect(lines).toEqual([
      "Could not check whether mend-vm-data shares a filesystem with the server's data: stat on the Docker host failed (stat: permission denied).",
    ]);
  });

  it("counts a volume on a filesystem of its own (nfs) as apart from the rest", async () => {
    const { runtime } = probeRuntime((args) =>
      args[2] === "volume"
        ? {
            status: 0,
            stdout: JSON.stringify(
              args.at(-1) === "mend-vm-data"
                ? {
                    Driver: "local",
                    Mountpoint: "/var/lib/docker/volumes/mend-vm-data/_data",
                    Options: { type: "nfs", o: "addr=10.0.0.2", device: ":/vm-data" },
                  }
                : {
                    Driver: "local",
                    Mountpoint: `/var/lib/docker/volumes/${args.at(-1)}/_data`,
                    Options: null,
                  },
            ),
            stderr: "",
          }
        : { status: 0, stdout: "41\n41\n", stderr: "" },
    );
    expect(await sharedFilesystemLines(runtime, "default", others, "busybox")).toEqual([]);
  });
});
