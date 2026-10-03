import { validateSecretFilePath } from "@mend/domain/workbench";

import { WORKSPACE_EXEC_ARG_CHARS } from "./workspace-files.ts";

/**
 * A person's secret files (docs/adr/0010-secret-files.md, secret-file.ts in @mend/domain),
 * written into each workspace a session they own launches in, before the harness starts. They go
 * into the executor's own `$HOME`, the one place no capture root covers: the worktree is
 * `/workspace/repo`, the harness home `/workspace/harness-home`, and the home directories the
 * relocation moves onto it were refused when the file was saved.
 *
 * The SDK's `exec` takes argv only (`workspace-files.ts`), so the bytes ride argv as base64 and
 * are decoded inside. Unlike `writeFilesExecs`, paths here are HOME-relative, the files land 0600
 * in directories made 0700, and every write first proves the path is still a plain path in the
 * home: no symlink at any component, the directory's physical path equal to its literal one, the
 * home itself outside `/workspace`. A dotfiles tree that linked `~/.aws` into the worktree would
 * otherwise turn a secret file into a captured one. Each file is staged beside its target as
 * `<target>.mend-secret-part` and renamed into place, so a reader never sees half a file.
 *
 * Outcomes are one line per file on stdout: `written <path>` or `refused <path> · <reason>`.
 */

/** Suffix of the staging file beside each target. */
export const SECRET_FILE_PART_SUFFIX = ".mend-secret-part";

/** A secret file ready to write: its HOME-relative path and its bytes. */
export interface SecretFileToWrite {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * `secret_target <home-relative path>`: sets `T` to the file's absolute path under the physical
 * home, and `D` to its directory, which it makes 0700 when missing. Prints the refusal and
 * returns 1 when the path may not be written.
 */
const TARGET_FUNCTION =
  "secret_target() { st_rel=$1; " +
  `H=$(cd "$HOME" 2>/dev/null && pwd -P) || { printf 'refused %s · no home directory\\n' "$st_rel"; return 1; }; ` +
  `case "$H" in /workspace|/workspace/*) printf 'refused %s · the home directory is inside the workspace\\n' "$st_rel"; return 1;; esac; ` +
  'T="$H/$st_rel"; st_walk=$H; st_rest=$st_rel; ' +
  'while :; do case "$st_rest" in ' +
  '*/*) st_seg=${st_rest%%/*}; st_rest=${st_rest#*/}; st_walk="$st_walk/$st_seg"; ' +
  `if [ -L "$st_walk" ]; then printf 'refused %s · %s is a symlink\\n' "$st_rel" "\${st_walk#"$H"/}"; return 1; fi;; ` +
  "*) break;; esac; done; " +
  `if [ -L "$T" ]; then printf 'refused %s · a symlink is at that path\\n' "$st_rel"; return 1; fi; ` +
  `if [ -e "$T" ] && [ ! -f "$T" ]; then printf 'refused %s · not a regular file\\n' "$st_rel"; return 1; fi; ` +
  "D=${T%/*}; " +
  `(umask 077; mkdir -p "$D") || { printf 'refused %s · could not make its directory\\n' "$st_rel"; return 1; }; ` +
  `st_phys=$(cd "$D" && pwd -P) || { printf 'refused %s · could not enter its directory\\n' "$st_rel"; return 1; }; ` +
  `if [ "$st_phys" != "$D" ]; then printf 'refused %s · its directory is really %s\\n' "$st_rel" "$st_phys"; return 1; fi; ` +
  "return 0; }; ";

/**
 * Decode `$2` (base64) into the staging file beside `$T`, 0600; on failure, remove it and say so.
 * Whatever sits at the staging path first goes (a symlink planted there would otherwise be written
 * through): `rm -f` removes a link, never what it points at.
 */
const START_PART =
  `rm -f "$T${SECRET_FILE_PART_SUFFIX}"; ` +
  `printf '%s' "$2" | (umask 077; base64 -d > "$T${SECRET_FILE_PART_SUFFIX}") || ` +
  `{ rm -f "$T${SECRET_FILE_PART_SUFFIX}"; printf 'refused %s · could not write\\n' "$1"; false; }`;

/** Rename the staging file into place, 0600, and report the file written. */
const FINISH_PART = `chmod 600 "$T${SECRET_FILE_PART_SUFFIX}" && mv -f "$T${SECRET_FILE_PART_SUFFIX}" "$T" && printf 'written %s\\n' "$1"`;

/** Small files, as (path, base64) pairs: each one checked, staged and renamed into place. */
const SMALL_FILES_SCRIPT =
  TARGET_FUNCTION +
  'while [ "$#" -gt 1 ]; do if secret_target "$1"; then ' +
  `${START_PART} && ${FINISH_PART}; fi; shift 2; done; exit 0`;

/** `$1` the HOME-relative path, `$2` a base64 chunk: the first chunk starts the staging file. */
const FIRST_CHUNK_SCRIPT =
  TARGET_FUNCTION + `if secret_target "$1"; then ${START_PART}; fi; exit 0`;

/**
 * The next chunk, appended only to a staging file the first chunk made (a refused first chunk made
 * none, and `>>` must not make one).
 */
const NEXT_CHUNK_SCRIPT =
  'H=$(cd "$HOME" 2>/dev/null && pwd -P) || exit 0; ' +
  `P="$H/$1${SECRET_FILE_PART_SUFFIX}"; [ -f "$P" ] && [ ! -L "$P" ] || exit 0; ` +
  `printf '%s' "$2" | base64 -d >> "$P" || { rm -f "$P"; printf 'refused %s · could not write\\n' "$1"; }; exit 0`;

/**
 * The last step of a chunked file: nothing when the first chunk was refused (it said why), else
 * the path proven again and the rename.
 */
const FINISH_SCRIPT =
  TARGET_FUNCTION +
  'H=$(cd "$HOME" 2>/dev/null && pwd -P) || exit 0; ' +
  `P="$H/$1${SECRET_FILE_PART_SUFFIX}"; [ -f "$P" ] && [ ! -L "$P" ] || exit 0; ` +
  `if secret_target "$1"; then ${FINISH_PART}; else rm -f "$P"; fi; exit 0`;

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/**
 * The files worth writing out of what the store holds: a path that no longer validates (a rule
 * tightened since it was saved) is left out, and said so in the outcomes the caller logs.
 */
export const planSecretFiles = (
  files: ReadonlyArray<SecretFileToWrite>,
): {
  readonly files: ReadonlyArray<SecretFileToWrite>;
  readonly refused: ReadonlyArray<SecretFileOutcome>;
} => {
  const kept: Array<SecretFileToWrite> = [];
  const refused: Array<SecretFileOutcome> = [];
  for (const file of files) {
    const issue = validateSecretFilePath(file.path);
    if (issue === null) kept.push(file);
    else refused.push({ path: file.path, outcome: "refused", reason: issue });
  }
  return { files: kept, refused };
};

/**
 * The execs that write `files` under the workspace user's home, in order. Each argv stays under
 * `WORKSPACE_EXEC_ARG_CHARS` of base64 plus the paths. Read each exec's stdout with
 * `parseSecretFileOutcomes`; an exec never exits non-zero over one file's refusal.
 */
export const secretFilesExecs = (
  files: ReadonlyArray<SecretFileToWrite>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const execs: Array<ReadonlyArray<string>> = [];
  let batch: Array<string> = [];
  let batchChars = 0;
  const flush = () => {
    if (batch.length === 0) return;
    execs.push(["sh", "-c", SMALL_FILES_SCRIPT, "mend-secret-files", ...batch]);
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
      execs.push(["sh", "-c", script, "mend-secret-files", file.path, chunk]);
    }
    execs.push(["sh", "-c", FINISH_SCRIPT, "mend-secret-files", file.path, ""]);
  }
  flush();
  return execs;
};

/** What one exec did with one file. */
export interface SecretFileOutcome {
  /** The HOME-relative path, as given. */
  readonly path: string;
  readonly outcome: "written" | "refused";
  /** Why, for a refusal. */
  readonly reason?: string;
}

/** The `written` and `refused` lines the execs printed. */
export const parseSecretFileOutcomes = (stdout: string): ReadonlyArray<SecretFileOutcome> =>
  stdout.split("\n").flatMap((line): ReadonlyArray<SecretFileOutcome> => {
    if (line.startsWith("written ")) return [{ path: line.slice(8), outcome: "written" }];
    if (line.startsWith("refused ")) {
      const at = line.indexOf(" · ");
      return at === -1
        ? [{ path: line.slice(8), outcome: "refused", reason: "refused" }]
        : [{ path: line.slice(8, at), outcome: "refused", reason: line.slice(at + 3) }];
    }
    return [];
  });
