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
