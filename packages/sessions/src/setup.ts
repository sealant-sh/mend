import { createHash } from "node:crypto";

import { PLATFORM_PROBE_SCRIPT, platformKeyOf } from "./dependency-cache.ts";

/** An input as the fingerprint takes it: the sha256 of its bytes, or null when there is none. */
export interface SetupInputDigest {
  readonly path: string;
  readonly digest: string | null;
}

export const sha256Hex = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * A missing input hashes as `absent`, never a hex digest, so it differs from a file that reads
 * "absent". `platform` is an executor's, whose copy may come from a capture made elsewhere;
 * `image` is the workspace image the steps run in, so a new runtime runs them again.
 */
export const setupFingerprint = (input: {
  readonly run: ReadonlyArray<string>;
  readonly inputs: ReadonlyArray<SetupInputDigest>;
  readonly platform: string | null;
  readonly image: string | null;
}): string => {
  const hash = createHash("sha256");
  hash.update("mend-setup/v1\0");
  hash.update(JSON.stringify(input.run));
  for (const { path, digest } of input.inputs) {
    hash.update(`${path}\0${digest ?? "absent"}\0`);
  }
  if (input.platform !== null) hash.update(`platform\0${input.platform}\0`);
  if (input.image !== null) hash.update(`image\0${input.image}\0`);
  return hash.digest("hex");
};

/**
 * Where setup's result lives: a co-located worktree's directory, which outlives its workspaces,
 * or one executor's own copy (ADR 0017, decision 4).
 */
export type SetupSite =
  | { readonly _tag: "Host"; readonly worktreeId: string }
  | { readonly _tag: "Executor"; readonly workspaceId: string };

export const setupSiteKey = (site: SetupSite): string =>
  site._tag === "Host" ? `host:${site.worktreeId}` : `executor:${site.workspaceId}`;

export const SETUP_LEASE_MS = 60_000;
export const SETUP_RENEW_MS = 20_000;
export const SETUP_BUSY_POLL_MS = 1_000;
export const SETUP_OUTPUT_TAIL_BYTES = 4096;
/** The longest a workspace exec is waited for (`exec_timeout` in the SDK): one setup step's limit. */
export const SETUP_STEP_LIMIT_MINUTES = 30;

/** The last few KiB of a step's output, from a line's start. */
export const outputTailOf = (output: string): string => {
  const bytes = Buffer.from(output);
  if (bytes.length <= SETUP_OUTPUT_TAIL_BYTES) return output;
  const tail = bytes.subarray(bytes.length - SETUP_OUTPUT_TAIL_BYTES).toString("utf8");
  const line = tail.indexOf("\n");
  return line >= 0 ? tail.slice(line + 1) : tail;
};

export const SETUP_RUN_ENV = "MEND_SETUP_RUN";

/**
 * One step as an exec: in `env` (the person's, as their Service gets it) and marked with the run,
 * its two streams in one so the tail reads in the order the step wrote it.
 */
export const setupStepArgv = (
  runId: string,
  step: string,
  env: Readonly<Record<string, string>>,
): ReadonlyArray<string> => [
  "env",
  `${SETUP_RUN_ENV}=${runId}`,
  ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
  "sh",
  "-c",
  'exec sh -lc "$1" 2>&1',
  "mend-setup",
  step,
];

/** Exec has no cancel, so this finds a run's processes by the marker their environment carries. */
export const setupStopArgv = (runId: string): ReadonlyArray<string> => [
  "sh",
  "-c",
  [
    "signal() {",
    "  for dir in /proc/[0-9]*; do",
    `    if tr '\\0' '\\n' < "$dir/environ" 2>/dev/null | grep -qxF "${SETUP_RUN_ENV}=$1"; then`,
    '      kill -s "$2" "${dir#/proc/}" 2>/dev/null',
    "    fi",
    "  done",
    "}",
    'signal "$1" TERM',
    "sleep 2",
    'signal "$1" KILL',
    "exit 0",
  ].join("\n"),
  "mend-setup-stop",
  runId,
];

const INPUTS_MARK = "--mend-setup-inputs--";

/**
 * Setup's inputs read in a workspace, as the person setup runs as: the platform, then a line per
 * input with its digest. Only a regular file that resolves inside the repository is read, and only
 * its digest leaves the workspace, never its bytes. The path is checked once to word a refusal,
 * then the file is opened and the open file itself is checked through `/proc/self/fd`, because an
 * agent can swap the path for a link out between the first check and the read.
 */
export const setupInputsArgv = (
  repository: string,
  inputs: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  [
    PLATFORM_PROBE_SCRIPT,
    `echo ${INPUTS_MARK}`,
    'cd "$1" || exit 45',
    "root=$(pwd -P)",
    "shift",
    "for input do",
    '  if [ ! -e "./$input" ]; then echo absent; continue; fi',
    '  real=$(realpath "./$input" 2>/dev/null) || { echo "refused does not resolve"; continue; }',
    '  case "$real" in "$root"/*) ;; *) echo "refused resolves outside the repository"; continue ;; esac',
    '  if [ -d "$real" ]; then echo "refused is a directory; name a file"; continue; fi',
    '  if [ ! -f "$real" ]; then echo "refused is not a regular file"; continue; fi',
    '  exec 3< "./$input" 2>/dev/null || { echo "refused could not be read"; continue; }',
    '  opened=$(readlink /proc/self/fd/3 2>/dev/null) || { exec 3<&-; echo "refused could not be read"; continue; }',
    '  case "$opened" in "$root"/*) ;; *) exec 3<&-; echo "refused resolves outside the repository"; continue ;; esac',
    '  if [ ! -f /proc/self/fd/3 ]; then exec 3<&-; echo "refused is not a regular file"; continue; fi',
    '  sum=$(sha256sum <&3) || { exec 3<&-; echo "refused could not be read"; continue; }',
    "  exec 3<&-",
    '  echo "sha256 ${sum%% *}"',
    "done",
  ].join("\n"),
  "mend-setup-inputs",
  repository,
  ...inputs,
];

export type SetupInputsRead =
  | {
      readonly _tag: "Read";
      readonly platform: string | null;
      readonly inputs: ReadonlyArray<SetupInputDigest>;
    }
  | { readonly _tag: "Refused"; readonly path: string; readonly reason: string }
  | { readonly _tag: "Unreadable"; readonly reason: string };

const SHA256_LINE = /^sha256 ([0-9a-f]{64})$/u;

export const parseSetupInputs = (
  stdout: string,
  inputs: ReadonlyArray<string>,
): SetupInputsRead => {
  const lines = stdout.split("\n");
  const mark = lines.indexOf(INPUTS_MARK);
  if (mark === -1) return { _tag: "Unreadable", reason: "the workspace printed no digests" };
  const answers = lines.slice(mark + 1);
  const digests: SetupInputDigest[] = [];
  for (const [index, path] of inputs.entries()) {
    const line = answers[index] ?? "";
    if (line === "absent") {
      digests.push({ path, digest: null });
      continue;
    }
    if (line.startsWith("refused ")) {
      return { _tag: "Refused", path, reason: line.slice("refused ".length) };
    }
    const digest = SHA256_LINE.exec(line)?.[1];
    if (digest === undefined) {
      return { _tag: "Unreadable", reason: `no digest for ${path}` };
    }
    digests.push({ path, digest });
  }
  return {
    _tag: "Read",
    platform: platformKeyOf(lines.slice(0, mark).join("\n")) ?? "unknown",
    inputs: digests,
  };
};
