import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureMacHostVmInstalled,
  MAC_VMD_DATA_SENTINEL,
  MAC_VMD_NETWORK,
  macHostVmPaths,
  type MacHostVmRuntime,
  observeMacVmdStatusLines,
  parseMacHostVmField,
  removeMacHostVm,
  renderMacHostVmOverlay,
  renderMacVmdLaunchAgentPlist,
  type ServerMacHostVm,
  upgradeMacHostVm,
} from "./server-host-vm-mac.ts";
import { hostVmChoiceLine, observeHostVm, renderHostVmOverlay } from "./server-host-vm.ts";

const tempRoots: Array<string> = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-mac-host-vm-"));
  tempRoots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MAC_SELF_TEST_PASSED = JSON.stringify({
  version: 1,
  ok: true,
  checks: [
    { name: "tun", ok: true, observed: "/dev/net/tun opened" },
    { name: "nftables", ok: true, observed: "nftables v1.1.3" },
  ],
});

const VMD_HEALTH = JSON.stringify({
  protocolVersion: 1,
  version: "0.21.0",
  instanceNonce: "nonce-abc-123",
  hostIps: { ipv4: ["192.168.1.50"], ipv6: ["2001:db8::50"] },
  memoryBytes: 24 * 1024 ** 3,
  availableMemoryBytes: 16 * 1024 ** 3,
  memoryPressure: "normal",
  diskAvailableImportantBytes: 120 * 1024 ** 3,
  workersRunning: 2,
});

const VMD_SELF_TEST_PASSED = JSON.stringify({
  version: 1,
  ok: true,
  checks: [
    { name: "appleSilicon", ok: true, observed: "arm64" },
    { name: "vzWorkerSigned", ok: true, observed: "com.apple.security.virtualization" },
  ],
});

const SAMPLE_MAC: ServerMacHostVm = {
  installId: "inst1234abcd",
  port: 7422,
  imagesHostPath: "/Users/dev/Library/Application Support/Mend/vm/inst1234abcd/images",
  dataHostPath: "/Users/dev/Library/Application Support/Mend/vm/inst1234abcd/data",
  tokenHostPath: "/Users/dev/.config/mend/vmd-token",
  network: MAC_VMD_NETWORK,
};

describe("macOS host-vm overlay and LaunchAgent plist", () => {
  it("renders compose.host-vm.yaml for mac-vmd with APFS bind mounts and enable_icc=false", () => {
    const overlay = renderHostVmOverlay({ sessionRuntime: "host-vm", macHostVm: SAMPLE_MAC });
    expect(overlay).toBe(renderMacHostVmOverlay(SAMPLE_MAC));
    expect(overlay).toContain('SEALANT_HOST_VM_BACKEND: "mac-vmd"');
    expect(overlay).toContain(`SEALANT_HOST_VM_IMAGE_HOST_PATH: "${SAMPLE_MAC.imagesHostPath}"`);
    expect(overlay).toContain(`SEALANT_HOST_VM_DATA_HOST_PATH: "${SAMPLE_MAC.dataHostPath}"`);
    expect(overlay).toContain('SEALANT_MAC_VMD_PORT: "7422"');
    expect(overlay).toContain(`${SAMPLE_MAC.tokenHostPath}:/run/sealant-vmd/token:ro`);
    expect(overlay).toContain('com.docker.network.bridge.enable_icc: "false"');
    expect(parseMacHostVmField(SAMPLE_MAC)).toEqual(SAMPLE_MAC);
    expect(parseMacHostVmField({ ...SAMPLE_MAC, port: 0 })).toBeNull();
  });

  it("renders a per-install LaunchAgent plist with AbandonProcessGroup so live VMs survive reloads", () => {
    const paths = macHostVmPaths("/Users/dev", "/Users/dev/.config/mend", "inst1234abcd");
    const plist = renderMacVmdLaunchAgentPlist(paths, 7422);
    expect(plist).toContain("<string>sh.sealant.vmd.inst1234abcd</string>");
    expect(plist).toContain("<key>AbandonProcessGroup</key>\n  <true/>");
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
    expect(plist).toContain("<string>127.0.0.1:7422</string>");
    expect(plist).toContain(`<string>${paths.tokenPath}</string>`);
  });
});

describe("observeHostVm on Apple Silicon macOS", () => {
  it("passes with mac-vmd self-test (no /dev/kvm) and isolated gateway on Apple Silicon macOS >= 14", async () => {
    const calls: Array<readonly [string, ReadonlyArray<string>]> = [];
    const result = await observeHostVm(
      {
        platform: "darwin",
        arch: "arm64",
        osRelease: "24.2.0",
        uid: 501,
        run: async (command, args) => {
          calls.push([command, args]);
          if (command === "launchctl") return { status: 0, stdout: "gui/501 = {}", stderr: "" };
          if (args.includes("--self-test")) {
            return { status: 0, stdout: `${MAC_SELF_TEST_PASSED}\n`, stderr: "" };
          }
          if (args[2] === "version") return { status: 0, stdout: "29.7.2\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
        randomBytes: (size) => Buffer.alloc(size, 0xaa),
      },
      {
        context: "orbstack",
        endpoint: "unix:///Users/dev/.orbstack/run/docker.sock",
        offline: false,
      },
    );

    expect(result).toEqual({ _tag: "passed", backend: "mac-vmd" });
    expect(hostVmChoiceLine(result)).toContain("Apple Silicon macOS Virtualization.framework");
    const runnerCall = calls.find(([, args]) => args.includes("--self-test"))?.[1] ?? [];
    expect(runnerCall).toContain("--vmm-backend");
    expect(runnerCall).toContain("mac-vmd");
    expect(runnerCall).not.toContain("/dev/kvm");
  });

  it("refuses Intel Macs, macOS older than 14, and remote SSH Docker contexts", async () => {
    const base = {
      platform: "darwin" as const,
      arch: "arm64",
      osRelease: "24.0.0",
      uid: 501,
      run: async () => ({ status: 0, stdout: "", stderr: "" }),
      randomBytes: (size: number) => Buffer.alloc(size, 0xbb),
    };
    const local = { context: "default", endpoint: "unix:///var/run/docker.sock", offline: false };

    expect(await observeHostVm({ ...base, arch: "x64" }, local)).toEqual({
      _tag: "unavailable",
      observed: expect.stringContaining("Apple Silicon (arm64)"),
    });
    expect(await observeHostVm({ ...base, osRelease: "22.6.0" }, local)).toEqual({
      _tag: "unavailable",
      observed: expect.stringContaining("macOS 14"),
    });
    expect(await observeHostVm(base, { ...local, endpoint: "ssh://ops@box.example.net" })).toEqual({
      _tag: "unavailable",
      observed: expect.stringContaining("local Docker context"),
    });
  });
});

describe("ensureMacHostVmInstalled, upgradeMacHostVm, status and uninstall", () => {
  it("installs bundle, writes sentinel and token, verifies instanceNonce + shared APFS, is idempotent, upgrades, and uninstalls cleanly", async () => {
    const root = makeTempDir();
    const homeDir = path.join(root, "home");
    const configDir = path.join(root, "config");
    const fakeBundle = path.join(root, "bundle.tar.gz");
    fs.writeFileSync(fakeBundle, "fake-tarball");

    const calls: Array<readonly [string, ReadonlyArray<string>]> = [];
    const lines: Array<string> = [];
    let launchdBootstrapped = false;

    const runtime: MacHostVmRuntime = {
      platform: "darwin",
      arch: "arm64",
      osRelease: "25.0.0",
      homeDir,
      configDir,
      uid: 501,
      macVmdBundlePath: fakeBundle,
      writeLine: (line) => lines.push(line),
      randomBytes: (size) => Buffer.alloc(size, 0x42),
      sleep: async () => undefined,
      portTaken: async () => false,
      fetchText: async (url) => {
        if (!launchdBootstrapped) return { status: 0, body: "", error: "ECONNREFUSED" };
        if (url.endsWith("/v1/health")) return { status: 200, body: VMD_HEALTH };
        if (url.endsWith("/v1/self-test")) return { status: 200, body: VMD_SELF_TEST_PASSED };
        return { status: 404, body: "" };
      },
      run: async (command, args) => {
        calls.push([command, args]);
        if (command === "tar") {
          const dest = args[args.indexOf("-C") + 1] ?? "";
          for (const file of ["sealant-vmd", "sealant-vz-worker", "Image"]) {
            fs.writeFileSync(path.join(dest, file), file, { mode: 0o755 });
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "launchctl") {
          if (args[0] === "bootstrap") launchdBootstrapped = true;
          if (args[0] === "print") return { status: 0, stdout: "state = running", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "docker" && args.some((arg) => arg.includes("wget"))) {
          return { status: 0, stdout: VMD_HEALTH, stderr: "" };
        }
        if (command === "docker" && args.some((arg) => arg.includes("printf"))) {
          const mount = args.find((arg) => arg.includes("target=/probe")) ?? "";
          const source = /source=([^,]+)/.exec(mount)?.[1] ?? "";
          const payload = args.at(-2) ?? "";
          const name = args.at(-1) ?? "";
          fs.writeFileSync(path.join(source, name), payload);
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    const mac = await ensureMacHostVmInstalled(runtime, {
      installId: "inst1234abcd",
      dockerContext: "orbstack",
      helperImage: "busybox:latest",
      offline: false,
    });

    const paths = macHostVmPaths(homeDir, configDir, "inst1234abcd");
    expect(mac.port).toBe(7422);
    expect(paths.dataSentinelPath.endsWith(MAC_VMD_DATA_SENTINEL)).toBe(true);
    expect(fs.readFileSync(paths.dataSentinelPath, "utf8")).toBe("inst1234abcd\n");
    expect(fs.existsSync(paths.tokenPath)).toBe(true);
    expect(fs.existsSync(paths.launchAgentPlistPath)).toBe(true);
    expect(calls).toContainEqual(["tmutil", ["addexclusion", paths.vmRoot]]);
    expect(calls).toContainEqual([
      "launchctl",
      ["bootstrap", "gui/501", paths.launchAgentPlistPath],
    ]);

    // Idempotent re-run without bundle override skips launchctl bootstrap/bootout completely.
    calls.length = 0;
    const { macVmdBundlePath: _unused, ...idempotentRuntime } = runtime;
    await ensureMacHostVmInstalled(idempotentRuntime, {
      installId: "inst1234abcd",
      dockerContext: "orbstack",
      helperImage: "busybox:latest",
      offline: true,
      existing: mac,
    });
    expect(calls.filter(([cmd]) => cmd === "launchctl")).toEqual([]);

    // Status line reports version, active VM count, pressure, and APFS headroom.
    const statusLines = await observeMacVmdStatusLines(idempotentRuntime, mac);
    expect(statusLines).toEqual([
      "macOS host-vm · sealant-vmd 0.21.0 on 127.0.0.1:7422 · 2 VMs running · memory pressure normal · APFS headroom 120.0 GiB",
    ]);

    // Upgrade unpacks and kickstarts without bootout.
    calls.length = 0;
    await upgradeMacHostVm(runtime, mac, false);
    expect(calls).toContainEqual([
      "launchctl",
      ["kickstart", "-k", "gui/501/sh.sealant.vmd.inst1234abcd"],
    ]);

    // Sibling install directory stays untouched when uninstalling this installId.
    const siblingDir = path.join(paths.vmRoot, "other9999");
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, "keep"), "sibling");

    const removed = await removeMacHostVm(runtime, mac);
    expect(removed).toContain(paths.launchAgentPlistPath);
    expect(removed).toContain(paths.tokenPath);
    expect(removed).toContain(paths.vmInstallDir);
    expect(fs.existsSync(paths.vmInstallDir)).toBe(false);
    expect(fs.existsSync(path.join(siblingDir, "keep"))).toBe(true);
  });
});
