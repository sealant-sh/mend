import { createHash } from "node:crypto";

import type { WorktreeId } from "@mend/domain";
import {
  RollbackRecoveryId,
  type HistoryBlob,
  type RollbackRecovery,
} from "@mend/domain/workbench";
import type { HistoryOperationId } from "@mend/domain/workbench";
import type { BlobStore } from "@mend/store";
import { Effect, Schema } from "effect";

/** A guarded live history helper refused a file state without discarding it. */
export class RollbackFilesError extends Schema.TaggedError<RollbackFilesError>()(
  "RollbackFilesError",
  {
    message: Schema.String,
  },
) {}

// This program is sent as code, while private bytes arrive through the existing pickup port.
// It touches only its journal and the managed paths fixed in its retained plan.
const PROGRAM = String.raw`
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process"), crypto = require("node:crypto");
const input = JSON.parse(process.argv[1]);
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
const json = x => Buffer.from(JSON.stringify(x));
const fail = reason => { throw new Error(reason); };
const safe = p => typeof p === "string" && p.length > 0 && !p.includes("\0") && !p.includes("\\") && !path.isAbsolute(p) && p.split("/").every(x => x !== "." && x !== ".." && x !== "" && x !== ".git");
const excluded = p => p.split("/").some(x => ["node_modules", ".pnpm-store", ".npm", "__pycache__", ".venv"].includes(x));
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const git = (args, stdin, extra = {}) => cp.execFileSync("git", args, {cwd: input.repository, env: {...gitEnv, GIT_CONFIG_NOSYSTEM:"1", ...extra}, input: stdin, maxBuffer: 256*1024*1024});
const text = args => git(args).toString("utf8").trim();
const split = b => { const s=b.toString("utf8"); if(!Buffer.from(s).equals(b))fail("Unsupported non-UTF-8 Git path"); return s.split("\0").filter(Boolean); };
const exists = p => { try { return fs.lstatSync(p); } catch(e) { if(e.code === "ENOENT")return null;throw e; } };
const parents = (root, p) => { if(!safe(p))fail("Unsafe managed path"); let current=root; for(const part of p.split("/").slice(0,-1)){ current=path.join(current,part);const st=exists(current); if(st && (!st.isDirectory() || st.isSymbolicLink()))fail("A managed ancestor is a link or file: "+p); } };
const ensure = dir => { const parent=path.dirname(dir);if(parent!==dir) {const st=exists(parent);if(!st)ensure(parent);else if(!st.isDirectory()||st.isSymbolicLink())fail("Journal ancestor is not a directory");} const st=exists(dir);if(!st)fs.mkdirSync(dir,{mode:0o700});else if(!st.isDirectory()||st.isSymbolicLink())fail("Journal path is not a directory"); };
const syncDir = p => { const fd=fs.openSync(p,"r"); try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);} };
const write = (p,b,exclusive=false) => { ensure(path.dirname(p));const fd=fs.openSync(p,exclusive?"wx":"w",0o600);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(path.dirname(p)); };
const atomic = (p,x) => {const tmp=p+".next-"+crypto.randomUUID();write(tmp,json(x),true);fs.renameSync(tmp,p);syncDir(path.dirname(p));};
const readJSON = p => JSON.parse(fs.readFileSync(p,"utf8"));
const readPath = (root,p) => { parents(root,p); const full=path.join(root,p), st=exists(full);if(!st)return {path:p,mode:null,bytes:null};if(st.isDirectory())return {path:p,mode:"directory",bytes:null};if(!st.isFile()&&!st.isSymbolicLink())fail("Unsupported special file: "+p);const bytes=st.isSymbolicLink()?Buffer.from(fs.readlinkSync(full)):fs.readFileSync(full);return {path:p,mode:st.isSymbolicLink()?"120000":st.mode&0o111?"100755":"100644",bytes:bytes.toString("base64")}; };
const same = (a,b) => a.mode===b.mode && a.bytes===b.bytes;
const listManaged = () => [...new Set(split(git(["ls-files","--cached","--others","--exclude-standard","-z"])))].filter(p=>!excluded(p)).sort();
const snapshot = () => listManaged().map(p=>readPath(input.repository,p));
const head = () => ({oid:text(["rev-parse","--verify","HEAD"]),symbolicRef:(()=>{try{return text(["symbolic-ref","-q","HEAD"]);}catch{return null;}})()});
const nativeArchive = () => { const out=[]; const allowed=[".codex/sessions",".codex/archived_sessions",".codex/session_index.jsonl",".claude/projects",".claude/plans",".claude/todos",".claude/tasks",".claude/jobs",".claude/teams"]; const walk=p=>{const st=exists(path.join(input.nativeRoot,p));if(!st)return;if(st.isSymbolicLink())fail("Native archive crosses a link");if(st.isDirectory()){for(const name of fs.readdirSync(path.join(input.nativeRoot,p)).sort())walk(p+"/"+name);}else out.push(readPath(input.nativeRoot,p));};for(const p of input.nativePaths){if(!allowed.includes(p))fail("Native archive path is outside the retained conversation policy");walk(p);}return out; };
const root=input.repository;
let operation,lock,indexLock,indexLockFd;
try {
 if(!/^[A-Za-z0-9_-]+$/.test(input.operationId)||!Number.isSafeInteger(input.generation)||input.generation<0)fail("Invalid operation generation");
 if(fs.realpathSync(root)!==root)fail("Repository root crosses a link");
 ensure(input.journalRoot);operation=path.join(input.journalRoot,input.operationId);ensure(operation);
 const requestedLock=path.join(operation,"worker.lock");fs.mkdirSync(requestedLock);lock=requestedLock;syncDir(operation);
 const generationPath=path.join(operation,"generation.json");const previous=exists(generationPath)?readJSON(generationPath):0;
 if(previous>input.generation)fail("Stale history generation");atomic(generationPath,input.generation);
 const indexPath=path.resolve(root,text(["rev-parse","--git-path","index"]));const requestedIndexLock=indexPath+".lock";
 indexLockFd=fs.openSync(requestedIndexLock,"wx",0o600);indexLock=requestedIndexLock;
 const indexBytes=()=>exists(indexPath)?fs.readFileSync(indexPath):Buffer.alloc(0);
 const artifacts=["files.json","index","index-support.json","objects.pack","native.json"];
 const manifestPath=path.join(operation,"save.json");
 if(input.action==="save") {
  if(!exists(manifestPath)) {
   const before=head(), index=indexBytes(), files=snapshot(), entries=git(["ls-files","--stage","-z"]);
   const support=[];for(const name of fs.readdirSync(path.dirname(indexPath)).filter(n=>/^sharedindex\.[0-9a-f]+$/.test(n)).sort())support.push({name,bytes:fs.readFileSync(path.join(path.dirname(indexPath),name)).toString("base64")});
   const tips=[before.oid,...split(entries).map(e=>e.split(" ")[1]),...(input.target?[input.target]:[])];
   const objects=git(["pack-objects","--stdout","--revs"],Buffer.from([...new Set(tips)].join("\n")+"\n"));
   const values=[json(files),index,json(support),objects,json(nativeArchive())];
   for(let i=0;i<artifacts.length;i++){const p=path.join(operation,artifacts[i]);if(exists(p)){if(!fs.readFileSync(p).equals(values[i]))fail("Incomplete original recovery differs; retained evidence was not replaced");}else write(p,values[i],true);}
   git(["index-pack","--strict",path.join(operation,"objects.pack")]);
   if(JSON.stringify(head())!==JSON.stringify(before)||!indexBytes().equals(index)||JSON.stringify(snapshot())!==JSON.stringify(files))fail("Files or Git state changed during recovery save");
   atomic(manifestPath,{operationId:input.operationId,generation:input.generation,head:before,filesDigest:hash(values[0]),artifacts:artifacts.map((name,i)=>({name,sha256:hash(values[i]),byteLength:values[i].length})),savedAt:new Date().toISOString()});
  }
  const saved=readJSON(manifestPath);for(const a of saved.artifacts)if(hash(fs.readFileSync(path.join(operation,a.name)))!==a.sha256)fail("Retained recovery failed its digest check");
  process.stdout.write(JSON.stringify({kind:"saved",manifest:saved}));
 } else {
  const saved=readJSON(manifestPath);for(const a of saved.artifacts)if(hash(fs.readFileSync(path.join(operation,a.name)))!==a.sha256)fail("Retained recovery failed its digest check");
  if(JSON.stringify(head())!==JSON.stringify(saved.head))fail("HEAD or its visible ref moved; automatic recovery is unavailable");
  if(input.action==="read") {
   if(!artifacts.includes(input.artifact)&&input.artifact!=="save.json")fail("Unknown retained artifact");
   process.stdout.write(fs.readFileSync(path.join(operation,input.artifact)).toString("base64"));
  } else if(input.action==="inspect") {process.stdout.write(JSON.stringify({kind:"observed",head:head(),indexDigest:hash(indexBytes()),filesDigest:hash(json(snapshot()))}));}
  else {
   if(input.action!=="restore"&&input.action!=="restoreSaved")fail("Unknown history file action");
   const savedFiles=readJSON(path.join(operation,"files.json"));
   let desired, desiredIndex;
   const forwardPath=path.join(operation,"restore.json");
   if(input.action==="restore") {
    if(!input.target||!/^[0-9a-f]{40,64}$/.test(input.target))fail("Missing exact target tree");
    if((()=>{try{return text(["config","--get","core.sparseCheckout"]);}catch{return "false";}})()==="true")fail("Sparse worktree restoration is unsupported");
    desired=split(git(["ls-tree","-rz","--full-tree",input.target])).map(line=>{const tab=line.indexOf("\t"),meta=line.slice(0,tab).split(" "),p=line.slice(tab+1);if(!safe(p))fail("Unsafe target path");if(meta[1]!=="blob")fail("Submodule restoration is unsupported");return {path:p,mode:meta[0],bytes:git(["cat-file","blob",meta[2]]).toString("base64")};}).filter(e=>!excluded(e.path));
    for(const e of desired) {
     for(const source of [[],["--source="+input.target]]) {
      const attrs=split(git(["check-attr",...source,"-z","filter","working-tree-encoding","text","eol","ident","--",e.path]));
      for(let i=2;i<attrs.length;i+=3)if(!["unspecified","unset"].includes(attrs[i]))fail("Target has nonidentity Git attributes: "+e.path);
     }
    }
    const autocrlf=(()=>{try{return text(["config","--get","core.autocrlf"]);}catch{return "false";}})();if(!["false",""].includes(autocrlf))fail("Nonidentity Git line-ending policy");
    const temp=path.join(operation,"head-index");if(!exists(temp)){git(["read-tree",saved.head.oid],undefined,{GIT_INDEX_FILE:temp});}
    const excludedEntries=split(git(["ls-files","--stage","-z"])).filter(e=>excluded(e.slice(e.indexOf("\t")+1)));if(excludedEntries.length)fail("Restoring an explicitly excluded tracked index is unsupported");
    desiredIndex=fs.readFileSync(temp);
   } else {
    desired=savedFiles.filter(e=>e.mode!==null);
    desiredIndex=fs.readFileSync(path.join(operation,"index"));
   }
   const journalPath=path.join(operation,input.action+".json");
   if(!exists(journalPath)) {
    let expected=savedFiles;
    if(input.action==="restoreSaved"&&exists(forwardPath)) {const f=readJSON(forwardPath);expected=f.entries.map(e=>e.desired);}
    const expectedMap=new Map(expected.map(e=>[e.path,e]));const desiredMap=new Map(desired.map(e=>[e.path,e]));
    const names=[...new Set([...expectedMap.keys(),...desiredMap.keys()])].sort();
    const oldIndex=input.action==="restoreSaved"&&exists(forwardPath)?readJSON(forwardPath).desiredIndex:fs.readFileSync(path.join(operation,"index")).toString("base64");
    if(!indexBytes().equals(Buffer.from(oldIndex,"base64")))fail("Index changed after the saved history boundary");
    const currentNames=listManaged();for(const p of currentNames)if(!expectedMap.has(p)&&!desiredMap.has(p))fail("New managed files appeared after recovery save: "+p);
    const entries=names.map(p=>({old:expectedMap.get(p)||{path:p,mode:null,bytes:null},desired:desiredMap.get(p)||{path:p,mode:null,bytes:null},path:p,state:"prepared"}));
    for(const e of entries)if(!same(readPath(root,e.path),e.old))fail("Managed path changed or conflicts with preserved files: "+e.path);
    atomic(journalPath,{generation:input.generation,oldIndex,desiredIndex:desiredIndex.toString("base64"),entries,indexInstalled:false,complete:false});
   }
   const journal=readJSON(journalPath);if(journal.generation>input.generation)fail("Stale file journal generation");journal.generation=input.generation;atomic(journalPath,journal);
   const currentIndex=indexBytes();if(!currentIndex.equals(Buffer.from(journal.oldIndex,"base64"))&&!currentIndex.equals(Buffer.from(journal.desiredIndex,"base64")))fail("Index diverged from the retained journal");
   const movedRoot=path.join(operation,input.action+"-originals");ensure(movedRoot);
   for(const e of [...journal.entries].sort((a,b)=>b.path.split("/").length-a.path.split("/").length)) {
    if(same(e.old,e.desired))continue;
    const live=readPath(root,e.path), moved=path.join(movedRoot,Buffer.from(e.path).toString("hex"));
    if(e.state==="prepared") {
     if(exists(moved)) {if(!same(readPath(movedRoot,path.basename(moved)),{...e.old,path:path.basename(moved)}))fail("Moved original differs from saved bytes");}
     else if(e.old.mode!==null) {if(!same(live,e.old))fail("Managed path changed before move: "+e.path);fs.renameSync(path.join(root,e.path),moved);syncDir(path.dirname(path.join(root,e.path)));syncDir(movedRoot);}
     else if(live.mode!==null)fail("A preserved path appeared before install: "+e.path);
     e.state="oldMoved";atomic(journalPath,journal);
    }
   }
   for(const e of journal.entries) {
    if(same(e.old,e.desired))continue;
    const live=readPath(root,e.path);
    if(e.state==="oldMoved") {
     if(!same(live,e.desired)) {
      if(live.mode!==null)fail("A new path appeared during restore: "+e.path);
      if(e.desired.mode!==null) {
       parents(root,e.path);const full=path.join(root,e.path);ensure(path.dirname(full));const bytes=Buffer.from(e.desired.bytes,"base64");
       if(e.desired.mode==="120000")fs.symlinkSync(bytes.toString(),full);
       else {const staged=path.join(operation,"staged-"+crypto.randomUUID());write(staged,bytes,true);fs.chmodSync(staged,e.desired.mode==="100755"?0o755:0o644);fs.linkSync(staged,full);}
       syncDir(path.dirname(full));
      }
     }
     e.state="installed";atomic(journalPath,journal);
    }
    if(!same(readPath(root,e.path),e.desired))fail("Installed path diverged: "+e.path);
   }
   if(JSON.stringify(head())!==JSON.stringify(saved.head))fail("HEAD changed during restore");
   if(!indexBytes().equals(Buffer.from(journal.oldIndex,"base64"))&&!indexBytes().equals(Buffer.from(journal.desiredIndex,"base64")))fail("Index changed during restore");
   fs.writeFileSync(indexLockFd,Buffer.from(journal.desiredIndex,"base64"));fs.fsyncSync(indexLockFd);fs.closeSync(indexLockFd);indexLockFd=null;fs.renameSync(indexLock,indexPath);indexLock=null;syncDir(path.dirname(indexPath));
   journal.indexInstalled=true;journal.complete=true;atomic(journalPath,journal);
   process.stdout.write(JSON.stringify({kind:"restored",filesDigest:hash(json(snapshot())),indexDigest:hash(indexBytes()),head:head()}));
  }
 }
} catch(e) {process.stderr.write("Mend rollback: "+e.message+"\n");process.exitCode=3;}
finally {if(indexLockFd!=null)fs.closeSync(indexLockFd);if(indexLock)fs.unlinkSync(indexLock);if(lock&&exists(lock)){fs.rmdirSync(lock);syncDir(operation);}}
`;

/** A helper always runs in authoritative workspace files, through the public SDK exec port. */
export const rollbackFilesExec = (input: {
  readonly action: "save" | "restore" | "inspect" | "restoreSaved" | "read";
  readonly artifact?: string;
  readonly operationId: string;
  readonly generation: number;
  readonly repository: string;
  readonly journalRoot: string;
  readonly nativeRoot: string;
  readonly nativePaths: ReadonlyArray<string>;
  readonly target: string | null;
}): ReadonlyArray<string> => ["node", "-e", PROGRAM, JSON.stringify(input)];

/** The engine supplies only its already-authorized public workspace execution and retained store. */
export interface RollbackFileAuthority {
  readonly operationId: HistoryOperationId;
  readonly worktreeId: WorktreeId;
  readonly workspaceId: string;
  readonly launchId: string;
  readonly generation: number;
  readonly repository: string;
  readonly journalRoot: string;
  readonly nativeRoot: string;
  readonly nativePaths: ReadonlyArray<string>;
  readonly target: string | null;
  readonly blobs: BlobStore["Service"];
  readonly execute: (argv: ReadonlyArray<string>) => Effect.Effect<
    {
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    },
    { readonly message: string }
  >;
}

const SavedManifest = Schema.Struct({
  operationId: Schema.String,
  generation: Schema.Int,
  head: Schema.Struct({ oid: Schema.String, symbolicRef: Schema.NullOr(Schema.String) }),
  artifacts: Schema.Array(
    Schema.Struct({ name: Schema.String, sha256: Schema.String, byteLength: Schema.Int }),
  ),
  savedAt: Schema.String,
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const execute = (
  authority: RollbackFileAuthority,
  action: Parameters<typeof rollbackFilesExec>[0]["action"],
  artifact?: string,
) =>
  authority
    .execute(
      rollbackFilesExec({ ...authority, action, ...(artifact === undefined ? {} : { artifact }) }),
    )
    .pipe(
      Effect.mapError((error) => new RollbackFilesError({ message: error.message })),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              new RollbackFilesError({
                message:
                  result.stderr.trim() ||
                  "The authoritative history file operation did not complete.",
              }),
            ),
      ),
    );

/** Retain and verify the original save once, including files that cannot be represented by a Git tree. */
export const saveRollbackRecovery = Effect.fn("SessionRepository.saveRollbackRecovery")(function* (
  authority: RollbackFileAuthority,
) {
  yield* execute(authority, "save");
  const manifestBytes = Buffer.from(yield* execute(authority, "read", "save.json"), "base64");
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SavedManifest))(
    manifestBytes.toString("utf8"),
  ).pipe(
    Effect.mapError(
      () => new RollbackFilesError({ message: "The workspace recovery manifest is invalid." }),
    ),
  );
  if (manifest.operationId !== authority.operationId)
    return yield* new RollbackFilesError({
      message: "The recovery manifest names a different operation.",
    });
  const retain = (
    name: string,
    bytes: Uint8Array,
  ): Effect.Effect<HistoryBlob, RollbackFilesError> =>
    Effect.gen(function* () {
      const sha256 = digest(bytes);
      const key = `changes/${authority.worktreeId}/history/${authority.operationId}/${sha256}`;
      yield* authority.blobs
        .put(key, bytes, { ifAbsent: true })
        .pipe(
          Effect.mapError(
            () => new RollbackFilesError({ message: `Recovery ${name} could not be retained.` }),
          ),
        );
      const stored = yield* authority.blobs
        .get(key)
        .pipe(
          Effect.mapError(
            () => new RollbackFilesError({ message: `Recovery ${name} could not be verified.` }),
          ),
        );
      if (digest(stored) !== sha256)
        return yield* new RollbackFilesError({
          message: `Recovery ${name} failed digest verification.`,
        });
      return { key, sha256, byteLength: bytes.byteLength };
    });
  const artifacts = new Map<string, Uint8Array>();
  for (const artifact of manifest.artifacts) {
    const bytes = Buffer.from(yield* execute(authority, "read", artifact.name), "base64");
    if (bytes.length !== artifact.byteLength || digest(bytes) !== artifact.sha256)
      return yield* new RollbackFilesError({
        message: "The workspace recovery bytes differ from their original manifest.",
      });
    artifacts.set(artifact.name, bytes);
  }
  const bytesOf = (name: string) => {
    const bytes = artifacts.get(name);
    if (bytes === undefined) throw new Error(`The recovery manifest omitted ${name}.`);
    return bytes;
  };
  const index = yield* retain(
    "index",
    Buffer.from(
      JSON.stringify({
        raw: Buffer.from(bytesOf("index")).toString("base64"),
        support: Buffer.from(bytesOf("index-support.json")).toString("base64"),
      }),
    ),
  );
  const files = yield* retain("files", bytesOf("files.json"));
  const objects = yield* retain("objects", bytesOf("objects.pack"));
  const native = yield* retain("native", bytesOf("native.json"));
  const journal = yield* retain("journal", manifestBytes);
  const recovery = {
    id: RollbackRecoveryId.make(`recovery-${authority.operationId}`),
    operationId: authority.operationId,
    worktreeId: authority.worktreeId,
    workspaceId: authority.workspaceId,
    launchId: authority.launchId,
    generation: manifest.generation,
    head: manifest.head,
    index,
    files,
    objects,
    native,
    journal,
    savedAt: new Date(manifest.savedAt),
  };
  return {
    ...recovery,
    manifestDigest: digest(Buffer.from(JSON.stringify(recovery))),
  } satisfies RollbackRecovery;
});

/** Restore the exact selected managed tree, or the saved raw tree and staging during recovery. */
export const restoreRollbackFiles = (
  authority: RollbackFileAuthority,
  action: "restore" | "restoreSaved" = "restore",
) => execute(authority, action);
/** Observe file/index fingerprints after native initialization without changing them. */
export const inspectRollbackFiles = (authority: RollbackFileAuthority) =>
  execute(authority, "inspect");
