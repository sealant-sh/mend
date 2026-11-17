// @vitest-environment jsdom
import {
  defaultWorkspaceImage,
  OrganizationId,
  ProjectId,
  type WorkspaceImage,
} from "@mend/domain";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACME,
  choice,
  InRouter,
  pageText,
  RUNTIMES,
  tipOf,
  type RuntimeView,
} from "#/components/settings/runtime-test-views";
import {
  byText,
  click,
  renderWithTrpc,
  type Answer,
} from "#/components/settings/sessions-test-trpc";
import type { ProjectDetailDto, ProjectDto } from "#/lib/api";

import { FoldersSettings } from "./folders.tsx";
import { WorkspaceSettings } from "./workspace.tsx";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const ARCH: WorkspaceImage = { ...defaultWorkspaceImage, os: "arch" };
const UBUNTU: WorkspaceImage = { ...defaultWorkspaceImage, os: "ubuntu" };

const project = (workspaceImage: WorkspaceImage | null): ProjectDto => ({
  id: ProjectId.make("project-mend"),
  name: "mend",
  organizationId: OrganizationId.make("org-acme"),
  visibility: "private",
  createdByUserId: null,
  scratchOwnerUserId: null,
  originUrl: "git@github.com:sealant-sh/mend.git",
  storePath: "/store/mend/repo.git",
  defaultBranch: "main",
  adoptedSha: null,
  autoTour: "inherit",
  autoSuggest: "inherit",
  autoName: "inherit",
  autoLand: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "mend-key",
  workspaceImage,
  applyDotfiles: false,
  newWorktreesUseProjectResources: true,
  defaultShellProfile: true,
  inheritUserSkills: true,
  hotSessions: 2,
  installCommand: null,
  installEnabled: false,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
});

const detailOf = (
  workspaceImage: WorkspaceImage | null,
  mountDelivery: ProjectDetailDto["mountDelivery"] = "bind",
): ProjectDetailDto => ({
  project: project(workspaceImage),
  sessions: [],
  hiddenEndedSessions: 0,
  annotations: [],
  worktrees: [],
  worktreeAnnotations: [],
  capabilities: { manage: true, changeVisibility: true, remove: true, hostMounts: true },
  mountDelivery,
});

/** The server, with the organization's environment `inherited` and its runtime `runtime`. */
const server =
  (runtime: RuntimeView, inherited: WorkspaceImage = UBUNTU) =>
  (path: string): Answer => {
    switch (path) {
      case "organization.current":
        return { data: ACME };
      case "organization.runtime":
        return { data: runtime };
      case "organization.settings":
        return {
          data: {
            organization: { workspaceImage: inherited },
            effective: { workspaceImage: inherited },
          },
        };
      case "projects.installDetection":
        return { data: { ref: "main", read: true, command: null, from: null } };
      case "projects.hotSessionsStatus":
        return { data: { hotSessions: 2, ready: 2, warming: 0, failed: 0, error: null } };
      case "folders.list":
      case "projects.folders":
        return { data: [] };
      case "projects.mounts":
        return {
          data: [{ id: "mount-1", name: "models", hostPath: "/srv/models", readOnly: true }],
        };
      default:
        return { refuse: `no fake for ${path}` };
    }
  };

const renderWorkspace = async (
  workspaceImage: WorkspaceImage | null,
  runtime: RuntimeView,
  inherited?: WorkspaceImage,
) => {
  root = await renderWithTrpc(
    <InRouter>
      <WorkspaceSettings detail={detailOf(workspaceImage)} />
    </InRouter>,
    server(runtime, inherited),
  );
};

const alertText = () =>
  [...document.querySelectorAll('[role="alert"]')]
    .map((alert) => alert.textContent ?? "")
    .filter((text) => text !== "");

describe("the project's workspace image against where new sessions run", () => {
  it("on Boat, shows Arch, Fedora and a custom image unavailable with Sealant's reasons", async () => {
    await renderWorkspace(UBUNTU, RUNTIMES.boat);
    expect(choice("OS", "Arch").disabled).toBe(true);
    expect(tipOf(choice("OS", "Arch"))).toBe("Boat supports Ubuntu and Nix; Arch is unsupported.");
    expect(choice("OS", "Fedora").disabled).toBe(true);
    expect(choice("OS", "Ubuntu").disabled).toBe(false);
    expect(choice("Base", "Custom image").disabled).toBe(true);
    expect(tipOf(choice("Base", "Custom image"))).toBe("Boat cannot boot a custom OCI base image.");
    expect(pageText()).toContain(
      "New sessions in Acme run on Boat, which runs Ubuntu and Nix; Arch and Fedora are unavailable.",
    );
    expect(alertText()).toEqual([]);
  });

  it("on Boat, keeps the project's saved Arch image and says what to do", async () => {
    await renderWorkspace(ARCH, RUNTIMES.boat);
    expect(choice("OS", "Arch").getAttribute("aria-pressed")).toBe("true");
    expect(alertText()).toEqual([
      "Boat supports Ubuntu and Nix; Arch is unsupported. New sessions in Acme run on Boat, so they cannot start from this environment. Pick Ubuntu or Nix and save.",
    ]);
  });

  it("on Boat, keeps an inherited Arch image and says to set one here or ask an owner", async () => {
    await renderWorkspace(null, RUNTIMES.boat, ARCH);
    expect(choice("OS", "Arch").getAttribute("aria-pressed")).toBe("true");
    expect(alertText()).toEqual([
      "Boat supports Ubuntu and Nix; Arch is unsupported. New sessions in Acme run on Boat, so they cannot start from the environment this project inherits. To set one for this project, pick Ubuntu or Nix and save, or ask an owner of Acme to change the organization's.",
    ]);
  });

  it("on Boat, keeps Save and rebuild off while the draft is still Arch", async () => {
    await renderWorkspace(ARCH, RUNTIMES.boat);
    await click(byText("button", "fish"));
    expect(byText("button", "Save and rebuild")).toHaveProperty("disabled", true);
    expect(pageText()).toContain("1 unsaved change · Boat cannot run this environment");
    await click(byText("button", "Nix"));
    expect(byText("button", "Save and rebuild")).toHaveProperty("disabled", false);
  });

  it("follows the report: a Boat that runs Arch leaves Arch open", async () => {
    await renderWorkspace(ARCH, RUNTIMES.boatWithArch);
    expect(choice("OS", "Arch").disabled).toBe(false);
    expect(alertText()).toEqual([]);
  });

  it("on this server's Docker, offers every choice and adds no line", async () => {
    for (const runtime of [RUNTIMES.docker, RUNTIMES.bothOnDocker]) {
      await renderWorkspace(ARCH, runtime);
      for (const label of ["Arch", "Fedora", "Ubuntu", "Nix"])
        expect(choice("OS", label).disabled).toBe(false);
      expect(choice("Base", "Custom image").disabled).toBe(false);
      expect(pageText()).not.toContain("New sessions in Acme");
      act(() => root?.unmount());
      document.body.replaceChildren();
    }
  });

  it("on an install offering both, judges by the organization's runtime: Boat restricts", async () => {
    await renderWorkspace(UBUNTU, RUNTIMES.bothOnBoat);
    expect(choice("OS", "Arch").disabled).toBe(true);
    expect(choice("Base", "Custom image").disabled).toBe(true);
  });

  it("when the report cannot be read, keeps every choice open and says it was not checked", async () => {
    await renderWorkspace(ARCH, RUNTIMES.unread);
    for (const label of ["Arch", "Fedora", "Ubuntu", "Nix"])
      expect(choice("OS", label).disabled).toBe(false);
    expect(choice("Base", "Custom image").disabled).toBe(false);
    expect(alertText()).toEqual([]);
    expect(pageText()).toContain(
      "Not checked against Boat: Mend could not read what it supports from Sealant (Sealant did not answer within 5 seconds). A session that cannot start says why.",
    );
  });
});

describe("ready workspaces on a runtime that bills idle workspaces", () => {
  const IDLE = "Boat bills a workspace by the second while its VM runs, idle or not.";

  it("on Boat, says what an idle workspace costs and that each ready one counts", async () => {
    await renderWorkspace(UBUNTU, RUNTIMES.boat);
    expect(pageText()).toContain(
      `${IDLE} Each ready workspace runs while it waits, so each one counts.`,
    );
  });

  it("on this server's Docker, or when the report is unread, says nothing about cost", async () => {
    for (const runtime of [RUNTIMES.docker, RUNTIMES.unread]) {
      await renderWorkspace(UBUNTU, runtime);
      expect(pageText()).not.toContain("Each ready workspace runs while it waits");
      act(() => root?.unmount());
      document.body.replaceChildren();
    }
  });
});

describe("server folders where sessions cannot mount them", () => {
  const renderFolders = async (
    runtime: RuntimeView,
    mountDelivery: ProjectDetailDto["mountDelivery"],
  ) => {
    root = await renderWithTrpc(
      <FoldersSettings detail={detailOf(UBUNTU, mountDelivery)} />,
      server(runtime),
    );
  };

  it("on Boat, says Boat cannot bind them and sessions start without them", async () => {
    await renderFolders(RUNTIMES.boat, "bind");
    expect(pageText()).toContain("/srv/models");
    expect(pageText()).toContain(
      "Boat cannot bind directories from this deployment's own servers. New sessions in Acme run on Boat, so sessions in mend start without these folders.",
    );
  });

  it("names the runtime's reason first on a captured server running Boat", async () => {
    await renderFolders(RUNTIMES.boat, "sources");
    expect(pageText()).toContain("Boat cannot bind directories");
    expect(pageText()).not.toContain("never mount server folders");
  });

  it("on a server running captured workspaces, says they never mount server folders", async () => {
    await renderFolders(RUNTIMES.docker, "sources");
    expect(pageText()).toContain(
      "This server runs captured workspaces, which never mount server folders, so sessions in mend start without these folders.",
    );
  });

  it("on this server's Docker beside the store, adds no line", async () => {
    await renderFolders(RUNTIMES.docker, "bind");
    expect(pageText()).not.toContain("start without these folders");
  });
});
