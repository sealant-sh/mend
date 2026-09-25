import { Effect, Schema } from "effect";

/**
 * PR timing has exactly two modes; there is no third.
 * Default: every successful run opens a draft PR immediately.
 */
export const PrMode = Schema.Literals(["draft-immediately", "pr-on-approval"]);
export type PrMode = typeof PrMode.Type;

/** Rows written before a switch existed decode to its default — never a failed read. */
const onByDefault = Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true)));
const offByDefault = Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)));

export const WorkspaceImageOs = Schema.Literals(["fedora", "arch", "nix", "ubuntu"]);
export type WorkspaceImageOs = typeof WorkspaceImageOs.Type;

const DEFAULT_WORKSPACE_PACKAGES: ReadonlyArray<string> = [
  "pnpm",
  "python",
  "uv",
  "mise",
  "github-cli",
  "lazygit",
  "bat",
  "curl",
  "jq",
  "ripgrep",
  "fd",
  "fzf",
];

const workspaceImageServices = Schema.Struct({
  docker: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ docker: true })));

export const WorkspaceShell = Schema.Literals(["bash", "zsh", "fish"]);
export type WorkspaceShell = typeof WorkspaceShell.Type;

/** Rows written before the shell knob existed decode to bash — the platform's own default. */
const shellWithDefault = WorkspaceShell.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed("bash" as const)),
);

/**
 * A managed OS family image: distro base, portable package names resolved by the platform
 * against that distro's archive. Rows written before custom mode existed decode here — a
 * missing `mode` key defaults to `"family"`.
 */
export const FamilyWorkspaceImage = Schema.Struct({
  mode: Schema.Literals(["family"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("family" as const)),
  ),
  os: WorkspaceImageOs,
  packages: Schema.Array(Schema.String),
  /**
   * Login shell inside the workspace — installed and switched to, so shell dotfiles take effect.
   * Family images only: custom bases guarantee just a POSIX shell, so the knob does not exist
   * there (the platform would reject it).
   */
  shell: shellWithDefault,
  services: workspaceImageServices,
});
export type FamilyWorkspaceImage = typeof FamilyWorkspaceImage.Type;

/**
 * A custom base image: any OCI reference the user already trusts. Deliberately exactly three
 * knobs — base image ref, extra packages (passed verbatim to the base's own package manager),
 * and setup commands (run in the workspace before the harness launches). NOT a compose editor:
 * the workspace is one container; compose already lives inside it (the dind sidecar).
 */
export const CustomWorkspaceImage = Schema.Struct({
  mode: Schema.Literals(["custom"]),
  baseImage: Schema.String,
  packages: Schema.Array(Schema.String),
  setupCommands: Schema.Array(Schema.String),
  services: workspaceImageServices,
});
export type CustomWorkspaceImage = typeof CustomWorkspaceImage.Type;

export const WorkspaceImage = Schema.Union([FamilyWorkspaceImage, CustomWorkspaceImage]);
export type WorkspaceImage = typeof WorkspaceImage.Type;

export const defaultWorkspaceImage: WorkspaceImage = {
  mode: "family",
  os: "arch",
  packages: [...DEFAULT_WORKSPACE_PACKAGES],
  shell: "bash",
  services: { docker: true },
};

const listsEqual = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const workspaceImagesEqual = (left: WorkspaceImage, right: WorkspaceImage): boolean => {
  if (
    left.services.docker !== right.services.docker ||
    !listsEqual(left.packages, right.packages)
  ) {
    return false;
  }
  if (left.mode === "family" && right.mode === "family") {
    return left.os === right.os && left.shell === right.shell;
  }
  if (left.mode === "custom" && right.mode === "custom") {
    return (
      left.baseImage === right.baseImage && listsEqual(left.setupCommands, right.setupCommands)
    );
  }
  return false;
};

const workspaceImageWithDefault = WorkspaceImage.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(defaultWorkspaceImage)),
);

export const DotfilesManager = Schema.Literals(["auto", "chezmoi", "stow", "copy"]);
export type DotfilesManager = typeof DotfilesManager.Type;

/**
 * A dotfiles repository resolved by the Mend server at every session launch: cloned with its
 * owner's own git access (the server's setup only for a single-tenant operator), packed, and
 * shipped into the workspace as an archive. No URL or
 * credential ever reaches the container, and every session gets the branch tip as of its launch.
 * Dotfiles are identity, not instance configuration — this rides per-user (see the dotfiles
 * store), never in the global settings document.
 */
/**
 * A repo-relative directory: the archive is re-rooted there, so a repo whose home tree lives in
 * a subfolder (`dots/`, a stow package, a `.chezmoiroot`-style layout) applies correctly. The
 * grammar stays deliberately narrow — path segments only, since the value lands in
 * `git archive HEAD:<subdirectory>`.
 */
export const DotfilesSubdirectory = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) => {
      const wellFormed =
        value.length > 0 &&
        !value.startsWith("/") &&
        !value.endsWith("/") &&
        !value.includes("\\") &&
        !value.includes(":") &&
        value
          .split("/")
          .every((segment) => segment.length > 0 && segment !== ".." && segment !== ".");
      return wellFormed
        ? undefined
        : "a repo-relative directory like `dots` or `home/dots` — no leading slash, no `..`";
    }),
  ),
);

export const DotfilesRepository = Schema.Struct({
  url: Schema.String,
  /** Null clones the remote's default branch — never assumed to be `main`. */
  ref: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * Null archives the repo root. Otherwise the archive is re-rooted at this directory, so its
   * contents — not the directory itself — land in `~`.
   */
  subdirectory: Schema.NullOr(DotfilesSubdirectory).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** How the tree applies in the workspace; auto detects chezmoi/stow layouts, else copies. */
  manager: DotfilesManager.pipe(Schema.withDecodingDefaultKey(Effect.succeed("auto" as const))),
  /** Run the repo's `./install.sh` (when present) after applying. */
  bootstrap: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type DotfilesRepository = typeof DotfilesRepository.Type;

/**
 * Why a dotfiles repository URL may not be saved because it carries a secret, or null. Mend stores
 * the URL, stamps it on every session and shows it there, so a token or password in it would be
 * readable by anyone who can see those sessions. A login name alone is fine where it is only a
 * name (`git@host:path`, `ssh://git@host/path`); over HTTP(S) the "user" is where tokens go.
 * Malformed URLs are `repositoryCloneUrlIssue`'s to report, not this check's.
 */
export const dotfilesRepositoryUrlCredentialIssue = (url: string): string | null => {
  if (!url.includes("://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const httpLogin =
    (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username !== "";
  return parsed.password !== "" || httpLogin
    ? "A dotfiles repository URL cannot carry a login or token: Mend stores it and shows it on your sessions. Save the URL without it; Mend clones with your own git access."
    : null;
};

export const dotfilesRepositoriesEqual = (
  left: DotfilesRepository | null,
  right: DotfilesRepository | null,
): boolean => {
  if (left === null || right === null) return left === right;
  return (
    left.url === right.url &&
    left.ref === right.ref &&
    left.subdirectory === right.subdirectory &&
    left.manager === right.manager &&
    left.bootstrap === right.bootstrap
  );
};

export class MendSettings extends Schema.Class<MendSettings>("MendSettings")({
  prMode: PrMode,
  /** How many issues mend at once — the dispatcher fills free slots from the top of queued. */
  concurrency: Schema.Int,
  /**
   * Review automation defaults — the machine-side prep that runs when a
   * session settles, so review opens ready. Each switch is overridable per
   * project (`inherit` follows these): the cascade is settings → project,
   * resolved per session at settle.
   */
  /** Compose the tour when a session settles — description and walkthrough ready before review opens. */
  autoTour: onByDefault,
  /** Run the suggestion pass when a session settles — strict, code-anchored; zero suggestions is normal. */
  autoSuggest: onByDefault,
  /** Name the session from its first prompt — a label appears in lists while it still runs. */
  autoName: onByDefault,
  /**
   * Land the change when a turn completes (docs/adr/0007-landing.md, "Automatic landing"): push
   * the branch and open or update its pull request. Off by default for sessions people run
   * themselves; Slack sessions follow the Slack app's own setting instead.
   */
  autoLand: offByDefault,
  /** Base operating system and additional tools baked into every new session workspace. */
  workspaceImage: workspaceImageWithDefault,
  /**
   * Sessions keep running when every client disconnects; stops are explicit.
   * Off gives CLI launches foreground semantics — the session stops when the
   * launching `mend` exits. Only the launching CLI can enforce this (a closing
   * browser tab cannot promise a stop), so the switch governs CLI launches.
   */
  backgroundSessions: onByDefault,
}) {}

export const defaultSettings = new MendSettings({
  prMode: "draft-immediately",
  concurrency: 1,
  autoTour: true,
  autoSuggest: true,
  autoName: true,
  autoLand: false,
  workspaceImage: defaultWorkspaceImage,
  backgroundSessions: true,
});
