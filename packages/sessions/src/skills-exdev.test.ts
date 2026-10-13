import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { parseSkillsVacateOutcomes, skillTreeDigest, vacateSkillsExec } from "./skills.ts";

const differentDevices =
  fs.existsSync("/dev/shm") && fs.statSync("/tmp").dev !== fs.statSync("/dev/shm").dev;
const cp = spawnSync("sh", ["-c", "command -v cp"], { encoding: "utf8" }).stdout?.trim() ?? "";

const fixture = () => {
  const home = fs.mkdtempSync("/tmp/mend-skills-exdev-");
  const kept = fs.mkdtempSync("/dev/shm/mend-skills-exdev-");
  const cleanup = () => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(kept, { recursive: true, force: true });
  };
  try {
    const source = path.join(home, ".codex/skills/review");
    const destination = path.join(kept, ".codex/skills/review");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "synthetic original\n");
    fs.linkSync(path.join(source, "SKILL.md"), path.join(source, "linked.md"));
    fs.mkdirSync(path.join(source, "nested/empty"), { recursive: true });
    fs.symlinkSync("../SKILL.md", path.join(source, "nested/relative"));
    fs.symlinkSync("/synthetic-missing-target", path.join(source, "dangling"));
    fs.linkSync(path.join(source, "dangling"), path.join(source, "linked-symlink"));
    for (const relative of ["", "SKILL.md", "nested", "nested/empty"]) {
      fs.chmodSync(path.join(source, relative), relative === "SKILL.md" ? 0o751 : 0o710);
    }
    // Independent exact nanosecond fixture; Node's number-based utimes rounds this value.
    const timestamped = spawnSync("touch", [
      "-h",
      "-d",
      "@1700000000.123456789",
      "--",
      source,
      ...[
        "SKILL.md",
        "linked.md",
        "nested",
        "nested/empty",
        "nested/relative",
        "dangling",
        "linked-symlink",
      ].map((relative) => path.join(source, relative)),
    ]);
    if (timestamped.status !== 0)
      throw new Error("GNU touch is required for the nanosecond fixture");
    const run = (extraEnv: NodeJS.ProcessEnv = {}, delivering = "different") => {
      const [command = "", ...args] = vacateSkillsExec(home, kept, {
        directories: [".codex/skills"],
        vacate: [{ dir: ".codex/skills/review", accept: [], delivering }],
        files: [],
        manifest: "{}",
        digests: "{}",
      });
      return spawnSync(command, args, { encoding: "utf8", env: { ...process.env, ...extraEnv } });
    };
    const shim = (script: string) => {
      const bin = path.join(home, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "cp"), `#!${process.execPath}\n${script}`, { mode: 0o755 });
      return {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        REAL_CP: cp,
        FIXTURE_SOURCE: source,
      };
    };
    return { home, kept, source, destination, run, shim, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
};

const facts = (root: string) => {
  const result: Array<{
    readonly relative: string;
    readonly mode: number;
    readonly mtimeNs: string;
    readonly contents: string | null;
    readonly target: string | null;
    readonly group: string | null;
  }> = [];
  const groups = new Map<string, string>();
  const walk = (relative: string) => {
    const file = path.join(root, relative);
    const st = fs.lstatSync(file, { bigint: true });
    const key = `${st.dev}:${st.ino}`;
    if (!st.isDirectory() && !groups.has(key)) groups.set(key, relative);
    result.push({
      relative,
      mode: Number(st.mode & 0o7777n),
      mtimeNs: st.mtimeNs.toString(),
      contents: st.isFile() ? fs.readFileSync(file, "utf8") : null,
      target: st.isSymbolicLink() ? fs.readlinkSync(file) : null,
      group: !st.isDirectory() ? (groups.get(key) ?? null) : null,
    });
    if (st.isDirectory())
      for (const name of fs.readdirSync(file).toSorted()) walk(path.join(relative, name));
  };
  walk("");
  return result;
};

const capability = `if(process.argv[2]==="--version"){console.log("cp (GNU coreutils) synthetic");process.exit(0)}`;

describe.skipIf(!differentDevices)("actual cross-filesystem skill preservation", () => {
  it("preserves exact file/directory/symlink metadata and internal hardlinks", () => {
    const f = fixture();
    try {
      const before = facts(f.source);
      expect(before.find((entry) => entry.relative === "SKILL.md")?.mtimeNs).toBe(
        "1700000000123456789",
      );
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(parseSkillsVacateOutcomes(result.stdout)[0]?.outcome).toBe("kept");
      expect(facts(f.destination)).toEqual(before);
      expect(fs.existsSync(f.source)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("leaves an identical delivery untouched without needing the copy capability", () => {
    const f = fixture();
    try {
      for (const relative of ["dangling", "linked-symlink", "nested/relative"])
        fs.unlinkSync(path.join(f.source, relative));
      const before = facts(f.source);
      const digest = skillTreeDigest(
        ["SKILL.md", "linked.md"].map((relative) => ({
          path: relative,
          contents: "synthetic original\n",
        })),
      );
      const result = f.run(f.shim("process.exit(1);"), digest);
      expect(result.status).toBe(0);
      expect(parseSkillsVacateOutcomes(result.stdout)[0]?.outcome).toBe("unchanged");
      expect(facts(f.source)).toEqual(before);
      expect(fs.existsSync(f.destination)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("preserves a symlink root without copying or changing its target", () => {
    const f = fixture();
    try {
      const target = path.join(f.home, "target");
      fs.renameSync(f.source, target);
      fs.symlinkSync(target, f.source);
      const before = facts(f.source);
      const original = facts(target);
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(facts(f.destination)).toEqual(before);
      expect(facts(target)).toEqual(original);
      expect(fs.existsSync(f.source)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a FIFO without clearing the original tree", () => {
    const f = fixture();
    try {
      const fifo = path.join(f.source, "special");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("cannot preserve this file type");
      expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
      expect(fs.readFileSync(path.join(f.source, "SKILL.md"), "utf8")).toBe("synthetic original\n");
      expect(fs.existsSync(f.destination)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("keeps the original after a partially written failed copy", () => {
    const f = fixture();
    try {
      const before = facts(f.source);
      const env = f.shim(
        `${capability};const fs=require("fs"),path=require("path");const to=process.argv.at(-1);fs.mkdirSync(to);fs.writeFileSync(path.join(to,"partial"),"partial");process.exit(1);`,
      );
      const result = f.run(env);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("copy failed");
      expect(facts(f.source)).toEqual(before);
      expect(fs.existsSync(f.destination)).toBe(false);
      expect(fs.readdirSync(path.dirname(f.destination))).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a missing preservation capability without clearing the original", () => {
    const f = fixture();
    try {
      const before = facts(f.source);
      const result = f.run(f.shim('console.log("cp (unsupported)");process.exit(1);'));
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("GNU cp");
      expect(result.stderr).toContain("install coreutils in this image; original kept");
      expect(facts(f.source)).toEqual(before);
      expect(fs.existsSync(f.destination)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a successful reply with degraded copied metadata", () => {
    const f = fixture();
    try {
      const before = facts(f.source);
      const result = f.run(
        f.shim(
          `${capability};const fs=require("fs");fs.cpSync(process.argv.at(-2),process.argv.at(-1),{recursive:true,verbatimSymlinks:true});`,
        ),
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("verification failed");
      expect(facts(f.source)).toEqual(before);
      expect(fs.existsSync(f.destination)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a source change observed while copying", () => {
    const f = fixture();
    try {
      const result = f.run(
        f.shim(
          `${capability};const fs=require("fs"),cp=require("child_process");const r=cp.spawnSync(process.env.REAL_CP,process.argv.slice(2));if(r.status!==0)process.exit(1);fs.writeFileSync(process.env.FIXTURE_SOURCE+"/SKILL.md","synthetic edited during copy");`,
        ),
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("source changed");
      expect(fs.readFileSync(path.join(f.source, "SKILL.md"), "utf8")).toBe(
        "synthetic edited during copy",
      );
      expect(fs.existsSync(f.destination)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("does not overwrite an existing kept destination", () => {
    const f = fixture();
    try {
      fs.mkdirSync(f.destination, { recursive: true });
      fs.writeFileSync(path.join(f.destination, "private-existing"), "existing");
      const before = facts(f.source);
      const result = f.run();
      expect(result.status).toBe(1);
      expect(facts(f.source)).toEqual(before);
      expect(fs.readFileSync(path.join(f.destination, "private-existing"), "utf8")).toBe(
        "existing",
      );
    } finally {
      f.cleanup();
    }
  });

  it("refuses a hardlink outside the copied tree rather than severing its identity", () => {
    const f = fixture();
    try {
      fs.linkSync(path.join(f.source, "SKILL.md"), path.join(f.home, "external"));
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("external hardlink");
      expect(fs.statSync(path.join(f.source, "SKILL.md")).ino).toBe(
        fs.statSync(path.join(f.home, "external")).ino,
      );
      expect(fs.existsSync(f.destination)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
