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
    const git = (cwd: string, args: ReadonlyArray<string>, input?: string): string =>
      execFileSync("git", ["-c", "commit.gpgSign=false", ...args], {
        cwd,
        env: gitEnv,
        encoding: "utf8",
        ...(input === undefined ? {} : { input }),
      }).trim();
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
