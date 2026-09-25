/**
 * Files Mend places into a live workspace that mounts nothing (capture mode, ADR-0002): a pasted
 * image, the owner's skills. The SDK's `exec` takes argv only — no stdin, no file write
 * (PLATFORM-FEEDBACK.md, "A file into a workspace") — so the bytes ride argv as base64, decoded
 * inside by `base64 -d`. Every argument set stays under `WORKSPACE_EXEC_ARG_CHARS`; small files
 * share one exec, a large one is appended chunk by chunk into a `.mend-part` file and renamed
 * into place, so a reader never sees half an image.
 *
 * Paths are absolute workspace paths chosen by Mend (never user input) and ride as positional
 * parameters, like the bytes: nothing is interpolated into the script.
 */

import { Schema } from "effect";

/** Base64 characters per exec: a multiple of 4, so every chunk decodes alone, under ~96 KB. */
export const WORKSPACE_EXEC_ARG_CHARS = 90_000;

export class WorkspaceFileError extends Schema.TaggedErrorClass<WorkspaceFileError>()(
  "WorkspaceFileError",
  { path: Schema.String, message: Schema.String },
) {}

export interface WorkspaceFile {
  /** Absolute path inside the workspace. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Writes each (path, base64) pair: its directory 0755, the file 0644. */
const SMALL_FILES_SCRIPT =
  'set -e; while [ "$#" -gt 1 ]; do ' +
  'dir=$(dirname "$1"); mkdir -p "$dir"; chmod 755 "$dir"; ' +
  'printf \'%s\' "$2" | base64 -d > "$1"; chmod 644 "$1"; shift 2; done';

/** `$1` a base64 chunk, `$2` the target; the first chunk starts the part file. */
const FIRST_CHUNK_SCRIPT =
  'set -e; dir=$(dirname "$2"); mkdir -p "$dir"; chmod 755 "$dir"; ' +
  'printf \'%s\' "$1" | base64 -d > "$2.mend-part"';
const NEXT_CHUNK_SCRIPT = 'set -e; printf \'%s\' "$1" | base64 -d >> "$2.mend-part"';
const FINISH_SCRIPT = 'set -e; chmod 644 "$2.mend-part"; mv -f "$2.mend-part" "$2"';

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/**
 * The execs that write `files` into a workspace, in order. Each argv's arguments together stay
 * under `WORKSPACE_EXEC_ARG_CHARS` plus the paths; running them all, each exiting 0, leaves every
 * file complete.
 */
export const writeFilesExecs = (
  files: ReadonlyArray<WorkspaceFile>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const execs: Array<ReadonlyArray<string>> = [];
  let batch: Array<string> = [];
  let batchChars = 0;
  const flush = () => {
    if (batch.length === 0) return;
    execs.push(["sh", "-c", SMALL_FILES_SCRIPT, "mend-write", ...batch]);
    batch = [];
    batchChars = 0;
  };
  for (const file of files) {
    const encoded = toBase64(file.bytes);
    if (encoded.length <= WORKSPACE_EXEC_ARG_CHARS) {
      if (batchChars + encoded.length > WORKSPACE_EXEC_ARG_CHARS) flush();
      batch.push(file.path, encoded);
      batchChars += encoded.length + file.path.length;
      continue;
    }
    flush();
    for (let offset = 0; offset < encoded.length; offset += WORKSPACE_EXEC_ARG_CHARS) {
      const chunk = encoded.slice(offset, offset + WORKSPACE_EXEC_ARG_CHARS);
      const script = offset === 0 ? FIRST_CHUNK_SCRIPT : NEXT_CHUNK_SCRIPT;
      execs.push(["sh", "-c", script, "mend-write", chunk, file.path]);
    }
    execs.push(["sh", "-c", FINISH_SCRIPT, "mend-write", "", file.path]);
  }
  flush();
  return execs;
};
