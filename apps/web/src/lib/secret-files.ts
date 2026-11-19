import { SECRET_FILE_MAX_BYTES, validateSecretFilePath } from "@mend/domain/workbench";

/**
 * Settings → Dotfiles: what the secret files and home files say, and what a path or a file is
 * refused for before anything is sent. Pure, so each refusal is testable.
 */

/** The home-relative path a typed `~/.aws/credentials` means. */
export const homeRelative = (typed: string): string => {
  const trimmed = typed.trim();
  return trimmed.startsWith("~/") ? trimmed.slice(2) : trimmed;
};

/** Bytes as a person reads them: 812 B, 4.1 KB. */
export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

/**
 * Why a secret file can't be saved as it stands, in a sentence; null when it can. The path is
 * checked as the server checks it, plus raw `..` segments, and a chosen file by its size.
 */
export const secretFileProblem = (
  typedPath: string,
  file: { readonly name: string; readonly bytes: number } | null,
): string | null => {
  const path = homeRelative(typedPath);
  if (path === "") return null;
  if (path.split("/").includes("..")) return `${typedPath.trim()} leaves your home folder.`;
  const refused = validateSecretFilePath(path);
  if (refused !== null) return `Mend can't keep a file there: ${refused}.`;
  if (file !== null && file.bytes > SECRET_FILE_MAX_BYTES) {
    return `${file.name} is larger than ${SECRET_FILE_MAX_BYTES / 1024} KB.`;
  }
  return null;
};

/** A file's bytes as base64, read in the browser; nothing leaves the page but the upload. */
export const readAsBase64 = async (file: Blob): Promise<string> => {
  let binary = "";
  for (const byte of new Uint8Array(await file.arrayBuffer())) binary += String.fromCharCode(byte);
  return btoa(binary);
};
