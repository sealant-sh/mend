import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SECRET_FILE_RESERVED_PATHS, validateSecretFilePath } from "@mend/domain/workbench";
import { BlobStore, BlobStoreFsLive, captureKeys, listCaptureFiles } from "@mend/store";
import { buildManifest, sectionOf, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { HARNESS_STATE } from "./harness-state.ts";
import {
  SECRET_FILE_PART_SUFFIX,
  parseSecretFileOutcomes,
  planSecretFiles,
  secretFilesExecs,
  type SecretFileOutcome,
  type SecretFileToWrite,
} from "./secret-files.ts";
import { WORKSPACE_EXEC_ARG_CHARS } from "./workspace-files.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const utf8 = (at: string, text: string): SecretFileToWrite => ({
  path: at,
  bytes: new TextEncoder().encode(text),
});

/** Run every exec as the engine does, with `home` as the workspace user's `$HOME`. */
const write = (home: string, files: ReadonlyArray<SecretFileToWrite>) => {
  const outcomes: Array<SecretFileOutcome> = [];
  for (const argv of secretFilesExecs(files)) {
    const [command, ...args] = argv;
    const result = spawnSync(command ?? "sh", args, {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    outcomes.push(...parseSecretFileOutcomes(result.stdout));
  }
  return outcomes;
};

const mode = (file: string) => (fs.statSync(file).mode & 0o777).toString(8);

/** Every file under `root`, relative, sorted. */
const filesUnder = (root: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(dir, entry.name), at);
      else out.push(at);
    }
  };
  walk(root, "");
  return out.toSorted();
};

describe("writing secret files into a workspace home", () => {
  it("writes each file 0600 in a directory made 0700, and leaves no staging file", () => {
    const home = tempDir("mend-secret-home-");
    const outcomes = write(home, [
      utf8(".aws/credentials", "[default]\naws_access_key_id = AKIA\n"),
      utf8(".npmrc", "//registry.npmjs.org/:_authToken=t\n"),
    ]);
    expect(outcomes).toEqual([
      { path: ".aws/credentials", outcome: "written" },
      { path: ".npmrc", outcome: "written" },
    ]);
    expect(fs.readFileSync(path.join(home, ".aws/credentials"), "utf8")).toBe(
      "[default]\naws_access_key_id = AKIA\n",
    );
    expect(mode(path.join(home, ".aws/credentials"))).toBe("600");
    expect(mode(path.join(home, ".npmrc"))).toBe("600");
    expect(mode(path.join(home, ".aws"))).toBe("700");
    expect(filesUnder(home)).toEqual([".aws/credentials", ".npmrc"]);
  });

  it("replaces a file something else left there, and the replacement is 0600", () => {
    const home = tempDir("mend-secret-home-");
    fs.writeFileSync(path.join(home, ".npmrc"), "registry=https://example.test\n", { mode: 0o644 });
    const outcomes = write(home, [utf8(".npmrc", "//registry.npmjs.org/:_authToken=t\n")]);
    expect(outcomes).toEqual([{ path: ".npmrc", outcome: "written" }]);
    expect(fs.readFileSync(path.join(home, ".npmrc"), "utf8")).toBe(
      "//registry.npmjs.org/:_authToken=t\n",
    );
    expect(mode(path.join(home, ".npmrc"))).toBe("600");
  });

  it("assembles a file larger than one exec carries, chunk by chunk, with no part left", () => {
    const home = tempDir("mend-secret-home-");
    const bytes = new Uint8Array(randomBytes(200 * 1024));
    const execs = secretFilesExecs([{ path: ".kube/config", bytes }]);
    expect(execs.length).toBeGreaterThan(2);
    for (const argv of execs) {
      expect(argv.join("").length).toBeLessThan(WORKSPACE_EXEC_ARG_CHARS + 2000);
    }
    const outcomes = write(home, [{ path: ".kube/config", bytes }]);
    expect(outcomes).toEqual([{ path: ".kube/config", outcome: "written" }]);
    expect([...fs.readFileSync(path.join(home, ".kube/config"))]).toEqual([...bytes]);
    expect(mode(path.join(home, ".kube/config"))).toBe("600");
    expect(filesUnder(home)).toEqual([".kube/config"]);
    expect(fs.existsSync(path.join(home, `.kube/config${SECRET_FILE_PART_SUFFIX}`))).toBe(false);
  });

  it("refuses a directory that is a symlink, so dotfiles cannot redirect a file into the worktree", () => {
    const home = tempDir("mend-secret-home-");
    const worktree = tempDir("mend-secret-worktree-");
    fs.symlinkSync(worktree, path.join(home, ".aws"));
    fs.symlinkSync(path.join(worktree, "token"), path.join(home, ".npmrc"));
    const outcomes = write(home, [
      utf8(".aws/credentials", "secret"),
      utf8(".npmrc", "secret"),
      utf8(".config/plain/ok", "fine"),
    ]);
    expect(outcomes).toEqual([
      { path: ".aws/credentials", outcome: "refused", reason: ".aws is a symlink" },
      { path: ".npmrc", outcome: "refused", reason: "a symlink is at that path" },
      { path: ".config/plain/ok", outcome: "written" },
    ]);
    expect(filesUnder(worktree)).toEqual([]);
    expect(fs.existsSync(path.join(worktree, "token"))).toBe(false);
  });

  it("refuses a chunked file whose directory is a symlink, writing no chunk anywhere", () => {
    const home = tempDir("mend-secret-home-");
    const worktree = tempDir("mend-secret-worktree-");
    fs.symlinkSync(worktree, path.join(home, ".kube"));
    const bytes = new Uint8Array(randomBytes(120 * 1024));
    const outcomes = write(home, [{ path: ".kube/config", bytes }]);
    expect(outcomes).toEqual([
      { path: ".kube/config", outcome: "refused", reason: ".kube is a symlink" },
    ]);
    expect(filesUnder(worktree)).toEqual([]);
  });

  it("leaves out a stored path that no longer validates, and says so", () => {
    const plan = planSecretFiles([
      utf8(".aws/credentials", "x"),
      utf8(".claude/settings.json", "y"),
    ]);
    expect(plan.files.map((file) => file.path)).toEqual([".aws/credentials"]);
    expect(plan.refused).toEqual([
      {
        path: ".claude/settings.json",
        outcome: "refused",
        reason: ".claude/settings.json is under .claude, which sessions capture",
      },
    ]);
  });
});

describe("a secret file is never captured", () => {
  it("refuses every path the harness home relocation moves onto the captured root, and every harvested one", () => {
    for (const [harness, shape] of Object.entries(HARNESS_STATE)) {
      for (const entry of [...shape.homeDirs, ...shape.paths]) {
        expect(validateSecretFilePath(entry), `${harness}: ${entry}`).not.toBeNull();
        expect(
          validateSecretFilePath(`${entry}/credentials`),
          `${harness}: ${entry}/`,
        ).not.toBeNull();
      }
    }
    for (const reserved of SECRET_FILE_RESERVED_PATHS) {
      expect(validateSecretFilePath(reserved)).toContain("which sessions capture");
    }
    expect(validateSecretFilePath("../.aws/credentials")).not.toBeNull();
    expect(validateSecretFilePath("/root/.aws/credentials")).not.toBeNull();
    expect(validateSecretFilePath("~/.aws/credentials")).not.toBeNull();
    expect(validateSecretFilePath(".aws/credentials")).toBeNull();
    expect(validateSecretFilePath(".kube/config")).toBeNull();
    expect(validateSecretFilePath(".npmrc")).toBeNull();
    // Unrelated dotfiles that happen to share a prefix are not caught.
    expect(validateSecretFilePath(".claude-other/x")).toBeNull();
  });

  it("appears in neither the executor's capture listing nor the co-located harvest", async () => {
    const scratch = tempDir("mend-secret-capture-");
    const home = path.join(scratch, "home");
    const harnessHome = path.join(scratch, "harness-home");
    const worktree = path.join(scratch, "worktree");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, "README.md"), "# repo\n");
    // The home as the relocation leaves it: each harness directory a symlink onto the harness
    // root sealantd captures, with a conversation already in it.
    fs.mkdirSync(path.join(harnessHome, ".claude", "projects", "-workspace-repo"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(harnessHome, ".claude", "projects", "-workspace-repo", "s.jsonl"),
      "{}\n",
    );
    for (const dir of new Set(Object.values(HARNESS_STATE).flatMap((shape) => shape.homeDirs))) {
      fs.mkdirSync(path.join(harnessHome, dir), { recursive: true });
      fs.mkdirSync(path.dirname(path.join(home, dir)), { recursive: true });
      fs.symlinkSync(path.join(harnessHome, dir), path.join(home, dir));
    }
    fs.writeFileSync(path.join(home, ".claude.json"), "{}\n");
    const outcomes = write(home, [
      utf8(".aws/credentials", "[default]\naws_secret_access_key = SECRET\n"),
      utf8(".kube/config", "apiVersion: v1\n"),
    ]);
    expect(outcomes.every((outcome) => outcome.outcome === "written")).toBe(true);

    // The workspace class sealantd ships (sealant-capture `roots.rs`): the worktree under `tree/`
    // and the harness root under `harness/`. Nothing else of the executor's disk is a root.
    const stage = path.join(scratch, "stage");
    fs.cpSync(worktree, path.join(stage, "tree"), { recursive: true });
    fs.cpSync(harnessHome, path.join(stage, "harness"), { recursive: true });
    const keys = captureKeys("wt-secret", 1);
    const snapshot = snapshotDirectory(stage, keys);
    const built = buildManifest({
      worktreeId: "wt-secret",
      n: 1,
      parent: null,
      epoch: 1,
      workspace: sectionOf(snapshot),
    });
    const blobs = BlobStoreFsLive(path.join(scratch, "blobs"));
    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        yield* uploadObjects(snapshot.objects);
        return yield* listCaptureFiles(built.manifest, "workspace", "");
      }).pipe(Effect.provide(blobs)),
    );
    const paths = listed.map((file) => file.path).toSorted();
    expect(paths).toContain("tree/README.md");
    expect(paths).toContain("harness/.claude/projects/-workspace-repo/s.jsonl");
    expect(paths.filter((p) => p.includes(".aws") || p.includes(".kube"))).toEqual([]);
    const bytes = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        let total = "";
        for (const key of snapshot.objects.keys()) {
          total += Buffer.from(yield* store.get(key)).toString("latin1");
        }
        return total;
      }).pipe(Effect.provide(blobs)),
    );
    expect(bytes).not.toContain("SECRET");

    // The co-located harvest: `cd $HOME; tar -czhf … <the harness's state paths that exist>`
    // (engine.ts, the harvest), which dereferences the relocation's symlinks and carries nothing
    // but those paths.
    const shape = HARNESS_STATE["claude"];
    if (shape === undefined) throw new Error("claude shape");
    const present = shape.paths.filter((p) => fs.existsSync(path.join(home, p)));
    expect(present).toContain(".claude/projects");
    const archive = path.join(scratch, "harvest.tgz");
    const packed = spawnSync("tar", ["-czhf", archive, ...present], {
      cwd: home,
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const entries = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout.split("\n");
    expect(entries).toContain(".claude/projects/-workspace-repo/s.jsonl");
    expect(entries.filter((e) => e.includes(".aws") || e.includes(".kube"))).toEqual([]);
  });
});
