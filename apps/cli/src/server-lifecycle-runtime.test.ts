import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, expect, it } from "vitest";

import { HOST_VM_COMPOSE_FILE, HOST_VM_COMPOSE_OVERLAY } from "./server-host-vm.ts";
import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it(
  "saves where sessions run across setup, upgrade and restart, and changes it back explicitly",
  { timeout: 120_000 },
  async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).not.toContain("MEND_SESSION_RUNTIME=");
    // Boat alone is refused: setup needs its key and the two public addresses.
    expect(
      await serverCommand(["setup", "--offline", "--session-runtime", "boat"], f.runtime),
    ).toMatchObject({ _tag: "error", message: expect.stringContaining("--session-endpoint-url") });
    expect(
      await serverCommand(
        [
          "setup",
          "--offline",
          "--session-runtime",
          "boat",
          "--boat-deployment-id",
          "1a2b3c4d-0000-4000-8000-00000000abcd",
          "--boat-api-key-stdin",
          "--no-boat-resources",
          "--session-endpoint-url",
          "https://mend.example.com:8443",
          "--blob-store-public-url",
          "https://mend.example.com:10000",
        ],
        { ...f.runtime, readStdin: async () => "boat_live_0123456789abcdef\n" },
      ),
    ).toEqual({ _tag: "ok" });
    const before = f.files();
    expect(before["server.env"]).toContain("MEND_SESSION_RUNTIME=boat");
    expect(before["compose.posture.yaml"]).toContain("MEND_SESSION_RUNTIME");
    expect(JSON.parse(before["server.json"] ?? "{}").sessionRuntime).toBe("boat");
    expect(await serverCommand(["setup", "--yes", "--offline"], f.runtime)).toEqual({ _tag: "ok" });
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    for (const command of [["restart"], ["stop"], ["start", "--offline"]]) {
      expect(await serverCommand(command, f.runtime)).toEqual({ _tag: "ok" });
      expect(f.files()["server.env"]).toContain("MEND_SESSION_RUNTIME=boat");
      expect(f.state().upFiles).toContain("compose.posture.yaml");
    }
    expect(
      await serverCommand(["setup", "--offline", "--session-runtime", "docker"], f.runtime),
    ).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toContain("MEND_SESSION_RUNTIME=docker");
    expect(JSON.parse(f.files()["server.json"] ?? "{}").sessionRuntime).toBe("docker");
    expect(await serverCommand(["setup", "--session-runtime", "auto"], f.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining('must be "docker" or "boat"'),
    });
    // SLNT-794: offering both lets each organization choose; the default stays the saved one.
    expect(
      await serverCommand(["setup", "--offline", "--session-runtimes", "docker,boat"], f.runtime),
    ).toEqual({ _tag: "ok" });
    const both = f.files();
    expect(both["server.env"]).toContain("MEND_SESSION_RUNTIME=docker\n");
    expect(both["server.env"]).toContain("MEND_SESSION_RUNTIMES=docker,boat\n");
    expect(both["compose.posture.yaml"]).toContain("MEND_SESSION_RUNTIMES");
    expect(JSON.parse(both["server.json"] ?? "{}")).toMatchObject({
      sessionRuntime: "docker",
      sessionRuntimes: ["docker", "boat"],
    });
    expect(await serverCommand(["restart"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.files()["server.env"]).toContain("MEND_SESSION_RUNTIMES=docker,boat\n");
  },
);

it(
  "reads back a server set to host-vm another way, and offers no host-vm itself",
  { timeout: 120_000 },
  async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--offline", "--session-runtime", "docker"], f.runtime),
    ).toEqual({ _tag: "ok" });
    // A Docker install maps the store and control roots only: no host VM overlay.
    expect(f.files()[HOST_VM_COMPOSE_FILE]).toBeUndefined();
    // What an owner, or a later setup, writes: the saved config and its environment name host-vm.
    const configFile = path.join(f.active(), "server.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    fs.writeFileSync(
      configFile,
      `${JSON.stringify({ ...config, sessionRuntime: "host-vm" }, null, 2)}\n`,
    );
    const envFile = path.join(f.active(), "server.env");
    fs.writeFileSync(
      envFile,
      fs
        .readFileSync(envFile, "utf8")
        .replace("MEND_SESSION_RUNTIME=docker\n", "MEND_SESSION_RUNTIME=host-vm\n"),
    );
    // A config naming host-vm without the overlay that maps its volumes is a corrupt generation.
    expect(await serverCommand(["restart"], f.runtime)).toMatchObject({
      _tag: "error",
      message: expect.stringContaining(`${HOST_VM_COMPOSE_FILE} does not match`),
    });
    fs.writeFileSync(path.join(f.active(), HOST_VM_COMPOSE_FILE), HOST_VM_COMPOSE_OVERLAY);
    for (const command of [["restart"], ["setup", "--yes", "--offline"]]) {
      expect(await serverCommand(command, f.runtime)).toEqual({ _tag: "ok" });
      expect(f.files()["server.env"]).toContain("MEND_SESSION_RUNTIME=host-vm\n");
      expect(JSON.parse(f.files()["server.json"] ?? "{}").sessionRuntime).toBe("host-vm");
      expect(f.files()[HOST_VM_COMPOSE_FILE]).toBe(HOST_VM_COMPOSE_OVERLAY);
    }
    for (const flags of [
      ["--session-runtime", "host-vm"],
      ["--session-runtimes", "docker,host-vm"],
    ]) {
      expect(await serverCommand(["setup", "--offline", ...flags], f.runtime)).toMatchObject({
        _tag: "error",
        message: expect.stringMatching(/docker.*boat/),
      });
    }
  },
);
