import { Schema } from "effect";

import { SecretFileId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { piProfileFileBytes } from "./pi-profile.ts";

/**
 * A secret file (docs/adr/0010-secret-files.md): a file a person keeps in Mend, sealed at rest
 * with the machine's secrets key (`@mend/store` SecretCipher, the project secrets' cipher), with
 * a path under `$HOME` in the workspace and its content. Every session the person owns receives
 * it at launch, written into the workspace before the harness starts: `~/.aws/credentials`, a
 * kubeconfig, an `.npmrc` token file. Per person, shared with no one.
 *
 * Never captured. It is written into the executor's own `$HOME`, which no capture root covers:
 * the worktree is `/workspace/repo`, the harness home is `/workspace/harness-home`, and the
 * harness directories relocated onto it are refused as secret file paths
 * (`SECRET_FILE_RESERVED_PATHS`). The writer in the workspace refuses a symlink at any component
 * and a directory whose physical path leaves the home or enters `/workspace`, so dotfiles cannot
 * redirect a secret file into a captured root either (`packages/sessions/src/secret-files.ts`).
 *
 * The API returns a secret file's path and size, never its content.
 */

export const SECRET_FILE_MAX_FILES = 64;
export const SECRET_FILE_MAX_BYTES = 256 * 1024;
export const SECRET_FILES_MAX_TOTAL_BYTES = 1024 * 1024;
const SECRET_FILE_MAX_PATH_LENGTH = 512;

/**
 * Home-relative paths a secret file may never take: every directory the harness home relocation
 * moves onto the captured harness root (`HARNESS_STATE[*].homeDirs` in @mend/sessions, which has
 * a test holding the two lists together), the one harness file the harvest archives from the home
 * root, and Mend's own markers. A path equal to one of these, or under one, is refused.
 */
export const SECRET_FILE_RESERVED_PATHS: ReadonlyArray<string> = [
  ".claude",
  ".claude.json",
  ".codex",
  ".pi",
  ".local/share/opencode",
  ".local/state/opencode",
  ".mend",
];

/** A secret file as every surface sees it: where it goes and how big it is, never what it holds. */
export class SecretFile extends Schema.Class<SecretFile>("SecretFile")({
  id: SecretFileId,
  /** Home-relative POSIX path, as `validateSecretFilePath` accepts it. */
  path: Schema.String,
  /** The last segment of `path`: what a list shows first. */
  name: Schema.String,
  bytes: Schema.Int,
  /** Grows with every replace; the content itself never appears. */
  revision: Schema.Int,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** `GET /me/secret-files`: the signed-in account's files, by path. */
export class SecretFilesView extends Schema.Class<SecretFilesView>("SecretFilesView")({
  files: Schema.Array(SecretFile),
}) {}

/** `PUT /me/secret-files`: one file, created or replaced by path. The content is write-only. */
export class SecretFileUpload extends Schema.Class<SecretFileUpload>("SecretFileUpload")({
  path: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  contents: Schema.String,
}) {}

/** What a save did. */
export class SecretFileSaved extends Schema.Class<SecretFileSaved>("SecretFileSaved")({
  file: SecretFile,
  action: Schema.Literals(["created", "replaced"]),
}) {}

/** `DELETE /me/secret-files?path=`: whether there was one at that path. */
export class SecretFileRemoved extends Schema.Class<SecretFileRemoved>("SecretFileRemoved")({
  removed: Schema.Boolean,
}) {}

/** The bytes an upload stands for, or null when its base64 does not decode. */
export const secretFileBytes = piProfileFileBytes;

/** The last segment of a validated path. */
export const secretFileNameOf = (filePath: string): string =>
  filePath.split("/").at(-1) ?? filePath;

/**
 * Where a secret file may go: a relative POSIX path under the workspace user's home, with no
 * empty, `.` or `..` segment, outside every reserved path. The first thing wrong, or null.
 */
export const validateSecretFilePath = (filePath: string): string | null => {
  const syntax = validateSecretFilePathSyntax(filePath);
  if (syntax !== null) return syntax;
  const reserved = reservedSecretFileRoot(filePath);
  if (reserved !== null) {
    return `${filePath} is under ${reserved}, which sessions capture`;
  }
  return null;
};

/** The reserved path (`SECRET_FILE_RESERVED_PATHS`) a home-relative path is, or is under; null when none. */
export const reservedSecretFileRoot = (filePath: string): string | null =>
  SECRET_FILE_RESERVED_PATHS.find(
    (prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`),
  ) ?? null;

/**
 * Whether a path is a well-formed home-relative path at all, reserved or not: what a record of a
 * delivery made before a path was reserved still needs, so the file it names can be cleaned up
 * (`.local/state/opencode` became reserved on 2026-10-04). The first thing wrong, or null.
 */
export const validateSecretFilePathSyntax = (filePath: string): string | null => {
  if (filePath.length === 0) return "a path under the home directory is required";
  if (filePath.length > SECRET_FILE_MAX_PATH_LENGTH) {
    return `${filePath} is longer than ${SECRET_FILE_MAX_PATH_LENGTH} characters`;
  }
  if (filePath.startsWith("/") || filePath.startsWith("~")) {
    return `${filePath} must be relative to the home directory, as .aws/credentials is`;
  }
  const control = [...filePath].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (filePath.includes("\\") || control) return `${filePath} is not a POSIX path`;
  const segments = filePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `${filePath} must not contain empty, "." or ".." segments`;
  }
  return null;
};

/** The first thing wrong with an upload's content, or null. */
export const validateSecretFileContent = (file: {
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
}): string | null => {
  const bytes = secretFileBytes(file);
  if (bytes === null) return "the content is not valid base64";
  if (bytes.byteLength === 0) return "the file is empty";
  if (bytes.byteLength > SECRET_FILE_MAX_BYTES) {
    return `the file is over ${SECRET_FILE_MAX_BYTES / 1024} KB`;
  }
  return null;
};
