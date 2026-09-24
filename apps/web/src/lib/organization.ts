import { FOLDER_MAX_FILE_BYTES, FOLDER_MAX_REQUEST_BYTES } from "@mend/domain/workbench";

import type { AuditEntryDto, InvitationPreviewDto } from "./api.ts";

/**
 * Pure view logic for the organization surfaces (docs/adr/0003-organizations-and-tenancy.md):
 * Settings panels and the join page read these, so every sentence and decision is testable.
 */

const text = (value: string | number | boolean | null | undefined): string | null =>
  typeof value === "string" ? value : null;

/** Slack settings by the words Settings → Slack uses for them. */
const SLACK_SETTING_WORDS: Readonly<Record<string, string>> = {
  defaultHarness: "default harness",
  showAgentMessages: "show agent messages",
  showDiffs: "show diffs",
  externalChannels: "external channels",
  landAutomatically: "land automatically",
};

/** How a Slack-started session's project was chosen, as the status message in Slack words it. */
const SLACK_PROJECT_SOURCE_WORDS: Readonly<Record<string, string>> = {
  message: "named in the request",
  "thread-session": "the thread's session",
  "thread-link": "from a link in the thread",
  "thread-inference": "from the thread",
  "channel-default": "channel default",
  "personal-default": "personal default",
  picked: "picked",
};

/**
 * One audit event as a plain sentence, without the actor or time (the row shows those). Member
 * events name the account the server resolved, removed members included.
 */
export const describeAudit = (entry: Pick<AuditEntryDto, "event" | "subjectName">): string => {
  const { event } = entry;
  const subject = entry.subjectName ?? event.subjectId;
  const name = text(event.data["name"]);
  switch (event.action) {
    case "invitation.created":
      return `created an invitation link for ${text(event.data["role"]) ?? "a member"}`;
    case "invitation.revoked":
      return "revoked an invitation link";
    case "invitation.accepted":
      return `joined as ${text(event.data["role"]) ?? "a member"}`;
    case "member.role_changed":
      return `made ${subject} ${text(event.data["role"]) === "owner" ? "an owner" : "a member"}`;
    case "member.removed":
      return `removed ${subject}`;
    case "project.visibility_changed":
      return `made project ${event.subjectId} ${text(event.data["visibility"]) ?? "private"}`;
    case "project.taken_over":
      return `took over project ${event.subjectId}`;
    case "folder.created":
      return `created folder ${name ?? event.subjectId}`;
    case "folder.removed":
      return `removed folder ${name ?? event.subjectId}`;
    case "reference.added":
      return `added reference ${name ?? event.subjectId}`;
    case "reference.removed":
      return `removed reference ${name ?? event.subjectId}`;
    case "session.shared_control_on":
      return `shared control of session ${event.subjectId}`;
    case "session.shared_control_off":
      return `turned off shared control of session ${event.subjectId}`;
    case "member.password_reset_issued":
      return `issued a password reset link for ${subject}`;
    case "organization.created":
      return `created the organization${name === null ? "" : ` as ${name}`}`;
    case "organization.renamed":
      return `renamed the organization${name === null ? "" : ` to ${name}`}`;
    case "recovery.owner_granted":
      return `made ${subject} an owner, as the operator`;
    case "recovery.password_reset_issued":
      return `issued a password reset link for ${subject}, as the operator`;
    case "slack.installed":
      return `connected the Slack workspace ${text(event.data["teamName"]) ?? event.subjectId}`;
    case "slack.replaced":
      return event.data["linksKept"] === false
        ? `connected the Slack workspace ${text(event.data["teamName"]) ?? event.subjectId} in place of ${text(event.data["previousTeamId"]) ?? "the previous one"}, dropping its links`
        : `replaced the Slack tokens for ${text(event.data["teamName"]) ?? event.subjectId}`;
    case "slack.removed":
      return `removed the Slack app from ${text(event.data["teamName"]) ?? event.subjectId}`;
    case "slack.settings_changed": {
      const changed = Object.entries(event.data)
        .map(([key, value]) => `${SLACK_SETTING_WORDS[key] ?? key} ${String(value)}`)
        .join(", ");
      return changed === "" ? "changed the Slack settings" : `set Slack ${changed}`;
    }
    case "slack.link_created":
      return `linked Slack user ${text(event.data["slackUserId"]) ?? "?"} to ${subject}`;
    case "slack.link_removed":
      return event.data["memberRemoved"] === true
        ? `removed the Slack link of ${subject} with their membership`
        : `removed the Slack link of ${subject} (${text(event.data["slackUserId"]) ?? "?"})`;
    case "slack.session_started": {
      const project = text(event.data["projectName"]) ?? text(event.data["projectId"]) ?? "?";
      const source = text(event.data["projectSource"]);
      const why = source === null ? "" : ` · ${SLACK_PROJECT_SOURCE_WORDS[source] ?? source}`;
      return `started session ${event.subjectId} from Slack in ${project}${why}`;
    }
    case "slack.channel_default_set": {
      const channel = text(event.data["channelId"]) ?? "?";
      const project = text(event.data["projectName"]) ?? event.subjectId;
      return `set the default project of Slack channel ${channel} to ${project}`;
    }
    case "slack.channel_default_cleared": {
      const channel = text(event.data["channelId"]) ?? "?";
      const project = text(event.data["projectName"]) ?? event.subjectId;
      return `cleared the default project of Slack channel ${channel} (was ${project})`;
    }
    case "change.landed": {
      const branch = text(event.data["remoteBranch"]) ?? "?";
      const pushed = text(event.data["pushedSha"]);
      const pullRequest = event.data["pullRequest"];
      switch (text(event.data["outcome"])) {
        case "pull-request":
          return `pushed change ${event.subjectId} to ${branch} · pull request #${String(pullRequest)}`;
        case "pushed":
          return `pushed change ${event.subjectId} to ${branch}${pushed === null ? "" : ` · ${pushed.slice(0, 7)}`}`;
        case "refused":
          return `landing of change ${event.subjectId} refused by origin · ${branch}`;
        default:
          return `landing of change ${event.subjectId} failed · ${branch}`;
      }
    }
    case "change.pull_request_refreshed":
      return `read pull request #${String(event.data["pullRequest"])} of change ${event.subjectId} · ${text(event.data["state"]) ?? "?"}`;
    case "change.bundle_downloaded": {
      const tip = text(event.data["tip"]);
      return `downloaded change ${event.subjectId} as a bundle · ${text(event.data["branch"]) ?? "?"}${tip === null ? "" : ` · ${tip.slice(0, 7)}`}`;
    }
  }
};

/** What the join page shows for one invitation link. */
export type JoinState =
  | { readonly kind: "spent"; readonly message: string }
  | { readonly kind: "register" }
  | { readonly kind: "already-member" }
  | { readonly kind: "other-organization"; readonly current: string };

const SPENT: Record<"accepted" | "revoked" | "expired", string> = {
  accepted: "This invitation was already used. Ask an owner for a new link.",
  revoked: "This invitation was revoked by an owner. Ask an owner for a new link.",
  expired: "This invitation has expired. Ask an owner for a new link.",
};

/**
 * An open link registers a new account. A signed-in account already belongs to exactly one
 * organization, so the link either names it or names another one.
 */
export const joinState = (
  preview: Pick<InvitationPreviewDto, "state" | "organizationId">,
  signedIn: boolean,
  current: { readonly id: string; readonly name: string } | null,
): JoinState => {
  if (preview.state !== "open") return { kind: "spent", message: SPENT[preview.state] };
  if (!signedIn) return { kind: "register" };
  if (current?.id === preview.organizationId) return { kind: "already-member" };
  return { kind: "other-organization", current: current?.name ?? "no organization" };
};

/** A picked file by its place in the folder and its size; bytes are read only once accepted. */
export interface StagedFile {
  readonly path: string;
  readonly size: number;
}

export interface UploadPlan<F extends StagedFile> {
  /** Each batch fits one request. */
  readonly batches: ReadonlyArray<ReadonlyArray<F>>;
  /** Files left out, with the reason, in the order they were picked. */
  readonly rejected: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/** Hidden paths people rarely mean to share: version control internals and OS litter. */
const SKIPPED_SEGMENTS = new Set([".git", ".DS_Store", "node_modules"]);

/**
 * Plan a folder upload: drop files over the per-file cap or under a skipped directory, and pack
 * the rest into requests under the per-request cap, in the order given.
 */
export const planUpload = <F extends StagedFile>(
  files: ReadonlyArray<F>,
  limits: { readonly file: number; readonly request: number } = {
    file: FOLDER_MAX_FILE_BYTES,
    request: FOLDER_MAX_REQUEST_BYTES,
  },
): UploadPlan<F> => {
  const batches: Array<Array<F>> = [];
  const rejected: Array<{ readonly path: string; readonly reason: string }> = [];
  let current: Array<F> = [];
  let size = 0;
  for (const file of files) {
    if (file.path.split("/").some((segment) => SKIPPED_SEGMENTS.has(segment))) {
      rejected.push({ path: file.path, reason: "skipped" });
      continue;
    }
    if (file.size > limits.file) {
      rejected.push({ path: file.path, reason: "over 1 MiB" });
      continue;
    }
    if (current.length > 0 && size + file.size > limits.request) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.size;
  }
  if (current.length > 0) batches.push(current);
  return { batches, rejected };
};

/** The folder-relative path a picked file lands at: its place inside a picked directory. */
export const stagedPath = (file: {
  readonly name: string;
  readonly webkitRelativePath: string;
}): string => {
  const relative = file.webkitRelativePath === "" ? file.name : file.webkitRelativePath;
  // A directory pick includes the directory's own name first; the folder is that directory.
  const segments = relative.split("/").filter((segment) => segment !== "");
  return segments.length > 1 && file.webkitRelativePath !== ""
    ? segments.slice(1).join("/")
    : segments.join("/");
};

/** Base64 without a data-URL prefix, in chunks so large files do not overflow the call stack. */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

/** Bytes for a listing: exact under a kibibyte, one decimal above. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};
