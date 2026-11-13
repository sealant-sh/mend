import { describe, expect, it } from "vitest";

import { ProjectId } from "../src/ids.ts";
import {
  BOAT_SUPPORT,
  DOCKER_SUPPORT,
  OBSERVED_AT,
  observedSupportReading,
} from "../src/runtime-support-fixtures.ts";
import { RuntimeSupport } from "../src/runtime-support.ts";
import {
  offeredMoves,
  type ProjectRuntimeFacts,
  runtimeSwitchImpact,
  switchChangesNothing,
} from "../src/runtime-switch.ts";
import { defaultWorkspaceImage, type WorkspaceImage } from "../src/settings.ts";

const arch: WorkspaceImage = { ...defaultWorkspaceImage, os: "arch" };
const ubuntu: WorkspaceImage = { ...defaultWorkspaceImage, os: "ubuntu" };
const fedoraWithTools: WorkspaceImage = {
  ...defaultWorkspaceImage,
  os: "fedora",
  packages: ["postgresql"],
};
const custom: WorkspaceImage = {
  mode: "custom",
  baseImage: "node:22-bookworm",
  packages: [],
  setupCommands: [],
  services: { docker: true },
};
const boatTarget: WorkspaceImage = { ...defaultWorkspaceImage, os: "ubuntu" };

const project = (name: string, facts: Partial<ProjectRuntimeFacts> = {}): ProjectRuntimeFacts => ({
  id: ProjectId.make(`project-${name}`),
  name,
  visible: true,
  workspaceImage: null,
  services: [],
  serverFolders: 0,
  ...facts,
});

const onBoat = observedSupportReading(BOAT_SUPPORT);

describe("what moving to a runtime would change for new sessions", () => {
  it("lists each environment Boat cannot run, with Sealant's reason and the one Mend would move it to", () => {
    const impact = runtimeSwitchImpact({
      reading: onBoat,
      organizationDefault: { image: arch, inherited: true },
      projects: [
        project("inherits"),
        project("on-ubuntu", { workspaceImage: ubuntu }),
        project("on-fedora", { workspaceImage: fedoraWithTools }),
        project("custom", { workspaceImage: custom }),
      ],
    });
    expect(impact).toEqual({
      state: "observed",
      observedAt: OBSERVED_AT,
      runtime: "boat",
      organizationDefault: {
        refusal: "Boat supports Ubuntu and Nix; Arch is unsupported.",
        from: arch,
        to: boatTarget,
        inherited: true,
      },
      projects: [
        {
          id: "project-inherits",
          name: "inherits",
          environment: {
            refusal: "Boat supports Ubuntu and Nix; Arch is unsupported.",
            from: arch,
            to: boatTarget,
            inherited: true,
          },
          services: [],
          serverFolders: null,
        },
        {
          id: "project-on-fedora",
          name: "on-fedora",
          environment: {
            refusal: "Boat supports Ubuntu and Nix; Fedora is unsupported.",
            from: fedoraWithTools,
            to: boatTarget,
            inherited: false,
          },
          services: [],
          serverFolders: null,
        },
        {
          id: "project-custom",
          name: "custom",
          environment: {
            refusal: "Boat cannot boot a custom OCI base image.",
            from: custom,
            to: boatTarget,
            inherited: false,
          },
          services: [],
          serverFolders: null,
        },
      ],
      unseen: 0,
    });
    expect(offeredMoves(impact)).toEqual({
      organizationDefault: true,
      projects: ["project-on-fedora", "project-custom"],
    });
  });

  it("lists Services on a port the runtime holds and server folders it cannot bind", () => {
    const impact = runtimeSwitchImpact({
      reading: onBoat,
      organizationDefault: { image: ubuntu, inherited: false },
      projects: [
        project("web", {
          services: [
            { name: "web", port: 8080 },
            { name: "api", port: 3000 },
          ],
        }),
        project("models", { serverFolders: 2 }),
        project("plain"),
      ],
    });
    expect(impact).toMatchObject({
      state: "observed",
      organizationDefault: null,
      projects: [
        { name: "web", environment: null, services: [{ name: "web", port: 8080 }] },
        {
          name: "models",
          serverFolders: {
            count: 2,
            refusal: "Boat cannot bind directories from this deployment's own servers.",
          },
        },
      ],
    });
    // Nothing to move: a Service or a folder is the project's to change.
    expect(offeredMoves(impact)).toEqual({ organizationDefault: false, projects: [] });
  });

  it("counts the projects the caller cannot see, and never names them", () => {
    const impact = runtimeSwitchImpact({
      reading: onBoat,
      organizationDefault: { image: ubuntu, inherited: false },
      projects: [
        project("secret", { visible: false, workspaceImage: arch }),
        project("secret-port", { visible: false, services: [{ name: "web", port: 8080 }] }),
        project("hidden-but-fine", { visible: false }),
      ],
    });
    expect(impact).toMatchObject({ state: "observed", projects: [], unseen: 2 });
    expect(JSON.stringify(impact)).not.toContain("secret");
    expect(switchChangesNothing(impact)).toBe(false);
    expect(offeredMoves(impact).projects).toEqual([]);
  });

  it("changes nothing on a runtime that runs everything", () => {
    const impact = runtimeSwitchImpact({
      reading: observedSupportReading(DOCKER_SUPPORT),
      organizationDefault: { image: arch, inherited: true },
      projects: [
        project("custom", { workspaceImage: custom, serverFolders: 1 }),
        project("web", { services: [{ name: "web", port: 8080 }] }),
      ],
    });
    expect(switchChangesNothing(impact)).toBe(true);
    expect(offeredMoves(impact)).toEqual({ organizationDefault: false, projects: [] });
  });

  it("follows the report: a Boat that ran Arch would move nothing", () => {
    const archOnBoat = new RuntimeSupport({
      ...BOAT_SUPPORT,
      os: { ...BOAT_SUPPORT.os, arch: { supported: true } },
    });
    const impact = runtimeSwitchImpact({
      reading: observedSupportReading(archOnBoat),
      organizationDefault: { image: arch, inherited: true },
      projects: [project("inherits")],
    });
    expect(switchChangesNothing(impact)).toBe(true);
  });

  it("offers no move when the runtime runs no family Mend builds", () => {
    const noFamily = new RuntimeSupport({
      ...BOAT_SUPPORT,
      os: {
        ubuntu: { supported: false, message: "no ubuntu" },
        nix: { supported: false, message: "no nix" },
        arch: { supported: false, message: "no arch" },
        fedora: { supported: false, message: "no fedora" },
      },
    });
    const impact = runtimeSwitchImpact({
      reading: observedSupportReading(noFamily),
      organizationDefault: { image: arch, inherited: false },
      projects: [project("own", { workspaceImage: ubuntu })],
    });
    expect(impact).toMatchObject({
      organizationDefault: { to: null },
      projects: [{ environment: { to: null, inherited: false } }],
    });
    expect(offeredMoves(impact)).toEqual({ organizationDefault: false, projects: [] });
  });

  it("knows nothing when Sealant was not read or does not launch the runtime", () => {
    const unread = runtimeSwitchImpact({
      reading: { state: "unread", reason: "Sealant could not be reached" },
      organizationDefault: { image: arch, inherited: true },
      projects: [project("inherits")],
    });
    expect(unread).toEqual({ state: "unread", reason: "Sealant could not be reached" });
    expect(switchChangesNothing(unread)).toBe(false);
    const notLaunched = runtimeSwitchImpact({
      reading: { state: "not-launched", observedAt: OBSERVED_AT, runtime: "boat" },
      organizationDefault: { image: arch, inherited: true },
      projects: [],
    });
    expect(notLaunched).toEqual({
      state: "not-launched",
      observedAt: OBSERVED_AT,
      runtime: "boat",
    });
    expect(switchChangesNothing(notLaunched)).toBe(false);
  });
});
