import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SkillWithFiles } from "@mend/domain/workbench";
import { validateSkillFilePath, validateSkillName } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

/**
 * Launch-side skills materialization. The mounted harness home is the seam
 * (plan §17: "skills management writes into `harness-home/.claude/skills`
 * with no workspace exec"): bundles are written server-side before the
 * workspace boots, and the boot relocation's `cp -an` keeps mount-side files
 * on collision, so what is written here is exactly what the harness reads.
 *
 * Every harness gets the same library in its own discovery location — claude
 * reads `$HOME/.claude/skills`, codex reads `$CODEX_HOME/skills` (both
 * symlinked onto the mount at boot). On a name collision the project's skill
 * wins over the user's: the more specific library overrides.
 *
 * Capture mode (ADR-0002) mounts nothing, so there the same plan (`planSkills`) is applied inside
 * the live workspace's harness home through exec, after the launch relocates it.
 */

/** Harness-home-relative skills directories, one per harness that reads skills. */
export const SKILL_TARGET_DIRS = [".claude/skills", ".codex/skills"] as const;

/**
 * The bookkeeping file that makes materialization reconciling rather than
 * additive: it records which bundle directories Mend wrote, so a skill
 * removed from the library disappears from the next launch too — while
 * directories the agent created itself are never touched.
 */
const MANAGED_MANIFEST = ".mend-managed-skills.json";

const ManagedManifest = Schema.Record(Schema.String, Schema.Array(Schema.String));

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
  readonly remove: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
  readonly manifest: string;
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
): SkillsPlan | null => {
  const deliverable = bundles.filter(
    (bundle) =>
      validateSkillName(bundle.skill.name) === null &&
      bundle.files.every((file) => validateSkillFilePath(file.path) === null),
  );
  const names = deliverable.map((bundle) => bundle.skill.name);
  if (names.length === 0 && Object.keys(previous).length === 0) return null;
  const current = new Set(names);
  const remove: Array<string> = [];
  const files: Array<{ readonly path: string; readonly contents: string }> = [];
  for (const target of SKILL_TARGET_DIRS) {
    for (const stale of previous[target] ?? []) {
      if (current.has(stale) || validateSkillName(stale) !== null) continue;
      remove.push(path.posix.join(target, stale));
    }
    for (const bundle of deliverable) {
      const bundleRoot = path.posix.join(target, bundle.skill.name);
      remove.push(bundleRoot);
      for (const file of bundle.files) {
        files.push({ path: path.posix.join(bundleRoot, file.path), contents: file.contents });
      }
    }
  }
  const manifest = Object.fromEntries(SKILL_TARGET_DIRS.map((target) => [target, names]));
  return {
    directories: [...SKILL_TARGET_DIRS],
    remove,
    files,
    manifest: JSON.stringify(manifest, null, 2),
  };
};

const readManifest = async (
  harnessHomePath: string,
): Promise<Record<string, ReadonlyArray<string>>> => {
  try {
    return parseManagedSkills(
      await fs.readFile(path.join(harnessHomePath, MANAGED_MANIFEST), "utf8"),
    );
  } catch {
    // Absent or unreadable — nothing was managed before.
    return {};
  }
};

/**
 * Write the merged library into the session's harness home on this machine (`planSkills`): the
 * co-located store, where that directory is mounted into the workspace. Capture mode mounts
 * nothing, and the engine applies the same plan inside the live workspace.
 */
export const materializeSkills = (
  harnessHomePath: string,
  bundles: ReadonlyArray<SkillWithFiles>,
): Effect.Effect<void, SkillMaterializeError> =>
  Effect.tryPromise({
    try: async () => {
      const plan = planSkills(await readManifest(harnessHomePath), bundles);
      if (plan === null) return;
      for (const directory of plan.directories) {
        await fs.mkdir(path.join(harnessHomePath, directory), { recursive: true });
      }
      for (const stale of plan.remove) {
        await fs.rm(path.join(harnessHomePath, stale), { recursive: true, force: true });
      }
      for (const file of plan.files) {
        const filePath = path.join(harnessHomePath, file.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, file.contents, "utf8");
      }
      await fs.writeFile(path.join(harnessHomePath, MANAGED_MANIFEST), plan.manifest, "utf8");
    },
    catch: (error) =>
      new SkillMaterializeError({
        message: `skills could not be written into the harness home: ${String(error)}`,
      }),
  });
