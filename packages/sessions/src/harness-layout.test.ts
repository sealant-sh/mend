import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultWorkspaceImage } from "@mend/domain";
import { LinuxIdentity } from "@mend/domain/workbench";
import { afterEach, describe, expect, it } from "vitest";

import {
  PERSON_SAVED_STATE,
  UNKNOWN_CAPABILITY,
  decideHarnessLayout,
  imageLayoutKeyOf,
  layoutProbeScript,
  parseLayoutReport,
  personHomeScript,
  personLayoutRefusal,
  personPrepareScript,
  processUserOf,
  staticLayoutObstacle,
  worktreeRepairScript,
  type LayoutDecisionInput,
} from "./harness-layout.ts";

const alice = new LinuxIdentity({ accountId: "alice-1", name: "m3kq7xj2a", uid: 40_012 });

const temps: Array<string> = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sh = (script: string, cwd?: string) =>
  spawnSync("sh", ["-c", script], { encoding: "utf8", ...(cwd === undefined ? {} : { cwd }) });

const fresh: LayoutDecisionInput = {
  flag: "shared",
  worktree: { layout: null, requested: null },
  headHasPeople: false,
  capability: UNKNOWN_CAPABILITY,
};
const capable = { person: true, missing: [], source: "mend" } as const;
const noSudo = { person: false, missing: ["no sudo"], source: "mend" } as const;

describe("the layout a launch runs (docs/adr/0016, decision 14)", () => {
  it("is shared with the flag off, as before, on a worktree with no layout", () => {
    expect(decideHarnessLayout(fresh)).toEqual({
      kind: "launch",
      layout: "shared",
      source: "flag",
      reason: null,
      probe: false,
    });
    // Capability says nothing with the flag off: nothing is probed, nothing changes.
    expect(decideHarnessLayout({ ...fresh, capability: capable })).toMatchObject({
      layout: "shared",
      probe: false,
    });
  });

  it("has no way back: a person worktree launches person with the flag off", () => {
    for (const worktree of [
      { layout: "person", requested: null },
      { layout: "person", requested: "shared" },
    ] as const) {
      expect(decideHarnessLayout({ ...fresh, worktree })).toEqual({
        kind: "launch",
        layout: "person",
        source: "worktree",
        onMissing: "refuse",
      });
    }
    // A head that already holds people/ counts, record or not.
    expect(decideHarnessLayout({ ...fresh, headHasPeople: true })).toMatchObject({
      layout: "person",
      source: "worktree",
    });
  });

  it("refuses a person worktree before create when the image is known not to run it", () => {
    for (const missing of [
      ["no sudo"],
      ["nix images run one person"],
      ["uid 40001 is taken in this image"],
      ["its sealantd cannot run processes as a user"],
      ["no ACLs on /workspace"],
    ]) {
      const decision = decideHarnessLayout({
        ...fresh,
        flag: "shared",
        worktree: { layout: "person", requested: null },
        capability: { person: false, missing, source: "mend" },
      });
      expect(decision).toEqual({ kind: "refuse", message: personLayoutRefusal(missing) });
    }
    expect(personLayoutRefusal(["no sudo"])).toBe(
      "This worktree's sessions are saved per person, and its image cannot run per-person users (no sudo). Pick an image that can, or start a new worktree.",
    );
  });

  it("launches a person worktree whose capability is unknown, for prepare to refuse if it must", () => {
    expect(
      decideHarnessLayout({ ...fresh, worktree: { layout: "person", requested: null } }),
    ).toMatchObject({ layout: "person", onMissing: "refuse" });
  });

  it("with the flag on, runs person only where the image is known to run it", () => {
    const on = { ...fresh, flag: "person" } as const;
    expect(decideHarnessLayout({ ...on, capability: capable })).toEqual({
      kind: "launch",
      layout: "person",
      source: "flag",
      onMissing: "fallback",
    });
    // Unknown means shared, and prepare records the answer for the next launch.
    expect(decideHarnessLayout(on)).toMatchObject({
      layout: "shared",
      source: "capability",
      probe: true,
    });
    // Known not to: shared, said, and checked again (an image can be fixed).
    expect(decideHarnessLayout({ ...on, capability: noSudo })).toMatchObject({
      layout: "shared",
      source: "capability",
      probe: true,
      reason:
        "this image cannot run per-person users (no sudo), so this workspace takes one person",
    });
    // What Mend knows statically is not probed again.
    expect(
      decideHarnessLayout({
        ...on,
        capability: { person: false, missing: ["nix images run one person"], source: "static" },
      }),
    ).toMatchObject({ layout: "shared", probe: false });
  });

  it("takes the operator's harnessLayout for a worktree it made, whatever the flag", () => {
    expect(
      decideHarnessLayout({
        ...fresh,
        flag: "person",
        capability: capable,
        worktree: { layout: null, requested: "shared" },
      }),
    ).toMatchObject({ layout: "shared", source: "operator" });
    expect(
      decideHarnessLayout({ ...fresh, worktree: { layout: null, requested: "person" } }),
    ).toEqual({ kind: "launch", layout: "person", source: "operator", onMissing: "refuse" });
    expect(
      decideHarnessLayout({
        ...fresh,
        worktree: { layout: null, requested: "person" },
        capability: noSudo,
      }),
    ).toMatchObject({ kind: "refuse" });
  });

  it("knows statically what rules person out: the platform, and nix images", () => {
    expect(staticLayoutObstacle(defaultWorkspaceImage, { processUser: false })).toBe(
      "this Mend's platform cannot start processes as a user",
    );
    expect(staticLayoutObstacle(defaultWorkspaceImage, { processUser: true })).toBeNull();
    expect(
      staticLayoutObstacle(
        { mode: "family", os: "nix", packages: [], shell: "bash", services: { docker: false } },
        { processUser: true },
      ),
    ).toBe("nix images run one person");
  });

  it("keys an image by Core's digest when known, else by what Mend asks for", () => {
    expect(imageLayoutKeyOf(defaultWorkspaceImage, "sha256:abc")).toBe("digest:sha256:abc");
    const key = imageLayoutKeyOf(defaultWorkspaceImage, null);
    expect(key).toMatch(/^spec:[0-9a-f]{32}$/);
    expect(
      imageLayoutKeyOf(
        defaultWorkspaceImage.mode === "family"
          ? { ...defaultWorkspaceImage, packages: [...defaultWorkspaceImage.packages].toReversed() }
          : defaultWorkspaceImage,
        null,
      ),
    ).toBe(key);
    expect(
      imageLayoutKeyOf(
        { mode: "family", os: "ubuntu", packages: [], shell: "bash", services: { docker: true } },
        null,
      ),
    ).not.toBe(key);
  });
});

describe("a process's user", () => {
  it("is the person's passwd entry: their uid, group mend, their home, umask 0002", () => {
    expect(processUserOf(alice)).toEqual({
      name: "m3kq7xj2a",
      uid: 40_012,
      gid: 40_000,
      groups: [40_000],
      home: "/home/m3kq7xj2a",
      umask: 0o002,
    });
  });
});

describe("the image probe (decision 1)", () => {
  it("names a reserved uid, gid, a taken name and a foreign mend group, and nothing else", () => {
    const dir = tempDir("mend-probe-");
    const passwd = path.join(dir, "passwd");
    const group = path.join(dir, "group");
    fs.writeFileSync(
      passwd,
      [
        "root:x:0:0:root:/root:/bin/bash",
        "builder:x:40001:40001::/home/builder:/bin/sh",
        `${alice.name}:x:1000:1000::/home/x:/bin/sh`,
      ].join("\n"),
    );
    fs.writeFileSync(group, ["root:x:0:", "mend:x:40000:", "ci:x:40007:"].join("\n"));
    const run = sh(layoutProbeScript([alice], { passwd, group, aclDir: dir }));
    const report = parseLayoutReport(run.stdout);
    expect(report.probed).toBe(true);
    expect(report.missing).toEqual(
      expect.arrayContaining([
        "uid 40001 is taken in this image",
        "gid 40007 is taken in this image",
        `user ${alice.name} is taken in this image`,
        // This machine runs no sealantd that can.
        "its sealantd cannot run processes as a user",
      ]),
    );
    expect(report.missing).not.toContain("gid 40000 is taken in this image");
    expect(report.ready).toBe(false);
  });

  it("does not make anyone when anything is missing", () => {
    const report = parseLayoutReport(
      sh(
        personPrepareScript([{ person: alice, ifSaved: false }], {
          harnessHome: tempDir("hh-"),
          repo: "/nonexistent",
        }),
      ).stdout,
    );
    // No sealantd here that can run processes as a user.
    expect(report.probed).toBe(true);
    expect(report.missing.length).toBeGreaterThan(0);
    expect(report.ready).toBe(false);
  });
});

describe("a person's home and saved directory (decision 2)", () => {
  const layout = () => {
    const root = tempDir("mend-person-");
    const harnessHome = path.join(root, "harness-home");
    const home = path.join(root, "home", alice.name);
    fs.mkdirSync(harnessHome, { recursive: true });
    const script = personHomeScript(alice, {
      harnessHome,
      home,
      tmpRoot: path.join(root, "tmp"),
      runRoot: path.join(root, "run"),
    });
    return { root, harnessHome, home, script, saved: path.join(harnessHome, "people", "alice-1") };
  };

  it("links every piece of conversation state into P, and nothing else", () => {
    const { home, saved, script } = layout();
    const run = sh(script);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(fs.statSync(saved).mode & 0o7777).toBe(0o710);
    expect(fs.statSync(path.join(saved, "conversations")).mode & 0o7777).toBe(0o2710);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    for (const entry of PERSON_SAVED_STATE) {
      const link = path.join(home, entry.path);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(path.join(saved, entry.path));
    }
    // A harness writes through the links into P; a login written beside them stays in R.
    fs.writeFileSync(path.join(home, ".claude/projects/x.jsonl"), "{}\n");
    fs.mkdirSync(path.join(home, ".claude/tasks/t1"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/plans/p.md"), "plan");
    fs.mkdirSync(path.join(home, ".codex/archived_sessions/2026"), { recursive: true });
    fs.appendFileSync(path.join(home, ".claude/history.jsonl"), "{}\n");
    fs.writeFileSync(path.join(home, ".claude/.credentials.json"), "{}");
    fs.writeFileSync(path.join(home, ".codex/auth.json"), "{}");
    expect(fs.existsSync(path.join(saved, ".claude/projects/x.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(saved, ".claude/tasks/t1"))).toBe(true);
    expect(fs.existsSync(path.join(saved, ".claude/plans/p.md"))).toBe(true);
    expect(fs.existsSync(path.join(saved, ".codex/archived_sessions/2026"))).toBe(true);
    expect(fs.existsSync(path.join(saved, ".claude/history.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(saved, ".claude/.credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(saved, ".codex/auth.json"))).toBe(false);
  });

  it("is idempotent, and moves what the image left in R into P without overwriting P", () => {
    const { home, saved, script } = layout();
    fs.mkdirSync(path.join(home, ".claude/projects/-workspace-repo"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/projects/-workspace-repo/a.jsonl"), "image");
    fs.mkdirSync(path.join(saved, ".claude/projects/-workspace-repo"), { recursive: true });
    fs.writeFileSync(path.join(saved, ".claude/projects/-workspace-repo/a.jsonl"), "restored");
    fs.writeFileSync(path.join(saved, ".claude/projects/-workspace-repo/b.jsonl"), "restored");
    expect(sh(script).status).toBe(0);
    expect(sh(script).status).toBe(0);
    expect(
      fs.readFileSync(path.join(saved, ".claude/projects/-workspace-repo/a.jsonl"), "utf8"),
    ).toBe("restored");
    expect(
      fs.readFileSync(path.join(home, ".claude/projects/-workspace-repo/b.jsonl"), "utf8"),
    ).toBe("restored");
  });

  it("writes at most 64 KB into saved state outside conversation state", () => {
    const { saved, script } = layout();
    expect(sh(script).status).toBe(0);
    // What a capture saves of these entries: the bytes of files and links. A directory is an
    // entry with no content (its inode size is the filesystem's, 4096 on ext4, not saved state).
    let bytes = 0;
    let files = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          files++;
          bytes += fs.lstatSync(full).size;
        }
      }
    };
    walk(saved);
    // The layout itself writes no file into P: directories only.
    expect(files).toBe(0);
    expect(bytes).toBeLessThan(64 * 1024);
  });
});

const changed = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("mend-repair "))
    .map((line) => line.slice("mend-repair ".length));

describe("the worktree repair (decision 2)", () => {
  const repairFixture = () => {
    const root = tempDir("mend-repair-");
    const repo = path.join(root, "repo");
    const marker = path.join(root, "run", "repair");
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.mkdirSync(repo);
    expect(sh(`git init -q ${repo}`).status).toBe(0);
    // The marker is made when the executor starts.
    fs.writeFileSync(marker, "");
    const past = new Date(Date.now() - 5_000);
    fs.utimesSync(marker, past, past);
    return { root, repo, marker, repair: worktreeRepairScript({ repo, marker }) };
  };

  it("makes what tar x, install -m 644 and open(…, 0644) left writable for the group", () => {
    const { root, repo, repair } = repairFixture();
    // An archive with old mtimes, unpacked with its modes.
    const src = path.join(root, "src", "pkg");
    fs.mkdirSync(path.join(src, "lib"), { recursive: true });
    fs.writeFileSync(path.join(src, "lib", "a.js"), "a");
    fs.writeFileSync(path.join(src, "run.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(src, "run.sh"), 0o755);
    fs.chmodSync(path.join(src, "lib", "a.js"), 0o644);
    fs.chmodSync(path.join(src, "lib"), 0o755);
    expect(
      sh(
        `touch -d 2026-01-01 ${src}/lib/a.js ${src}/run.sh ${src}/lib ${src} && ` +
          `tar -C ${path.dirname(src)} -cf ${root}/pkg.tar pkg && ` +
          `umask 022 && tar -C ${repo} -xpf ${root}/pkg.tar && ` +
          `install -m 644 /dev/null ${repo}/installed && ` +
          `node -e 'require("fs").writeFileSync(process.argv[1], "x", { mode: 0o644 })' ${repo}/opened`,
      ).status,
    ).toBe(0);
    expect(fs.statSync(path.join(repo, "pkg/lib/a.js")).mtime.getFullYear()).toBe(2026);
    const run = sh(repair);
    expect(run.status).toBe(0);
    for (const file of ["pkg/lib/a.js", "installed", "opened"]) {
      expect(fs.statSync(path.join(repo, file)).mode & 0o060).toBe(0o060);
    }
    // Group execute only where the owner has it.
    expect(fs.statSync(path.join(repo, "pkg/run.sh")).mode & 0o070).toBe(0o070);
    expect(fs.statSync(path.join(repo, "installed")).mode & 0o010).toBe(0);
    for (const dir of ["pkg", "pkg/lib"]) {
      expect(fs.statSync(path.join(repo, dir)).mode & 0o2070).toBe(0o2070);
    }
    expect(changed(run.stdout)).toEqual(
      expect.arrayContaining([
        path.join(repo, "pkg/lib/a.js"),
        path.join(repo, "installed"),
        path.join(repo, "opened"),
      ]),
    );
  });

  it("walks only what changed since the last repair, its own chmod included", () => {
    const { repo, repair } = repairFixture();
    fs.writeFileSync(path.join(repo, "one"), "1", { mode: 0o644 });
    fs.chmodSync(path.join(repo, "one"), 0o644);
    expect(changed(sh(repair).stdout)).toContain(path.join(repo, "one"));
    // Nothing new: nothing to change, though the first repair's chmod moved ctimes.
    expect(changed(sh(repair).stdout)).toEqual([]);
    fs.writeFileSync(path.join(repo, "two"), "2");
    fs.chmodSync(path.join(repo, "two"), 0o644);
    expect(changed(sh(repair).stdout)).toEqual([path.join(repo, "two")]);
  });

  it("with no marker yet only makes one", () => {
    const { repo, marker } = repairFixture();
    fs.rmSync(marker);
    fs.writeFileSync(path.join(repo, "f"), "x");
    fs.chmodSync(path.join(repo, "f"), 0o644);
    const run = sh(worktreeRepairScript({ repo, marker }));
    expect(run.status).toBe(0);
    expect(changed(run.stdout)).toEqual([]);
    expect(fs.existsSync(marker)).toBe(true);
  });
});
