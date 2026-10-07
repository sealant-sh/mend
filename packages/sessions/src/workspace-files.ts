/**
 * Files Mend places into a live workspace that mounts nothing (capture mode, ADR-0002): a pasted
 * image, the owner's skills, their agent memory, carried conversations, the pi profile. The SDK's
 * `exec` takes argv only (no stdin, no file write; PLATFORM-FEEDBACK.md, "A file into a
 * workspace"), and Core stores every exec's argv in plaintext for good. So the engine writes them
 * with `writeFilesPickupExec`: one exec carrying a pickup ticket and the paths, whose `node`
 * redeems the bytes over the session channel (`pickup-tickets.ts`). Every launch already runs
 * `node` there (the helper install, the skills plan).
 *
 * `writeFilesExecs` is the argv writer it replaced: the bytes gzipped and base64-encoded into the
 * arguments, as few execs as the argument limits allow (a 1.9 MB skills library took 103 execs,
 * 55 s, on the box, 2026-10-03). One argument stays under `WORKSPACE_EXEC_ARG_CHARS`, one exec's
 * arguments under `WORKSPACE_EXEC_BATCH_CHARS`, an identical content travels once, and a content
 * too large for one exec is staged across several. Nothing in the engine uses it now.
 *
 * Paths are absolute workspace paths chosen by Mend (never user input) and ride as positional
 * parameters: nothing is interpolated into the script.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

import { Schema } from "effect";

import {
  SCRIPT_PICKUP_FUNCTION,
  SCRIPT_PINNED_PUT_FUNCTION,
  SCRIPT_TRANSPORT_PRELUDE,
} from "./script-transport.ts";

/** `value` as one single-quoted `sh` word, whatever it holds. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Base64 characters per argument: a multiple of 4, so every chunk decodes alone, under ~96 KB. */
export const WORKSPACE_EXEC_ARG_CHARS = 90_000;

/** Characters per exec, every argument together: half the 2 MiB argv limit. */
export const WORKSPACE_EXEC_BATCH_CHARS = 1_000_000;

export class WorkspaceFileError extends Schema.TaggedErrorClass<WorkspaceFileError>()(
  "WorkspaceFileError",
  { path: Schema.String, message: Schema.String },
) {}

export interface WorkspaceFile {
  /** Absolute path inside the workspace. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * The writer: a sequence of operations over its arguments.
 * - `w <n> <path>… <k> <chunk>…`: the gzipped base64 in the k chunks, written to each of the n
 *   paths;
 * - `s <staging> <k> <chunk>…`, `a <staging> <k> <chunk>…`: create (exclusively) or append the
 *   staging file of a content too large for one exec;
 * - `f <staging> <n> <path>…`: the staged content written to each path; the staging file removed.
 * Each path's directory is made and set 0755; the file is written beside it under a name of its
 * own, created exclusively (never a payload's name, never one already there), set 0644 and renamed
 * into place. Once every operation ran, each path it wrote must be a file, or the exec fails.
 */
const WRITE_PROGRAM = [
  'const fs=require("fs"),path=require("path"),zlib=require("zlib"),crypto=require("crypto");',
  "const a=process.argv.slice(1);let i=0;const done=[];",
  "const list=()=>{const n=Number(a[i++]);const out=a.slice(i,i+n);i+=n;return out;};",
  'const bytes=(text)=>zlib.gunzipSync(Buffer.from(text,"base64"));',
  "const put=(p,b)=>{const d=path.dirname(p);fs.mkdirSync(d,{recursive:true});",
  'fs.chmodSync(d,0o755);const t=path.join(d,".mend-part-"+crypto.randomBytes(8).toString("hex"));',
  'fs.writeFileSync(t,b,{flag:"wx",mode:0o600});fs.chmodSync(t,0o644);fs.renameSync(t,p);done.push(p);};',
  "while(i<a.length){const op=a[i++];",
  'if(op==="w"){const ps=list();const b=bytes(list().join(""));for(const p of ps)put(p,b);}',
  'else if(op==="s"||op==="a"){const t=a[i++];const text=list().join("");',
  "fs.mkdirSync(path.dirname(t),{recursive:true});",
  'if(op==="s")fs.writeFileSync(t,text,{flag:"wx",mode:0o600});else fs.appendFileSync(t,text);}',
  'else if(op==="f"){const t=a[i++];const ps=list();const b=bytes(fs.readFileSync(t,"utf8"));',
  "for(const p of ps)put(p,b);fs.rmSync(t,{force:true});}",
  'else{process.stderr.write("mend-write: unknown operation "+op+"\\n");process.exit(2);}}',
  "const missing=done.filter((p)=>{try{return !fs.statSync(p).isFile();}catch{return true;}});",
  'if(missing.length>0){process.stderr.write("mend-write: not written: "+missing.join(", ")+"\\n");process.exit(3);}',
].join("");

/** `$0` names the exec in the record; `--` keeps node from reading an argument as its option. */
const WRITE_SCRIPT = `exec node -e ${shellQuote(WRITE_PROGRAM)} -- "$@"`;

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/** One content and every path it goes to. */
interface Content {
  readonly paths: Array<string>;
  readonly bytes: Uint8Array;
}

/**
 * `files` as contents: a path given twice keeps its last bytes, as writing them one after another
 * would, and identical bytes merge, in the order each content first appears.
 */
const contentsOf = (files: ReadonlyArray<WorkspaceFile>): ReadonlyArray<Content> => {
  const latest = new Map<string, Uint8Array>();
  for (const file of files) latest.set(file.path, file.bytes);
  const byBytes = new Map<string, Content>();
  for (const [filePath, bytes] of latest) {
    const key = toBase64(bytes);
    const known = byBytes.get(key);
    if (known === undefined) byBytes.set(key, { paths: [filePath], bytes });
    else known.paths.push(filePath);
  }
  return [...byBytes.values()];
};

/** `text` in arguments of `WORKSPACE_EXEC_ARG_CHARS` at most; an empty text is one argument. */
const chunksOf = (text: string): ReadonlyArray<string> => {
  if (text.length === 0) return [""];
  const chunks: Array<string> = [];
  for (let offset = 0; offset < text.length; offset += WORKSPACE_EXEC_ARG_CHARS) {
    chunks.push(text.slice(offset, offset + WORKSPACE_EXEC_ARG_CHARS));
  }
  return chunks;
};

const charsOf = (args: ReadonlyArray<string>) => args.reduce((sum, arg) => sum + arg.length, 0);

/**
 * The execs that write `files` into a workspace, in order. No argument passes
 * `WORKSPACE_EXEC_ARG_CHARS`, and one exec's arguments together pass `WORKSPACE_EXEC_BATCH_CHARS`
 * by its paths at most; running them all, each exiting 0, leaves every file complete.
 */
export const writeFilesExecs = (
  files: ReadonlyArray<WorkspaceFile>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const execs: Array<ReadonlyArray<string>> = [];
  let ops: Array<string> = [];
  const flush = () => {
    if (ops.length === 0) return;
    execs.push(["sh", "-c", WRITE_SCRIPT, "mend-write", ...ops]);
    ops = [];
  };
  const perExec = Math.floor(WORKSPACE_EXEC_BATCH_CHARS / WORKSPACE_EXEC_ARG_CHARS);
  for (const content of contentsOf(files)) {
    const chunks = chunksOf(gzipSync(content.bytes, { level: 9 }).toString("base64"));
    const paths = [String(content.paths.length), ...content.paths];
    if (chunks.length <= perExec) {
      if (charsOf(ops) + charsOf(chunks) > WORKSPACE_EXEC_BATCH_CHARS) flush();
      ops.push("w", ...paths, String(chunks.length), ...chunks);
      continue;
    }
    // Too large for one exec: staged beside the first path across several, under a name of its
    // own, and written by the last of them.
    flush();
    const staging = path.posix.join(
      path.posix.dirname(content.paths[0] ?? "/"),
      `.mend-stage-${randomBytes(12).toString("hex")}`,
    );
    for (let index = 0; index < chunks.length; index += perExec) {
      flush();
      const part = chunks.slice(index, index + perExec);
      ops.push(index === 0 ? "s" : "a", staging, String(part.length), ...part);
    }
    ops.push("f", staging, ...paths);
  }
  flush();
  return execs;
};

/**
 * The pickup writer (`pickup-tickets.ts`): the same writes as `WRITE_PROGRAM`, for bytes that must
 * never ride argv, because the platform keeps every exec's argv for good. Arguments: a single-use
 * ticket, then each absolute path behind one letter: `P` a plain file, written as `put` does
 * (0644, its directories made 0755), or `S` a file that holds someone's keys, written 0600 by
 * `pinnedPut`, in a directory made 0700 that must be physically where its name says, never
 * through a link, `Q` a file of someone's own saved state, written 0600 in directories made 0700,
 * changing no directory already there, or `A` such a file written only where nothing is (no file,
 * no link): staged, then linked into place, which refuses to replace anything; `present <path>` is
 * printed for one left as it was. It redeems the ticket once over the session channel; a path the
 * answer lacks,
 * or any refusal, fails the exec with a reason that names paths only, never a byte of a file.
 */
const WRITE_PICKUP_PROGRAM =
  SCRIPT_TRANSPORT_PRELUDE +
  SCRIPT_PICKUP_FUNCTION +
  SCRIPT_PINNED_PUT_FUNCTION +
  [
    'const path=require("path"),crypto=require("crypto");',
    "const [ticket,...marked]=process.argv.slice(1);",
    'const targets=marked.map((m)=>({secret:m[0]==="S",private:m[0]==="Q",absent:m[0]==="A",path:m.slice(1)}));',
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
    "for(const t of targets){try{(t.secret?putSecret:t.private?putPrivate:t.absent?putAbsent:put)(t.path,files.get(t.path));}",
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
  ...targets.map(
    (target) =>
      `${target.secret === true ? "S" : target.private === true ? "Q" : target.absent === true ? "A" : "P"}${target.path}`,
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
