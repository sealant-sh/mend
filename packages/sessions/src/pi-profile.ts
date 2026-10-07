import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  PI_PROFILE_AGENT_PATH,
  piProfileFileBytes,
  validatePiProfileFilePath,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import {
  SKILLS_VACATE_PROGRAM,
  parseSkillsVacateOutcomes,
  type SkillsVacate,
  type SkillsVacateOutcome,
} from "./skills.ts";
import { shellQuote } from "./workspace-files.ts";

/**
 * A person's pi setup (`mend connect pi`, pi-profile.ts in @mend/domain), delivered into each pi
 * session they start: the files go to `.pi/agent/mend/profile` in the harness home, and before pi
 * starts `PI_PROFILE_PROGRAM` installs what they need and points `settings.json` at them.
 *
 * The profile directory is delivered as skills are (`skills.ts`): one that already holds exactly
 * the profile is left alone, and anything else there is moved aside whole, to
 * `.mend/pi-profile-kept/<stamp>/`, never deleted. What the session installs inside it
 * (`node_modules`) is not part of the comparison.
 */

/** The profile directory, relative to the harness home. */
export const PI_PROFILE_HOME_DIR = path.posix.join(".pi/agent", PI_PROFILE_AGENT_PATH);

/** Where a profile directory that is not exactly the one being delivered goes. */
export const PI_PROFILE_KEPT_DIR = ".mend/pi-profile-kept";

/** What the session builds inside a delivered profile, which the comparison leaves out. */
const SESSION_BUILT = ["node_modules"];

/**
 * The profile file that can hold the person's keys (`mcp.json`: its servers' headers, env and
 * client secrets, sent as they are). The platform never saves it (`HARNESS_CREDENTIALS` in
 * harness-state.ts), so a profile restored from a capture lacks it: the comparison leaves it out,
 * and it is written again at every delivery, so a restored profile stays `unchanged` and keeps
 * what the session installed in it.
 */
export const PI_PROFILE_SECRET_FILE = "root/mcp.json";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The digest `SKILLS_VACATE_PROGRAM` reads off a directory holding exactly these files. */
const treeDigest = (
  files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>,
): string =>
  sha256(
    files
      .map((file) => [file.path, sha256(file.bytes)] as const)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([file, digest]) => `${file}\u0000${digest}\n`)
      .join(""),
  );

export class PiProfileDeliveryError extends Schema.TaggedErrorClass<PiProfileDeliveryError>()(
  "PiProfileDeliveryError",
  { message: Schema.String },
) {}

/** What one delivery writes: the directory to clear, and the files, relative to the harness home. */
export interface PiProfilePlan {
  readonly vacate: SkillsVacate;
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>;
}

/**
 * The plan for a saved profile. Paths and contents were validated when it was saved; they are
 * checked again before they touch a filesystem, and a file that fails is left out.
 */
export const planPiProfile = (profile: {
  readonly digest: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly encoding: "utf8" | "base64";
    readonly contents: string;
  }>;
}): PiProfilePlan => {
  const files = profile.files.flatMap((file) => {
    const bytes = piProfileFileBytes(file);
    if (bytes === null || validatePiProfileFilePath(file.path) !== null) return [];
    return [{ path: file.path, bytes }];
  });
  const compared = treeDigest(files.filter((file) => file.path !== PI_PROFILE_SECRET_FILE));
  return {
    vacate: {
      dir: PI_PROFILE_HOME_DIR,
      accept: [compared],
      delivering: compared,
      skip: SESSION_BUILT,
      skipFiles: [PI_PROFILE_SECRET_FILE],
    },
    files: files.map((file) => ({
      path: path.posix.join(PI_PROFILE_HOME_DIR, file.path),
      bytes: file.bytes,
    })),
  };
};

/** A fresh kept directory for one delivery, relative to the harness home. */
export const piProfileKeptDir = (now: Date = new Date()): string =>
  path.posix.join(
    PI_PROFILE_KEPT_DIR,
    `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  );

/**
 * pi's own identity of a package entry, as its package manager matches a source: `npm:<name>`
 * whatever the version, `git:<host>/<path>` whatever the protocol, credentials or ref, and the
 * path of a local one. An entry in object form (`{ source, extensions }`, which pi writes when an
 * extension of the package is turned off) has its source's identity. Shared by the merge and the
 * undo, so a delivered package pi rewrote is still known as the one delivered.
 */
const PI_PACKAGE_KEY_FUNCTION = String.raw`function pkgKey(e){const s=typeof e==="string"?e:e!==null&&typeof e==="object"&&typeof e.source==="string"?e.source:null;if(s===null)return "?"+JSON.stringify(e);const t=s.trim();if(t.startsWith("npm:")){const spec=t.slice(4).trim(),at=spec.lastIndexOf("@");return "npm:"+(at>0?spec.slice(0,at):spec)}const g=t.startsWith("git:");let u=g?t.slice(4).trim():t;if(!g&&!/^(https?|ssh|git):\/\//i.test(u))return "local:"+t;u=u.replace(/^[a-z][a-z0-9+.-]*:\/\//i,"").replace(/^[^@\/]*@/,"").replace(/#.*$/,"").replace(/^([^\/:]+):\d+\//,"$1/").replace(/^([^\/:]+):/,"$1/");const parts=u.split("/"),host=(parts.shift()||"").toLowerCase();return "git:"+host+"/"+parts.join("/").replace(/\/+$/,"").replace(/@[^\/@]*$/,"").replace(/\.git$/,"")}`;

/**
 * Where a file a link names really is, a dangling link's target included: Mend writes pi's
 * settings beside that, then renames over it, so a link into a person's saved directory (docs/adr/
 * 0016, decision 2) stays a link and the settings stay saved.
 */
const REAL_PATH_FUNCTION = String.raw`function real(p){try{return fs.realpathSync(p)}catch{try{return path.resolve(path.dirname(p),fs.readlinkSync(p))}catch{return p}}}`;

/** A JSON object file: `{}` when absent, null when it does not parse; a leading BOM is pi's to skip, and ours. */
const READ_JSON_FUNCTION = String.raw`function read(p){try{const v=JSON.parse(fs.readFileSync(p,"utf8").replace(/^﻿/,""));return v!==null&&typeof v==="object"&&!Array.isArray(v)?v:null}catch(e){return e.code==="ENOENT"?{}:null}}`;

/**
 * Takes an earlier delivery's settings back out of pi's agent directory (`argv[1]`), keeping a
 * copy of everything it touches under `argv[2]` first: `settings.json`, the copied `mcp.json` and
 * `keybindings.json`, and the delivery records (`mend/delivered-*.json`). A setting still holding
 * the value that delivery wrote goes; one the session changed stays. The packages it delivered go;
 * the session's own stay, each matched as pi matches a package (`PI_PACKAGE_KEY_FUNCTION`). A
 * copied file the session did not change goes. Nothing goes that is not in the copy. A
 * `settings.json` or record that does not parse is left as it is, and the program exits 2 saying
 * which: the launch refuses rather than guess. With `check` as `argv[3]` it only checks that. No
 * single quotes: it rides `sh -c` inside them.
 */
export const PI_PROFILE_UNDO_PROGRAM = [
  `const fs=require("fs"),path=require("path"),crypto=require("crypto");`,
  REAL_PATH_FUNCTION,
  `const [A,K,mode]=process.argv.slice(1),M=path.join(A,"mend"),D=path.join(M,"delivered-settings.json"),F=path.join(M,"delivered-files.json"),S=real(path.join(A,"settings.json"));`,
  READ_JSON_FUNCTION,
  PI_PACKAGE_KEY_FUNCTION,
  `const refuse=m=>{process.stderr.write("mend: "+m+"\\n");process.exit(2)};`,
  `const cur=read(S),last=read(D),lastFiles=read(F);`,
  `if(last===null)refuse("~/.pi/agent/mend/delivered-settings.json does not parse, so what an earlier pi profile delivered cannot be told apart; fix or remove it");`,
  `if(lastFiles===null)refuse("~/.pi/agent/mend/delivered-files.json does not parse, so what an earlier pi profile delivered cannot be told apart; fix or remove it");`,
  `if(!fs.existsSync(D)&&!fs.existsSync(F))process.exit(0);`,
  `if(cur===null)refuse("~/.pi/agent/settings.json does not parse, so the settings an earlier pi profile delivered cannot be taken out of it; fix it, or move it away");`,
  `if(mode==="check")process.exit(0);`,
  `const sha=b=>crypto.createHash("sha256").update(b).digest("hex");`,
  `for(const f of ["settings.json","mcp.json","keybindings.json","mend/delivered-settings.json","mend/delivered-files.json"]){`,
  `const from=path.join(A,f);if(!fs.existsSync(from))continue;const to=path.join(K,f);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to)}`,
  `if(fs.existsSync(S)){const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),has=Object.hasOwn,out=Object.assign({},cur);`,
  `for(const k of Object.keys(last)){if(k!=="packages"&&has(cur,k)&&same(cur[k],last[k]))delete out[k]}`,
  `const gone=new Set((Array.isArray(last.packages)?last.packages:[]).map(pkgKey));`,
  `if(Array.isArray(cur.packages))out.packages=cur.packages.filter(e=>!gone.has(pkgKey(e)));`,
  `const t=S+".mend-seed-"+process.pid;fs.writeFileSync(t,JSON.stringify(out,null,2),{mode:0o600});fs.renameSync(t,S)}`,
  `for(const f of ["mcp.json","keybindings.json"]){if(!lastFiles[f])continue;`,
  `const to=path.join(A,f);let have=null;try{have=sha(fs.readFileSync(to))}catch(e){if(e.code!=="ENOENT")throw e}`,
  `if(have===lastFiles[f])fs.rmSync(to)}`,
  `fs.rmSync(D,{force:true});fs.rmSync(F,{force:true})`,
].join("");

/** pi's agent directory, relative to the harness home. */
const PI_AGENT_DIR = path.posix.dirname(path.posix.dirname(PI_PROFILE_HOME_DIR));

/**
 * The exec that makes a pi session's harness home hold its owner's profile or none, before the
 * profile's files are written (`plan`, or null when the owner has none). In capture mode the
 * harness home is the worktree's, so what is there is whoever's session delivered last:
 *
 * 1. The profile directory is left as it is only when it holds exactly the profile being
 *    delivered (`unchanged`: the same files, whoever delivered them); otherwise it is moved aside
 *    whole to `kept` (`SKILLS_VACATE_PROGRAM`), never deleted.
 * 2. Unless it was left as it is, what an earlier delivery put into pi's settings is taken back
 *    out, with a copy under `kept` (`PI_PROFILE_UNDO_PROGRAM`). Left as it is, its settings and
 *    records are only checked to parse.
 *
 * Prints the vacate's outcome lines. Exits non-zero when either step fails: the launch then
 * stops, as it does when the files cannot be written. A pi launch runs on its owner's freshly
 * delivered profile, or on no profile, or does not start.
 */
export const preparePiProfileExec = (
  home: string,
  kept: string,
  plan: PiProfilePlan | null,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  `set -e; mkdir -p "$1"/${shellQuote(path.posix.dirname(PI_PROFILE_HOME_DIR))}; ` +
    `out=$(node -e ${shellQuote(SKILLS_VACATE_PROGRAM)} "$1" "$2" "$3") || ` +
    `{ printf '%s\\n' "$out"; printf 'mend: the pi profile there could not be moved aside: %s\\n' "$out" >&2; exit 1; }; ` +
    `printf '%s\\n' "$out"; ` +
    `case "$out" in *"skill unchanged "*) mode=check ;; *) mode=undo ;; esac; ` +
    `node -e ${shellQuote(PI_PROFILE_UNDO_PROGRAM)} "$1"/${shellQuote(PI_AGENT_DIR)} ` +
    `"$1/$2"/${shellQuote(PI_AGENT_DIR)} "$mode"`,
  "mend-pi-profile",
  home,
  kept,
  JSON.stringify([
    plan?.vacate ?? {
      dir: PI_PROFILE_HOME_DIR,
      accept: [],
      delivering: null,
      skip: SESSION_BUILT,
      skipFiles: [PI_PROFILE_SECRET_FILE],
    },
  ]),
];

/**
 * The plan's files, unless the directory already held exactly them; then only the file the
 * comparison leaves out (`PI_PROFILE_SECRET_FILE`), which a restore never brings back.
 */
export const piProfileFilesToWrite = (
  plan: PiProfilePlan,
  outcomes: ReadonlyArray<SkillsVacateOutcome>,
): PiProfilePlan["files"] => {
  if (!outcomes.some((o) => o.dir === plan.vacate.dir && o.outcome === "unchanged")) {
    return plan.files;
  }
  const uncompared = (plan.vacate.skipFiles ?? []).map((file) =>
    path.posix.join(plan.vacate.dir, file),
  );
  return plan.files.filter((file) => uncompared.includes(file.path));
};

/**
 * Prepare a session's harness home on this machine (`preparePiProfileExec`) and write the owner's
 * profile into it, or leave it holding none (`plan` null): the co-located store, where that
 * directory is the workspace's mounted harness home. Capture mode runs the same exec and writes
 * the same files inside the workspace.
 */
export const materializePiProfile = (
  harnessHomePath: string,
  plan: PiProfilePlan | null,
): Effect.Effect<ReadonlyArray<SkillsVacateOutcome>, PiProfileDeliveryError> =>
  Effect.tryPromise({
    try: async () => {
      // A harness home that was never made was never mounted: nothing here would reach pi.
      await fs.access(harnessHomePath);
      const [command, ...args] = preparePiProfileExec(harnessHomePath, piProfileKeptDir(), plan);
      const prepared = spawnSync(command ?? "sh", args, { encoding: "utf8" });
      const outcomes = parseSkillsVacateOutcomes(prepared.stdout ?? "");
      if (prepared.status !== 0) {
        throw new Error(`could not clear ${PI_PROFILE_HOME_DIR}: ${prepared.stderr ?? ""}`);
      }
      if (plan === null) return outcomes;
      // As the workspace writer does (`workspace-files.ts`): directories 0755, files 0644.
      for (const file of piProfileFilesToWrite(plan, outcomes)) {
        const filePath = path.join(harnessHomePath, file.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.chmod(path.dirname(filePath), 0o755);
        await fs.writeFile(filePath, file.bytes, { mode: 0o644 });
        await fs.chmod(filePath, 0o644);
      }
      return outcomes;
    },
    catch: (error) =>
      new PiProfileDeliveryError({
        message: `the pi profile could not be written into the harness home: ${String(error)}`,
      }),
  });

/**
 * Runs before pi starts in a session (`PI_SEED`), with pi's agent directory as `argv[1]`, and does
 * nothing when no profile was delivered there. Every step says what it does on the terminal, and
 * none of them stops pi from starting:
 *
 * 1. Installs what the profile's extensions import (its `package.json`), what an extension with
 *    its own `package.json` imports when the profile's does not already name it all, and what each
 *    bundled local package imports, each in place. The directory's own scripts do not run (an
 *    extension's `prepare` is a build step of its author's, needing dev tools that are not
 *    installed); its dependencies' do, through `npm rebuild`. Nothing is written beside the
 *    delivered files (no lockfile), so the profile still reads as delivered at the next launch. A
 *    marker in `node_modules` skips an install already done. pi refuses to start when an extension cannot load, so these matter.
 * 2. Installs each `npm:` package `settings.json` declares, with the command pi itself runs, into
 *    pi's own `npm/` directory, so pi finds it there. pi installs a missing package itself at
 *    startup, but a package that fails to install there stops pi (observed 2026-10-01: a native
 *    build without `make`). One that fails here is left out of this session's settings, and the
 *    terminal says so.
 * 3. Merges the profile's settings into the session's `settings.json`. A setting the session has
 *    not changed since the last delivery takes the profile's value; one it changed keeps its own.
 *    The packages are the profile itself, the profile's, then any the session added.
 * 4. Copies `root/mcp.json` and `root/keybindings.json` into the agent directory, unless the
 *    session changed its copy since the last delivery.
 *
 * What was last delivered is kept beside the profile (`mend/delivered-*.json`). No single quotes:
 * the program rides `sh -c` inside them.
 */
export const PI_PROFILE_PROGRAM = [
  `try{const fs=require("fs"),path=require("path"),cp=require("child_process"),crypto=require("crypto");`,
  `const A=process.argv[1],M=path.join(A,"mend"),P=path.join(M,"profile");if(!fs.existsSync(P))process.exit(0);`,
  `const say=m=>process.stderr.write("mend: "+m+"\\n");`,
  `const sha=b=>crypto.createHash("sha256").update(b).digest("hex");`,
  READ_JSON_FUNCTION,
  PI_PACKAGE_KEY_FUNCTION,
  REAL_PATH_FUNCTION,
  `function put(p,v,mode){p=real(p);fs.mkdirSync(path.dirname(p),{recursive:true});const t=p+".mend-seed-"+process.pid;`,
  `fs.writeFileSync(t,Buffer.isBuffer(v)?v:JSON.stringify(v,null,2),{mode:mode||0o644});fs.renameSync(t,p)}`,
  `function why(r){const l=String(r.stderr||r.error||"").split("\\n").map(x=>x.trim()).filter(x=>x&&!/_logs\\/|complete log|^npm (ERR!|error) *$/.test(x));`,
  `const telling=l.find(x=>/not found|cannot find|ERESOLVE|E404|ETARGET|ENOTFOUND|EACCES|code E/i.test(x));return telling||(l.length?l[l.length-1]:"exit "+r.status)}`,
  `function npm(args,cwd){return cp.spawnSync("npm",args,{cwd,encoding:"utf8",stdio:["ignore","ignore","pipe"]})}`,
  `function deps(dir,label){let m;try{m=JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8"))}catch{return}`,
  `if(!m||!m.dependencies||Object.keys(m.dependencies).length===0)return;`,
  `const lock=path.join(dir,"package-lock.json"),locked=fs.existsSync(lock),verb=locked?"ci":"install";`,
  `const want=sha(fs.readFileSync(path.join(dir,"package.json"))+"\\0"+(locked?fs.readFileSync(lock):""));`,
  `const mark=path.join(dir,"node_modules",".mend-installed");try{if(fs.readFileSync(mark,"utf8")===want)return}catch{}`,
  `say("installing what "+label+" import");let r=npm([verb,...(locked?[]:["--no-package-lock"]),"--omit=dev","--ignore-scripts","--legacy-peer-deps","--no-audit","--no-fund"],dir);`,
  `if(r.status===0)r=npm(["rebuild"],dir);`,
  `if(r.status===0)fs.writeFileSync(mark,want);else say(label+": npm "+verb+" failed: "+why(r))}`,
  `deps(P,"your pi extensions");const list=d=>{try{return fs.readdirSync(d)}catch{return[]}};`,
  `let shared=[];try{shared=Object.keys(JSON.parse(fs.readFileSync(path.join(P,"package.json"),"utf8")).dependencies||{})}catch{}`,
  `for(const n of list(path.join(P,"extensions"))){const d=path.join(P,"extensions",n);let m;try{m=JSON.parse(fs.readFileSync(path.join(d,"package.json"),"utf8"))}catch{continue}`,
  `const names=Object.keys((m&&m.dependencies)||{});if(names.length>0&&!names.every(x=>shared.includes(x)))deps(d,"pi extension "+n)}`,
  `for(const n of list(path.join(P,"packages")))deps(path.join(P,"packages",n),"pi package "+n);`,
  `const prof=read(path.join(P,"settings.json"))||{},declared=Array.isArray(prof.packages)?prof.packages:[];`,
  `const src=e=>typeof e==="string"?e:e!==null&&typeof e==="object"&&typeof e.source==="string"?e.source:null;`,
  `const N=path.join(A,"npm"),failed=new Set();`,
  `for(const e of declared){const s=src(e);if(s===null||!s.startsWith("npm:"))continue;const spec=s.slice(4);`,
  `const at=spec.lastIndexOf("@"),name=at>0?spec.slice(0,at):spec,version=at>0?spec.slice(at+1):"";`,
  `let have=null;try{have=JSON.parse(fs.readFileSync(path.join(N,"node_modules",name,"package.json"),"utf8")).version}catch{}`,
  `if(typeof have==="string"&&(!/^\\d+\\.\\d+\\.\\d+(-[\\w.]+)?$/.test(version)||have===version))continue;`,
  `if(!fs.existsSync(path.join(N,"package.json")))put(path.join(N,"package.json"),{name:"pi-extensions",private:true});`,
  `say("installing pi package "+spec);const r=npm(["install",spec,"--prefix",N,"--legacy-peer-deps","--no-audit","--no-fund"],A);`,
  `if(r.status!==0){failed.add(s);say("pi package "+spec+" did not install, so this session runs without it: "+why(r))}}`,
  `const S=path.join(A,"settings.json"),D=path.join(M,"delivered-settings.json"),cur=read(S),last=read(D);`,
  `if(cur===null)say("settings.json could not be read, so your profile settings were not applied");`,
  `else if(last===null)say("mend/delivered-settings.json could not be read, so your profile settings were not applied");else{`,
  `const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),has=Object.hasOwn,out=Object.assign({},cur);`,
  `for(const k of Object.keys(prof)){if(k!=="packages"&&(!has(cur,k)||same(cur[k],last[k])))out[k]=prof[k]}`,
  `for(const k of Object.keys(last)){if(k!=="packages"&&!has(prof,k)&&has(cur,k)&&same(cur[k],last[k]))delete out[k]}`,
  `const delivered=["./${PI_PROFILE_AGENT_PATH}",...declared.filter(e=>!failed.has(src(e)))];`,
  `const lastPkgs=Array.isArray(last.packages)?last.packages:[],curPkgs=Array.isArray(cur.packages)?cur.packages:[];`,
  `const lastBy=new Map(lastPkgs.map(e=>[pkgKey(e),e])),curBy=new Map(curPkgs.map(e=>[pkgKey(e),e])),now=new Set(delivered.map(pkgKey));`,
  `const kept=e=>{const k=pkgKey(e),c=curBy.get(k);return c!==undefined&&lastBy.has(k)&&!same(c,lastBy.get(k))?c:e};`,
  `out.packages=[...delivered.map(kept),...curPkgs.filter(e=>!lastBy.has(pkgKey(e))&&!now.has(pkgKey(e)))];`,
  `const next=Object.assign({},prof,{packages:delivered});`,
  `put(D,Object.assign({},last,next,{packages:[...lastPkgs,...delivered]}));put(S,out,0o600);put(D,next)}`,
  `const F=path.join(M,"delivered-files.json"),lastFiles=read(F)||{},nextFiles={},union=Object.assign({},lastFiles);`,
  `for(const f of ["mcp.json","keybindings.json"]){let want;try{want=fs.readFileSync(path.join(P,"root",f))}catch{continue}`,
  `const to=path.join(A,f);let have=null;try{have=sha(fs.readFileSync(to))}catch(e){if(e.code!=="ENOENT")continue}`,
  `if(have===null||have===lastFiles[f]||have===sha(want)){union[f]=sha(want);put(F,union);put(to,want,0o600);nextFiles[f]=sha(want)}`,
  `else{say(f+" was changed in this session, so the profile did not replace it");if(lastFiles[f])nextFiles[f]=lastFiles[f]}}`,
  `put(F,nextFiles)}catch(e){process.stderr.write("mend: the pi profile was not set up: "+(e&&e.message)+"\\n")}`,
].join("");
