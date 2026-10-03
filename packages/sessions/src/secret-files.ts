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
 * `<target>.mend-secret-part-<stamp>`, the stamp one delivery's own, and renamed into place, so a
 * reader never sees half a file and two deliveries into one home never share a staging file. The
 * proof is repeated before every chunk and the rename (Astra review, 2026-10-03: a planted staging
 * file under a symlinked directory took later chunks).
 *
 * What a delivery wrote is recorded at `~/.mend/secret-files`, one path per line, so the next
 * delivery into the same home removes a file the person no longer keeps.
 *
 * Outcomes are one line per file on stdout, tab-separated: `written\t<path>`,
 * `refused\t<path>\t<reason>`, `removed\t<path>`, `kept\t<path>`. A tab cannot be in a path.
 */

/** Prefix of the staging file beside each target; the delivery's stamp follows it. */
export const SECRET_FILE_PART_PREFIX = ".mend-secret-part-";

/** Where a home records the secret files Mend delivered into it, relative to `$HOME`. */
export const SECRET_FILES_DELIVERED = ".mend/secret-files";

/** A secret file ready to write: its HOME-relative path and its bytes. */
export interface SecretFileToWrite {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** A delivery's stamp: lowercase hex or digits only, so it is safe inside a script. */
const stampOf = (stamp: string): string => {
  if (!/^[a-f0-9]{4,32}$/.test(stamp)) throw new Error(`secret files: not a stamp: ${stamp}`);
  return stamp;
};

/**
 * `secret_path <home-relative path>`: sets `H` to the physical home and `T` to the file's absolute
 * path under it, after proving no component on the way is a symlink and nothing but a regular file
 * (or nothing) is at the end. Prints `refused\t<path>\t<reason>` and returns 1 otherwise.
 */
const PATH_FUNCTION =
  "secret_path() { sp_rel=$1; " +
  `H=$(cd "$HOME" 2>/dev/null && pwd -P) || { printf 'refused\\t%s\\tno home directory\\n' "$sp_rel"; return 1; }; ` +
  `case "$H" in /workspace|/workspace/*) printf 'refused\\t%s\\tthe home directory is inside the workspace\\n' "$sp_rel"; return 1;; esac; ` +
  'T="$H/$sp_rel"; sp_walk=$H; sp_rest=$sp_rel; ' +
  'while :; do case "$sp_rest" in ' +
  '*/*) sp_seg=${sp_rest%%/*}; sp_rest=${sp_rest#*/}; sp_walk="$sp_walk/$sp_seg"; ' +
  `if [ -L "$sp_walk" ]; then printf 'refused\\t%s\\t%s is a symlink\\n' "$sp_rel" "\${sp_walk#"$H"/}"; return 1; fi;; ` +
  "*) break;; esac; done; " +
  `if [ -L "$T" ]; then printf 'refused\\t%s\\ta symlink is at that path\\n' "$sp_rel"; return 1; fi; ` +
  `if [ -e "$T" ] && [ ! -f "$T" ]; then printf 'refused\\t%s\\tnot a regular file\\n' "$sp_rel"; return 1; fi; ` +
  "return 0; }; ";

/**
 * `secret_target <home-relative path>`: `secret_path`, then the file's directory `D` made 0700
 * where missing and proven to be physically where its name says.
 */
const TARGET_FUNCTION =
  PATH_FUNCTION +
  'secret_target() { secret_path "$1" || return 1; D=${T%/*}; ' +
  `(umask 077; mkdir -p "$D") || { printf 'refused\\t%s\\tcould not make its directory\\n' "$1"; return 1; }; ` +
  `st_phys=$(cd "$D" && pwd -P) || { printf 'refused\\t%s\\tcould not enter its directory\\n' "$1"; return 1; }; ` +
  `if [ "$st_phys" != "$D" ]; then printf 'refused\\t%s\\tits directory is really %s\\n' "$1" "$st_phys"; return 1; fi; ` +
  "return 0; }; ";

/** The staging path for `$T` under this delivery's stamp, in `P`. */
const partOf = (stamp: string) => `P="$T${SECRET_FILE_PART_PREFIX}${stampOf(stamp)}"; `;

/**
 * Decode `$2` (base64) into a fresh staging file `P`, 0600; on failure, remove it and say so.
 * Whatever sits at the staging path first goes: `rm -f` removes a link, never what it points at.
 */
const START_PART =
  'rm -f "$P"; printf \'%s\' "$2" | (umask 077; base64 -d > "$P") || ' +
  `{ rm -f "$P"; printf 'refused\\t%s\\tcould not write\\n' "$1"; false; }`;

/** Rename the staging file `P` into place as `$T`, 0600, or remove it and say so. */
const FINISH_PART =
  `{ chmod 600 "$P" && mv -f "$P" "$T" && printf 'written\\t%s\\n' "$1"; } || ` +
  `{ rm -f "$P"; printf 'refused\\t%s\\tcould not write\\n' "$1"; }`;

/** Small files, as (path, base64) pairs: each one checked, staged and renamed into place. */
const smallFilesScript = (stamp: string) =>
  TARGET_FUNCTION +
  `while [ "$#" -gt 1 ]; do if secret_target "$1"; then ${partOf(stamp)}${START_PART} && ${FINISH_PART}; fi; ` +
  "shift 2; done; exit 0";

/** `$1` the HOME-relative path, `$2` a base64 chunk: the first chunk starts the staging file. */
const firstChunkScript = (stamp: string) =>
  TARGET_FUNCTION + `if secret_target "$1"; then ${partOf(stamp)}${START_PART}; fi; exit 0`;

/**
 * The next chunk: the path proved again, quietly (the first chunk said why when it refused), and
 * appended only to this delivery's own staging file, a regular file (a refused first chunk made
 * none, and `>>` must not make one). Nothing is removed through a path that failed the proof: the
 * literal path may now lead into the worktree.
 */
const nextChunkScript = (stamp: string) =>
  TARGET_FUNCTION +
  `secret_target "$1" >/dev/null || exit 0; ` +
  `${partOf(stamp)}[ -f "$P" ] && [ ! -L "$P" ] || exit 0; ` +
  `printf '%s' "$2" | base64 -d >> "$P" || { rm -f "$P"; printf 'refused\\t%s\\tcould not write\\n' "$1"; }; exit 0`;

/**
 * The last step of a chunked file: the path proved once more, then the rename. A refusal here is
 * said, as the first chunk's was; the engine folds one file's repeated refusal into one.
 */
const finishScript = (stamp: string) =>
  TARGET_FUNCTION +
  `secret_target "$1" || exit 0; ` +
  `${partOf(stamp)}[ -f "$P" ] && [ ! -L "$P" ] || exit 0; ${FINISH_PART}; exit 0`;

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
 * The execs that write `files` under the workspace user's home, in order, under one delivery's
 * `stamp`. Each argv stays under `WORKSPACE_EXEC_ARG_CHARS` of base64 plus the paths. Read each
 * exec's stdout with `parseSecretFileOutcomes`; an exec never exits non-zero over one file's
 * refusal.
 */
export const secretFilesExecs = (
  files: ReadonlyArray<SecretFileToWrite>,
  stamp: string,
): ReadonlyArray<ReadonlyArray<string>> => {
  const execs: Array<ReadonlyArray<string>> = [];
  let batch: Array<string> = [];
  let batchChars = 0;
  const flush = () => {
    if (batch.length === 0) return;
    execs.push(["sh", "-c", smallFilesScript(stamp), "mend-secret-files", ...batch]);
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
      const script = offset === 0 ? firstChunkScript(stamp) : nextChunkScript(stamp);
      execs.push(["sh", "-c", script, "mend-secret-files", file.path, chunk]);
    }
    execs.push(["sh", "-c", finishScript(stamp), "mend-secret-files", file.path, ""]);
  }
  flush();
  return execs;
};

/**
 * The exec that removes this delivery's staging files for `paths`, after an exec failed or the
 * launch was interrupted part-way: nothing of a secret file stays in the home half-written. Each
 * path is proved first; a staging file whose directory became a link is left where it is rather
 * than removed through the link.
 */
export const secretFilesCleanupExec = (
  paths: ReadonlyArray<string>,
  stamp: string,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  PATH_FUNCTION +
    `for p; do secret_path "$p" >/dev/null || continue; ${partOf(stamp)}[ -L "$P" ] || rm -f "$P"; done; exit 0`,
  "mend-secret-files",
  ...paths,
];

/**
 * The exec that removes files an earlier delivery wrote and this one no longer carries. Each path
 * is proved a plain path in the home first, as a write is; a symlink, a directory or a missing
 * file is `kept`, never removed through a link.
 */
export const secretFilesRemoveExec = (paths: ReadonlyArray<string>): ReadonlyArray<string> => [
  "sh",
  "-c",
  PATH_FUNCTION +
    'for p; do if secret_path "$p" >/dev/null && [ -f "$T" ]; then ' +
    `rm -f "$T" && printf 'removed\\t%s\\n' "$p"; else printf 'kept\\t%s\\n' "$p"; fi; done; exit 0`,
  "mend-secret-files",
  ...paths,
];

/** The exec that prints the paths the home's record lists; a home without one prints nothing. */
export const secretFilesDeliveredExec: ReadonlyArray<string> = [
  "sh",
  "-c",
  `cat "$HOME/${SECRET_FILES_DELIVERED}" 2>/dev/null; exit 0`,
];

/**
 * The exec that records `paths` as delivered into this home (0600, in `~/.mend` made 0700), or
 * removes the record when there are none.
 */
export const secretFilesRecordExec = (paths: ReadonlyArray<string>): ReadonlyArray<string> => [
  "sh",
  "-c",
  `F="$HOME/${SECRET_FILES_DELIVERED}"; if [ "$#" -eq 0 ]; then rm -f "$F"; exit 0; fi; ` +
    '[ -L "$HOME/.mend" ] && exit 0; (umask 077; mkdir -p "$HOME/.mend" && [ ! -L "$F" ] && ' +
    'printf \'%s\\n\' "$@" > "$F"); exit 0',
  "mend-secret-files",
  ...paths,
];

/** The paths a record exec printed. */
export const parseSecretFilesDelivered = (stdout: string): ReadonlyArray<string> =>
  stdout.split("\n").filter((line) => line !== "" && validateSecretFilePath(line) === null);

/** What one exec did with one file. */
export interface SecretFileOutcome {
  /** The HOME-relative path, as given. */
  readonly path: string;
  readonly outcome: "written" | "refused" | "removed" | "kept";
  /** Why, for a refusal. */
  readonly reason?: string;
}

/**
 * One delivery's outcomes with each file's repeated refusal folded into one: a chunked file whose
 * first chunk and last step both refused for the same reason is one file not written.
 */
export const foldSecretFileOutcomes = (
  outcomes: ReadonlyArray<SecretFileOutcome>,
): ReadonlyArray<SecretFileOutcome> => {
  const seen = new Set<string>();
  return outcomes.filter((outcome) => {
    const key = `${outcome.outcome}\t${outcome.path}\t${outcome.reason ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The outcome lines the execs printed. */
export const parseSecretFileOutcomes = (stdout: string): ReadonlyArray<SecretFileOutcome> =>
  stdout.split("\n").flatMap((line): ReadonlyArray<SecretFileOutcome> => {
    const [kind, path, ...rest] = line.split("\t");
    if (path === undefined || path === "") return [];
    if (kind === "written" || kind === "removed" || kind === "kept") {
      return [{ path, outcome: kind }];
    }
    if (kind === "refused") {
      return [{ path, outcome: "refused", reason: rest.join("\t") || "refused" }];
    }
    return [];
  });
