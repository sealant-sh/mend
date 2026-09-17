import { FOLDER_MAX_FILE_BYTES, FOLDER_MAX_REQUEST_BYTES } from "@mend/domain/workbench";

import type { AuditEntryDto, InvitationPreviewDto } from "./api.ts";

/**
 * Pure view logic for the organization surfaces (docs/adr/0003-organizations-and-tenancy.md):
 * Settings panels and the join page read these, so every sentence and decision is testable.
 */

const text = (value: string | number | boolean | null | undefined): string | null =>
  typeof value === "string" ? value : null;

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
