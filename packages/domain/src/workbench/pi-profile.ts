import { Schema } from "effect";

import { Timestamp } from "../timestamp.ts";

/**
 * A person's pi setup, as `mend connect pi` read it from their machine: the extensions, themes,
 * prompt templates and settings that make pi theirs. One per account. Every pi session the person
 * starts receives it in its agent directory, at `.pi/agent/mend/profile`, and pi loads it from
 * there as a local package (`harness-seeds.ts`).
 *
 * Never part of it: logins (`auth.json`; pi runs on the ChatGPT login `mend connect codex` made),
 * sessions, installed packages (`npm/`, `git/`, `node_modules/`; the session installs what
 * `settings.json` declares), caches, and skills, which `mend skills push` carries.
 *
 * The layout, relative to the profile root:
 * - `settings.json`: the person's settings, with every local package rewritten to its bundled
 *   copy (`PI_PROFILE_LOCAL_PACKAGES`).
 * - `extensions/`, `themes/`, `prompts/`: as in their agent directory.
 * - `package.json`, `package-lock.json`: the dependencies their extensions import, installed in
 *   the session beside the profile.
 * - `packages/<name>/`: a local package `settings.json` named by path, copied whole.
 * - `root/mcp.json`, `root/keybindings.json`: files pi reads from the agent directory itself.
 */

/** Where the profile lands, relative to pi's agent directory. */
export const PI_PROFILE_AGENT_PATH = "mend/profile";

/** Where bundled local packages live inside the profile. */
export const PI_PROFILE_LOCAL_PACKAGES = "packages";

/** The top-level directories a profile may carry. */
export const PI_PROFILE_DIRECTORIES = ["extensions", "themes", "prompts", "packages"] as const;

/** The top-level files a profile may carry. */
export const PI_PROFILE_FILES = [
  "settings.json",
  "package.json",
  "package-lock.json",
  "root/mcp.json",
  "root/keybindings.json",
] as const;

export const PI_PROFILE_MAX_FILES = 4000;
export const PI_PROFILE_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const PI_PROFILE_MAX_BYTES = 16 * 1024 * 1024;
const PI_PROFILE_MAX_PATH_LENGTH = 512;

/** One file of a profile. Extensions may carry images and the like, so a file may be base64. */
export class PiProfileFile extends Schema.Class<PiProfileFile>("PiProfileFile")({
  /** Profile-relative POSIX path; validated by `validatePiProfileFilePath`. */
  path: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  contents: Schema.String,
}) {}

/** A saved profile as a person sees it: what it holds, not the bytes. */
export class PiProfile extends Schema.Class<PiProfile>("PiProfile")({
  fileCount: Schema.Int,
  bytes: Schema.Int,
  /** The profile's top-level extensions: each file or directory under `extensions/`. */
  extensions: Schema.Array(Schema.String),
  /** The packages its `settings.json` declares, each as its source. */
  packages: Schema.Array(Schema.String),
  /** Changes whenever the files do: the tree digest a session compares against. */
  digest: Schema.String,
  revision: Schema.Int,
  updatedAt: Timestamp,
}) {}

/** `GET /me/pi-profile`: the saved profile, or null when the person has not connected pi. */
export class PiProfileView extends Schema.Class<PiProfileView>("PiProfileView")({
  profile: Schema.NullOr(PiProfile),
}) {}

/** `PUT /me/pi-profile`: the whole profile; it replaces the saved one. */
export class PiProfileUpload extends Schema.Class<PiProfileUpload>("PiProfileUpload")({
  files: Schema.Array(PiProfileFile),
}) {}

/** What a save did: `changed` is false when the upload held exactly the saved files. */
export class PiProfileSaved extends Schema.Class<PiProfileSaved>("PiProfileSaved")({
  profile: PiProfile,
  changed: Schema.Boolean,
}) {}

/** `DELETE /me/pi-profile`: whether there was one to remove. */
export class PiProfileRemoved extends Schema.Class<PiProfileRemoved>("PiProfileRemoved")({
  removed: Schema.Boolean,
}) {}

/** The bytes a file stands for, or null when its base64 does not decode. */
export const piProfileFileBytes = (file: {
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
}): Uint8Array | null => {
  if (file.encoding === "utf8") return new TextEncoder().encode(file.contents);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.contents) || file.contents.length % 4 !== 0) return null;
  try {
    return Uint8Array.from(atob(file.contents), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

/**
 * Paths are profile-relative and written under the session's agent directory, so anything that
 * could leave the profile is refused, and so is anything outside the layout above.
 */
export const validatePiProfileFilePath = (filePath: string): string | null => {
  if (filePath.length === 0) return "a file path is required";
  if (filePath.length > PI_PROFILE_MAX_PATH_LENGTH) {
    return `${filePath} is longer than ${PI_PROFILE_MAX_PATH_LENGTH} characters`;
  }
  if (filePath.startsWith("/") || filePath.includes("\\") || filePath.includes("\0")) {
    return `${filePath} is not a relative POSIX path`;
  }
  const segments = filePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `${filePath} must not contain empty, "." or ".." segments`;
  }
  if (PI_PROFILE_FILES.some((file) => file === filePath)) return null;
  const top = segments[0] ?? "";
  if (segments.length > 1 && PI_PROFILE_DIRECTORIES.some((directory) => directory === top)) {
    return null;
  }
  return `${filePath} is not part of a pi profile`;
};

/** The first thing that makes a profile unacceptable, or null when it is well-formed. */
export const validatePiProfile = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly encoding: "utf8" | "base64";
    readonly contents: string;
  }>,
): string | null => {
  if (files.length === 0) return "a pi profile needs at least one file";
  if (files.length > PI_PROFILE_MAX_FILES) {
    return `a pi profile is capped at ${PI_PROFILE_MAX_FILES} files`;
  }
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const pathIssue = validatePiProfileFilePath(file.path);
    if (pathIssue !== null) return pathIssue;
    if (seen.has(file.path)) return `${file.path} appears twice`;
    seen.add(file.path);
    const bytes = piProfileFileBytes(file);
    if (bytes === null) return `${file.path} is not valid base64`;
    if (bytes.byteLength > PI_PROFILE_MAX_FILE_BYTES) {
      return `${file.path} is over ${PI_PROFILE_MAX_FILE_BYTES / (1024 * 1024)} MB`;
    }
    total += bytes.byteLength;
  }
  // A path that is both a file and a directory cannot be written.
  for (const filePath of seen) {
    const segments = filePath.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join("/");
      if (seen.has(parent)) return `${parent} is both a file and a directory`;
    }
  }
  if (total > PI_PROFILE_MAX_BYTES) {
    return `a pi profile is capped at ${PI_PROFILE_MAX_BYTES / (1024 * 1024)} MB in total`;
  }
  return null;
};

/** The profile's top-level extensions, as `PiProfile.extensions` lists them. */
export const piProfileExtensions = (
  files: ReadonlyArray<{ readonly path: string }>,
): ReadonlyArray<string> =>
  [
    ...new Set(
      files.flatMap((file) => {
        const [top, name] = file.path.split("/");
        return top === "extensions" && name !== undefined ? [name] : [];
      }),
    ),
  ].toSorted();

/** The package sources the profile's `settings.json` declares, as `PiProfile.packages` lists them. */
export const piProfilePackages = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly encoding: "utf8" | "base64";
    readonly contents: string;
  }>,
): ReadonlyArray<string> => {
  const settings = files.find((file) => file.path === "settings.json");
  if (settings === undefined) return [];
  const bytes = piProfileFileBytes(settings);
  if (bytes === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || !("packages" in parsed)) return [];
  const packages = parsed.packages;
  if (!Array.isArray(packages)) return [];
  return packages.flatMap((entry: unknown) => {
    if (typeof entry === "string") return [entry];
    if (entry !== null && typeof entry === "object" && "source" in entry) {
      return typeof entry.source === "string" ? [entry.source] : [];
    }
    return [];
  });
};
