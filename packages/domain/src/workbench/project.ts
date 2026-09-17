import { Effect, Schema } from "effect";

import { OrganizationId, ProjectId, Sha } from "../ids.ts";
import { WorkspaceImage } from "../settings.ts";
import { Timestamp } from "../timestamp.ts";
import { ProjectVisibility } from "./organization.ts";

/**
 * A project's stance on one review-automation switch: follow the Settings
 * default, or override it either way. The cascade has exactly these two
 * levels — a session takes whatever its project resolves to at settle.
 */
export const AutomationChoice = Schema.Literals(["inherit", "on", "off"]);
export type AutomationChoice = typeof AutomationChoice.Type;

export const resolveAutomation = (choice: AutomationChoice, settingsDefault: boolean): boolean =>
  choice === "inherit" ? settingsDefault : choice === "on";

/**
 * How host-side git reaches this project's remote (docs/GIT-ACCESS.md):
 * `ambient` uses the login user's git/ssh setup unchanged; `mend-key` uses the
 * machine's Mend-generated deploy key (`~/.config/mend/keys/`), whose private half
 * never leaves the host; `bridge` signs through an ssh-agent shared from
 * another machine via `mend keys share` — the key (often hardware) physically
 * stays there, and ops fail readably when no signer is connected. All modes
 * run ssh with BatchMode=yes — a daemon cannot answer a prompt, so auth
 * failures surface as readable errors instead of hangs.
 */
export const GitAuthMode = Schema.Literals(["ambient", "mend-key", "bridge"]);
export type GitAuthMode = typeof GitAuthMode.Type;

/** The recovery guidance shown wherever project adoption accepts a repository source. */
export const REPOSITORY_CLONE_URL_GUIDANCE =
  "Use an HTTP(S), SSH, SCP-style, or git:// repository URL. Local paths and file:// URLs are not supported.";

const isScpStyleGitUrl = (value: string): boolean =>
  /^(?:[^@\s/:[\]]+@)?(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]*):[^:\s\\][^\s\\]*$/.test(
    value,
  );

/** Return the caller-visible problem with a repository clone URL, or null when it is accepted. */
export const repositoryCloneUrlIssue = (value: string): string | null => {
  // Git parses the original bytes, not WHATWG URL's repaired spelling. Exclude
  // options, control characters, backslashes and drive-relative Windows paths
  // before considering SCP syntax. A one-letter host needs an explicit URL.
  if (
    value === "" ||
    value.startsWith("-") ||
    /[\s\\\p{Cc}]/u.test(value) ||
    /^[a-z]:/i.test(value) ||
    /^file:/i.test(value)
  ) {
    return REPOSITORY_CLONE_URL_GUIDANCE;
  }
  if (!value.includes("://")) {
    // The first path character cannot be ':': Git interprets host::path as
    // an external transport helper, not an SSH repository.
    return !/^(?:https?|ssh|git):/i.test(value) && isScpStyleGitUrl(value)
      ? null
      : REPOSITORY_CLONE_URL_GUIDANCE;
  }
  // Require the actual network spelling; URL would repair http:/ and http:///.
  if (!/^(?:https?|ssh|git):\/\/[^/]+\//.test(value)) {
    return REPOSITORY_CLONE_URL_GUIDANCE;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return REPOSITORY_CLONE_URL_GUIDANCE;
  }
  if (
    (url.protocol !== "http:" &&
      url.protocol !== "https:" &&
      url.protocol !== "ssh:" &&
      url.protocol !== "git:") ||
    url.hostname === "" ||
    url.pathname === "" ||
    url.pathname === "/" ||
    // A host is a DNS name or an IP literal. `ssh:` is not a special scheme, so URL keeps any
    // code point in its host; a `$`, backtick or `;` there would reach a shell through
    // GIT_SSH_COMMAND.
    !/^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])$/i.test(url.hostname)
  ) {
    return REPOSITORY_CLONE_URL_GUIDANCE;
  }
  return null;
};

/** A network Git clone URL accepted for project adoption. */
/** A remote's network location as git dials it: scheme, host without brackets, explicit port. */
export interface GitRemoteLocation {
  readonly scheme: "http" | "https" | "ssh" | "git";
  readonly host: string;
  readonly port: number | null;
}

/**
 * Where an accepted clone URL points, or null for one `repositoryCloneUrlIssue` refuses. SCP-style
 * `user@host:path` is ssh on its default port.
 */
export const gitRemoteLocation = (value: string): GitRemoteLocation | null => {
  if (repositoryCloneUrlIssue(value) !== null) return null;
  if (!value.includes("://")) {
    const hostPart = value.slice(value.indexOf("@") + 1, value.lastIndexOf(":"));
    const host = hostPart.startsWith("[") ? hostPart.slice(1, -1) : hostPart;
    return { scheme: "ssh", host: host.toLowerCase(), port: null };
  }
  const url = new URL(value);
  const scheme = url.protocol.slice(0, -1);
  if (scheme !== "http" && scheme !== "https" && scheme !== "ssh" && scheme !== "git") return null;
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  return { scheme, host: host.toLowerCase(), port: url.port === "" ? null : Number(url.port) };
};

/**
 * Whether a workspace's git transport target is the project's own remote: the same host, and the
 * same ssh port (22 when unspecified).
 */
export const isSameGitRemote = (
  origin: GitRemoteLocation,
  target: { readonly host: string; readonly port: number | null },
): boolean =>
  origin.host === target.host.toLowerCase() &&
  (origin.scheme === "ssh" ? (origin.port ?? 22) === (target.port ?? 22) : true);

export const RepositoryCloneUrl = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value: string) => repositoryCloneUrlIssue(value) ?? undefined)),
  Schema.brand("RepositoryCloneUrl"),
);
export type RepositoryCloneUrl = typeof RepositoryCloneUrl.Type;

/** What a workspace git transport op is doing, named by its remote command. */
export type GitTransportKind = "fetch" | "push" | "archive";

/**
 * A repository adopted into Mend's central store on this machine (plan §5.2).
 * Adoption clones the repository into the store; the store copy is canonical
 * for Mend. The user's pre-existing checkout, if any, is a peer that syncs
 * through git — never an execution target.
 */
export class Project extends Schema.Class<Project>("Project")({
  id: ProjectId,
  /** Short name, unique within the organization. */
  name: Schema.String,
  /** The organization that owns the project (docs/adr/0003-organizations-and-tenancy.md). */
  organizationId: OrganizationId,
  /** `private`: its creator only. `shared`: every member of its organization. */
  visibility: ProjectVisibility,
  /** The account that adopted it; the creator a private project is visible to. */
  createdByUserId: Schema.NullOr(Schema.String),
  /** Network Git URL used for adoption. Null only for legacy bare-created repositories. */
  originUrl: Schema.NullOr(Schema.String),
  /**
   * Absolute path of the bare repo inside the store: `<storeRoot>/<projectId>/repo.git` for
   * projects adopted after organizations, `<storeRoot>/<name>/repo.git` before.
   */
  storePath: Schema.String,
  defaultBranch: Schema.String,
  /** HEAD of the default branch at adoption — display only; git is the source of truth. */
  adoptedSha: Schema.NullOr(Sha),
  /** Override of the Settings default: compose the tour when a session settles. */
  autoTour: AutomationChoice,
  /** Override of the Settings default: run the suggestion pass when a session settles. */
  autoSuggest: AutomationChoice,
  /** Override of the Settings default: name the session from its first prompt. */
  autoName: AutomationChoice,
  /**
   * Override of the Settings default: sessions keep running when every client
   * disconnects. Resolved by the launching CLI (flag → project → settings) —
   * only the client that would stop the session can enforce foreground.
   */
  backgroundSessions: AutomationChoice,
  /** How host-side git authenticates to this project's remote. */
  gitAuthMode: GitAuthMode,
  /** Override of the Settings default workspace image; null inherits it. */
  workspaceImage: Schema.NullOr(WorkspaceImage),
  /**
   * Whether sessions here receive the launching user's dotfiles (per-user store + repo). A
   * boolean, not a cascade: dotfiles are identity, so the only project-level question is
   * "does this project want them applied".
   */
  applyDotfiles: Schema.Boolean,
  /**
   * Whether sessions receive skills from the launching user's library. Project skills always
   * remain enabled and override inherited user skills with the same name. Older values decode to
   * enabled so adding this setting cannot silently drop an existing user's skills.
   */
  inheritUserSkills: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /**
   * How many hot workspaces to keep ready for new sessions (0 = none). Each is a fully
   * pre-provisioned worktree + live workspace a new session claims at start, so the attach is
   * effectively instant. Explicit resource intent: N ready containers per project.
   */
  hotSessions: Schema.Number,
  /**
   * The command that builds this project's dependency tree, run by Mend in a workspace whose
   * tree does not match the executor's platform and by the install job that feeds the shared
   * cache (ADR-0002 decisions 2/9). Null = detected from the base tree's lockfile at launch.
   */
  installCommand: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}
