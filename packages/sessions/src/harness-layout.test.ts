import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultWorkspaceImage } from "@mend/domain";
import { LinuxIdentity } from "@mend/domain/workbench";
import { afterEach, describe, expect, it } from "vitest";

import { runExec, startPickupChannel } from "../test/pickup-channel.ts";
import { GIT_CREDENTIAL_HELPER_SCRIPT } from "./git-credential.ts";
import {
  PERSON_SAVED_STATE,
  UNKNOWN_CAPABILITY,
  decideHarnessLayout,
  imageLayoutKeyOf,
  layoutProbeScript,
  parseLayoutReport,
  personHomeScript,
  personLayoutRefusal,
  gitAuthorConfigText,
  identityFilesOf,
  identityPickupScript,
  personPrepareScript,
  personProcessEnv,
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

/**
 * A root an executor's prepare sees, without being root: `id -u` says 0, and `useradd`,
 * `groupadd`, `chown`, `chgrp`, `sudo`, `setfacl` and `sealantd` are stand-ins on `PATH`.
 * `useradd` does what shadow-utils does with `-m -k <skel>`: it makes the home from the skeleton
 * when the home does not exist, and when it does, warns, copies nothing and changes no owner.
 * `chown` and `chgrp` change nothing and log their arguments. A `useradd-fails` file makes
 * `useradd` fail.
 */
const fakeRoot = () => {
  const dir = tempDir("mend-fake-root-");
  const bin = path.join(dir, "bin");
  const users = path.join(dir, "users");
  const log = path.join(dir, "log");
  fs.mkdirSync(bin);
  fs.mkdirSync(users);
  const stub = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub(
    "id",
    `if [ "$1" = -u ] && [ -z "$2" ]; then echo 0; exit 0; fi\n` +
      `[ -f "${users}/$2" ] && cat "${users}/$2" || exit 1`,
  );
  stub(
    "useradd",
    `[ -e "${dir}/useradd-fails" ] && exit 9\n` +
      `while [ $# -gt 1 ]; do case "$1" in -u) uid=$2; shift 2 ;; -k) skel=$2; shift 2 ;; ` +
      `-d) home=$2; shift 2 ;; -g|-G|-s) shift 2 ;; *) shift ;; esac; done\n` +
      `echo "$uid" > "${users}/$1"\n` +
      `if [ -d "$home" ]; then echo "useradd: warning: the home directory $home already exists." >&2; ` +
      `echo "useradd: Not copying any file from skel directory into it." >&2; ` +
      `else mkdir -p "$home" && cp -a "$skel/." "$home/"; fi`,
  );
  stub("groupadd", "exit 0");
  stub("chown", `echo "chown $*" >> "${log}"`);
  stub("chgrp", `echo "chgrp $*" >> "${log}"`);
  stub("sudo", "exit 0");
  stub("setfacl", "exit 0");
  stub("sealantd", `echo '{"exec.user":true,"dotfiles.user":true,"restore.owner_map":true}'`);
  // The image's skeleton: a dotfile and the link to a shared cache decision 3 depends on.
  const skel = path.join(dir, "skel");
  fs.mkdirSync(path.join(skel, ".cargo"), { recursive: true });
  fs.writeFileSync(path.join(skel, ".bashrc"), "# skel\n");
  fs.symlinkSync("/var/cache/cargo/registry", path.join(skel, ".cargo/registry"));
  const passwd = path.join(dir, "passwd");
  const group = path.join(dir, "group");
  fs.writeFileSync(passwd, "root:x:0:0:root:/root:/bin/sh\n");
  fs.writeFileSync(group, "root:x:0:\n");
  return {
    dir,
    skel,
    passwd,
    group,
    failUseradd: () => fs.writeFileSync(path.join(dir, "useradd-fails"), ""),
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""),
    run: (script: string) =>
      spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      }),
  };
};

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

  it("reads which people a prepare made", () => {
    expect(
      parseLayoutReport(
        "mend-layout probed\nmend-layout made m3kq7xj2a\nmend-layout made mf9t2bw4c\nmend-layout ready\n",
      ),
    ).toEqual({
      probed: true,
      missing: [],
      ready: true,
      made: ["m3kq7xj2a", "mf9t2bw4c"],
      unowned: null,
      failed: [],
    });
    expect(parseLayoutReport("mend-layout probed\nmend-layout ready\n").made).toEqual([]);
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

/** Prepare for `people` under a fake root, everything it touches inside the root. */
const prepare = (
  root: ReturnType<typeof fakeRoot>,
  people: Parameters<typeof personPrepareScript>[0],
  // The restored worktree's group, as sealantd's owner map leaves it: the test's own gid.
  worktreeGid: number = process.getgid?.() ?? 0,
) => {
  const harnessHome = path.join(root.dir, "harness-home");
  fs.mkdirSync(harnessHome, { recursive: true });
  const homesRoot = path.join(root.dir, "home");
  const repo = path.join(root.dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const script = personPrepareScript(people, {
    harnessHome,
    repo,
    places: {
      homesRoot,
      tmpRoot: path.join(root.dir, "tmp"),
      runRoot: path.join(root.dir, "run"),
      skel: root.skel,
      marker: path.join(root.dir, "run-mend", "repair"),
      passwd: root.passwd,
      group: root.group,
      aclDir: root.dir,
      worktreeGid,
    },
  });
  return { harnessHome, homesRoot, script };
};

describe("what prepare makes (decision 1)", () => {
  const maria = new LinuxIdentity({ accountId: "maria-1", name: "mfqt2bw4c", uid: 40_031 });
  const bob = new LinuxIdentity({ accountId: "bob-1", name: "mb6r4kq2d", uid: 40_044 });

  it("reports made only the people it made: a member with no saved directory here is not", () => {
    const root = fakeRoot();
    const { harnessHome, homesRoot, script } = prepare(root, [
      { person: alice, ifSaved: false },
      { person: maria, ifSaved: true },
      { person: bob, ifSaved: true },
    ]);
    // Maria's saved directory came back with the head; Bob has an identity (from another
    // worktree) and nothing saved in this one.
    fs.mkdirSync(path.join(harnessHome, "people", maria.accountId), { recursive: true });
    const run = root.run(script);
    const report = parseLayoutReport(run.stdout);
    expect(report.missing).toEqual([]);
    expect(report.made).toEqual([alice.name, maria.name]);
    expect(report.ready).toBe(true);
    expect(fs.existsSync(path.join(homesRoot, bob.name))).toBe(false);
  });

  it("refuses a restore that did not apply the owner map: nobody is made, and it says what it found", () => {
    const root = fakeRoot();
    // sealantd gave the worktree to another group (or to none): root's 0644 files, which nobody
    // could edit.
    const { homesRoot, script } = prepare(root, [{ person: alice, ifSaved: false }], 40_000);
    const run = root.run(`( exit 0 ); h=$?\n${script}\nexit $h`);
    const report = parseLayoutReport(run.stdout);
    expect(report.unowned).toBe(
      `the restored worktree's group is ${process.getgid?.() ?? 0}, not mend (40000)`,
    );
    expect(report.made).toEqual([]);
    expect(report.ready).toBe(false);
    expect(fs.existsSync(path.join(homesRoot, alice.name))).toBe(false);
    expect(run.status).toBe(0);
  });

  it("a person who cannot be made fails the layout, makes nobody after them, and keeps the helper's status", () => {
    const root = fakeRoot();
    root.failUseradd();
    const { script } = prepare(root, [
      { person: alice, ifSaved: false },
      { person: maria, ifSaved: false },
    ]);
    // As the engine runs it: beside the helper install, whose status the exec reports.
    const run = root.run(`( exit 3 ); h=$?\n${script}\nexit $h`);
    const report = parseLayoutReport(run.stdout);
    expect(run.stdout).toContain(`mend-layout failed ${alice.name}`);
    expect(report.made).toEqual([]);
    expect(report.ready).toBe(false);
    expect(run.stdout).not.toContain(maria.name);
    expect(run.status).toBe(3);
  });
});

describe("a home Core wrote into before its user existed (decision 5)", () => {
  it("becomes the user's, logins included, with the skeleton copied in and nothing replaced", () => {
    const root = fakeRoot();
    const harnessHome = path.join(root.dir, "harness-home");
    const home = path.join(root.dir, "home", alice.name);
    fs.mkdirSync(harnessHome, { recursive: true });
    // What Core writes at create into `credentialsHome`, before prepare: root's files, 0600.
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/.credentials.json"), "alice's login", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(home, ".bashrc"), "# alice's own\n");
    const run = root.run(
      personHomeScript(alice, {
        harnessHome,
        home,
        tmpRoot: path.join(root.dir, "tmp"),
        runRoot: path.join(root.dir, "run"),
        skel: root.skel,
      }),
    );
    expect(run.status).toBe(0);
    // useradd copied nothing into a home already there; the script did, over nothing.
    expect(fs.readlinkSync(path.join(home, ".cargo/registry"))).toBe("/var/cache/cargo/registry");
    expect(fs.readFileSync(path.join(home, ".bashrc"), "utf8")).toBe("# alice's own\n");
    expect(fs.readFileSync(path.join(home, ".claude/.credentials.json"), "utf8")).toBe(
      "alice's login",
    );
    // Everything in the home is the user's, links as links.
    expect(root.log()).toContain(`chown -hR ${alice.uid}:40000 ${home}\n`);
  });

  it("a home made for a new user holds the skeleton and is theirs, before useradd and Core's POST race for it", () => {
    const root = fakeRoot();
    const harnessHome = path.join(root.dir, "harness-home");
    const home = path.join(root.dir, "home", alice.name);
    fs.mkdirSync(harnessHome, { recursive: true });
    const run = root.run(
      personHomeScript(alice, {
        harnessHome,
        home,
        tmpRoot: path.join(root.dir, "tmp"),
        runRoot: path.join(root.dir, "run"),
        skel: root.skel,
      }),
    );
    expect(run.status).toBe(0);
    expect(fs.readlinkSync(path.join(home, ".cargo/registry"))).toBe("/var/cache/cargo/registry");
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    // Made by the script, owned by the user by number, before useradd ran: useradd never makes
    // it, so a POST that makes it first (decision 5) never fails useradd's mkdir.
    const log = root.log();
    expect(log.indexOf(`chown ${alice.uid}:40000 ${home}\n`)).toBeGreaterThanOrEqual(0);
    expect(run.stderr).toContain("already exists");
    // The skeleton copied in becomes theirs: one walk of a home that holds only it.
    expect(log.split("\n").filter((line) => line.startsWith("chown -hR"))).toEqual([
      `chown -hR ${alice.uid}:40000 ${home}`,
    ]);
  });

  it("a home Core's POST made first, logins inside, is kept and becomes the user's", () => {
    const root = fakeRoot();
    const harnessHome = path.join(root.dir, "harness-home");
    const home = path.join(root.dir, "home", alice.name);
    fs.mkdirSync(harnessHome, { recursive: true });
    // Core's POST with uid and gid made the home first (0700, the skeleton) and wrote the login.
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, ".codex/auth.json"), "alice's codex", { mode: 0o600 });
    const run = root.run(
      personHomeScript(alice, {
        harnessHome,
        home,
        tmpRoot: path.join(root.dir, "tmp"),
        runRoot: path.join(root.dir, "run"),
        skel: root.skel,
      }),
    );
    expect(run.status).toBe(0);
    expect(fs.readFileSync(path.join(home, ".codex/auth.json"), "utf8")).toBe("alice's codex");
    expect(fs.statSync(path.join(home, ".codex/auth.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(root.log()).toContain(`chown -hR ${alice.uid}:40000 ${home}\n`);
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

  it("follows no link planted on the way to opencode's logins: it fails instead", () => {
    for (const plant of ["home", "saved"] as const) {
      const { home, saved, script, root } = layout();
      expect(sh(script).status).toBe(0);
      const elsewhere = path.join(root, "elsewhere");
      fs.mkdirSync(elsewhere, { recursive: true });
      const at =
        plant === "home"
          ? path.join(home, ".mend/opencode")
          : path.join(saved, ".local/share/opencode");
      fs.rmSync(at, { recursive: true, force: true });
      fs.symlinkSync(elsewhere, at);
      const run = sh(script);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("unexpected link");
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    }
  });

  it("keeps Claude's file history in the home, never in P: it holds copies of edited secret files", () => {
    const { home, saved, script } = layout();
    expect(sh(script).status).toBe(0);
    fs.mkdirSync(path.join(home, ".claude/file-history/s1"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/file-history/s1/.env@v1"), "SECRET=1");
    expect(fs.lstatSync(path.join(home, ".claude/file-history")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(saved, ".claude/file-history"))).toBe(false);
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
    // The layout itself writes no file into P: directories, and the one link that keeps
    // opencode's logins in the home (decision 5).
    expect(files).toBe(1);
    expect(fs.lstatSync(path.join(saved, ".local/share/opencode/auth.json")).isSymbolicLink()).toBe(
      true,
    );
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

/** What git answers for `key` as the person whose home is `home`, system config aside. */
const asThePerson = (home: string, key: string) =>
  spawnSync("git", ["config", "--get", key], {
    cwd: home,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
  }).stdout.replace(/\n$/, "");

/** A key of a git config file, every value of it, as git reads it. */
const gitGet = (file: string, key: string) =>
  spawnSync("git", ["config", "--file", file, "--get-all", key], {
    encoding: "utf8",
  }).stdout.trim();

describe("a person's Mend identity in their home (decision 4)", () => {
  const TOKEN = "t".repeat(40) + "abc";
  const AUTHOR = { name: 'Alice "Al" O\'Neil\\', email: "alice@example.com" };
  const homeOf = (root: ReturnType<typeof fakeRoot> | null) => {
    const dir = root?.dir ?? tempDir("mend-identity-");
    const harnessHome = path.join(dir, "harness-home");
    const home = path.join(dir, "home", alice.name);
    fs.mkdirSync(harnessHome, { recursive: true });
    const script = personHomeScript(alice, {
      harnessHome,
      home,
      tmpRoot: path.join(dir, "tmp"),
      runRoot: path.join(dir, "run"),
      ...(root === null ? {} : { skel: root.skel }),
    });
    return { dir, home, script };
  };
  const channels: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const channel of channels.splice(0)) await channel.close();
  });
  const channel = async (failFirst = 0) => {
    const opened = await startPickupChannel({ failFirst });
    channels.push(opened);
    return opened;
  };
  const identityTicket = (
    opened: Awaited<ReturnType<typeof startPickupChannel>>,
    home: string,
    author: { readonly name: string; readonly email: string } | null = AUTHOR,
  ) => {
    const files = identityFilesOf(home);
    return opened.mint([
      { path: files.token, bytes: new TextEncoder().encode(TOKEN) },
      { path: files.gitAuthor, bytes: new TextEncoder().encode(gitAuthorConfigText(author)) },
    ]);
  };
  const pickUp = (
    opened: Awaited<ReturnType<typeof startPickupChannel>>,
    home: string,
    author: { readonly name: string; readonly email: string } | null = AUTHOR,
  ) =>
    runExec(
      [
        "sh",
        "-c",
        identityPickupScript([
          { person: alice, ticket: identityTicket(opened, home, author), home },
        ]),
      ],
      opened.env,
    );

  it("makes a real ~/.mend (0700) and ~/.config/git for them, with no file in either yet", () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    expect(fs.lstatSync(path.join(home, ".mend")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(home, ".mend")).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(path.join(home, ".config/git")).isDirectory()).toBe(true);
    // Only where opencode's logins go (decision 5), empty.
    expect(fs.readdirSync(path.join(home, ".mend"))).toEqual(["opencode"]);
    expect(fs.readdirSync(path.join(home, ".mend/opencode"))).toEqual([]);
  });

  it("writes their token 0600 and their git author from a pickup, and neither rides the exec's arguments", async () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    const opened = await channel();
    const ticket = identityTicket(opened, home);
    const argv = ["sh", "-c", identityPickupScript([{ person: alice, ticket, home }])];
    for (const arg of argv) {
      expect(arg).not.toContain(TOKEN);
      expect(arg).not.toContain("alice@example.com");
    }
    const run = await runExec(argv, opened.env);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`mend-layout identity ${alice.name}\n`);
    const token = path.join(home, ".mend/session-token");
    expect(fs.readFileSync(token, "utf8")).toBe(TOKEN);
    expect(fs.statSync(token).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(home, ".mend")).toSorted()).toEqual([
      "git-author",
      "opencode",
      "session-token",
    ]);
    // Git reads the author back exactly, as the person, quotes and backslash included.
    expect(asThePerson(home, "user.name")).toBe(AUTHOR.name);
    expect(asThePerson(home, "user.email")).toBe(AUTHOR.email);
    // The ticket is spent: presented again, it is refused, and nothing is written.
    const again = await runExec(argv, opened.env);
    expect(again.status).toBe(1);
    expect(again.stdout).toContain(
      `mend-layout failed ${alice.name} identity: the pickup was refused`,
    );
    expect(opened.redemptions()).toBe(2);
  });

  it("applies a changed Mend author at the next pickup, and includes Mend's file once", async () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    const opened = await channel();
    expect((await pickUp(opened, home)).status).toBe(0);
    expect(asThePerson(home, "user.name")).toBe(AUTHOR.name);
    // They change their git author in Mend's settings; the next pickup (a new executor, or a
    // restart's re-make) applies it.
    const renamed = { name: "Alice Smith", email: "alice@smith.example" };
    expect((await pickUp(opened, home, renamed)).status).toBe(0);
    expect(asThePerson(home, "user.name")).toBe(renamed.name);
    expect(asThePerson(home, "user.email")).toBe(renamed.email);
    const config = path.join(home, ".config/git/config");
    expect(gitGet(config, "include.path")).toBe(path.join(home, ".mend/git-author"));
    // Cleared in Mend: no stale author left behind.
    expect((await pickUp(opened, home, null)).status).toBe(0);
    expect(asThePerson(home, "user.name")).toBe("");
    expect(gitGet(config, "include.path")).toBe(path.join(home, ".mend/git-author"));
  });

  it("puts Mend's author under theirs: their dotfiles' author and config stay and win", async () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    // What their dotfiles (or their own `git config --global`) put in the XDG file.
    const config = path.join(home, ".config/git/config");
    const theirs = [
      '[url "git@github.com:"]',
      "\tinsteadOf = https://github.com/",
      "[commit]",
      "\tgpgsign = true",
      "[user]",
      "\tsigningkey = ~/.ssh/id_ed25519.pub",
      "\temail = alice@work.example",
      "[gpg]",
      "\tformat = ssh",
      "",
    ].join("\n");
    fs.writeFileSync(config, theirs, { mode: 0o640 });
    const opened = await channel();
    expect((await pickUp(opened, home)).status).toBe(0);
    // Mend's include at the very top; their file, byte for byte, after it.
    const text = fs.readFileSync(config, "utf8");
    expect(text).toBe(`[include]\n\tpath = ${path.join(home, ".mend/git-author")}\n${theirs}`);
    expect(fs.statSync(config).mode & 0o777).toBe(0o640);
    expect(asThePerson(home, "user.email")).toBe("alice@work.example");
    expect(asThePerson(home, "user.name")).toBe(AUTHOR.name);
    expect(asThePerson(home, "url.git@github.com:.insteadof")).toBe("https://github.com/");
    expect(asThePerson(home, "commit.gpgsign")).toBe("true");
    // What they set later with `git config --global` lands after the include, and wins, a
    // re-make's pickup included; the include is never added twice.
    spawnSync("git", ["config", "--global", "user.name", "Al"], {
      env: { PATH: process.env["PATH"] ?? "", HOME: home },
    });
    expect((await pickUp(opened, home)).status).toBe(0);
    expect(asThePerson(home, "user.name")).toBe("Al");
    expect(gitGet(config, "include.path")).toBe(path.join(home, ".mend/git-author"));
  });

  it("drops a leading BOM rather than move it mid-file, and keeps group write", async () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    const config = path.join(home, ".config/git/config");
    fs.writeFileSync(config, "\uFEFF[user]\n\temail = theirs@x.example\n");
    fs.chmodSync(config, 0o664);
    expect(asThePerson(home, "user.email")).toBe("theirs@x.example");
    const opened = await channel();
    const run = await pickUp(opened, home);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const text = fs.readFileSync(config, "utf8");
    expect(text.includes("\uFEFF")).toBe(false);
    expect(text.startsWith("[include]\n")).toBe(true);
    expect(fs.statSync(config).mode & 0o777).toBe(0o664);
    // Every git command for them still works; theirs wins, Mend fills the rest.
    expect(asThePerson(home, "user.email")).toBe("theirs@x.example");
    expect(asThePerson(home, "user.name")).toBe(AUTHOR.name);
  });

  it("drops the BOM from a config that holds nothing else, too", async () => {
    for (const only of ["\uFEFF", "\uFEFF\n"]) {
      const { home, script } = homeOf(null);
      expect(sh(script).status).toBe(0);
      const config = path.join(home, ".config/git/config");
      fs.writeFileSync(config, only);
      const opened = await channel();
      const run = await pickUp(opened, home);
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(fs.readFileSync(config, "utf8").includes("\uFEFF")).toBe(false);
      expect(asThePerson(home, "user.name")).toBe(AUTHOR.name);
    }
  });

  it("removes a config.lock a dead writer left 30 s ago, without waiting on it", async () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    const config = path.join(home, ".config/git/config");
    fs.writeFileSync(config, "[pull]\n\trebase = true\n");
    fs.writeFileSync(`${config}.lock`, "");
    const minuteAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(`${config}.lock`, minuteAgo, minuteAgo);
    const opened = await channel();
    const started = performance.now();
    const run = await pickUp(opened, home);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(gitGet(config, "include.path")).toBe(path.join(home, ".mend/git-author"));
    expect(fs.existsSync(`${config}.lock`)).toBe(false);
  });

  it("waits for git's own lock on their config, and adds the include once it is free", async () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    const config = path.join(home, ".config/git/config");
    fs.writeFileSync(config, "[pull]\n\trebase = true\n");
    // Their `git config --global` is mid-write: it holds config.lock.
    fs.writeFileSync(`${config}.lock`, "");
    const opened = await channel();
    const released = new Promise<void>((resolve) =>
      setTimeout(() => {
        fs.rmSync(`${config}.lock`);
        resolve();
      }, 400),
    );
    const run = await pickUp(opened, home);
    await released;
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(gitGet(config, "include.path")).toBe(path.join(home, ".mend/git-author"));
    expect(gitGet(config, "pull.rebase")).toBe("true");
    expect(fs.existsSync(`${config}.lock`)).toBe(false);
  });

  it("leaves a config git cannot parse alone, says so, and never stacks includes in it", async () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    const config = path.join(home, ".config/git/config");
    const broken = "[user\n\tname = half a section\n";
    fs.writeFileSync(config, broken);
    const opened = await channel();
    for (let i = 0; i < 3; i++) {
      const run = await pickUp(opened, home);
      expect(run.status).toBe(0);
      expect(run.stderr).toContain("git cannot read");
      expect(run.stderr).not.toContain("Node.js");
    }
    expect(fs.readFileSync(config, "utf8")).toBe(broken);
  });

  it("says what failed when the include cannot be written, never just Node's version", async () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    const dir = path.join(home, ".config/git");
    fs.writeFileSync(path.join(dir, "config"), "[pull]\n\trebase = true\n");
    // A directory they cannot write: an image left it root's.
    fs.chmodSync(dir, 0o555);
    try {
      const opened = await channel();
      const run = await pickUp(opened, home);
      expect(run.status).toBe(0);
      expect(run.stderr).toContain("git author was not included in their git config: EACCES");
      expect(run.stderr).not.toContain("Node.js");
      expect(fs.readFileSync(path.join(home, ".mend/session-token"), "utf8")).toBe(TOKEN);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it("lets a person's concurrent first processes all write their identity", async () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    fs.writeFileSync(path.join(home, ".config/git/config"), "[pull]\n\trebase = true\n");
    const opened = await channel();
    const runs = await Promise.all([
      pickUp(opened, home),
      pickUp(opened, home),
      pickUp(opened, home),
    ]);
    for (const run of runs) {
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
    }
    expect(fs.readFileSync(path.join(home, ".mend/session-token"), "utf8")).toBe(TOKEN);
    expect(gitGet(path.join(home, ".config/git/config"), "include.path")).toBe(
      path.join(home, ".mend/git-author"),
    );
    expect(fs.readdirSync(path.join(home, ".mend")).toSorted()).toEqual([
      "git-author",
      "opencode",
      "session-token",
    ]);
  });

  it("includes Mend's author through a ~/.config/git their dotfiles linked, and never fails the person over it", async () => {
    const { dir, home, script } = homeOf(null);
    // Their install.sh linked ~/.config/git into their checkout before prepare made the rest.
    const checkout = path.join(dir, "dotfiles", "git");
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, "config"), "[pull]\n\trebase = true\n");
    fs.mkdirSync(path.join(home, ".config"), { recursive: true });
    fs.symlinkSync(checkout, path.join(home, ".config/git"));
    expect(sh(script).status).toBe(0);
    expect(fs.lstatSync(path.join(home, ".config/git")).isSymbolicLink()).toBe(true);
    const opened = await channel();
    const run = await pickUp(opened, home);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`mend-layout identity ${alice.name}\n`);
    expect(fs.lstatSync(path.join(home, ".config/git")).isSymbolicLink()).toBe(true);
    expect(gitGet(path.join(checkout, "config"), "pull.rebase")).toBe("true");
    expect(asThePerson(home, "user.email")).toBe(AUTHOR.email);
    // A link that leads nowhere: the author is not included, said on stderr, and the person is
    // fine, their token written.
    const broken = homeOf(null);
    fs.mkdirSync(path.join(broken.home, ".config"), { recursive: true });
    fs.symlinkSync(path.join(broken.dir, "nowhere"), path.join(broken.home, ".config/git"));
    expect(sh(broken.script).status).toBe(0);
    const again = await pickUp(opened, broken.home);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe(`mend-layout identity ${alice.name}\n`);
    expect(again.stderr).toContain("git author was not included");
    expect(fs.readFileSync(path.join(broken.home, ".mend/session-token"), "utf8")).toBe(TOKEN);
  });

  it("tries a redemption once more when the channel is busy", async () => {
    const { home, script } = homeOf(null);
    expect(sh(script).status).toBe(0);
    const opened = await channel(1);
    const run = await runExec(
      [
        "sh",
        "-c",
        identityPickupScript([{ person: alice, ticket: identityTicket(opened, home), home }]),
      ],
      opened.env,
    );
    expect(run.status).toBe(0);
    expect(opened.redemptions()).toBe(2);
    expect(fs.readFileSync(path.join(home, ".mend/session-token"), "utf8")).toBe(TOKEN);
  });

  it("skips a person prepare did not make, and never presents their ticket", async () => {
    const opened = await channel();
    const home = path.join(tempDir("mend-identity-"), "home", alice.name);
    const ticket = identityTicket(opened, home);
    const run = await runExec(
      ["sh", "-c", identityPickupScript([{ person: alice, ticket, home }])],
      opened.env,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(opened.redemptions()).toBe(0);
    expect(opened.tickets.size()).toBe(1);
  });

  it("as root gives the files to their person", async () => {
    // Under a fake root, `id -u` says 0; node's own uid decides the chown, so as a non-root test
    // it only shows the files are written where a root run would give them away.
    const root = fakeRoot();
    const { home, script } = homeOf(root);
    expect(root.run(script).status).toBe(0);
    // `-h`: a link their dotfiles made is given away, never what it points at.
    expect(root.log()).toContain(
      `chown -h 40012:40000 ${home}/.mend ${home}/.config ${home}/.config/git`,
    );
  });

  it("refuses a ~/.mend that is a link, and a ticket that is not one", () => {
    const { home, script } = homeOf(null);
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(tempDir("elsewhere-"), path.join(home, ".mend"));
    const run = sh(script);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("unexpected link");
    expect(() => identityPickupScript([{ person: alice, ticket: "x'; rm -rf / #" }])).toThrow(
      "a pickup ticket",
    );
  });

  it("names the process's session and its person's token file, and blanks shared logins", () => {
    expect(personProcessEnv("/workspace/harness-home", alice, "sess-1")).toMatchObject({
      MEND_SESSION_ID: "sess-1",
      MEND_SESSION_TOKEN_FILE: "/home/m3kq7xj2a/.mend/session-token",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
  });
});

describe("a person who cannot be made says why (review of mend#552, P3-8)", () => {
  it("names the person and their last words in the report", () => {
    const root = fakeRoot();
    root.failUseradd();
    const { script } = prepare(root, [{ person: alice, ifSaved: false }]);
    const report = parseLayoutReport(root.run(script).stdout);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatch(new RegExp(`^${alice.name}`));
    expect(
      parseLayoutReport("mend-layout failed m3kq7xj2a useradd: uid 40012 is not unique\n").failed,
    ).toEqual(["m3kq7xj2a: useradd: uid 40012 is not unique"]);
  });
});

describe("mend-git-credential (decision 4)", () => {
  const helper = () => {
    const dir = tempDir("mend-git-credential-");
    const script = path.join(dir, "mend-git-credential");
    fs.writeFileSync(script, GIT_CREDENTIAL_HELPER_SCRIPT, { mode: 0o755 });
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".config/gh"), { recursive: true });
    // The helper reads the passwd home, never $HOME: the test hands it one through os.userInfo,
    // and points HOME elsewhere to show HOME is not what it reads.
    const passwd = path.join(dir, "passwd-home.cjs");
    fs.writeFileSync(
      passwd,
      `const os = require("node:os"); const real = os.userInfo; os.userInfo = (o) => ({ ...real(o), homedir: ${JSON.stringify(home)} });`,
    );
    const run = (args: ReadonlyArray<string>, input = "") =>
      spawnSync(process.execPath, ["--require", passwd, script, ...args], {
        encoding: "utf8",
        input,
        env: { ...process.env, HOME: path.join(dir, "not-the-home") },
      });
    const hosts = (text: string) => fs.writeFileSync(path.join(home, ".config/gh/hosts.yml"), text);
    return { run, hosts };
  };

  it("answers github.com over HTTPS with the user's own login, and nothing else", () => {
    const { run, hosts } = helper();
    hosts(
      [
        "github.com:",
        "    users:",
        "        someone-else:",
        "            oauth_token: gho_not_this_one",
        "    oauth_token: gho_alices",
        "    git_protocol: https",
        "    user: alice",
        "gitlab.com:",
        "    oauth_token: glpat_other",
        "",
      ].join("\n"),
    );
    const get = run(["get"], "protocol=https\nhost=github.com\n\n");
    expect(get.status).toBe(0);
    expect(get.stdout).toBe("username=alice\npassword=gho_alices\n");
    expect(run(["get"], "protocol=https\nhost=gitlab.com\n\n").stdout).toBe("");
    expect(run(["get"], "protocol=http\nhost=github.com\n\n").stdout).toBe("");
    expect(run(["store"], "protocol=https\nhost=github.com\n\n").stdout).toBe("");
    expect(run(["token"]).stdout).toBe("gho_alices\n");
  });

  it("says nothing to git without a login, and fails `token` with why", () => {
    const { run } = helper();
    const get = run(["get"], "protocol=https\nhost=github.com\n\n");
    expect(get.status).toBe(0);
    expect(get.stdout).toBe("");
    const token = run(["token"]);
    expect(token.status).toBe(1);
    expect(token.stderr).toContain("no GitHub login");
  });
});
