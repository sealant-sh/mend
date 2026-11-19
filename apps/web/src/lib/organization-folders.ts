import {
  FOLDER_MAX_FILE_BYTES,
  FOLDER_MAX_LISTED_FILES,
  FOLDER_MAX_REQUEST_BYTES,
} from "@mend/domain/workbench";

import { sizeWords } from "./byte-size.ts";

/**
 * Settings → the organization → Folders and references (docs/adr/0003, docs/adr/0025): the folders
 * Mend keeps for the organization and the reference repositories it clones, which each project
 * picks for its sessions. Everyone reads them; owners change them. What each row says, and how an
 * upload is split into requests the server takes.
 */

/** Folder and reference names become directory names inside the workspace (the server's rule). */
export const FOLDER_NAME_HINT =
  'Lowercase letters, digits, ".", "_" and "-", starting with a letter or digit.';

/** `2 days ago`, `5 hours ago`, `just now`, then the day. */
export const agoWords = (at: Date, now: Date): string => {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  if (days < 28) {
    const weeks = Math.floor(days / 7);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;
  }
  return at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
};

/** A folder's file count and size, from its listing; a listing the server cut short says so. */
export const folderFacts = (listing: {
  readonly files: ReadonlyArray<{ readonly bytes: number }>;
  readonly truncated: boolean;
}): { readonly files: string; readonly size: string; readonly count: number } => {
  const count = listing.files.length;
  const bytes = listing.files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    count,
    files: listing.truncated ? `${FOLDER_MAX_LISTED_FILES}+` : count.toString(),
    size: `${listing.truncated ? "over " : ""}${sizeWords(bytes)}`,
  };
};

/** `12 files`, `1 file`. */
export const filesWords = (files: string): string => `${files} ${files === "1" ? "file" : "files"}`;

/** What deleting a folder does first, said in its confirmation. */
export const deleteFolderLine = (
  facts: { readonly files: string; readonly size: string; readonly count: number } | null,
): string =>
  facts === null
    ? "Mend deletes the folder and its files. You can't undo this."
    : facts.count === 0
      ? "The folder is empty. You can't undo this."
      : `Mend deletes its ${filesWords(facts.files)} (${facts.size}). You can't undo this.`;

/** A reference's repository without its scheme: `github.com/stripe/stripe-node`. */
export const repositoryWords = (url: string): string =>
  url
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");

// --- Uploads ------------------------------------------------------------------------------------

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

/** What an upload did, as the toast says it. */
export const uploadedWords = (
  folder: string,
  sent: number,
  rejected: ReadonlyArray<{ readonly reason: string }>,
): string => {
  const added = `Added ${sent} ${sent === 1 ? "file" : "files"} to ${folder}.`;
  if (rejected.length === 0) return added;
  const reasons = [...new Set(rejected.map((entry) => entry.reason))].join(", ");
  return `${added} Left out ${rejected.length} (${reasons}).`;
};
