import * as fs from "node:fs";

import { describe, expect, it } from "vitest";

import { composeOverlays } from "./server-edge.ts";
import {
  HOST_VM_COMPOSE_FILE,
  HOST_VM_COMPOSE_OVERLAY,
  namesHostVm,
  renderHostVmOverlay,
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
