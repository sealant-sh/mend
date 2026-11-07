import * as fs from "node:fs";

import { Effect } from "effect";

import { WorkspaceFileError } from "./workspace-file-error.ts";

/**
 * Shared by the host writer and the pickup exec. Self-contained so the same containment and
 * replacement rules run in both places. Links must resolve inside the root; the resolved parent
 * directories are then held by descriptor. Replacing a file preserves its executable bits.
 */
function replaceWorktreeFile(
  io: typeof fs,
  root: string,
  relative: string,
  bytes: Uint8Array,
  nonce: string,
): string | null {
  const parts = relative.split("/");
  for (const part of parts) {
    if (
      part === "" ||
      part === "." ||
      part === ".." ||
      part.toLowerCase() === ".git" ||
      part.includes("\\") ||
      part.includes("\0")
    )
      return "a path must stay inside the worktree and outside .git";
  }
  const c = io.constants;
  let directory: number | undefined;
  let staged: number | undefined;
  let temporary: string | undefined;
  try {
    const realRoot = io.realpathSync(root);
    let ancestor = `${realRoot}/${relative}`;
    const missing: string[] = [];
    let resolved: string;
    while (true) {
      try {
        resolved = io.realpathSync(ancestor);
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        // A dangling link is present, and cannot be treated as a new file.
        try {
          io.lstatSync(ancestor);
          return "the path is a dangling link";
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
        }
        const slash = ancestor.lastIndexOf("/");
        if (slash <= 0) return "could not resolve the file path";
        missing.unshift(ancestor.slice(slash + 1));
        ancestor = ancestor.slice(0, slash);
      }
    }
    if (resolved !== realRoot && !resolved.startsWith(`${realRoot}/`))
      return "the path leaves the worktree";
    const canonical = resolved.slice(realRoot.length + 1);
    const targetParts = [...(canonical === "" ? [] : canonical.split("/")), ...missing];
    for (const part of targetParts)
      if (part.toLowerCase() === ".git") return "the path enters .git";
    const name = targetParts.pop();
    if (name === undefined) return "the path is not a file";
    directory = io.openSync(realRoot, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
    const held = io.fstatSync(directory);
    let prefix: string | undefined;
    for (const candidate of ["/proc/self/fd/", "/dev/fd/"]) {
      try {
        const seen = io.statSync(`${candidate}${directory}/.`);
        if (seen.dev === held.dev && seen.ino === held.ino) {
          prefix = candidate;
          break;
        }
      } catch {
        /* This platform has no descriptor directory here. */
      }
    }
    if (prefix === undefined) return "this platform cannot keep the write inside the worktree";
    for (const part of targetParts) {
      const entry = `${prefix}${directory}/${part}`;
      if (!io.existsSync(entry)) io.mkdirSync(entry, { mode: 0o755 });
      const next = io.openSync(entry, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
      io.closeSync(directory);
      directory = next;
    }
    const target = `${prefix}${directory}/${name}`;
    let mode = 0o644;
    try {
      const existing = io.lstatSync(target);
      if (!existing.isFile()) return "the path is not a regular file";
      mode = existing.mode & 0o777;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const candidate = `${prefix}${directory}/.mend-write-${nonce}`;
    staged = io.openSync(candidate, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
    temporary = candidate;
    io.writeFileSync(staged, bytes);
    io.fchmodSync(staged, mode);
    io.fsyncSync(staged);
    io.renameSync(temporary, target);
    temporary = undefined;
    return null;
  } catch {
    return "could not write the file inside the worktree";
  } finally {
    if (staged !== undefined) io.closeSync(staged);
    if (temporary !== undefined) io.unlinkSync(temporary);
    if (directory !== undefined) io.closeSync(directory);
  }
}

/** The pickup exec's replacement function; it needs only its explicit arguments. */
export const WORKTREE_FILE_REPLACE_FUNCTION = `const replaceWorktreeFile = ${replaceWorktreeFile.toString()};`;

/** Atomically replaces a worktree text file, refusing links that leave the root. */
export const writeWorktreeFileOnHost = (
  root: string,
  relative: string,
  contents: string,
): Effect.Effect<void, WorkspaceFileError> =>
  Effect.try({
    try: () =>
      replaceWorktreeFile(
        fs,
        root,
        relative,
        new TextEncoder().encode(contents),
        crypto.randomUUID(),
      ),
    catch: () =>
      new WorkspaceFileError({ path: relative, message: "could not write the worktree file" }),
  }).pipe(
    Effect.flatMap((reason) =>
      reason === null
        ? Effect.void
        : Effect.fail(new WorkspaceFileError({ path: relative, message: reason })),
    ),
  );
