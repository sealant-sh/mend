/**
 * Files Mend places into a live workspace that mounts nothing (capture mode, ADR-0002): a pasted
 * image, the owner's skills, their agent memory, carried conversations, the pi profile. The SDK's
 * `exec` takes argv only (no stdin, no file write; PLATFORM-FEEDBACK.md, "A file into a
 * workspace"), and Core stores every exec's argv in plaintext for good. So the engine writes them
 * with `writeFilesPickupExec`: one exec carrying a pickup ticket and the paths, whose `node`
 * redeems the bytes over the session channel (`pickup-tickets.ts`). Every launch already runs
 * `node` there (the helper install, the skills plan).
 *
 * Paths are absolute workspace paths chosen by Mend (never user input) and ride as positional
 * parameters: nothing is interpolated into the script.
 */

import { Schema } from "effect";

import {
  SCRIPT_CONTAINED_PUT_FUNCTION,
  SCRIPT_PICKUP_FUNCTION,
  SCRIPT_PINNED_PUT_FUNCTION,
  SCRIPT_TRANSPORT_PRELUDE,
} from "./script-transport.ts";

/** `value` as one single-quoted `sh` word, whatever it holds. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Base64 characters per argument: a multiple of 4, so every chunk decodes alone, under ~96 KB. */
export const WORKSPACE_EXEC_ARG_CHARS = 90_000;

export class WorkspaceFileError extends Schema.TaggedError<WorkspaceFileError>()(
  "WorkspaceFileError",
  { path: Schema.String, message: Schema.String },
) {}

export interface WorkspaceFile {
  /** Absolute path inside the workspace. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/**
 * The pickup writer (`pickup-tickets.ts`): writes files whose bytes must
 * never ride argv, because the platform keeps every exec's argv for good. Arguments: a single-use
 * ticket, then each absolute path behind one letter: `P` a plain file, written as `put` does
 * (0644, its directories made 0755), or `S` a file that holds someone's keys, written 0600 by
 * `pinnedPut`, in a directory made 0700 that must be physically where its name says, never
 * through a link, `Q` a file of someone's own saved state, written 0600 in directories made 0700,
 * changing no directory already there, or `A` such a file written only where nothing is (no file,
 * no link): staged, then linked into place, which refuses to replace anything; `present <path>` is
 * printed for one left as it was. `C<directory mode>:<file mode>:<root>` followed by the path is a
 * file kept inside `root` (`containedPut`). It redeems the ticket once over the session channel; a
 * path the answer lacks, or any refusal, fails the exec with a reason that names paths only, never a
 * byte of a file.
 */
const WRITE_PICKUP_PROGRAM =
  SCRIPT_TRANSPORT_PRELUDE +
  SCRIPT_PICKUP_FUNCTION +
  SCRIPT_PINNED_PUT_FUNCTION +
  SCRIPT_CONTAINED_PUT_FUNCTION +
  [
    'const path=require("path"),crypto=require("crypto");',
    "const [ticket,...marked]=process.argv.slice(1);const targets=[];",
    'for(let k=0;k<marked.length;k++){const m=marked[k];if(m[0]==="C"){const [dm,fm,...r]=m.slice(1).split(":");',
    'targets.push({within:{root:r.join(":"),dirMode:parseInt(dm,8),fileMode:parseInt(fm,8)},path:marked[++k]??""});continue;}',
    'targets.push({secret:m[0]==="S",private:m[0]==="Q",absent:m[0]==="A",path:m.slice(1)});}',
    'const fail=(why)=>{process.stderr.write("mend-write: "+why+"\\n");process.exit(3);};',
    "const put=(p,b)=>{const d=path.dirname(p);fs.mkdirSync(d,{recursive:true});",
    'fs.chmodSync(d,0o755);const t=path.join(d,".mend-part-"+crypto.randomBytes(8).toString("hex"));',
    'fs.writeFileSync(t,b,{flag:"wx",mode:0o600});fs.chmodSync(t,0o644);fs.renameSync(t,p);};',
    "const putSecret=(p,b)=>{const d=path.dirname(p);fs.mkdirSync(d,{recursive:true,mode:0o700});",
    'const n=path.basename(p);const why=pinnedPut(d,n,".mend-part-"+crypto.randomBytes(8).toString("hex"),b);',
    "if(why!==null)throw new Error(why);};",
    "const putPrivate=(p,b)=>{const d=path.dirname(p);fs.mkdirSync(d,{recursive:true,mode:0o700});",
    'const t=path.join(d,".mend-part-"+crypto.randomBytes(8).toString("hex"));',
    'fs.writeFileSync(t,b,{flag:"wx",mode:0o600});fs.chmodSync(t,0o600);fs.renameSync(t,p);};',
    "const putAbsent=(p,b)=>{const d=path.dirname(p);fs.mkdirSync(d,{recursive:true,mode:0o700});",
    'const t=path.join(d,".mend-part-"+crypto.randomBytes(8).toString("hex"));fs.writeFileSync(t,b,{flag:"wx",mode:0o600});fs.chmodSync(t,0o600);',
    'try{fs.linkSync(t,p);}catch(e){if(e.code!=="EEXIST")throw e;process.stdout.write("present "+p+"\\n");}finally{fs.rmSync(t,{force:true});}};',
    "redeemPickup(ticket,(reason,files)=>{if(reason!==null)return fail(reason);",
    'const missing=targets.filter((t)=>!files.has(t.path)).map((t)=>t.path);if(missing.length>0)return fail("not in the pickup: "+missing.join(", "));',
    "const putWithin=(w,p,b)=>{const why=containedPut(w.root,w.dirMode,w.fileMode,p,b);if(why!==null)throw new Error(why);};",
    "for(const t of targets){try{if(t.within)putWithin(t.within,t.path,files.get(t.path));",
    "else (t.secret?putSecret:t.private?putPrivate:t.absent?putAbsent:put)(t.path,files.get(t.path));}",
    'catch(e){return fail("not written: "+t.path+" ("+(e&&e.code?e.code:e&&e.message?e.message:"error")+")");}}});',
  ].join("");

/**
 * One file the pickup writer puts in place: `secret` for one that holds someone's keys, `private`
 * for one of a person's own saved state (docs/adr/0016, decision 2), `absent` for such a file
 * written only where nothing is.
 */
export interface PickupTarget {
  readonly path: string;
  readonly secret?: boolean;
  readonly private?: boolean;
  readonly absent?: boolean;
  /** Kept inside a directory, through no link (`containedPut`); wins over the other marks. */
  readonly within?: ContainedPlacement;
}

/**
 * A file that must land physically inside `root` (a pasted image, mend#597 review finding 2):
 * every directory below `root` is entered through no link, one missing is made `directoryMode`
 * (and only one this write made: a directory already there keeps its mode), and the file is
 * written `fileMode`, through no link.
 */
export interface ContainedPlacement {
  /** An absolute directory; the file's path must be below it. */
  readonly root: string;
  readonly directoryMode: number;
  readonly fileMode: number;
}

/**
 * The one exec that writes `targets` into a workspace with bytes it redeems through `ticket` over
 * the session channel (`pickup-tickets.ts`): only the ticket and the paths ride argv, whatever the
 * files hold or weigh. Exits non-zero, naming paths only, when any file is not written.
 */
export const writeFilesPickupExec = (
  targets: ReadonlyArray<PickupTarget>,
  ticket: string,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  `exec node -e ${shellQuote(WRITE_PICKUP_PROGRAM)} -- "$@"`,
  "mend-write",
  ticket,
  ...targets.flatMap((target) =>
    target.within !== undefined
      ? [
          `C${target.within.directoryMode.toString(8)}:${target.within.fileMode.toString(8)}:${target.within.root}`,
          target.path,
        ]
      : [
          `${target.secret === true ? "S" : target.private === true ? "Q" : target.absent === true ? "A" : "P"}${target.path}`,
        ],
  ),
];

/**
 * Writes each (path under `$HOME`, base64) pair only when nothing is at that path yet — no file,
 * no directory, no symlink (a dangling one included) — and prints `written <path>` or
 * `present <path>` per pair. `set -C` makes the redirect refuse an existing file, so even a file
 * that appears between the test and the write is never overwritten. An existing directory keeps
 * its mode.
 */
const ABSENT_HOME_FILES_SCRIPT =
  'set -eC; while [ "$#" -gt 1 ]; do target="$HOME/$1"; ' +
  'if [ -e "$target" ] || [ -L "$target" ]; then printf \'present %s\\n\' "$1"; ' +
  'else mkdir -p "$(dirname "$target")"; printf \'%s\' "$2" | base64 -d > "$target"; ' +
  'chmod 644 "$target"; printf \'written %s\\n\' "$1"; fi; shift 2; done';

/** What `writeAbsentHomeFilesExecs` did with one file. */
export interface HomeFileOutcome {
  /** The path under `$HOME`, as given. */
  readonly path: string;
  readonly outcome: "written" | "present";
}

/**
 * The execs that write `files` under the workspace user's `$HOME` without replacing anything:
 * each `path` is relative to `$HOME`, and a path that already holds something is left alone and
 * reported `present`. For small files: each file rides one argument, batched under
 * `WORKSPACE_EXEC_ARG_CHARS`. Read each exec's stdout with `parseHomeFileOutcomes`.
 */
export const writeAbsentHomeFilesExecs = (
  files: ReadonlyArray<WorkspaceFile>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const execs: Array<ReadonlyArray<string>> = [];
  let batch: Array<string> = [];
  let batchChars = 0;
  for (const file of files) {
    const encoded = toBase64(file.bytes);
    if (batch.length > 0 && batchChars + encoded.length > WORKSPACE_EXEC_ARG_CHARS) {
      execs.push(["sh", "-c", ABSENT_HOME_FILES_SCRIPT, "mend-write-absent", ...batch]);
      batch = [];
      batchChars = 0;
    }
    batch.push(file.path, encoded);
    batchChars += encoded.length + file.path.length;
  }
  if (batch.length > 0) {
    execs.push(["sh", "-c", ABSENT_HOME_FILES_SCRIPT, "mend-write-absent", ...batch]);
  }
  return execs;
};

/** The `written` / `present` lines one `writeAbsentHomeFilesExecs` exec printed. */
export const parseHomeFileOutcomes = (stdout: string): ReadonlyArray<HomeFileOutcome> =>
  stdout.split("\n").flatMap((line): ReadonlyArray<HomeFileOutcome> => {
    if (line.startsWith("written ")) return [{ path: line.slice(8), outcome: "written" }];
    if (line.startsWith("present ")) return [{ path: line.slice(8), outcome: "present" }];
    return [];
  });
