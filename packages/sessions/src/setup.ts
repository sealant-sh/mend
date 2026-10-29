import { createHash } from "node:crypto";

export interface SetupInputRead {
  readonly path: string;
  readonly bytes: Uint8Array | null;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * A missing input hashes as `absent`, never a hex digest, so it differs from a file that reads
 * "absent".
 */
export const setupFingerprint = (input: {
  readonly run: ReadonlyArray<string>;
  readonly inputs: ReadonlyArray<SetupInputRead>;
  readonly platform: string | null;
}): string => {
  const hash = createHash("sha256");
  hash.update("mend-setup/v1\0");
  hash.update(JSON.stringify(input.run));
  for (const { path, bytes } of input.inputs) {
    hash.update(`${path}\0${bytes === null ? "absent" : sha256(bytes)}\0`);
  }
  if (input.platform !== null) hash.update(`platform\0${input.platform}\0`);
  return hash.digest("hex");
};

export type SetupSite =
  | { readonly _tag: "Host"; readonly path: string }
  | { readonly _tag: "Executor"; readonly workspaceId: string };

export const setupSiteKey = (site: SetupSite): string =>
  site._tag === "Host" ? `host:${site.path}` : `executor:${site.workspaceId}`;

export const SETUP_LEASE_MS = 60_000;
export const SETUP_RENEW_MS = 20_000;
export const SETUP_BUSY_POLL_MS = 1_000;
export const SETUP_OUTPUT_TAIL_BYTES = 4096;

export const outputTailOf = (stdout: string, stderr: string): string => {
  const both = Buffer.from(`${stdout}${stdout !== "" && stderr !== "" ? "\n" : ""}${stderr}`);
  if (both.length <= SETUP_OUTPUT_TAIL_BYTES) return both.toString("utf8");
  const tail = both.subarray(both.length - SETUP_OUTPUT_TAIL_BYTES).toString("utf8");
  const line = tail.indexOf("\n");
  return line >= 0 ? tail.slice(line + 1) : tail;
};

export const SETUP_RUN_ENV = "MEND_SETUP_RUN";

export const setupStepArgv = (runId: string, step: string): ReadonlyArray<string> => [
  "sh",
  "-c",
  `export ${SETUP_RUN_ENV}="$1"; exec sh -lc "$2"`,
  "mend-setup",
  runId,
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
