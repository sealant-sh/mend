/**
 * Settings → a project → Workspace (Doop "Settings · Project · checkout-api · Workspace"): the
 * project's own workspace image (docs/adr/0025: a copy of the organization's starting image taken
 * when the project was made, never inherited), its dependency install, and its ready workspaces
 * (workspace-images.md, automatic-install.md, hot-sessions.md). What each row says, the image draft
 * the editor works on, and which choices the organization's runtime can't run. Pure, so each rule
 * is tested without a server.
 *
 * The image editor is written to serve the organization's starting image too (route PR 47): the
 * draft, its words and the runtime's refusals take an image, not a project.
 */

import {
  customImageRefusal,
  osRefusal,
  type RuntimeSupport,
  type WorkspaceImage,
  workspaceImagesEqual,
} from "@mend/domain";

export { workspaceImagesEqual };

export type WorkspaceImageOs = Extract<WorkspaceImage, { mode: "family" }>["os"];
export type WorkspaceImageShell = Extract<WorkspaceImage, { mode: "family" }>["shell"];

export const OS_LABELS: Readonly<Record<WorkspaceImageOs, string>> = {
  arch: "Arch",
  fedora: "Fedora",
  ubuntu: "Ubuntu",
  nix: "Nix",
};
export const OS_ORDER: ReadonlyArray<WorkspaceImageOs> = ["arch", "fedora", "ubuntu", "nix"];
export const SHELL_ORDER: ReadonlyArray<WorkspaceImageShell> = ["zsh", "bash", "fish"];

/** "1 package", "18 packages". */
const packagesWords = (count: number) => `${count} ${count === 1 ? "package" : "packages"}`;

/** The Current image row's line: "Arch, zsh and 18 packages." or a custom base's. */
export const imageLine = (image: WorkspaceImage): string =>
  image.mode === "family"
    ? `${OS_LABELS[image.os]}, ${image.shell} and ${packagesWords(image.packages.length)}.`
    : `Built from ${image.baseImage}, with ${packagesWords(image.packages.length)} and ${image.setupCommands.length === 1 ? "1 setup command" : `${image.setupCommands.length} setup commands`}.`;

/** The image in a few machine words, beside Edit image…: "arch · zsh" or the base reference. */
export const imageTag = (image: WorkspaceImage): string =>
  image.mode === "family" ? `${image.os} · ${image.shell}` : image.baseImage;

/** The editor's working copy: every field of both kinds, so switching kinds loses nothing. */
export interface ImageDraft {
  readonly mode: WorkspaceImage["mode"];
  readonly os: WorkspaceImageOs;
  readonly shell: WorkspaceImageShell;
  readonly baseImage: string;
  readonly setupCommands: string;
  readonly packages: ReadonlyArray<string>;
  readonly docker: boolean;
  readonly screen: boolean;
}

export const draftOf = (image: WorkspaceImage): ImageDraft => ({
  mode: image.mode,
  os: image.mode === "family" ? image.os : "arch",
  shell: image.mode === "family" ? image.shell : "zsh",
  baseImage: image.mode === "custom" ? image.baseImage : "",
  setupCommands: image.mode === "custom" ? image.setupCommands.join("\n") : "",
  packages: image.packages,
  docker: image.services.docker,
  screen: image.mode === "family" && image.screen,
});

/** The image a draft saves. */
export const imageOf = (draft: ImageDraft): WorkspaceImage =>
  draft.mode === "custom"
    ? {
        mode: "custom",
        baseImage: draft.baseImage.trim(),
        packages: draft.packages,
        setupCommands: draft.setupCommands
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
        services: { docker: draft.docker },
      }
    : {
        mode: "family",
        os: draft.os,
        shell: draft.shell,
        packages: draft.packages,
        services: { docker: draft.docker },
        screen: draft.screen,
      };

/**
 * Packages typed into Add package: split on spaces, commas and line breaks, lowercased, added after
 * the ones already there without repeats. A name that can't be a package is refused, with the
 * name, before anything is sent.
 */
export const addPackages = (
  current: ReadonlyArray<string>,
  typed: string,
):
  | { readonly packages: ReadonlyArray<string>; readonly invalid: null }
  | { readonly packages: ReadonlyArray<string>; readonly invalid: string } => {
  const names = typed
    .split(/[\s,]+/)
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  const invalid = names.find((name) => !/^[a-z0-9][a-z0-9._:+-]*$/.test(name));
  if (invalid !== undefined) return { packages: current, invalid };
  return { packages: [...new Set([...current, ...names])], invalid: null };
};

/** Why Save image is held back; null when the draft may be sent. */
export const draftProblem = (draft: ImageDraft): string | null =>
  draft.mode === "custom" && draft.baseImage.trim() === ""
    ? "Type the base image, such as node:22-bookworm."
    : null;

/** A package the server refused, in a sentence beside its name. Null for one it took. */
export const resolutionIssue = (
  resolution: {
    readonly status: "resolved" | "ambiguous" | "unsupported" | "not-found" | "invalid";
    readonly supported: boolean;
    readonly canonicalId: string | null;
    readonly alternatives: ReadonlyArray<string>;
  },
  os: WorkspaceImageOs,
): string | null => {
  if (resolution.status === "resolved" && resolution.supported) return null;
  switch (resolution.status) {
    case "ambiguous":
      return resolution.alternatives.length === 0
        ? "Sealant found more than one possible package."
        : `Sealant found more than one match. Try ${resolution.alternatives.join(", ")}.`;
    case "not-found":
      return "Sealant could not find this package.";
    case "invalid":
      return "Sealant rejected this package name.";
    default:
      return resolution.canonicalId === null
        ? "Sealant's package catalog does not carry this package."
        : `Sealant found the package, but not for ${OS_LABELS[os]}.`;
  }
};

/** Why the organization's runtime can't run an OS, or a custom base; null when it can. */
export const osUnavailable = (support: RuntimeSupport | null, os: WorkspaceImageOs) =>
  support === null ? null : osRefusal(support, os);
export const customUnavailable = (support: RuntimeSupport | null) =>
  support === null ? null : customImageRefusal(support);

/**
 * The Image section's line: the image is the project's own, copied from the organization's
 * starting image when the project was made, and changing that one doesn't change it.
 */
export const imageSectionLine = (
  projectName: string,
  organizationName: string,
  createdOn: string,
): string =>
  `${projectName} has its own image. Mend copied it from ${organizationName}'s starting image when the project was created on ${createdOn}. Changing ${organizationName}'s image doesn't change this one.`;

/** What a save says, by whether the project keeps ready workspaces (S17: a save builds nothing). */
export const imageSavedWords = (projectName: string, hotSessions: number): string =>
  hotSessions > 0
    ? `Saved ${projectName}'s image. Mend rebuilds its ready workspaces from it.`
    : `Saved ${projectName}'s image. Mend builds it when the next session starts.`;

// --- Dependencies -------------------------------------------------------------------------------

/** What the install detection read from the default branch. */
export interface InstallDetection {
  readonly ref: string;
  readonly read: boolean;
  readonly command: string | null;
  readonly from: string | null;
}

/** The Automatic install switch's line, on or off. */
export const installSwitchLine = (enabled: boolean, custom: string | null): string =>
  enabled
    ? "Mend runs your custom command. If you haven't set one, it runs the command it finds from the lockfile."
    : custom === null
      ? "No install runs, in sessions or for the shared cache."
      : "No install runs, in sessions or for the shared cache. Mend keeps your custom command.";

/** The Custom command row's line: the saved command, or what Mend found on the default branch. */
export const customCommandLine = (
  custom: string | null,
  detection: InstallDetection | null,
): string => {
  if (custom !== null) return "Mend runs this instead of the command it found from the lockfile.";
  if (detection === null) return "Mend reads the lockfile on the default branch…";
  const branch = detection.ref.replace(/^origin\//, "");
  if (!detection.read) {
    return `Mend couldn't read ${branch}, so it finds the command from the lockfile when a session starts. Type a command to replace it.`;
  }
  if (detection.command === null) {
    return `Mend found no lockfile it knows on ${branch}, and looks again when a session starts. Type a command to run instead.`;
  }
  return `Mend found ${detection.command} from ${detection.from ?? "the lockfile"} on ${branch} and runs it. Type a command to replace it.`;
};

/** What the custom command field sends: a blank field goes back to the detected command. */
export const customCommandValue = (typed: string): string | null =>
  typed.trim() === "" ? null : typed.trim();

// --- Ready workspaces ---------------------------------------------------------------------------

export const MAX_READY = 8;

/** The person's own standbys, as `projects.hotSessionsStatus` answers them. */
export interface HotStatus {
  readonly hotSessions: number;
  readonly ready: number;
  readonly warming: number;
  readonly failed: number;
  readonly error: string | null;
}

/**
 * The words beside the count: what is ready for the person now, warming or failed (hot-sessions.md
 * `hot-status`). "Off" at 0; "None ready yet" before the first is up.
 */
export const readyWords = (status: HotStatus): string => {
  if (status.hotSessions === 0) return "Off";
  const parts = [
    status.ready > 0 ? `${status.ready} ready for you` : null,
    status.warming > 0 ? `${status.warming} starting` : null,
    status.failed > 0 ? `${status.failed} failed` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "None ready yet" : parts.join(", ");
};

/**
 * After an image save, whether the page should say the ready workspaces are being rebuilt: the
 * server rewarms them (S17) and reports it as warming.
 */
export const rebuilding = (status: HotStatus): boolean =>
  status.hotSessions > 0 && status.warming > 0;

/*
 * The organization's starting image (Settings → the organization → Workspace image, route PR 47):
 * the image Mend copies into each new project when the project is created. Saving it changes no
 * existing project and starts no build.
 */

/** Each package a save refused, with why, for the rows under Packages. */
export const rejectedPackages = (
  resolutions: ReadonlyArray<
    Parameters<typeof resolutionIssue>[0] & { readonly requested: string }
  >,
  os: WorkspaceImageOs,
): ReadonlyArray<{ readonly name: string; readonly issue: string }> =>
  resolutions.flatMap((resolution) => {
    const issue = resolutionIssue(resolution, os);
    return issue === null ? [] : [{ name: resolution.requested, issue }];
  });

/** The line over a refused save of the starting image. */
export const rejectionLine = (count: number, os: WorkspaceImageOs): string =>
  count === 1
    ? `Not saved. Sealant couldn't find 1 package for ${OS_LABELS[os]}. Remove it or change its name, then save again.`
    : `Not saved. Sealant couldn't find ${count} packages for ${OS_LABELS[os]}. Remove them or change their names, then save again.`;

/** The toast after the starting image is saved. */
export const startingImageSaved = (organization: string): string =>
  `Saved. New projects in ${organization} start from this image.`;
