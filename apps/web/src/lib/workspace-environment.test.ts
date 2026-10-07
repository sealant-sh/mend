import { desktopWorkspaceImage } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { SettingsDto, WorkspacePackageResolutionDto } from "./api";
import {
  createWorkspaceEnvironmentForm,
  parsePackageDraft,
  resolutionIssue,
  workspaceEnvironmentFormReducer,
  workspaceImageFromForm,
  workspaceImagesEqual,
} from "./workspace-environment";

const image = (packages: ReadonlyArray<string>): SettingsDto["workspaceImage"] => ({
  mode: "family",
  os: "arch",
  packages,
  shell: "bash",
  services: { docker: true },
});

const resolution = (
  overrides: Partial<WorkspacePackageResolutionDto> = {},
): WorkspacePackageResolutionDto => ({
  requested: "pnpm",
  normalized: "pnpm",
  status: "resolved",
  canonicalId: "pnpm",
  supported: true,
  packageName: "pnpm",
  alternatives: [],
  ...overrides,
});

describe("workspace environment form", () => {
  it("applies the desktop preset as an unsaved edit", () => {
    const original = image(["pnpm"]);
    const initial = createWorkspaceEnvironmentForm(original);
    const applied = workspaceEnvironmentFormReducer(initial, {
      type: "image-applied",
      image: desktopWorkspaceImage,
    });
    expect(workspaceImageFromForm(applied)).toEqual(desktopWorkspaceImage);
    expect(applied.savedImage).toEqual(original);
    expect(workspaceImagesEqual(workspaceImageFromForm(applied), applied.savedImage)).toBe(false);
  });
  it("normalizes the package draft without changing package order", () => {
    expect(parsePackageDraft(" PNPM\npython, pnpm\n\nuv ")).toEqual({
      packages: ["pnpm", "python", "uv"],
      invalid: null,
    });
  });

  it("treats OS, Docker, package order, and package contents as one draft", () => {
    expect(workspaceImagesEqual(image(["pnpm", "python"]), image(["pnpm", "python"]))).toBe(true);
    expect(workspaceImagesEqual(image(["pnpm", "python"]), image(["python", "pnpm"]))).toBe(false);
    expect(
      workspaceImagesEqual(image(["pnpm"]), {
        ...image(["pnpm"]),
        services: { docker: false },
      }),
    ).toBe(false);
  });

  it("explains Sealant resolution failures beside the requested package", () => {
    expect(resolutionIssue(resolution({ status: "not-found", supported: false }), "arch")).toBe(
      "Sealant could not find this package.",
    );
    expect(
      resolutionIssue(
        resolution({ status: "ambiguous", alternatives: ["nodejs", "nodejs-lts"] }),
        "arch",
      ),
    ).toBe("Sealant found more than one match. Try nodejs, nodejs-lts.");
  });

  it("keeps edits through rejection and resets the complete baseline after save", () => {
    const initial = createWorkspaceEnvironmentForm(image(["pnpm"]));
    const edited = workspaceEnvironmentFormReducer(
      workspaceEnvironmentFormReducer(initial, { type: "os-changed", os: "nix" }),
      { type: "packages-changed", packageDraft: "pnpm\nuv" },
    );
    const rejected = workspaceEnvironmentFormReducer(edited, {
      type: "save-rejected",
      resolutions: [resolution({ requested: "uv", status: "unsupported", supported: false })],
    });

    expect(workspaceImageFromForm(rejected)).toEqual({
      mode: "family",
      os: "nix",
      packages: ["pnpm", "uv"],
      shell: "bash",
      services: { docker: true },
    });
    expect(rejected.savedImage).toEqual(image(["pnpm"]));

    const savedImage: SettingsDto["workspaceImage"] = {
      mode: "family",
      os: "nix",
      packages: ["pnpm", "uv"],
      shell: "bash",
      services: { docker: true },
    };
    const saved = workspaceEnvironmentFormReducer(rejected, {
      type: "save-succeeded",
      workspaceImage: savedImage,
      resolutions: [resolution()],
    });

    expect(saved.phase).toBe("saved");
    expect(saved.savedImage).toEqual(savedImage);
    expect(workspaceImageFromForm(saved)).toEqual(savedImage);
  });

  it("keeps package findings when only Docker changes", () => {
    const rejected = workspaceEnvironmentFormReducer(
      createWorkspaceEnvironmentForm(image(["uv"])),
      {
        type: "save-rejected",
        resolutions: [resolution({ requested: "uv", status: "unsupported", supported: false })],
      },
    );

    const toggled = workspaceEnvironmentFormReducer(rejected, { type: "docker-toggled" });

    expect(toggled.resolutions).toEqual(rejected.resolutions);
    expect(toggled.docker).toBe(false);
  });
});
