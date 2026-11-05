import { createHash } from "node:crypto";

import type { WorktreeId } from "@mend/domain";
import {
  RollbackRecoveryId,
  RollbackRefusedError,
  type HistoryBlob,
  type RollbackRecovery,
} from "@mend/domain/workbench";
import type { HistoryOperationId } from "@mend/domain/workbench";
import type { BlobStore } from "@mend/store";
import { Effect, Schema } from "effect";

import { nativeSeedProbeArgv } from "./native-fork-seed.ts";

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
// Open every ancestor without following links. Kernel paths stay anchored to these descriptors.
const atParent = (root,p,create,use) => {
 if(!safe(p))fail("Unsafe managed path");
 const fds=[];let fd;
 try {
  fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);fds.push(fd);
  const parts=p.split("/"),leaf=parts.pop();
  for(const part of parts) {
   const next="/proc/self/fd/"+fd+"/"+part;
   let child;
   try {child=fs.openSync(next,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);}
   catch(e) {
    if(e.code==="ENOENT"&&create){fs.mkdirSync(next,{mode:0o755});fs.fsyncSync(fd);child=fs.openSync(next,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);}
    else if((e.code==="ENOENT"||e.code==="ENOTDIR")&&!create)return use(null,null);
    else fail("A managed ancestor is not a plain directory: "+p);
   }
   fd=child;fds.push(fd);
  }
  return use("/proc/self/fd/"+fd+"/"+leaf,fd);
 } finally {for(const fd of fds.reverse())fs.closeSync(fd);}
};
const ensure = dir => { const parent=path.dirname(dir);if(parent!==dir) {const st=exists(parent);if(!st)ensure(parent);else if(!st.isDirectory()||st.isSymbolicLink())fail("Journal ancestor is not a directory");} const st=exists(dir);if(!st)fs.mkdirSync(dir,{mode:0o700});else if(!st.isDirectory()||st.isSymbolicLink())fail("Journal path is not a directory"); };
const syncDir = p => { const fd=fs.openSync(p,"r"); try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);} };
const write = (p,b,exclusive=false) => { ensure(path.dirname(p));const fd=fs.openSync(p,exclusive?"wx":"w",0o600);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(path.dirname(p)); };
const atomic = (p,x) => {const tmp=p+".next-"+crypto.randomUUID();write(tmp,json(x),true);fs.renameSync(tmp,p);syncDir(path.dirname(p));};
const readJSON = p => JSON.parse(fs.readFileSync(p,"utf8"));
const readPath = (root,p) => atParent(root,p,false,(full)=>{
 const absent={path:p,mode:null,bytes:null};if(full===null)return absent;
 const st=exists(full);if(!st)return absent;if(st.isDirectory())return {path:p,mode:"directory",bytes:null};
 if(!st.isFile()&&!st.isSymbolicLink())fail("Unsupported special file: "+p);
 let bytes;
 if(st.isSymbolicLink())bytes=Buffer.from(fs.readlinkSync(full));
 else {const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const actual=fs.fstatSync(fd);if(!actual.isFile()||actual.ino!==st.ino||actual.dev!==st.dev)fail("Managed file changed while reading: "+p);bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}}
 return {path:p,mode:st.isSymbolicLink()?"120000":st.mode&0o111?"100755":"100644",bytes:bytes.toString("base64")};
});
const install = (root,e) => atParent(root,e.path,true,(full,parent)=>{
 if(e.mode==="directory")fs.mkdirSync(full,{mode:0o755});
 else if(e.mode==="120000")fs.symlinkSync(Buffer.from(e.bytes,"base64").toString(),full);
 else {const fd=fs.openSync(full,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,e.mode==="100755"?0o755:0o644);try{fs.writeFileSync(fd,Buffer.from(e.bytes,"base64"));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 fs.fsyncSync(parent);
});
const remove = (root,e) => atParent(root,e.path,false,(full,parent)=>{
 if(full===null||!same(readPath(root,e.path),e))fail("Managed path changed before removal: "+e.path);
 if(e.mode==="directory")fs.rmdirSync(full);else fs.unlinkSync(full);fs.fsyncSync(parent);
});
const withDirectories = files => {
 const values=new Map(files.map(e=>[e.path,e]));
 for(const e of files)if(e.mode!==null){let p=path.dirname(e.path);while(p!=="."){const old=values.get(p);if(old&&old.mode!==null&&old.mode!=="directory")fail("Conflicting managed file and directory: "+p);values.set(p,{path:p,mode:"directory",bytes:null});p=path.dirname(p);}}
 return [...values.values()].sort((a,b)=>a.path.localeCompare(b.path));
};
const same = (a,b) => a.mode===b.mode && a.bytes===b.bytes;
const listManaged = () => [...new Set(split(git(["ls-files","--cached","--others","--exclude-standard","-z"])))].filter(p=>!excluded(p)).sort();
const snapshot = () => listManaged().map(p=>readPath(input.repository,p)).filter(e=>e.mode!=="directory");
const head = () => ({oid:text(["rev-parse","--verify","HEAD"]),symbolicRef:(()=>{try{return text(["symbolic-ref","-q","HEAD"]);}catch{return null;}})()});
const nativeArchive = () => { const out=[]; const allowed=[".codex/sessions",".codex/archived_sessions",".codex/session_index.jsonl",".claude/projects",".claude/plans",".claude/todos",".claude/tasks",".claude/jobs",".claude/teams"]; const walk=p=>{const st=exists(path.join(input.nativeRoot,p));if(!st)return;if(st.isSymbolicLink())fail("Native archive crosses a link");if(st.isDirectory()){for(const name of fs.readdirSync(path.join(input.nativeRoot,p)).sort())walk(p+"/"+name);}else out.push(readPath(input.nativeRoot,p));};for(const p of input.nativePaths){if(!safe(p)||!allowed.some(base=>p===base||(base!==".codex/session_index.jsonl"&&p.startsWith(base+"/"))))fail("Native archive path is outside the retained conversation policy");walk(p);}return out; };
const root=input.repository;
let operation,lock,indexLock,indexLockFd,indexStage,ownerPath;
const identity = p => {const st=exists(p);return st?{dev:st.dev,ino:st.ino}:null;};
const holds = (p,id) => {const actual=identity(p);return actual&&id&&actual.dev===id.dev&&actual.ino===id.ino;};
const processIdentity = pid => {try{const stat=fs.readFileSync("/proc/"+pid+"/stat","utf8");const fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");return {start:fields[19],state:fields[0],boot:fs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()};}catch{return null;}};

try {
 if(!/^[A-Za-z0-9_-]+$/.test(input.operationId)||!Number.isSafeInteger(input.generation)||input.generation<0)fail("Invalid operation generation");
 if(fs.realpathSync(root)!==root)fail("Repository root crosses a link");
 ensure(input.journalRoot);operation=path.join(input.journalRoot,input.operationId);ensure(operation);
 const generationPath=path.join(operation,"generation.json");const previous=exists(generationPath)?readJSON(generationPath):0;
 if(previous>input.generation)fail("Stale history generation");
 const indexPath=path.resolve(root,text(["rev-parse","--git-path","index"]));const requestedIndexLock=indexPath+".lock";
 const requestedLock=path.join(operation,"worker.lock");
 if(exists(requestedLock)) {
  const oldPath=path.join(requestedLock,"owner.json"), old=exists(oldPath)?readJSON(oldPath):null;
  if(input.previousExecutionExited!==true||input.generation<=(old?.generation??previous))fail("A previous history execution has no exit witness");
  const running=old?processIdentity(old.pid):null;
  if(running&&running.start===old.process?.start&&running.boot===old.process?.boot&&running.state!=="Z")fail("The previous history helper is still running");
  if(old?.indexStage) {
   const expectedStage=path.join(path.dirname(indexPath),".mend-history-index-"+input.operationId+"-"+old.generation);
   if(old.indexStage!==expectedStage)fail("The retained index lock has an unknown owner");
   if(exists(requestedIndexLock)){if(!holds(requestedIndexLock,old.indexIdentity))fail("Another writer owns the Git index lock");fs.unlinkSync(requestedIndexLock);}
   if(exists(expectedStage)){if(!holds(expectedStage,old.indexIdentity))fail("The prior index staging file diverged");fs.unlinkSync(expectedStage);}
  }
  if(exists(oldPath))fs.unlinkSync(oldPath);
  if(fs.readdirSync(requestedLock).length)fail("The previous execution lock contains unknown evidence");
  fs.rmdirSync(requestedLock);syncDir(operation);
 }
 fs.mkdirSync(requestedLock);lock=requestedLock;syncDir(operation);atomic(generationPath,input.generation);
 ownerPath=path.join(lock,"owner.json");
 const owner={generation:input.generation,pid:process.pid,process:processIdentity(process.pid)};
 atomic(ownerPath,owner);
 const stagePath=path.join(path.dirname(indexPath),".mend-history-index-"+input.operationId+"-"+input.generation);
 indexLockFd=fs.openSync(stagePath,"wx",0o600);indexStage=stagePath;
 const indexIdentity=identity(indexStage);atomic(ownerPath,{...owner,indexStage,indexIdentity});
 fs.linkSync(indexStage,requestedIndexLock);indexLock=requestedIndexLock;syncDir(path.dirname(indexPath));
 const indexBytes=()=>exists(indexPath)?fs.readFileSync(indexPath):Buffer.alloc(0);
 const artifacts=["files.json","index","index-support.json","objects.pack","native.json"];
 const manifestPath=path.join(operation,"save.json");
 if(input.action==="target") {
  if(!/^target-[a-f0-9]{64}\.pack$/.test(input.artifact??""))fail("Unknown target pack");
  const fd=fs.openSync(path.join(operation,input.artifact),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let bytes;try{bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
  if(hash(bytes)!==input.artifact.slice(7,-5))fail("Target pack digest differs");
  git(["index-pack","--stdin","--strict"],bytes);
  process.stdout.write(JSON.stringify({kind:"targetHydrated"}));
 } else if(input.action==="save") {
  if(!exists(manifestPath)) {
   const before=head(), index=indexBytes(), files=snapshot(), entries=git(["ls-files","--stage","-z"]);
   const support=[];for(const name of fs.readdirSync(path.dirname(indexPath)).filter(n=>/^sharedindex\.[0-9a-f]+$/.test(n)).sort())support.push({name,bytes:fs.readFileSync(path.join(path.dirname(indexPath),name)).toString("base64")});
   const rawIndex=path.join(operation,"raw-index");if(exists(rawIndex))fs.unlinkSync(rawIndex);
   const rawEnv={GIT_INDEX_FILE:rawIndex};git(["read-tree","--empty"],undefined,rawEnv);
   const rawEntries=files.filter(e=>e.mode!==null).map(e=>{if(e.mode==="directory")fail("Unexpected raw directory entry");const oid=git(["hash-object","-w","--no-filters","--stdin"],Buffer.from(e.bytes,"base64")).toString("utf8").trim();return e.mode+" "+oid+"\t"+e.path+"\0";}).join("");
   git(["update-index","-z","--index-info"],Buffer.from(rawEntries),rawEnv);
   const rawTree=git(["write-tree"],undefined,rawEnv).toString("utf8").trim();
   const recoveryRef="refs/mend/history/"+input.operationId+"/recovery";
   let recoverySha;try{recoverySha=text(["rev-parse","--verify",recoveryRef]);if(text(["rev-parse",recoverySha+"^{tree}"])!==rawTree)fail("The original recovery checkpoint differs");}catch(e){if(e.status===undefined)throw e;recoverySha=git(["-c","user.name=Mend","-c","user.email=mend@localhost","-c","commit.gpgsign=false","commit-tree",rawTree,"-p",before.oid],Buffer.from("Pre-rollback recovery\n")).toString("utf8").trim();git(["update-ref",recoveryRef,recoverySha,""]);}
   const checkpoint={ref:recoveryRef,sha:recoverySha,rawTree};
   const tips=[before.oid,recoverySha,...split(entries).map(e=>e.split(" ")[1]),...(input.target?[input.target]:[])];
   const objects=git(["pack-objects","--stdout","--revs"],Buffer.from([...new Set(tips)].join("\n")+"\n"));
   const values=[json(files),index,json(support),objects,json(nativeArchive())];
   for(let i=0;i<artifacts.length;i++){const p=path.join(operation,artifacts[i]);if(exists(p)){if(!fs.readFileSync(p).equals(values[i]))fail("Incomplete original recovery differs; retained evidence was not replaced");}else write(p,values[i],true);}
   git(["index-pack","--strict",path.join(operation,"objects.pack")]);
   if(JSON.stringify(head())!==JSON.stringify(before)||!indexBytes().equals(index)||JSON.stringify(snapshot())!==JSON.stringify(files))fail("Files or Git state changed during recovery save");
   atomic(manifestPath,{operationId:input.operationId,generation:input.generation,head:before,checkpoint,filesDigest:hash(values[0]),artifacts:artifacts.map((name,i)=>({name,sha256:hash(values[i]),byteLength:values[i].length})),savedAt:new Date().toISOString()});
  }
  const saved=readJSON(manifestPath);for(const a of saved.artifacts)if(hash(fs.readFileSync(path.join(operation,a.name)))!==a.sha256)fail("Retained recovery failed its digest check");
  process.stdout.write(JSON.stringify({kind:"saved",manifest:saved}));
 } else {
  const saved=readJSON(manifestPath);for(const a of saved.artifacts)if(hash(fs.readFileSync(path.join(operation,a.name)))!==a.sha256)fail("Retained recovery failed its digest check");
  if(input.action!=="evidence"&&JSON.stringify(head())!==JSON.stringify(saved.head))fail("HEAD or its visible ref moved; automatic recovery is unavailable");
  if(input.action==="hydrate") {
   git(["index-pack","--stdin"],fs.readFileSync(path.join(operation,"objects.pack")));
   const support=readJSON(path.join(operation,"index-support.json"));
   for(const entry of support){if(!/^sharedindex\.[0-9a-f]+$/.test(entry.name))fail("Unsafe split-index dependency");const p=path.join(path.dirname(indexPath),entry.name), bytes=Buffer.from(entry.bytes,"base64");if(exists(p)){if(!fs.readFileSync(p).equals(bytes))fail("A split-index dependency differs");}else write(p,bytes,true);}
   process.stdout.write(JSON.stringify({kind:"hydrated",head:head()}));
  } else if(input.action==="read") {
   if(!artifacts.includes(input.artifact)&&input.artifact!=="save.json")fail("Unknown retained artifact");
   process.stdout.write(fs.readFileSync(path.join(operation,input.artifact)).toString("base64"));
  } else if(input.action==="evidence") {process.stdout.write(JSON.stringify({operationId:input.operationId,generation:input.generation,workspaceId:input.workspaceId,launchId:input.launchId,captureId:input.captureId??null,saveDigest:hash(fs.readFileSync(manifestPath)),head:head(),indexDigest:hash(indexBytes()),filesDigest:hash(json(snapshot())),files:snapshot(),index:indexBytes().toString("base64"),objects:git(["pack-objects","--stdout","--revs"],Buffer.from([...new Set([head().oid,...split(git(["ls-files","--stage","-z"])).map(e=>e.split(" ")[1])])].join("\n")+"\n")).toString("base64"),journal:exists(path.join(operation,"restore.json"))?readJSON(path.join(operation,"restore.json")):null,native:nativeArchive()}));}
  else if(input.action==="inspect") {process.stdout.write(JSON.stringify({kind:"observed",head:head(),indexDigest:hash(indexBytes()),filesDigest:hash(json(snapshot()))}));}
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
    const expectedMap=new Map(withDirectories(expected).map(e=>[e.path,e]));const desiredMap=new Map(withDirectories(desired).map(e=>[e.path,e]));
    const names=[...new Set([...expectedMap.keys(),...desiredMap.keys()])].sort();
    const oldIndex=input.action==="restoreSaved"&&exists(forwardPath)?readJSON(forwardPath).desiredIndex:fs.readFileSync(path.join(operation,"index")).toString("base64");
    if(!indexBytes().equals(Buffer.from(oldIndex,"base64")))fail("Index changed after the saved history boundary");
    const currentNames=listManaged();for(const p of currentNames)if(!expectedMap.has(p)&&!desiredMap.has(p))fail("New managed files appeared after recovery save: "+p);
    const entries=names.map(p=>({old:expectedMap.get(p)||{path:p,mode:null,bytes:null},desired:desiredMap.get(p)||{path:p,mode:null,bytes:null},path:p,state:"prepared"}));
    for(const e of entries) {
     if(!same(readPath(root,e.path),e.old))fail("Managed path changed or conflicts with preserved files: "+e.path);
     if(e.old.mode==="directory"&&e.desired.mode!=="directory")atParent(root,e.path,false,(full)=>{for(const name of fs.readdirSync(full))if(!expectedMap.has(e.path+"/"+name))fail("Directory contains preserved files: "+e.path);});
    }
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
     else if(e.old.mode!==null) {if(!same(live,e.old))fail("Managed path changed before move: "+e.path);install(movedRoot,{...e.old,path:path.basename(moved)});}
     if(e.old.mode!==null) {const actual=readPath(root,e.path);if(same(actual,e.old))remove(root,e.old);else if(actual.mode!==null)fail("Managed path diverged after its recovery copy: "+e.path);}
     else if(live.mode!==null)fail("A preserved path appeared before install: "+e.path);
     e.state="oldMoved";atomic(journalPath,journal);
    }
   }
   for(const e of [...journal.entries].sort((a,b)=>a.path.split("/").length-b.path.split("/").length)) {
    if(same(e.old,e.desired))continue;
    const live=readPath(root,e.path);
    if(e.state==="oldMoved") {
     if(!same(live,e.desired)) {
      if(live.mode!==null)fail("A new path appeared during restore: "+e.path);
      if(e.desired.mode!==null) {
       install(root,e.desired);
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
finally {if(indexLockFd!=null)fs.closeSync(indexLockFd);if(indexLock)fs.unlinkSync(indexLock);if(indexStage&&exists(indexStage))fs.unlinkSync(indexStage);if(lock&&exists(lock)){if(ownerPath&&exists(ownerPath))fs.unlinkSync(ownerPath);fs.rmdirSync(lock);syncDir(operation);}}
`;

/** A helper always runs in authoritative workspace files, through the public SDK exec port. */
export const rollbackFilesExec = (input: {
  readonly action:
    | "target"
    | "save"
    | "restore"
    | "inspect"
    | "restoreSaved"
    | "read"
    | "hydrate"
    | "evidence";
  readonly artifact?: string;
  readonly operationId: string;
  readonly generation: number;
  readonly previousExecutionExited?: boolean;
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
  readonly previousExecutionExited?: boolean;
  readonly repository: string;
  readonly journalRoot: string;
  readonly nativeRoot: string;
  readonly nativePaths: ReadonlyArray<string>;
  readonly target: string | null;
  readonly captureId?: string | null;
  readonly blobs: BlobStore["Service"];
  /** Existing pickup delivery, exclusive at each operation-owned path. Bytes never ride argv. */
  readonly placeRecovery?: (
    files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>,
  ) => Effect.Effect<void, { readonly message: string }>;
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
  checkpoint: Schema.Struct({ ref: Schema.String, sha: Schema.String, rawTree: Schema.String }),
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
      Effect.mapError((error) =>
        error instanceof RollbackRefusedError
          ? error
          : new RollbackFilesError({ message: error.message }),
      ),
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
    checkpoint: manifest.checkpoint,
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

const placeRetainedPayloads = (
  authority: RollbackFileAuthority,
  files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>,
) =>
  Effect.gen(function* () {
    if (authority.placeRecovery === undefined)
      return yield* new RollbackFilesError({
        message: "The retained evidence cannot be delivered to this workspace.",
      });
    const root = `${authority.journalRoot}/${authority.operationId}`;
    const refs = files.map((file) => ({
      relativePath: file.path.slice(root.length + 1),
      sha256: digest(file.bytes),
      byteLength: file.bytes.byteLength,
    }));
    const probe = () =>
      authority.execute(nativeSeedProbeArgv(root, refs, { allowMissingRoot: true })).pipe(
        Effect.mapError((error) => new RollbackFilesError({ message: error.message })),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
                result.stdout,
              ).pipe(
                Effect.mapError(
                  () =>
                    new RollbackFilesError({
                      message: "Retained payload verification returned an invalid observation.",
                    }),
                ),
              )
            : Effect.fail(
                new RollbackFilesError({
                  message: "An existing immutable recovery payload differs. It was preserved.",
                }),
              ),
        ),
      );
    const missing = new Set(yield* probe());
    yield* authority
      .placeRecovery(files.filter((file) => missing.has(file.path.slice(root.length + 1))))
      .pipe(Effect.mapError((error) => new RollbackFilesError({ message: error.message })));
    if ((yield* probe()).length !== 0)
      return yield* new RollbackFilesError({
        message: "Retained recovery delivery is incomplete.",
      });
  });

/** Hydrate the original immutable save after losing a workspace's local journal. */
export const hydrateRollbackRecovery = Effect.fn("SessionRepository.hydrateRollbackRecovery")(
  function* (authority: RollbackFileAuthority, recovery: RollbackRecovery) {
    if (
      recovery.operationId !== authority.operationId ||
      recovery.worktreeId !== authority.worktreeId ||
      authority.placeRecovery === undefined
    )
      return yield* new RollbackFilesError({
        message: "This authority cannot hydrate the retained recovery.",
      });
    const load = (blob: HistoryBlob) =>
      authority.blobs.get(blob.key).pipe(
        Effect.mapError(
          () => new RollbackFilesError({ message: "A retained recovery object is unavailable." }),
        ),
        Effect.flatMap((bytes) =>
          bytes.byteLength === blob.byteLength && digest(bytes) === blob.sha256
            ? Effect.succeed(bytes)
            : Effect.fail(
                new RollbackFilesError({
                  message: "A retained recovery object failed verification.",
                }),
              ),
        ),
      );
    const index = yield* load(recovery.index);
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ raw: Schema.String, support: Schema.String })),
    )(Buffer.from(index).toString("utf8")).pipe(
      Effect.mapError(
        () => new RollbackFilesError({ message: "Retained index evidence is invalid." }),
      ),
    );
    const files = [
      { name: "files.json", bytes: yield* load(recovery.files) },
      { name: "index", bytes: Buffer.from(decoded.raw, "base64") },
      { name: "index-support.json", bytes: Buffer.from(decoded.support, "base64") },
      { name: "objects.pack", bytes: yield* load(recovery.objects) },
      { name: "native.json", bytes: yield* load(recovery.native) },
      { name: "save.json", bytes: yield* load(recovery.journal) },
    ];
    yield* placeRetainedPayloads(
      authority,
      files.map((file) => ({
        path: `${authority.journalRoot}/${authority.operationId}/${file.name}`,
        bytes: file.bytes,
      })),
    ).pipe(Effect.mapError((error) => new RollbackFilesError({ message: error.message })));
    yield* execute(authority, "hydrate");
  },
);

/** Retain the verified outcome and journal before history publication, including conversation-only. */
export const retainRollbackFileEvidence = Effect.fn("SessionRepository.retainRollbackFileEvidence")(
  function* (authority: RollbackFileAuthority) {
    const bytes = Buffer.from(yield* execute(authority, "evidence"));
    const sha256 = digest(bytes);
    const key = `changes/${authority.worktreeId}/history/${authority.operationId}/${sha256}`;
    yield* authority.blobs
      .put(key, bytes, { ifAbsent: true })
      .pipe(
        Effect.mapError(
          () => new RollbackFilesError({ message: "Rollback outcome could not be retained." }),
        ),
      );
    const stored = yield* authority.blobs
      .get(key)
      .pipe(
        Effect.mapError(
          () => new RollbackFilesError({ message: "Rollback outcome could not be verified." }),
        ),
      );
    if (digest(stored) !== sha256)
      return yield* new RollbackFilesError({
        message: "Retained rollback outcome failed verification.",
      });
    return { key, sha256, byteLength: bytes.byteLength } satisfies HistoryBlob;
  },
);

/** Check that initialization or conversation-only rollback preserved the original managed bytes. */
export const compareRollbackFiles = Effect.fn("SessionRepository.compareRollbackFiles")(function* (
  authority: RollbackFileAuthority,
  recovery: RollbackRecovery,
) {
  const index = yield* authority.blobs
    .get(recovery.index.key)
    .pipe(
      Effect.mapError(
        () => new RollbackFilesError({ message: "The retained original index is unavailable." }),
      ),
    );
  if (digest(index) !== recovery.index.sha256)
    return yield* new RollbackFilesError({
      message: "The retained original index failed verification.",
    });
  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ raw: Schema.String, support: Schema.String })),
  )(Buffer.from(index).toString("utf8")).pipe(
    Effect.mapError(
      () => new RollbackFilesError({ message: "The retained original index is invalid." }),
    ),
  );
  const observation = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        kind: Schema.Literal("observed"),
        head: Schema.Struct({ oid: Schema.String, symbolicRef: Schema.NullOr(Schema.String) }),
        indexDigest: Schema.String,
        filesDigest: Schema.String,
      }),
    ),
  )(yield* inspectRollbackFiles(authority)).pipe(
    Effect.mapError(
      () =>
        new RollbackFilesError({ message: "The authoritative rollback observation is invalid." }),
    ),
  );
  if (
    observation.head.oid !== recovery.head.oid ||
    observation.head.symbolicRef !== recovery.head.symbolicRef
  )
    return yield* new RollbackFilesError({
      message: "HEAD moved after the original save. Automatic recovery is unavailable.",
    });
  return {
    observation,
    changed:
      observation.indexDigest !== digest(Buffer.from(decoded.raw, "base64")) ||
      observation.filesDigest !== recovery.files.sha256,
  };
});

/** Refuse initialization or conversation-only success when managed bytes changed after saving. */
export const verifyRollbackUnchanged = (
  authority: RollbackFileAuthority,
  recovery: RollbackRecovery,
) =>
  compareRollbackFiles(authority, recovery).pipe(
    Effect.flatMap((result) =>
      result.changed
        ? Effect.fail(
            new RollbackFilesError({
              message:
                "Managed files or staging changed after the original save. Recovery is required.",
            }),
          )
        : Effect.succeed(result.observation),
    ),
  );

/** Import only independently retained exact target objects, leaving managed files and staging alone. */
export const hydrateRollbackTarget = (
  authority: RollbackFileAuthority,
  keys: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (keys.length === 0) return;
    if (authority.placeRecovery === undefined)
      return yield* new RollbackFilesError({
        message: "The target objects cannot be delivered to this authoritative workspace.",
      });
    for (const key of keys) {
      const bytes = yield* authority.blobs.get(key).pipe(
        Effect.mapError(
          () =>
            new RollbackFilesError({
              message: "The retained target object pack is unavailable.",
            }),
        ),
      );
      const sha = digest(bytes);
      if (!key.endsWith(sha))
        return yield* new RollbackFilesError({
          message: "The retained target object pack has a different digest.",
        });
      const artifact = `target-${sha}.pack`;
      yield* placeRetainedPayloads(authority, [
        { path: `${authority.journalRoot}/${authority.operationId}/${artifact}`, bytes },
      ]).pipe(Effect.mapError((error) => new RollbackFilesError({ message: error.message })));
      yield* execute(authority, "target", artifact);
    }
  });
