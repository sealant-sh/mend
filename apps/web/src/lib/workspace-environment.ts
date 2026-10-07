import { workspaceImagesEqual } from "@mend/domain";

import type { SettingsDto, WorkspacePackageResolutionDto } from "./api";

export { workspaceImagesEqual };

type WorkspaceImage = SettingsDto["workspaceImage"];
type WorkspaceImageOs = Extract<WorkspaceImage, { mode: "family" }>["os"];
type WorkspaceImageShell = Extract<WorkspaceImage, { mode: "family" }>["shell"];

export const OS_LABELS: Record<WorkspaceImageOs, string> = {
  fedora: "Fedora",
  arch: "Arch",
  nix: "Nix",
  ubuntu: "Ubuntu",
};

export const parsePackageDraft = (draft: string) => {
  const packages = [
    ...new Set(
      draft
        .split(/[\n,]/)
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value !== ""),
    ),
  ];
  const invalid = packages.find((value) => !/^[a-z0-9][a-z0-9._:+-]*$/.test(value));
  return invalid === undefined ? { packages, invalid: null } : { packages, invalid };
};

/** The image summarized the way a status line would say it — terse mono facts. */
export const workspaceImageSummary = (image: WorkspaceImage): string =>
  image.mode === "custom"
    ? `custom · ${image.baseImage}`
    : `${OS_LABELS[image.os].toLowerCase()} · ${image.packages.length} packages`;

/** One setup command per line, verbatim — commands are not package names, no normalization. */
export const parseSetupDraft = (draft: string): ReadonlyArray<string> =>
  draft
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value !== "");

export interface WorkspaceEnvironmentFormState {
  readonly savedImage: WorkspaceImage;
  readonly mode: WorkspaceImage["mode"];
  readonly os: WorkspaceImageOs;
  readonly shell: WorkspaceImageShell;
  readonly baseImage: string;
  readonly setupDraft: string;
  readonly docker: boolean;
  readonly packageDraft: string;
  readonly phase: "idle" | "saving" | "saved";
  readonly resolutions: ReadonlyArray<WorkspacePackageResolutionDto> | null;
  readonly error: string | null;
}

export type WorkspaceEnvironmentFormAction =
  | { readonly type: "image-applied"; readonly image: WorkspaceImage }
  | { readonly type: "mode-changed"; readonly mode: WorkspaceImage["mode"] }
  | { readonly type: "os-changed"; readonly os: WorkspaceImageOs }
  | { readonly type: "shell-changed"; readonly shell: WorkspaceImageShell }
  | { readonly type: "base-image-changed"; readonly baseImage: string }
  | { readonly type: "setup-changed"; readonly setupDraft: string }
  | { readonly type: "docker-toggled" }
  | { readonly type: "packages-changed"; readonly packageDraft: string }
  | {
      readonly type: "suggestions-applied";
      readonly packageIds: ReadonlyArray<string>;
      readonly dockerObserved: boolean;
    }
  | { readonly type: "save-started" }
  | {
      readonly type: "save-rejected";
      readonly resolutions: ReadonlyArray<WorkspacePackageResolutionDto>;
    }
  | {
      readonly type: "save-succeeded";
      readonly workspaceImage: WorkspaceImage;
      readonly resolutions: ReadonlyArray<WorkspacePackageResolutionDto>;
    }
  | { readonly type: "save-failed"; readonly message: string };

export const createWorkspaceEnvironmentForm = (
  workspaceImage: WorkspaceImage,
): WorkspaceEnvironmentFormState => ({
  savedImage: workspaceImage,
  mode: workspaceImage.mode,
  os: workspaceImage.mode === "family" ? workspaceImage.os : "arch",
  shell: workspaceImage.mode === "family" ? workspaceImage.shell : "bash",
  baseImage: workspaceImage.mode === "custom" ? workspaceImage.baseImage : "",
  setupDraft: workspaceImage.mode === "custom" ? workspaceImage.setupCommands.join("\n") : "",
  docker: workspaceImage.services.docker,
  packageDraft: workspaceImage.packages.join("\n"),
  phase: "idle",
  resolutions: null,
  error: null,
});

const edited = (state: WorkspaceEnvironmentFormState): WorkspaceEnvironmentFormState => ({
  ...state,
  phase: "idle",
  resolutions: null,
  error: null,
});

export const workspaceEnvironmentFormReducer = (
  state: WorkspaceEnvironmentFormState,
  action: WorkspaceEnvironmentFormAction,
): WorkspaceEnvironmentFormState => {
  switch (action.type) {
    case "image-applied":
      return { ...createWorkspaceEnvironmentForm(action.image), savedImage: state.savedImage };
    case "mode-changed":
      return edited({ ...state, mode: action.mode });
    case "os-changed":
      return edited({ ...state, os: action.os });
    case "shell-changed":
      return edited({ ...state, shell: action.shell });
    case "base-image-changed":
      return edited({ ...state, baseImage: action.baseImage });
    case "setup-changed":
      return edited({ ...state, setupDraft: action.setupDraft });
    case "docker-toggled":
      return { ...state, docker: !state.docker, phase: "idle", error: null };
    case "packages-changed":
      return edited({ ...state, packageDraft: action.packageDraft });
    case "suggestions-applied": {
      const currentPackages = parsePackageDraft(state.packageDraft).packages;
      const packages = [...new Set([...currentPackages, ...action.packageIds])];
      return edited({
        ...state,
        packageDraft: packages.join("\n"),
        docker: state.docker || action.dockerObserved,
      });
    }
    case "save-started":
      return { ...state, phase: "saving", error: null };
    case "save-rejected":
      return { ...state, phase: "idle", resolutions: action.resolutions, error: null };
    case "save-succeeded":
      return {
        ...createWorkspaceEnvironmentForm(action.workspaceImage),
        phase: "saved",
        resolutions: action.resolutions,
      };
    case "save-failed":
      return { ...state, phase: "idle", error: action.message };
  }
};

export const workspaceImageFromForm = (state: WorkspaceEnvironmentFormState): WorkspaceImage =>
  state.mode === "custom"
    ? {
        mode: "custom",
        baseImage: state.baseImage.trim(),
        packages: parsePackageDraft(state.packageDraft).packages,
        setupCommands: parseSetupDraft(state.setupDraft),
        services: { docker: state.docker },
      }
    : {
        mode: "family",
        os: state.os,
        packages: parsePackageDraft(state.packageDraft).packages,
        shell: state.shell,
        services: { docker: state.docker },
      };

export const resolutionIssue = (
  resolution: WorkspacePackageResolutionDto,
  os: WorkspaceImageOs,
) => {
  if (resolution.status === "resolved" && resolution.supported) return null;
  if (resolution.status === "ambiguous") {
    return resolution.alternatives.length === 0
      ? "Sealant found more than one possible package."
      : `Sealant found more than one match. Try ${resolution.alternatives.join(", ")}.`;
  }
  if (resolution.status === "not-found") return "Sealant could not find this package.";
  if (resolution.status === "invalid") return "Sealant rejected this package name.";
  return `Sealant found the package, but not for ${OS_LABELS[os]}.`;
};
