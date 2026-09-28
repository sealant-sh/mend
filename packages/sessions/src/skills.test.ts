import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SkillId } from "@mend/domain";
import { Skill, SkillWithFiles } from "@mend/domain/workbench";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  MANAGED_SKILLS_DIGESTS,
  MANAGED_SKILLS_MANIFEST,
  materializeSkills,
  mergeSkillLibraries,
  parseSkillsVacateOutcomes,
  planSkills,
  SKILL_TARGET_DIRS,
  SKILLS_KEPT_DIR,
  skillFilesToWrite,
  skillTreeDigest,
  vacateSkillsExec,
} from "./skills.ts";

const bundle = (
  name: string,
  files: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
  scope: "user" | "project" = "user",
): SkillWithFiles =>
  new SkillWithFiles({
    skill: new Skill({
      id: SkillId.make(`id-${name}-${scope}`),
      scope,
      ownerUserId: scope === "user" ? "user-1" : null,
      projectId: null,
      name,
      description: "",
      fileCount: files.length,
      bytes: 0,
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    files,
  });

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "mend-skills-home-"));

describe("mergeSkillLibraries", () => {
  it("project wins over user by name", () => {
    const merged = mergeSkillLibraries(
      {
        user: [bundle("a", [{ path: "SKILL.md", contents: "user a" }])],
        project: [bundle("a", [{ path: "SKILL.md", contents: "project a" }], "project")],
      },
      { inheritUserSkills: true },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.files[0]?.contents).toBe("project a");
  });

  it("inherits user skills by default when enabled", () => {
    const merged = mergeSkillLibraries(
      {
        user: [bundle("global", [{ path: "SKILL.md", contents: "user" }])],
        project: [bundle("local", [{ path: "SKILL.md", contents: "project" }], "project")],
      },
      { inheritUserSkills: true },
    );
    expect(merged.map((entry) => entry.skill.name)).toEqual(["global", "local"]);
  });

  it("keeps project skills and excludes user skills when inheritance is off", () => {
    const merged = mergeSkillLibraries(
      {
        user: [bundle("global", [{ path: "SKILL.md", contents: "user" }])],
        project: [bundle("local", [{ path: "SKILL.md", contents: "project" }], "project")],
      },
      { inheritUserSkills: false },
    );
    expect(merged.map((entry) => entry.skill.name)).toEqual(["local"]);
  });
});

describe("materializeSkills", () => {
  it("writes every bundle into every harness's skills directory", async () => {
    const home = tmpHome();
    await Effect.runPromise(
      materializeSkills(home, [
        bundle("review", [
          { path: "SKILL.md", contents: "# review" },
          { path: "references/notes.md", contents: "notes" },
        ]),
      ]),
    );
    for (const target of SKILL_TARGET_DIRS) {
      expect(fs.readFileSync(path.join(home, target, "review", "SKILL.md"), "utf8")).toBe(
        "# review",
      );
      expect(
        fs.readFileSync(path.join(home, target, "review", "references", "notes.md"), "utf8"),
      ).toBe("notes");
    }
  });

  it("reconciles: a skill gone from the library disappears; foreign dirs survive", async () => {
    const home = tmpHome();
    await Effect.runPromise(
      materializeSkills(home, [
        bundle("kept", [{ path: "SKILL.md", contents: "k" }]),
        bundle("dropped", [{ path: "SKILL.md", contents: "d" }]),
      ]),
    );
    // A directory the agent made itself, outside Mend's bookkeeping.
    const foreign = path.join(home, ".claude", "skills", "hand-made");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "SKILL.md"), "mine");

    await Effect.runPromise(
      materializeSkills(home, [bundle("kept", [{ path: "SKILL.md", contents: "k2" }])]),
    );
    expect(fs.existsSync(path.join(home, ".claude", "skills", "dropped"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex", "skills", "dropped"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".claude", "skills", "kept", "SKILL.md"), "utf8")).toBe(
      "k2",
    );
    expect(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8")).toBe("mine");
  });

  it("an empty library leaves the harness home untouched", async () => {
    const home = tmpHome();
    await Effect.runPromise(materializeSkills(home, []));
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("skips a bundle whose name or paths could escape", async () => {
    const home = tmpHome();
    await Effect.runPromise(
      materializeSkills(home, [
        bundle("ok", [{ path: "SKILL.md", contents: "fine" }]),
        bundle("evil", [{ path: "../escape.md", contents: "nope" }]),
      ]),
    );
    expect(fs.existsSync(path.join(home, ".claude", "skills", "ok", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "evil"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude", "escape.md"))).toBe(false);
  });
});

const skill = (home: string, target: string, name: string, file = "SKILL.md") =>
  path.join(home, target, name, file);
const keptRoot = (home: string) => path.join(home, SKILLS_KEPT_DIR);
/** Every file under the kept root, relative to its stamp directory, with its contents. */
const keptFiles = (home: string): Record<string, string> => {
  const root = keptRoot(home);
  if (!fs.existsSync(root)) return {};
  const out: Record<string, string> = {};
  for (const stamp of fs.readdirSync(root)) {
    const walk = (dir: string, rel: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const next = path.join(dir, entry.name);
        const relNext = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(next, relNext);
        else
          out[relNext] = entry.isSymbolicLink()
            ? `-> ${fs.readlinkSync(next)}`
            : fs.readFileSync(next, "utf8");
      }
    };
    walk(path.join(root, stamp), "");
  }
  return out;
};
const deliver = (home: string, bundles: ReadonlyArray<SkillWithFiles>) =>
  Effect.runPromise(materializeSkills(home, bundles));

/**
 * Review 2026-09-28 (17), sweep: every delivery used to `rm -rf` each bundle's directory before
 * rewriting it, and every retired one, whatever was in it. A skill the agent or the user edited in
 * the harness home, or a directory of the agent's own that a library skill now shares a name with,
 * went at the next launch or resume. Now a directory goes only when it is exactly what Mend
 * delivered there (or is about to); anything else is moved aside whole.
 */
describe("a delivery never deletes what Mend did not deliver", () => {
  it("an edited skill is kept aside and the library's version delivered; an untouched one is simply replaced", async () => {
    const home = tmpHome();
    await deliver(home, [
      bundle("review", [{ path: "SKILL.md", contents: "v1" }]),
      bundle("plain", [{ path: "SKILL.md", contents: "p1" }]),
    ]);
    // The agent improves the skill in the session; the library never saw it.
    fs.writeFileSync(skill(home, ".claude/skills", "review"), "v1, with the agent's fix");
    fs.writeFileSync(skill(home, ".claude/skills", "review", "notes.md"), "why");
    const outcomes = await deliver(home, [
      bundle("review", [{ path: "SKILL.md", contents: "v1" }]),
      bundle("plain", [{ path: "SKILL.md", contents: "p2" }]),
    ]);
    expect(keptFiles(home)).toEqual({
      ".claude/skills/review/SKILL.md": "v1, with the agent's fix",
      ".claude/skills/review/notes.md": "why",
    });
    expect(outcomes.filter((outcome) => outcome.outcome === "kept").map((o) => o.dir)).toEqual([
      ".claude/skills/review",
    ]);
    expect(fs.readFileSync(skill(home, ".claude/skills", "review"), "utf8")).toBe("v1");
    expect(fs.existsSync(skill(home, ".claude/skills", "review", "notes.md"))).toBe(false);
    for (const target of SKILL_TARGET_DIRS) {
      expect(fs.readFileSync(skill(home, target, "plain"), "utf8")).toBe("p2");
    }
    // Nothing else moved: the codex copy and the plain skill were Mend's own delivery.
    const again = await deliver(home, [bundle("review", [{ path: "SKILL.md", contents: "v1" }])]);
    expect(again.filter((outcome) => outcome.outcome === "kept")).toEqual([]);
    expect(Object.keys(keptFiles(home))).toHaveLength(2);
  });

  it("a directory of the agent's own is kept when a library skill takes its name", async () => {
    const home = tmpHome();
    const own = skill(home, ".codex/skills", "deploy");
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, "the agent's own deploy steps");
    await deliver(home, [bundle("deploy", [{ path: "SKILL.md", contents: "library deploy" }])]);
    expect(keptFiles(home)).toEqual({
      ".codex/skills/deploy/SKILL.md": "the agent's own deploy steps",
    });
    expect(fs.readFileSync(own, "utf8")).toBe("library deploy");
  });

  it("a retired skill goes only as Mend delivered it; an edited one is kept", async () => {
    const home = tmpHome();
    await deliver(home, [
      bundle("old", [{ path: "SKILL.md", contents: "o" }]),
      bundle("edited", [{ path: "SKILL.md", contents: "e" }]),
    ]);
    fs.appendFileSync(skill(home, ".claude/skills", "edited"), " and more");
    await deliver(home, []);
    for (const target of SKILL_TARGET_DIRS) {
      expect(fs.existsSync(path.join(home, target, "old"))).toBe(false);
      expect(fs.existsSync(path.join(home, target, "edited"))).toBe(false);
    }
    expect(keptFiles(home)).toEqual({ ".claude/skills/edited/SKILL.md": "e and more" });
  });

  it("a home from a Mend that kept no digests: only a directory equal to the new delivery goes", async () => {
    const home = tmpHome();
    for (const target of SKILL_TARGET_DIRS) {
      fs.mkdirSync(path.join(home, target, "same"), { recursive: true });
      fs.writeFileSync(skill(home, target, "same"), "s");
      fs.mkdirSync(path.join(home, target, "stale"), { recursive: true });
      fs.writeFileSync(skill(home, target, "stale"), "t");
    }
    fs.writeFileSync(skill(home, ".claude/skills", "same"), "s, edited");
    fs.writeFileSync(
      path.join(home, MANAGED_SKILLS_MANIFEST),
      JSON.stringify({ ".claude/skills": ["same", "stale"], ".codex/skills": ["same", "stale"] }),
    );
    await deliver(home, [bundle("same", [{ path: "SKILL.md", contents: "s" }])]);
    expect(keptFiles(home)).toEqual({
      ".claude/skills/same/SKILL.md": "s, edited",
      ".claude/skills/stale/SKILL.md": "t",
      ".codex/skills/stale/SKILL.md": "t",
    });
    expect(fs.existsSync(path.join(home, MANAGED_SKILLS_DIGESTS))).toBe(true);
  });

  it("a symlinked skill directory is moved as a link; what it points at is untouched", async () => {
    const home = tmpHome();
    const mine = path.join(home, "dotfiles", "skills", "lint");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "SKILL.md"), "mine");
    fs.mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
    fs.symlinkSync(mine, path.join(home, ".claude/skills/lint"));
    await deliver(home, [bundle("lint", [{ path: "SKILL.md", contents: "library" }])]);
    expect(keptFiles(home)).toEqual({ ".claude/skills/lint": `-> ${mine}` });
    expect(fs.readFileSync(path.join(mine, "SKILL.md"), "utf8")).toBe("mine");
    expect(fs.readFileSync(skill(home, ".claude/skills", "lint"), "utf8")).toBe("library");
  });

  it("a directory that cannot be cleared is never written into", async () => {
    if (process.getuid?.() === 0) return;
    const home = tmpHome();
    const own = skill(home, ".claude/skills", "docs");
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, "mine");
    fs.chmodSync(path.join(home, ".claude/skills"), 0o555);
    const failed = await Effect.runPromise(
      Effect.flip(
        materializeSkills(home, [bundle("docs", [{ path: "SKILL.md", contents: "lib" }])]),
      ),
    );
    fs.chmodSync(path.join(home, ".claude/skills"), 0o755);
    expect(failed.message).toContain(".claude/skills/docs (EACCES)");
    expect(fs.readFileSync(own, "utf8")).toBe("mine");
    expect(fs.existsSync(path.join(home, MANAGED_SKILLS_MANIFEST))).toBe(false);
  });

  it("the workspace exec applies the same plan: run by sh, it keeps an edit and removes Mend's own", () => {
    const home = tmpHome();
    const files = [{ path: "SKILL.md", contents: "v1" }];
    for (const target of SKILL_TARGET_DIRS) {
      fs.mkdirSync(path.join(home, target, "review"), { recursive: true });
      fs.writeFileSync(skill(home, target, "review"), "v1");
    }
    fs.writeFileSync(skill(home, ".codex/skills", "review"), "v1 edited");
    const plan = planSkills(
      { ".claude/skills": ["review"], ".codex/skills": ["review"] },
      [bundle("review", [{ path: "SKILL.md", contents: "v2" }])],
      {
        ".claude/skills": { review: skillTreeDigest(files) },
        ".codex/skills": { review: skillTreeDigest(files) },
      },
    );
    if (plan === null) throw new Error("no plan");
    const [command = "", ...args] = vacateSkillsExec(home, `${SKILLS_KEPT_DIR}/stamp`, plan);
    const run = spawnSync(command, args, { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(parseSkillsVacateOutcomes(run.stdout)).toEqual([
      { outcome: "removed", dir: ".claude/skills/review", detail: null },
      {
        outcome: "kept",
        dir: ".codex/skills/review",
        detail: `${SKILLS_KEPT_DIR}/stamp/.codex/skills/review`,
      },
    ]);
    expect(fs.existsSync(path.join(home, ".claude/skills/review"))).toBe(false);
    expect(
      fs.readFileSync(
        path.join(home, SKILLS_KEPT_DIR, "stamp/.codex/skills/review/SKILL.md"),
        "utf8",
      ),
    ).toBe("v1 edited");
  });
});

/**
 * Review 2026-09-28 (18): the ownership check compared file contents only, so a delivered skill
 * whose script the user made executable, or that gained an empty directory or a hard link, still
 * read as "Mend's delivery". Every resume then removed it and wrote it again: the script came back
 * 0644, the empty directory and the link were gone, the times reset. Now a directory that already
 * holds exactly the bundle is left untouched, and a replaced or retired one goes only when its
 * metadata is also exactly what Mend writes; otherwise it is moved aside whole.
 */
const helper = (contents: string) =>
  bundle("build-helper", [
    { path: "SKILL.md", contents: "# Build helper\nRun scripts/check.sh.\n" },
    { path: "scripts/check.sh", contents },
  ]);
const CHECK = "#!/bin/sh\necho checked\n";
/** The reviewer's fixture: the helper made executable, an empty directory, a hard link. */
const customize = (home: string) => {
  const dir = path.join(home, ".claude/skills/build-helper");
  const script = path.join(dir, "scripts/check.sh");
  fs.chmodSync(script, 0o755);
  fs.mkdirSync(path.join(dir, "scratch/empty"), { recursive: true });
  fs.linkSync(script, path.join(home, "my-check.sh"));
  fs.utimesSync(script, 1700000000.123, 1700000000.123);
  return script;
};
const facts = (home: string, script: string) => ({
  mode: fs.statSync(script).mode & 0o777,
  empty: fs.existsSync(path.join(home, ".claude/skills/build-helper/scratch/empty")),
  linked: fs.statSync(script).ino === fs.statSync(path.join(home, "my-check.sh")).ino,
  mtime: fs.statSync(script, { bigint: true }).mtimeNs.toString(),
  bytes: fs.readFileSync(script, "utf8"),
});

describe("a delivery keeps what the user set on a skill's files", () => {
  it("AUDIT R18 skill delivery keeps user metadata and topology", async () => {
    const home = tmpHome();
    await deliver(home, [helper(CHECK)]);
    const script = customize(home);
    const before = facts(home, script);
    const outcomes = await deliver(home, [helper(CHECK)]);
    expect(facts(home, script)).toEqual(before);
    expect(before).toMatchObject({ mode: 0o755, empty: true, linked: true });
    expect(
      outcomes.filter((outcome) => outcome.dir.endsWith("build-helper")).map((o) => o.outcome),
    ).toEqual(["unchanged", "unchanged"]);
    expect(fs.existsSync(keptRoot(home))).toBe(false);
  });

  it("a replaced skill whose metadata the user changed is kept aside whole, metadata and all", async () => {
    const home = tmpHome();
    await deliver(home, [helper(CHECK)]);
    const script = customize(home);
    const before = facts(home, script);
    const outcomes = await deliver(home, [helper("#!/bin/sh\necho checked twice\n")]);
    expect(outcomes.find((outcome) => outcome.dir === ".claude/skills/build-helper")?.outcome).toBe(
      "kept",
    );
    // The codex copy was exactly Mend's delivery: it goes.
    expect(outcomes.find((outcome) => outcome.dir === ".codex/skills/build-helper")?.outcome).toBe(
      "removed",
    );
    const [stamp = ""] = fs.readdirSync(keptRoot(home));
    const keptHome = path.join(keptRoot(home), stamp);
    const keptScript = path.join(keptHome, ".claude/skills/build-helper/scripts/check.sh");
    expect(fs.statSync(keptScript).mode & 0o777).toBe(0o755);
    expect(fs.statSync(keptScript, { bigint: true }).mtimeNs.toString()).toBe(before.mtime);
    expect(fs.statSync(keptScript).ino).toBe(fs.statSync(path.join(home, "my-check.sh")).ino);
    expect(fs.existsSync(path.join(keptHome, ".claude/skills/build-helper/scratch/empty"))).toBe(
      true,
    );
    // The new delivery is a fresh tree, written as Mend writes: 0644.
    expect(fs.readFileSync(script, "utf8")).toBe("#!/bin/sh\necho checked twice\n");
    expect(fs.statSync(script).mode & 0o777).toBe(0o644);
  });

  it("a retired skill goes only with nothing of the user's on it", async () => {
    const setups: ReadonlyArray<readonly [string, (dir: string, home: string) => void]> = [
      ["a mode", (dir) => fs.chmodSync(path.join(dir, "scripts/check.sh"), 0o755)],
      ["an empty directory", (dir) => fs.mkdirSync(path.join(dir, "notes"))],
      ["a hard link", (dir, home) => fs.linkSync(path.join(dir, "SKILL.md"), path.join(home, "l"))],
      ["a directory mode", (dir) => fs.chmodSync(path.join(dir, "scripts"), 0o700)],
    ];
    for (const [what, setup] of setups) {
      const home = tmpHome();
      await deliver(home, [helper(CHECK)]);
      setup(path.join(home, ".claude/skills/build-helper"), home);
      const outcomes = await deliver(home, []);
      expect(
        outcomes.map((outcome) => [outcome.dir, outcome.outcome]),
        what,
      ).toEqual([
        [".claude/skills/build-helper", "kept"],
        [".codex/skills/build-helper", "removed"],
      ]);
    }
  });

  it("the workspace exec leaves an unchanged skill alone, and the writer skips its files", () => {
    const home = tmpHome();
    const files = [{ path: "SKILL.md", contents: "v1" }];
    for (const target of SKILL_TARGET_DIRS) {
      fs.mkdirSync(path.join(home, target, "review"), { recursive: true });
      fs.writeFileSync(skill(home, target, "review"), "v1");
    }
    fs.chmodSync(skill(home, ".claude/skills", "review"), 0o600);
    const plan = planSkills(
      { ".claude/skills": ["review"], ".codex/skills": ["review"] },
      [bundle("review", files), bundle("other", [{ path: "SKILL.md", contents: "o" }])],
      {
        ".claude/skills": { review: skillTreeDigest(files) },
        ".codex/skills": { review: skillTreeDigest(files) },
      },
    );
    if (plan === null) throw new Error("no plan");
    const [command = "", ...args] = vacateSkillsExec(home, `${SKILLS_KEPT_DIR}/stamp`, plan);
    const run = spawnSync(command, args, { encoding: "utf8" });
    expect(run.status).toBe(0);
    const outcomes = parseSkillsVacateOutcomes(run.stdout);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
      "unchanged",
      "absent",
      "unchanged",
      "absent",
    ]);
    expect(fs.statSync(skill(home, ".claude/skills", "review")).mode & 0o777).toBe(0o600);
    expect(skillFilesToWrite(plan, outcomes).map((file) => file.path)).toEqual([
      ".claude/skills/other/SKILL.md",
      ".codex/skills/other/SKILL.md",
    ]);
  });
});
