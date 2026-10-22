import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll } from "vitest";

const SLASH = Buffer.from("/");

const nameOf = (bytes: Buffer): string => {
  const text = bytes.toString("utf8");
  return Buffer.from(text).equals(bytes) ? text : `bytes:${bytes.toString("hex")}`;
};

export const fingerprint = (root: string): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  const top = Buffer.from(root);
  const walk = (dir: Buffer): void => {
    for (const name of fs.readdirSync(dir, { encoding: "buffer" }).toSorted(Buffer.compare)) {
      const full = Buffer.concat([dir, SLASH, name]);
      const stat = fs.lstatSync(full, { bigint: true });
      const content = stat.isFile()
        ? createHash("sha256").update(fs.readFileSync(full)).digest("hex")
        : stat.isSymbolicLink()
          ? fs.readlinkSync(full)
          : "";
      lines.push(
        [
          nameOf(full.subarray(top.length + 1)),
          stat.mode.toString(8),
          stat.size,
          stat.mtimeNs,
          stat.ctimeNs,
          content,
        ].join("|"),
      );
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(top);
  return lines;
};

const write = (file: string, content: string | Buffer): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const FIXTURE_EPOCH = 1_760_000_000;

export const handoffWorlds = () => {
  const roots: Array<string> = [];
  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  return (fileBytes = 64 * 1024) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-handoff-"));
    roots.push(root);
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    // A commit or clone otherwise starts a detached `git maintenance run --auto`, whose
    // objects/maintenance.lock comes and goes while a test fingerprints the checkout.
    fs.writeFileSync(
      path.join(home, ".gitconfig"),
      "[user]\n\tname = Dana\n\temail = dana@example.com\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = false\n[init]\n\tdefaultBranch = main\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n",
    );
    const gitEnv = {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
    };
    let clock = FIXTURE_EPOCH;
    const git = (cwd: string, args: ReadonlyArray<string>, input?: string): string => {
      clock += 1;
      const date = `${clock} +0000`;
      return execFileSync("git", ["-c", "commit.gpgSign=false", ...args], {
        cwd,
        env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        encoding: "utf8",
        ...(input === undefined ? {} : { input }),
      }).trim();
    };
    const gitBytes = (cwd: string, args: ReadonlyArray<string>): Buffer =>
      execFileSync("git", args, { cwd, env: gitEnv });

    const origin = path.join(root, "origin.git");
    git(root, ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = path.join(root, "seed");
    git(root, ["init", "-q", "-b", "main", seed]);
    const seedFiles: Record<string, string> = {
      "a.txt": "one\n",
      "b.txt": "keep\n",
      "d.txt": "doomed\n",
      ".env.example": "tmpl\n",
      ".env.defaults": "port=1\n",
      ".gitignore": "node_modules/\n*.log\n",
      ".gitattributes": "*.dat filter=marker\n",
      "assets/one.dat": "1111\n",
      "assets/two.dat": "2222\n",
      "config/.env.shared": "x=1\n",
      "docs/guide.md": "guide\n",
    };
    for (const [file, content] of Object.entries(seedFiles)) write(path.join(seed, file), content);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-q", "-m", "init"]);
    git(seed, ["push", "-q", origin, "HEAD:main"]);

    const clone = (name: string): string => {
      const dir = path.join(root, name);
      git(root, ["clone", "-q", origin, dir]);
      return dir;
    };

    const hostileEnv: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      GIT_DIR: path.join(root, "nowhere"),
      GIT_INDEX_FILE: path.join(root, "nowhere-index"),
      GIT_WORK_TREE: "/",
      GIT_OBJECT_DIRECTORY: path.join(root, "nowhere-objects"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: path.join(root, "nowhere-hooks"),
    };

    return { root, home, origin, git, gitBytes, write, clone, hostileEnv, fileBytes, seedFiles };
  };
};

export type HandoffWorld = ReturnType<ReturnType<typeof handoffWorlds>>;

export const mixedCheckout = (w: HandoffWorld) => {
  const dana = w.clone("dana");
  const at = (file: string) => path.join(dana, file);
  w.git(dana, ["switch", "-q", "-c", "fix/login"]);
  w.write(at("a.txt"), "one\ntwo\n");
  w.git(dana, ["commit", "-q", "-am", "c1"]);
  w.write(at("c.txt"), "three\n");
  w.git(dana, ["add", "c.txt"]);
  w.git(dana, ["commit", "-q", "-m", "c2"]);

  w.write(at("s.txt"), "staged\n");
  w.git(dana, ["add", "s.txt"]);
  w.write(at("a.txt"), "one\ntwo\nstaged-a\n");
  w.git(dana, ["add", "a.txt"]);
  w.write(at("a.txt"), "one\ntwo\nstaged-a\nunstaged-a\n");
  w.git(dana, ["rm", "-q", "--cached", "b.txt"]);
  fs.rmSync(at("b.txt"));
  fs.rmSync(at("d.txt"));
  fs.rmSync(at(".env.defaults"));
  w.write(at("c.txt"), "unstaged\n");
  w.write(at(".env.local"), "secret=1\n");
  w.write(at(".env.example"), "changed\n");
  w.write(at("config/.env.shared"), "x=2\n");
  w.git(dana, ["add", "config/.env.shared"]);
  w.write(at("u.txt"), "new\n");
  w.write(at("reuses-main-blob.txt"), "one\n");
  w.write(at("node_modules/dep.js"), "ignored\n");
  w.write(at("big.bin"), Buffer.alloc(w.fileBytes + 1, 7));
  w.write(at("huge-staged.bin"), Buffer.alloc(w.fileBytes + 1, 8));
  w.git(dana, ["add", "huge-staged.bin"]);
  w.write(at("huge-staged.bin"), "small now\n");
  w.write(at("assets/two.dat"), "2223\n");
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(at("assets/one.dat"), later, later);
  w.write(at("ita.txt"), "ita\n");
  w.git(dana, ["add", "-N", "ita.txt"]);
  w.git(dana, ["config", "core.splitIndex", "true"]);
  w.git(dana, ["update-index", "--split-index"]);
  const marker = path.join(w.root, "clean-filter-ran");
  w.git(dana, ["config", "filter.marker.clean", `sh -c 'touch ${marker}; cat'`]);
  w.git(dana, ["config", "filter.marker.process", `sh -c 'touch ${marker}'`]);
  w.git(dana, ["config", "filter.marker.required", "true"]);
  return { checkout: dana, marker };
};

export const countedCheckout = (w: HandoffWorld): string => {
  const dana = w.clone("facts");
  const at = (file: string) => path.join(dana, file);
  w.git(dana, ["switch", "-q", "-c", "fix/facts"]);
  w.write(at("one.txt"), "1\n");
  w.git(dana, ["add", "one.txt"]);
  w.git(dana, ["commit", "-q", "-m", "one"]);
  w.write(at("two.txt"), "2\n");
  w.git(dana, ["add", "two.txt"]);
  w.git(dana, ["commit", "-q", "-m", "two"]);
  w.write(at("a.txt"), "staged only\n");
  w.git(dana, ["add", "a.txt"]);
  w.write(at("a.txt"), "one\n");
  w.write(at("b.txt"), "unstaged\n");
  w.write(at("docs/new.md"), "new\n");
  w.git(dana, ["add", "docs/new.md"]);
  w.write(at("notes.txt"), "untracked\n");
  w.write(at("debug.log"), "ignored\n");
  return dana;
};

export const committedEnvCheckout = (w: HandoffWorld) => {
  const dana = w.clone("committed-env");
  const at = (file: string) => path.join(dana, file);
  w.git(dana, ["switch", "-q", "-c", "fix/env"]);
  w.write(at(".env.prod"), "token=1\n");
  w.git(dana, ["add", ".env.prod"]);
  w.git(dana, ["commit", "-q", "-m", "add prod env"]);
  const added = w.git(dana, ["rev-parse", "--short=7", "HEAD"]);
  w.git(dana, ["rm", "-q", ".env.prod"]);
  w.git(dana, ["commit", "-q", "-m", "drop it again"]);
  w.write(at("deploy/.env.staging"), "token=2\n");
  w.write(at("deploy/run.sh"), "run\n");
  w.git(dana, ["add", "deploy"]);
  w.git(dana, ["commit", "-q", "-m", "staging"]);
  const staging = w.git(dana, ["rev-parse", "--short=7", "HEAD"]);
  return { checkout: dana, added, staging };
};

export const detachedCheckout = (w: HandoffWorld): string => {
  const dana = w.clone("detached");
  w.git(dana, ["checkout", "-q", "--detach"]);
  w.write(path.join(dana, "a.txt"), "edited\n");
  return dana;
};

export const linkedWorktree = (w: HandoffWorld) => {
  const main = w.clone("main-checkout");
  const linked = path.join(w.root, "linked");
  w.git(main, ["worktree", "add", "-q", "-b", "feature", linked]);
  w.write(path.join(linked, "a.txt"), "in the linked worktree\n");
  w.git(linked, ["add", "a.txt"]);
  w.write(path.join(linked, "fresh.txt"), "fresh\n");
  w.write(path.join(main, "a.txt"), "the main checkout's own edit\n");
  return { main, linked };
};

export const noOriginMainCheckout = (w: HandoffWorld): string => {
  const dana = w.clone("no-tracking");
  w.git(dana, ["update-ref", "-d", "refs/remotes/origin/main"]);
  return dana;
};

export const unmergedCheckout = (w: HandoffWorld): string => {
  const dana = w.clone("unmerged");
  w.git(dana, ["switch", "-q", "-c", "left"]);
  w.write(path.join(dana, "a.txt"), "left\n");
  w.git(dana, ["commit", "-q", "-am", "left"]);
  w.git(dana, ["switch", "-q", "-c", "right", "main"]);
  w.write(path.join(dana, "a.txt"), "right\n");
  w.git(dana, ["commit", "-q", "-am", "right"]);
  try {
    w.git(dana, ["merge", "-q", "left"]);
  } catch {
    return dana;
  }
  throw new Error("the merge did not conflict");
};

export const nonUtf8Checkout = (w: HandoffWorld) => {
  const dana = w.clone("bytes");
  const onDisk = (name: Buffer) => Buffer.concat([Buffer.from(`${dana}/`), name]);
  const tracked = Buffer.from([...Buffer.from("tracked-"), 0xff, 0x2e, 0x74]);
  const untracked = Buffer.from([...Buffer.from("untracked-"), 0xff, 0x2e, 0x74]);
  fs.writeFileSync(onDisk(tracked), "v1\n");
  w.git(dana, ["add", "-A"]);
  w.git(dana, ["commit", "-q", "-m", "a name that is not UTF-8"]);
  fs.writeFileSync(onDisk(tracked), "v2\n");
  fs.writeFileSync(onDisk(untracked), "new\n");
  return { checkout: dana, tracked, untracked };
};

export const SAME_TICKS: ReadonlyArray<readonly [string, Date]> = [
  ["now", new Date("2026-10-18T07:00:00.000Z")],
  ["before 1970", new Date(-500)],
  ["before 1834", new Date(-4_294_967_294_500)],
];

export const sameTickCheckout = (w: HandoffWorld, tick: Date): string => {
  const dana = w.clone("same-tick");
  const file = path.join(dana, "a.txt");
  // ctime cannot be set, so a test can only line up mtime and size; CI lined up all three.
  w.git(dana, ["config", "core.trustctime", "false"]);
  w.write(file, "v1\n");
  fs.utimesSync(file, tick, tick);
  w.git(dana, ["commit", "-q", "-am", "v1"]);
  w.write(file, "v2\n");
  fs.utimesSync(file, tick, tick);
  fs.utimesSync(path.join(dana, ".git", "index"), tick, tick);
  return dana;
};

export const dirToFileCheckout = (w: HandoffWorld): string => {
  const dana = w.clone("dir-to-file");
  fs.rmSync(path.join(dana, "docs"), { recursive: true });
  w.write(path.join(dana, "docs"), "a file now\n");
  return dana;
};

export const hiddenEditsCheckout = (w: HandoffWorld): string => {
  const dana = w.clone("hidden-edits");
  w.git(dana, ["update-index", "--assume-unchanged", "a.txt"]);
  w.write(path.join(dana, "a.txt"), "assumed unchanged, edited\n");
  w.git(dana, ["update-index", "--skip-worktree", "b.txt"]);
  w.write(path.join(dana, "b.txt"), "skipped, edited\n");
  w.git(dana, ["update-index", "--assume-unchanged", "d.txt"]);
  w.git(dana, ["update-index", "--skip-worktree", "d.txt"]);
  w.write(path.join(dana, "d.txt"), "both, edited\n");
  w.git(dana, ["update-index", "--skip-worktree", "docs/guide.md"]);
  w.git(dana, ["update-index", "--assume-unchanged", "config/.env.shared"]);
  w.write(path.join(dana, "config/.env.shared"), "x=2\n");
  return dana;
};

export const partialClone = (w: HandoffWorld): string => {
  w.git(w.origin, ["config", "uploadpack.allowFilter", "true"]);
  const seed = w.clone("partial-seed");
  w.git(seed, ["switch", "-q", "-c", "feature"]);
  for (const step of ["first", "second"]) {
    w.write(path.join(seed, "a.txt"), `${step}\n`);
    w.git(seed, ["commit", "-q", "-am", step]);
  }
  w.git(seed, ["push", "-q", "origin", "feature"]);
  const dana = path.join(w.root, "partial");
  w.git(w.root, ["clone", "-q", "--filter=tree:0", `file://${w.origin}`, dana]);
  w.git(dana, ["switch", "-q", "feature"]);
  w.write(path.join(dana, "a.txt"), "edited in the partial clone\n");
  return dana;
};

export const fetchedPartialClone = (w: HandoffWorld): string => {
  const dana = partialClone(w);
  const mergeBase = w.git(dana, ["merge-base", "HEAD", "origin/main"]);
  w.git(dana, ["log", "-p", `${mergeBase}..HEAD`]);
  return dana;
};

export const replacedCheckout = (w: HandoffWorld) => {
  const dana = w.clone("replaced");
  w.git(dana, ["switch", "-q", "-c", "fix/real"]);
  w.write(path.join(dana, ".env.prod"), "token=1\n");
  w.git(dana, ["add", ".env.prod"]);
  w.git(dana, ["commit", "-q", "-m", "real"]);
  const real = w.git(dana, ["rev-parse", "--short=7", "HEAD"]);
  const decoy = w.git(dana, [
    "commit-tree",
    "-p",
    "origin/main",
    "-m",
    "decoy",
    "origin/main^{tree}",
  ]);
  w.git(dana, ["replace", "HEAD", decoy]);
  return { checkout: dana, real };
};

export const signedCheckout = (w: HandoffWorld) => {
  const dana = w.clone("signed");
  w.git(dana, ["switch", "-q", "-c", "fix/signed"]);
  w.write(path.join(dana, ".env.prod"), "token=1\n");
  w.git(dana, ["add", ".env.prod"]);
  const tree = w.git(dana, ["write-tree"]);
  const parent = w.git(dana, ["rev-parse", "HEAD"]);
  const ident = "Dana <dana@example.com> 1760000000 +0000";
  const signed = w.git(
    dana,
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    [
      `tree ${tree}`,
      `parent ${parent}`,
      `author ${ident}`,
      `committer ${ident}`,
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " iQEzBAABCAAdFiEEnotarealsignature",
      " -----END PGP SIGNATURE-----",
      "",
      "signed",
      "",
    ].join("\n"),
  );
  w.git(dana, ["reset", "-q", "--hard", signed]);
  const marker = path.join(w.root, "verifier-ran");
  const verifier = path.join(w.root, "verifier.sh");
  fs.writeFileSync(verifier, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  w.git(dana, ["config", "log.showSignature", "true"]);
  w.git(dana, ["config", "gpg.program", verifier]);
  return { checkout: dana, signed, marker };
};

export const sparseIndexCheckout = (w: HandoffWorld, name = "sparse"): string => {
  const dana = w.clone(name);
  w.git(dana, ["sparse-checkout", "set", "--cone", "docs"]);
  w.git(dana, ["config", "index.sparse", "true"]);
  w.git(dana, ["sparse-checkout", "reapply"]);
  w.write(path.join(dana, "docs/guide.md"), "guide, edited\n");
  w.write(path.join(dana, "docs/new.md"), "new\n");
  return dana;
};

export const evilMergeCheckout = (w: HandoffWorld) => {
  const dana = w.clone("evil-merge");
  w.git(dana, ["switch", "-q", "-c", "side"]);
  w.write(path.join(dana, "side.txt"), "side\n");
  w.git(dana, ["add", "side.txt"]);
  w.git(dana, ["commit", "-q", "-m", "side"]);
  w.git(dana, ["switch", "-q", "-c", "fix/merge", "origin/main"]);
  w.write(path.join(dana, "fix.txt"), "fix\n");
  w.git(dana, ["add", "fix.txt"]);
  w.git(dana, ["commit", "-q", "-m", "fix"]);
  w.git(dana, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
  w.write(path.join(dana, ".env.prod"), "token=1\n");
  w.git(dana, ["add", ".env.prod"]);
  w.git(dana, ["commit", "-q", "-m", "merge side"]);
  const merge = w.git(dana, ["rev-parse", "--short=7", "HEAD"]);
  return { checkout: dana, merge };
};

export const ignoredEnvCheckout = (w: HandoffWorld): string => {
  const dana = w.clone("ignored-env");
  fs.appendFileSync(path.join(dana, ".git/info/exclude"), ".env.production\nsecrets/\n");
  w.write(path.join(dana, ".env.production"), "token=1\n");
  w.write(path.join(dana, "secrets/.env"), "token=2\n");
  w.write(path.join(dana, "debug.log"), "ignored, not env\n");
  return dana;
};

export const envFilesCheckout = (w: HandoffWorld) => {
  const dana = w.clone("env-files");
  const at = (file: string) => path.join(dana, file);
  w.git(dana, ["switch", "-q", "-c", "fix/env"]);
  w.write(at(".env"), "committed=1\n");
  w.git(dana, ["add", ".env"]);
  w.git(dana, ["commit", "-q", "-m", "add .env"]);
  const committed = w.git(dana, ["rev-parse", "--short=7", "HEAD"]);
  w.write(at(".env"), "committed=2\n");
  w.write(at(".env.local"), "local=1\n");
  fs.appendFileSync(at(".git/info/exclude"), ".env.secret\n");
  w.write(at(".env.secret"), "secret=1\n");
  w.write(at(".env.big"), Buffer.alloc(w.fileBytes + 1, 9));
  w.write(at(".env.dat"), "filtered\n");
  return { checkout: dana, committed };
};

export const mergedMainCheckout = (w: HandoffWorld) => {
  const dana = w.clone("merged-main");
  const forkPoint = w.git(dana, ["rev-parse", "HEAD"]);
  w.git(dana, ["switch", "-q", "-c", "fix/catch-up"]);
  w.write(path.join(dana, "fix.txt"), "fix\n");
  w.git(dana, ["add", "fix.txt"]);
  w.git(dana, ["commit", "-q", "-m", "fix"]);
  const upstream = w.clone("upstream");
  w.write(path.join(upstream, "main.txt"), "main moved\n");
  w.git(upstream, ["add", "main.txt"]);
  w.git(upstream, ["commit", "-q", "-m", "main moves"]);
  w.git(upstream, ["push", "-q", "origin", "HEAD:main"]);
  w.git(dana, ["fetch", "-q", "origin"]);
  w.git(dana, ["merge", "-q", "--no-edit", "origin/main"]);
  w.write(path.join(dana, "fix.txt"), "fix, after the merge\n");
  w.git(dana, ["commit", "-q", "-am", "after"]);
  const mainTip = w.git(dana, ["rev-parse", "origin/main"]);
  return { checkout: dana, forkPoint, mainTip };
};

export const newsroomCheckout = (
  w: HandoffWorld,
  origin: string,
  name = "newsroom-api",
): string => {
  const dana = w.clone(name);
  const at = (file: string) => path.join(dana, file);
  w.git(dana, ["remote", "set-url", "origin", origin]);
  w.git(dana, ["switch", "-q", "-c", "fix/login"]);
  w.write(at("login.ts"), "export const login = 1;\n");
  w.git(dana, ["add", "login.ts"]);
  w.git(dana, ["commit", "-q", "-m", "login"]);
  w.write(at("a.txt"), "one\ntwo\n");
  w.git(dana, ["commit", "-q", "-am", "two"]);
  w.write(at("a.txt"), "one\ntwo\nstaged\n");
  w.git(dana, ["add", "a.txt"]);
  w.write(at("b.txt"), "unstaged\n");
  fs.rmSync(at("d.txt"));
  w.write(at("tests/login.test.ts"), "test\n");
  w.write(at(".env.local"), "secret=1\n");
  w.write(at("assets/demo.mov"), Buffer.alloc(100 * 1024, 1));
  return dana;
};

export const hiddenNewsroomCheckout = (w: HandoffWorld, origin: string): string => {
  const dana = newsroomCheckout(w, origin);
  w.git(dana, ["update-index", "--skip-worktree", "b.txt"]);
  w.git(dana, ["update-index", "--assume-unchanged", "docs/guide.md"]);
  w.write(path.join(dana, "docs/guide.md"), "guide, edited\n");
  return dana;
};

export const detachedNewsroomCheckout = (w: HandoffWorld, origin: string): string => {
  const dana = w.clone("newsroom-api");
  w.git(dana, ["remote", "set-url", "origin", origin]);
  w.git(dana, ["checkout", "-q", "--detach"]);
  w.write(path.join(dana, "a.txt"), "edited\n");
  return dana;
};

export const unbornCheckout = (w: HandoffWorld, origin: string): string => {
  const unborn = path.join(w.root, "unborn");
  w.git(w.root, ["init", "-q", "-b", "main", unborn]);
  w.git(unborn, ["remote", "add", "origin", origin]);
  return unborn;
};

export const conflictedNewsroomCheckout = (w: HandoffWorld, origin: string): string => {
  const conflicted = newsroomCheckout(w, origin, "conflicted");
  w.git(conflicted, ["stash", "-q", "-u"]);
  w.git(conflicted, ["switch", "-q", "-c", "theirs", "origin/main"]);
  w.write(path.join(conflicted, "a.txt"), "theirs\n");
  w.git(conflicted, ["commit", "-q", "-am", "theirs"]);
  try {
    w.git(conflicted, ["merge", "-q", "fix/login"]);
  } catch {
    return conflicted;
  }
  throw new Error("the merge did not conflict");
};

export const nothingFetchedCheckout = (w: HandoffWorld, origin: string): string => {
  const dana = newsroomCheckout(w, origin, "nothing-fetched");
  w.git(dana, ["update-ref", "-d", "refs/remotes/origin/main"]);
  return dana;
};

export const otherDefaultCheckout = (w: HandoffWorld, origin: string): string => {
  const dana = newsroomCheckout(w, origin, "other-default");
  w.git(dana, ["update-ref", "refs/remotes/origin/trunk", "refs/remotes/origin/main"]);
  w.git(dana, ["update-ref", "-d", "refs/remotes/origin/main"]);
  w.git(dana, ["remote", "set-head", "origin", "-d"]);
  return dana;
};

export const danglingOriginHeadCheckout = (w: HandoffWorld, origin: string): string => {
  w.git(w.origin, ["branch", "-m", "main", "master"]);
  w.git(w.origin, ["symbolic-ref", "HEAD", "refs/heads/master"]);
  const renamed = newsroomCheckout(w, origin, "renamed");
  w.git(w.origin, ["branch", "-m", "master", "main"]);
  w.git(w.origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  w.git(renamed, ["remote", "set-url", "origin", w.origin]);
  w.git(renamed, ["fetch", "-q", "--prune", "origin"]);
  w.git(renamed, ["remote", "set-url", "origin", origin]);
  return renamed;
};

export const unsetDefaultCheckout = (w: HandoffWorld, origin: string): string => {
  const dana = newsroomCheckout(w, origin, "unset");
  w.git(dana, ["remote", "set-head", "origin", "-d"]);
  return dana;
};
