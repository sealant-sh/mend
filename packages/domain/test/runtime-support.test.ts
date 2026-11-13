import { describe, expect, it } from "vitest";

import {
  BOAT_SUPPORT,
  DOCKER_AND_BOAT,
  DOCKER_SUPPORT,
  observedRuntimes,
  OBSERVED_AT,
  UNREAD,
} from "../src/runtime-support-fixtures.ts";
import {
  environmentRefusal,
  newProjectWorkspaceImage,
  reservedPortRefusal,
  RuntimeSupport,
  runtimeSupportFor,
} from "../src/runtime-support.ts";
import { defaultWorkspaceImage, type WorkspaceImage } from "../src/settings.ts";

const arch: WorkspaceImage = { ...defaultWorkspaceImage, os: "arch" };
const ubuntu: WorkspaceImage = { ...defaultWorkspaceImage, os: "ubuntu" };
const custom: WorkspaceImage = {
  mode: "custom",
  baseImage: "node:22-bookworm",
  packages: [],
  setupCommands: [],
  services: { docker: true },
};

describe("what the organization's runtime supports", () => {
  it("reads the runtime its new sessions run on, Core's default where Sealant picks", () => {
    expect(runtimeSupportFor(DOCKER_AND_BOAT, "boat")).toEqual({
      state: "observed",
      observedAt: OBSERVED_AT,
      support: BOAT_SUPPORT,
    });
    expect(runtimeSupportFor(DOCKER_AND_BOAT, null)).toMatchObject({
      state: "observed",
      support: { runtime: "docker" },
    });
  });

  it("says a runtime Core did not list is not launched, and an unread report is unread", () => {
    expect(runtimeSupportFor(observedRuntimes(DOCKER_SUPPORT), "boat")).toEqual({
      state: "not-launched",
      observedAt: OBSERVED_AT,
      runtime: "boat",
    });
    expect(runtimeSupportFor(UNREAD, "boat")).toEqual(UNREAD);
  });
});

describe("environment refusals come from Core's report", () => {
  it("refuses what the report marks unsupported, in Core's words", () => {
    expect(environmentRefusal(BOAT_SUPPORT, arch)).toBe(
      "Boat supports Ubuntu and Nix; Arch is unsupported.",
    );
    expect(environmentRefusal(BOAT_SUPPORT, custom)).toBe(
      "Boat cannot boot a custom OCI base image.",
    );
    expect(environmentRefusal(BOAT_SUPPORT, ubuntu)).toBeNull();
    expect(environmentRefusal(DOCKER_SUPPORT, arch)).toBeNull();
  });

  it("follows the report when it changes: a Boat that ran Arch would be allowed", () => {
    const archOnBoat = new RuntimeSupport({
      ...BOAT_SUPPORT,
      os: { ...BOAT_SUPPORT.os, arch: { supported: true } },
    });
    expect(environmentRefusal(archOnBoat, arch)).toBeNull();
    const noDocker = new RuntimeSupport({
      ...DOCKER_SUPPORT,
      docker: { supported: false, message: "No Docker in this workspace." },
    });
    expect(environmentRefusal(noDocker, ubuntu)).toBe("No Docker in this workspace.");
    expect(environmentRefusal(noDocker, { ...ubuntu, services: { docker: false } })).toBeNull();
  });

  it("refuses a Service on a port the runtime reserves, and only that port", () => {
    expect(reservedPortRefusal(BOAT_SUPPORT, 8080)).toBe(
      "Boat holds port 8080 inside every workspace for itself, so a Service cannot listen on it. Use another port.",
    );
    expect(reservedPortRefusal(BOAT_SUPPORT, 3000)).toBeNull();
    expect(reservedPortRefusal(DOCKER_SUPPORT, 8080)).toBeNull();
  });
});

describe("a new project's environment", () => {
  it("inherits whatever the runtime can run, and nothing is guessed without a report", () => {
    expect(newProjectWorkspaceImage(arch, DOCKER_SUPPORT)).toBeNull();
    expect(newProjectWorkspaceImage(ubuntu, BOAT_SUPPORT)).toBeNull();
    expect(newProjectWorkspaceImage(arch, null)).toBeNull();
  });

  it("starts on the first family the runtime runs when the inherited one cannot run", () => {
    expect(newProjectWorkspaceImage(arch, BOAT_SUPPORT)).toEqual({
      ...defaultWorkspaceImage,
      os: "ubuntu",
      services: { docker: true },
    });
    expect(newProjectWorkspaceImage(custom, BOAT_SUPPORT)).toMatchObject({ os: "ubuntu" });
    const nixOnly = new RuntimeSupport({
      ...BOAT_SUPPORT,
      os: { ...BOAT_SUPPORT.os, ubuntu: { supported: false, message: "no" } },
    });
    expect(newProjectWorkspaceImage(arch, nixOnly)).toMatchObject({ os: "nix" });
  });
});
