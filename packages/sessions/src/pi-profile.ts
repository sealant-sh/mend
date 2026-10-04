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

/** The exec that clears the way for `plan` in a workspace's harness home (`SKILLS_VACATE_PROGRAM`). */
export const vacatePiProfileExec = (
  home: string,
  kept: string,
  plan: PiProfilePlan,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  `set -e; mkdir -p "$1"/${shellQuote(path.posix.dirname(PI_PROFILE_HOME_DIR))}; ` +
    `exec node -e ${shellQuote(SKILLS_VACATE_PROGRAM)} "$1" "$2" "$3"`,
  "mend-pi-profile",
  home,
  kept,
  JSON.stringify([plan.vacate]),
];

/**
 * Where a clear leaves its mark, relative to the harness home: `PI_PROFILE_PROGRAM` takes a gone
 * profile's settings back out only when Mend cleared it on purpose, never when a delivery failed
 * after the vacate moved a profile aside.
 */
export const PI_PROFILE_CLEARED = path.posix.join(
  path.posix.dirname(PI_PROFILE_HOME_DIR),
  "cleared",
);

/** The vacate that moves a profile out of the way with nothing to deliver in its place. */
const CLEAR_VACATE: SkillsVacate = {
  dir: PI_PROFILE_HOME_DIR,
  accept: [],
  delivering: null,
  skip: SESSION_BUILT,
};

/**
 * The exec that takes a delivered profile out of a pi session's harness home when the session has
 * no profile of its owner's: in capture mode the harness home is the worktree's, so the profile
 * there is whoever's session delivered it last. Moved aside whole, as a replaced profile is
 * (`.mend/pi-profile-kept/<stamp>/`, never saved with the session), never deleted, and marked
 * (`PI_PROFILE_CLEARED`) so `PI_PROFILE_PROGRAM` takes its settings back out before pi starts.
 * Exits non-zero when the profile could not be moved: the launch then stops.
 */
export const clearPiProfileExec = (home: string, kept: string): ReadonlyArray<string> => [
  "sh",
  "-c",
  `set -e; mkdir -p "$1"/${shellQuote(path.posix.dirname(PI_PROFILE_HOME_DIR))}; ` +
    `node -e ${shellQuote(SKILLS_VACATE_PROGRAM)} "$1" "$2" "$3"; ` +
    `: > "$1"/${shellQuote(PI_PROFILE_CLEARED)}`,
  "mend-pi-profile",
  home,
  kept,
  JSON.stringify([CLEAR_VACATE]),
];

/** The same on this machine: the co-located store's harness home. */
export const clearPiProfile = (
  harnessHomePath: string,
): Effect.Effect<ReadonlyArray<SkillsVacateOutcome>, PiProfileDeliveryError> =>
  Effect.try({
    try: () => {
      const [command, ...args] = clearPiProfileExec(harnessHomePath, piProfileKeptDir());
      const cleared = spawnSync(command ?? "sh", args, { encoding: "utf8" });
      if (cleared.status !== 0) {
        throw new Error(`could not move ${PI_PROFILE_HOME_DIR} aside: ${cleared.stderr ?? ""}`);
      }
      return parseSkillsVacateOutcomes(cleared.stdout ?? "");
    },
    catch: (error) =>
      new PiProfileDeliveryError({
        message: `the pi profile could not be taken out of the harness home: ${String(error)}`,
      }),
  });

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
 * Write the profile into a session's harness home on this machine: the co-located store, where
 * that directory is the workspace's mounted harness home. Capture mode applies the same plan
 * inside the workspace through exec.
 */
export const materializePiProfile = (
  harnessHomePath: string,
  plan: PiProfilePlan,
): Effect.Effect<ReadonlyArray<SkillsVacateOutcome>, PiProfileDeliveryError> =>
  Effect.tryPromise({
    try: async () => {
      // A harness home that was never made was never mounted: nothing here would reach pi.
      await fs.access(harnessHomePath);
      await fs.mkdir(path.join(harnessHomePath, path.dirname(PI_PROFILE_HOME_DIR)), {
        recursive: true,
      });
      const vacated = spawnSync(
        process.execPath,
        [
          "-e",
          SKILLS_VACATE_PROGRAM,
          harnessHomePath,
          piProfileKeptDir(),
          JSON.stringify([plan.vacate]),
        ],
        { encoding: "utf8" },
      );
      const outcomes = parseSkillsVacateOutcomes(vacated.stdout ?? "");
      if (vacated.status !== 0) {
        throw new Error(`could not clear ${PI_PROFILE_HOME_DIR}: ${vacated.stderr ?? ""}`);
      }
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
 * 5. When Mend cleared the profile (`clearPiProfileExec`: the session has no profile of its
 *    owner's, and the one there was whoever's session delivered it) and an earlier delivery's
 *    records are there: takes its settings and packages back out of `settings.json` where the
 *    session left them as delivered, removes the copied files it did not change, and drops the
 *    records. One person's profile never runs in another person's pi. A profile that is gone
 *    without that mark is a delivery that failed: what it delivered before stays, and the terminal
 *    says so.
 *
 * What was last delivered is kept beside the profile (`mend/delivered-*.json`). No single quotes:
 * the program rides `sh -c` inside them.
 */
export const PI_PROFILE_PROGRAM = [
  `try{const fs=require("fs"),path=require("path"),cp=require("child_process"),crypto=require("crypto");`,
  `const A=process.argv[1],M=path.join(A,"mend"),P=path.join(M,"profile"),C=path.join(M,"cleared"),gone=!fs.existsSync(P);`,
  `const say=m=>process.stderr.write("mend: "+m+"\\n");`,
  `if(!gone)fs.rmSync(C,{force:true});`,
  `else if(!fs.existsSync(path.join(M,"delivered-settings.json"))&&!fs.existsSync(path.join(M,"delivered-files.json"))){fs.rmSync(C,{force:true});process.exit(0)}`,
  `else if(!fs.existsSync(C)){say("the pi profile was not delivered to this session, so what it delivered before stays as it is");process.exit(0)}`,
  `const sha=b=>crypto.createHash("sha256").update(b).digest("hex");`,
  `function read(p){try{const v=JSON.parse(fs.readFileSync(p,"utf8"));return v!==null&&typeof v==="object"&&!Array.isArray(v)?v:null}catch(e){return e.code==="ENOENT"?{}:null}}`,
  `function put(p,v,mode){fs.mkdirSync(path.dirname(p),{recursive:true});const t=p+".mend-seed-"+process.pid;`,
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
  `const S=path.join(A,"settings.json"),D=path.join(M,"delivered-settings.json"),cur=read(S);`,
  `if(cur===null)say("settings.json could not be read, so your profile settings were not applied");else{`,
  `const last=read(D)||{},same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),has=Object.hasOwn,out=Object.assign({},cur);`,
  `for(const k of Object.keys(prof)){if(k!=="packages"&&(!has(cur,k)||same(cur[k],last[k])))out[k]=prof[k]}`,
  `for(const k of Object.keys(last)){if(k!=="packages"&&!has(prof,k)&&has(cur,k)&&same(cur[k],last[k]))delete out[k]}`,
  `const id=e=>JSON.stringify(e),delivered=gone?[]:["./${PI_PROFILE_AGENT_PATH}",...declared.filter(e=>!failed.has(src(e)))];`,
  `const before=new Set((Array.isArray(last.packages)?last.packages:[]).map(id)),now=new Set(delivered.map(id));`,
  `out.packages=[...delivered,...(Array.isArray(cur.packages)?cur.packages:[]).filter(e=>!before.has(id(e))&&!now.has(id(e)))];`,
  `put(S,out,0o600);if(gone)fs.rmSync(D,{force:true});else put(D,Object.assign({},prof,{packages:delivered}))}`,
  `const F=path.join(M,"delivered-files.json"),lastFiles=read(F)||{},nextFiles={};`,
  `for(const f of ["mcp.json","keybindings.json"]){let want;try{want=fs.readFileSync(path.join(P,"root",f))}catch{`,
  `if(gone&&lastFiles[f]){const to=path.join(A,f);try{if(sha(fs.readFileSync(to))===lastFiles[f])fs.rmSync(to)}catch{}}continue}`,
  `const to=path.join(A,f);let have=null;try{have=sha(fs.readFileSync(to))}catch(e){if(e.code!=="ENOENT")continue}`,
  `if(have===null||have===lastFiles[f]||have===sha(want)){put(to,want,0o600);nextFiles[f]=sha(want)}`,
  `else{say(f+" was changed in this session, so the profile did not replace it");if(lastFiles[f])nextFiles[f]=lastFiles[f]}}`,
  `if(gone){fs.rmSync(F,{force:true});fs.rmSync(C,{force:true});say("no pi profile is connected for this session, so the one delivered here before was taken out")}else put(F,nextFiles)}catch(e){process.stderr.write("mend: the pi profile was not set up: "+(e&&e.message)+"\\n")}`,
].join("");
