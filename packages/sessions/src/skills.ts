import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SkillWithFiles } from "@mend/domain/workbench";
import { validateSkillFilePath, validateSkillName } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { shellQuote } from "./workspace-files.ts";

/**
 * Launch-side skills materialization. The mounted harness home is the seam
 * (plan §17: "skills management writes into `harness-home/.claude/skills`
 * with no workspace exec"): bundles are written server-side before the
 * workspace boots, and the boot relocation keeps mount-side files
 * on collision, so what is written here is exactly what the harness reads.
 *
 * Every harness gets the same library in its own discovery location — claude
 * reads `$HOME/.claude/skills`, codex reads `$CODEX_HOME/skills` (both
 * symlinked onto the mount at boot). On a name collision the project's skill
 * wins over the user's: the more specific library overrides.
 *
 * Capture mode (ADR-0002) mounts nothing, so there the same plan (`planSkills`) is applied inside
 * the live workspace's harness home through exec, after the launch relocates it.
 *
 * A delivered skill directory is also where the agent or the user edits a skill, and the harness
 * home comes back whole from a capture. So a directory that already holds exactly the files about
 * to be delivered (`skillTreeDigest`, contents only) is left as it is: not removed, not rewritten,
 * whatever the user did to its modes, times, empty directories or links (review 2026-09-28 (18)).
 * A directory Mend is about to replace or retire is never deleted: it is moved aside whole (a
 * rename keeps its metadata) to `.mend/skills-kept/<stamp>/…` in the harness home. That covers an
 * edited skill, a script made executable, a file whose time alone changed, and a directory of the
 * agent's own that a library skill now shares a name with (review 2026-09-28 (17), sweep; (19):
 * an ownership check that read no times deleted a skill whose only change was an mtime). One
 * program does this in both stores (`SKILLS_VACATE_PROGRAM`).
 */

/**
 * Harness-home-relative skills directories, one per harness that reads skills. opencode needs none
 * of its own: it reads Claude Code's `~/.claude/skills`.
 */
export const SKILL_TARGET_DIRS = [".claude/skills", ".codex/skills", ".pi/agent/skills"] as const;

/**
 * The bookkeeping file that makes materialization reconciling rather than
 * additive: it records which bundle directories Mend wrote, so a skill
 * removed from the library disappears from the next launch too — while
 * directories the agent created itself are never touched.
 */
const MANAGED_MANIFEST = ".mend-managed-skills.json";

const ManagedManifest = Schema.Record(Schema.String, Schema.Array(Schema.String));

/**
 * What Mend last delivered, per skills directory and bundle name: the `skillTreeDigest` of the
 * files it wrote. A separate file, so a Mend that predates it still reads its manifest.
 */
const MANAGED_DIGESTS = ".mend-managed-skills-digests.json";

const ManagedDigests = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String));

/** Where a directory that is not Mend's to delete goes, relative to the harness home. */
export const SKILLS_KEPT_DIR = ".mend/skills-kept";

export class SkillMaterializeError extends Schema.TaggedErrorClass<SkillMaterializeError>()(
  "SkillMaterializeError",
  { message: Schema.String },
) {}

/**
 * Resolve the delivered set. User skills form the optional base; project skills always remain
 * enabled and replace inherited skills with the same name.
 */
export const mergeSkillLibraries = (
  libraries: {
    readonly user: ReadonlyArray<SkillWithFiles>;
    readonly project: ReadonlyArray<SkillWithFiles>;
  },
  options: { readonly inheritUserSkills: boolean },
): ReadonlyArray<SkillWithFiles> => {
  const byName = new Map<string, SkillWithFiles>();
  if (options.inheritUserSkills) {
    for (const bundle of libraries.user) byName.set(bundle.skill.name, bundle);
  }
  for (const bundle of libraries.project) byName.set(bundle.skill.name, bundle);
  return [...byName.values()];
};

/** The bookkeeping file's name, relative to the harness home. */
export const MANAGED_SKILLS_MANIFEST = MANAGED_MANIFEST;

/** The digests file's name, relative to the harness home. */
export const MANAGED_SKILLS_DIGESTS = MANAGED_DIGESTS;

/** Read the digests; anything unreadable is "no directory is known to be Mend's as it stands". */
export const parseManagedSkillDigests = (
  raw: string | null,
): Record<string, Record<string, string>> => {
  if (raw === null) return {};
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(ManagedDigests))(raw);
  } catch {
    return {};
  }
};

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * One digest for a directory's files: each regular file's path (relative, `/`-separated) and the
 * SHA-256 of its bytes, sorted by path. Empty directories do not count; anything that is neither a
 * file nor a directory makes the tree unlike any bundle. `SKILLS_VACATE_PROGRAM` computes the same
 * digest on disk.
 */
export const skillTreeDigest = (
  files: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
): string =>
  sha256(
    files
      .map((file) => [file.path, sha256(file.contents)] as const)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([file, digest]) => `${file}\u0000${digest}\n`)
      .join(""),
  );

/** Read a manifest's contents; anything unreadable is "nothing was managed before". */
export const parseManagedSkills = (raw: string | null): Record<string, ReadonlyArray<string>> => {
  if (raw === null) return {};
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(ManagedManifest))(raw);
  } catch {
    return {};
  }
};

/**
 * What one delivery does to a harness home, relative to it: the directories to create, the
 * bundle directories to remove (stale ones, and the ones about to be rewritten), the files to
 * write and the manifest's new contents. Null when there is nothing to do: an empty library with
 * nothing managed before must not manufacture directories — the engine reads an empty home as
 * "no live harness state yet", and that signal steers archive restores on relaunch.
 */
export interface SkillsPlan {
  readonly directories: ReadonlyArray<string>;
  /**
   * Bundle directories to clear before the files are written: stale ones, and the ones about to
   * be rewritten. Each is moved aside, unless it already holds exactly `delivering`.
   */
  readonly vacate: ReadonlyArray<SkillsVacate>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
  readonly manifest: string;
  /** The digests file's new contents. */
  readonly digests: string;
}

/** One directory to clear, relative to the harness home. */
export interface SkillsVacate {
  readonly dir: string;
  /**
   * The trees Mend delivered here (this delivery's and the last one's). Reported, never a reason
   * to delete: nothing on disk says the times and the rest are still Mend's.
   */
  readonly accept: ReadonlyArray<string>;
  /**
   * The tree about to be delivered here, or null for a skill being retired. A directory whose
   * files are exactly this tree is left untouched and its files are not written again.
   */
  readonly delivering: string | null;
}

/**
 * Plan the merged library into every harness's skills directory, removing bundles Mend managed on
 * a previous launch that the library no longer carries. Defense in depth: rows are validated at
 * the API seam, but names and paths are re-checked before they touch any filesystem — an invalid
 * bundle is skipped, never a traversal.
 */
export const planSkills = (
  previous: Record<string, ReadonlyArray<string>>,
  bundles: ReadonlyArray<SkillWithFiles>,
  previousDigests: Record<string, Record<string, string>> = {},
): SkillsPlan | null => {
  const deliverable = bundles.filter(
    (bundle) =>
      validateSkillName(bundle.skill.name) === null &&
      bundle.files.every((file) => validateSkillFilePath(file.path) === null),
  );
  const names = deliverable.map((bundle) => bundle.skill.name);
  if (names.length === 0 && Object.keys(previous).length === 0) return null;
  const current = new Set(names);
  const vacate: Array<SkillsVacate> = [];
  const files: Array<{ readonly path: string; readonly contents: string }> = [];
  const digests: Record<string, Record<string, string>> = {};
  for (const target of SKILL_TARGET_DIRS) {
    const delivered = previousDigests[target] ?? {};
    const lastDelivered = (name: string): ReadonlyArray<string> => {
      const digest = Object.hasOwn(delivered, name) ? delivered[name] : undefined;
      return digest === undefined ? [] : [digest];
    };
    for (const stale of previous[target] ?? []) {
      if (current.has(stale) || validateSkillName(stale) !== null) continue;
      vacate.push({
        dir: path.posix.join(target, stale),
        accept: lastDelivered(stale),
        delivering: null,
      });
    }
    const targetDigests: Record<string, string> = {};
    for (const bundle of deliverable) {
      const bundleRoot = path.posix.join(target, bundle.skill.name);
      const digest = skillTreeDigest(bundle.files);
      targetDigests[bundle.skill.name] = digest;
      vacate.push({
        dir: bundleRoot,
        accept: [...new Set([digest, ...lastDelivered(bundle.skill.name)])],
        delivering: digest,
      });
      for (const file of bundle.files) {
        files.push({ path: path.posix.join(bundleRoot, file.path), contents: file.contents });
      }
    }
    digests[target] = targetDigests;
  }
  const manifest = Object.fromEntries(SKILL_TARGET_DIRS.map((target) => [target, names]));
  return {
    directories: [...SKILL_TARGET_DIRS],
    vacate,
    files,
    manifest: JSON.stringify(manifest, null, 2),
    digests: JSON.stringify(digests, null, 2),
  };
};

/**
 * Clears the plan's directories under a harness home (`node -e`, argv: home, the kept directory
 * relative to it, the `vacate` list as JSON). Prints one `skill <outcome> <dir>[ <detail>]` line
 * per directory: `absent`; `unchanged` (its files are exactly `delivering`; nothing was touched
 * and nothing is written into it); `kept` (moved whole to the detail path; nothing is ever
 * deleted); `error` (the detail is the code). Exits 1 after any `error`,
 * and the caller then writes nothing: a directory that could not be cleared is never written into.
 */
export const SKILLS_VACATE_PROGRAM = [
  `const fs=require("fs"),path=require("path"),crypto=require("crypto");`,
  `const [home,kept,list]=process.argv.slice(1);const items=JSON.parse(list);`,
  `const sha=b=>crypto.createHash("sha256").update(b).digest("hex");`,
  `function tree(dir){const out=[];const walk=(abs,rel)=>{for(const e of fs.readdirSync(abs,{withFileTypes:true})){`,
  `const a=path.join(abs,e.name),r=rel===""?e.name:rel+"/"+e.name;`,
  `if(e.isDirectory())walk(a,r);else if(e.isFile())out.push([r,sha(fs.readFileSync(a))]);else throw new Error("special")}};`,
  `walk(dir,"");out.sort((x,y)=>x[0]<y[0]?-1:x[0]>y[0]?1:0);return sha(out.map(([r,h])=>r+"\\u0000"+h+"\\n").join(""))}`,
  `function say(o,d,x){process.stdout.write("skill "+o+" "+d+(x?" "+x:"")+"\\n")}`,
  `let failed=false;for(const it of items){const abs=path.join(home,it.dir);let st;`,
  `try{st=fs.lstatSync(abs)}catch(e){if(e.code==="ENOENT"){say("absent",it.dir);continue}say("error",it.dir,e.code);failed=true;continue}`,
  `let digest=null;if(st.isDirectory()){try{digest=tree(abs)}catch{digest=null}}`,
  `if(digest!==null&&it.delivering!==null&&digest===it.delivering){say("unchanged",it.dir);continue}`,
  `try{const rel=path.join(kept,it.dir),to=path.join(home,rel);fs.mkdirSync(path.dirname(to),{recursive:true});fs.renameSync(abs,to);say("kept",it.dir,rel)}`,
  `catch(e){say("error",it.dir,e.code||"error");failed=true}}`,
  `process.exit(failed?1:0)`,
].join("");

/** A fresh kept directory for one delivery, relative to the harness home. */
export const skillsKeptDir = (now: Date = new Date()): string =>
  path.posix.join(
    SKILLS_KEPT_DIR,
    `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  );

/**
 * The exec that prepares a workspace's harness home for `plan`: the skills directories exist, and
 * every directory in `plan.vacate` is left unchanged or kept aside.
 */
export const vacateSkillsExec = (
  home: string,
  kept: string,
  plan: SkillsPlan,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  `set -e; ${plan.directories.map((dir) => `mkdir -p "$1"/${shellQuote(dir)}`).join("; ")}; ` +
    `exec node -e ${shellQuote(SKILLS_VACATE_PROGRAM)} "$1" "$2" "$3"`,
  "mend-skills",
  home,
  kept,
  JSON.stringify(plan.vacate),
];

/** What the vacate program did with one directory. */
export interface SkillsVacateOutcome {
  readonly outcome: "absent" | "unchanged" | "kept" | "error";
  readonly dir: string;
  readonly detail: string | null;
}

export const parseSkillsVacateOutcomes = (stdout: string): ReadonlyArray<SkillsVacateOutcome> =>
  stdout.split("\n").flatMap((line): ReadonlyArray<SkillsVacateOutcome> => {
    const match = /^skill (absent|unchanged|kept|error) (\S+)(?: (.*))?$/.exec(line);
    if (match === null) return [];
    const outcome = match[1];
    if (
      outcome !== "absent" &&
      outcome !== "unchanged" &&
      outcome !== "kept" &&
      outcome !== "error"
    ) {
      return [];
    }
    return [{ outcome, dir: match[2] ?? "", detail: match[3] ?? null }];
  });

/**
 * The plan's files minus those of every directory the vacate program left `unchanged`: those
 * already hold exactly these bytes, and writing them again would reset what the user set on them.
 */
export const skillFilesToWrite = (
  plan: SkillsPlan,
  outcomes: ReadonlyArray<SkillsVacateOutcome>,
): SkillsPlan["files"] => {
  const unchanged = outcomes
    .filter((outcome) => outcome.outcome === "unchanged")
    .map((outcome) => `${outcome.dir}/`);
  return plan.files.filter((file) => !unchanged.some((dir) => file.path.startsWith(dir)));
};

const readOptional = async (file: string): Promise<string | null> => {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    // Absent or unreadable: the parsers read null as "nothing known".
    return null;
  }
};

/**
 * Write the merged library into the session's harness home on this machine (`planSkills`): the
 * co-located store, where that directory is mounted into the workspace. Capture mode mounts
 * nothing, and the engine applies the same plan inside the live workspace. Answers what happened
 * to each directory it cleared.
 */
export const materializeSkills = (
  harnessHomePath: string,
  bundles: ReadonlyArray<SkillWithFiles>,
): Effect.Effect<ReadonlyArray<SkillsVacateOutcome>, SkillMaterializeError> =>
  Effect.tryPromise({
    try: async () => {
      const plan = planSkills(
        parseManagedSkills(await readOptional(path.join(harnessHomePath, MANAGED_MANIFEST))),
        bundles,
        parseManagedSkillDigests(await readOptional(path.join(harnessHomePath, MANAGED_DIGESTS))),
      );
      if (plan === null) return [];
      for (const directory of plan.directories) {
        await fs.mkdir(path.join(harnessHomePath, directory), { recursive: true });
      }
      const vacated = spawnSync(
        process.execPath,
        [
          "-e",
          SKILLS_VACATE_PROGRAM,
          harnessHomePath,
          skillsKeptDir(),
          JSON.stringify(plan.vacate),
        ],
        { encoding: "utf8" },
      );
      const outcomes = parseSkillsVacateOutcomes(vacated.stdout ?? "");
      if (vacated.status !== 0) {
        throw new Error(
          `could not clear ${
            outcomes
              .filter((outcome) => outcome.outcome === "error")
              .map((outcome) => `${outcome.dir} (${outcome.detail ?? "error"})`)
              .join(", ") || `the skills directories (${vacated.stderr ?? ""})`
          }`,
        );
      }
      // As the workspace writer does (`workspace-files.ts`): each file's directory 0755, the
      // file 0644. Every path here is under a directory the vacate just cleared.
      for (const file of skillFilesToWrite(plan, outcomes)) {
        const filePath = path.join(harnessHomePath, file.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.chmod(path.dirname(filePath), 0o755);
        await fs.writeFile(filePath, file.contents, { encoding: "utf8", mode: 0o644 });
        await fs.chmod(filePath, 0o644);
      }
      await fs.writeFile(path.join(harnessHomePath, MANAGED_MANIFEST), plan.manifest, "utf8");
      await fs.writeFile(path.join(harnessHomePath, MANAGED_DIGESTS), plan.digests, "utf8");
      return outcomes;
    },
    catch: (error) =>
      new SkillMaterializeError({
        message: `skills could not be written into the harness home: ${String(error)}`,
      }),
  });
