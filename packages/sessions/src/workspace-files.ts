/**
 * Files Mend places into a live workspace that mounts nothing (capture mode, ADR-0002): a pasted
 * image, the owner's skills, their agent memory. The SDK's `exec` takes argv only — no stdin, no
 * file write (PLATFORM-FEEDBACK.md, "A file into a workspace") — so the bytes ride argv, gzipped
 * and base64-encoded, and a small `node` program inside writes them: every launch already runs
 * `node` there (the helper install, the skills plan).
 *
 * An exec is a round trip of half a second or more, and a launch waits on each one before its
 * agent starts: a 1.9 MB skills library took 103 execs, 55 s, on the box (2026-10-03). So files
 * share as few execs as the argument limits allow. One argument stays under
 * `WORKSPACE_EXEC_ARG_CHARS` (Linux refuses a single argument over 128 KiB); one exec's arguments
 * together stay under `WORKSPACE_EXEC_BATCH_CHARS` (argv and environment must fit in 2 MiB); and an
 * identical content (one skill in each harness's directory) travels once. A content too large for
 * one exec is staged across several and written by the last, so a reader never sees half an image.
 *
 * Paths are absolute workspace paths chosen by Mend (never user input) and ride as positional
 * parameters, like the bytes: nothing is interpolated into the script.
 */

import { gzipSync } from "node:zlib";

import { Schema } from "effect";

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
 * - `s <path> <k> <chunk>…`, `a <path> <k> <chunk>…`: start or append the staging file
 *   (`<path>.mend-gz64`) of a content too large for one exec;
 * - `f <n> <path>…`: the content staged beside the first path, written to each path; the staging
 *   file is removed.
 * Each path's directory is made and set 0755; the file is written beside it as `.mend-part`, set
 * 0644 and renamed into place.
 */
const WRITE_PROGRAM = [
  'const fs=require("fs"),path=require("path"),zlib=require("zlib");',
  "const a=process.argv.slice(1);let i=0;",
  "const list=()=>{const n=Number(a[i++]);const out=a.slice(i,i+n);i+=n;return out;};",
  'const bytes=(text)=>zlib.gunzipSync(Buffer.from(text,"base64"));',
  "const put=(p,b)=>{const d=path.dirname(p);fs.mkdirSync(d,{recursive:true});",
  'fs.chmodSync(d,0o755);const t=p+".mend-part";fs.writeFileSync(t,b);fs.chmodSync(t,0o644);',
  "fs.renameSync(t,p);};",
  'const staged=(p)=>p+".mend-gz64";',
  "while(i<a.length){const op=a[i++];",
  'if(op==="w"){const ps=list();const b=bytes(list().join(""));for(const p of ps)put(p,b);}',
  'else if(op==="s"||op==="a"){const p=a[i++];const text=list().join("");',
  "fs.mkdirSync(path.dirname(p),{recursive:true});",
  'if(op==="s")fs.writeFileSync(staged(p),text);else fs.appendFileSync(staged(p),text);}',
  'else if(op==="f"){const ps=list();const b=bytes(fs.readFileSync(staged(ps[0]),"utf8"));',
  "for(const p of ps)put(p,b);fs.rmSync(staged(ps[0]),{force:true});}",
  'else{process.stderr.write("mend-write: unknown operation "+op+"\\n");process.exit(2);}}',
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
    // Too large for one exec: staged beside the first path across several, and written by the
    // last of them.
    flush();
    const first = content.paths[0] ?? "";
    for (let index = 0; index < chunks.length; index += perExec) {
      flush();
      const part = chunks.slice(index, index + perExec);
      ops.push(index === 0 ? "s" : "a", first, String(part.length), ...part);
    }
    ops.push("f", ...paths);
  }
  flush();
  return execs;
};

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
