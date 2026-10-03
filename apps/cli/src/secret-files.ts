import * as path from "node:path";

import { validateSecretFilePath } from "@mend/domain/workbench";

/**
 * `mend secrets` (docs/adr/0010-secret-files.md): the person's secret files, each written into
 * every workspace a session they own launches in. The CLI reads a file's bytes on this machine
 * and sends them once; the server seals them and never returns them.
 */

/** A secret file as the API lists it: never its content. */
export interface SecretFileDto {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What `mend secrets add` sends. */
export interface SecretFileUploadDto {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
}

/**
 * The home-relative path a person means: `~/.aws/credentials`, `.aws/credentials` and, when it is
 * under this machine's home, `/home/me/.aws/credentials` all name `.aws/credentials` in the
 * workspace. Any other absolute path has no place under the workspace home and is refused.
 */
export const secretFilePathOf = (
  input: string,
  home: string,
):
  | { readonly path: string; readonly issue: null }
  | { readonly path: null; readonly issue: string } => {
  const trimmed = input.trim();
  let relative = trimmed;
  if (trimmed === "~" || trimmed.startsWith("~/")) relative = trimmed.slice(2);
  else if (path.isAbsolute(trimmed)) {
    const fromHome = path.relative(home, trimmed);
    if (fromHome === "" || fromHome.startsWith("..") || path.isAbsolute(fromHome)) {
      return {
        path: null,
        issue: `${trimmed} is outside your home directory; name the path under the workspace home, as .aws/credentials`,
      };
    }
    relative = fromHome;
  }
  const normalized = path.posix
    .normalize(relative)
    .replace(/^(\.\/)+/, "")
    .replace(/\/$/, "");
  const issue = validateSecretFilePath(normalized === "." ? "" : normalized);
  return issue === null ? { path: normalized, issue: null } : { path: null, issue };
};

/** The upload for a file's bytes: text rides as utf8, anything else as base64. */
export const secretFileUploadOf = (filePath: string, bytes: Buffer): SecretFileUploadDto => {
  const text = bytes.includes(0) ? null : bytes.toString("utf8");
  return text !== null && Buffer.from(text, "utf8").equals(bytes)
    ? { path: filePath, encoding: "utf8", contents: text }
    : { path: filePath, encoding: "base64", contents: bytes.toString("base64") };
};

const sizeOf = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** One line per file for `mend secrets`: the path as the workspace sees it, its size, when it changed. */
export const secretFileLines = (files: ReadonlyArray<SecretFileDto>): ReadonlyArray<string> => {
  const width = Math.max(0, ...files.map((file) => file.path.length + 2));
  return files.map(
    (file) =>
      `~/${file.path}`.padEnd(width) +
      `  ${sizeOf(file.bytes).padStart(8)}  ${file.updatedAt.slice(0, 16).replace("T", " ")}` +
      (file.revision > 1
        ? ` · replaced ${file.revision - 1} time${file.revision === 2 ? "" : "s"}`
        : ""),
  );
};
