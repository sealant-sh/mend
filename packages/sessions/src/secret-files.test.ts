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
  SECRET_FILE_PART_PREFIX,
  SECRET_FILES_DELIVERED,
  foldSecretFileOutcomes,
  parseSecretFileOutcomes,
  parseSecretFilesDelivered,
  planSecretFiles,
  secretFilesCleanupExec,
  secretFilesDeliveredExec,
  secretFilesExecs,
  secretFilesRecordExec,
  secretFilesRemoveExec,
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

const STAMP = "0123abcd";

/** Run one exec as the engine does, with `home` as the workspace user's `$HOME`. */
const run = (home: string, argv: ReadonlyArray<string>) => {
  const [command, ...args] = argv;
  const result = spawnSync(command ?? "sh", args, {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
};

/** Run every write exec of one delivery, folding outcomes as the engine does. */
const write = (home: string, files: ReadonlyArray<SecretFileToWrite>, stamp = STAMP) => {
  const outcomes: Array<SecretFileOutcome> = [];
  for (const argv of secretFilesExecs(files, stamp)) {
    outcomes.push(...parseSecretFileOutcomes(run(home, argv)));
  }
  return foldSecretFileOutcomes(outcomes);
};

const mode = (file: string) => (fs.statSync(file).mode & 0o777).toString(8);

/** Every file under `root`, relative, sorted; a symlink is listed, not followed. */
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

  it("takes a path with spaces, quotes and a leading dash as it is", () => {
    const home = tempDir("mend-secret-home-");
    const odd = '-odd dir/it\'s "quoted"/$HOME `x` *.txt';
    expect(validateSecretFilePath(odd)).toBeNull();
    const outcomes = write(home, [utf8(odd, "fine\n")]);
    expect(outcomes).toEqual([{ path: odd, outcome: "written" }]);
    expect(fs.readFileSync(path.join(home, odd), "utf8")).toBe("fine\n");
    expect(filesUnder(home)).toEqual([odd]);
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
    const execs = secretFilesExecs([{ path: ".kube/config", bytes }], STAMP);
    expect(execs.length).toBeGreaterThan(2);
    for (const argv of execs) {
      expect(argv.join("").length).toBeLessThan(WORKSPACE_EXEC_ARG_CHARS + 3000);
    }
    const outcomes = write(home, [{ path: ".kube/config", bytes }]);
    expect(outcomes).toEqual([{ path: ".kube/config", outcome: "written" }]);
    expect([...fs.readFileSync(path.join(home, ".kube/config"))]).toEqual([...bytes]);
    expect(mode(path.join(home, ".kube/config"))).toBe("600");
    expect(filesUnder(home)).toEqual([".kube/config"]);
  });

  it("two deliveries into one home at once each leave a whole file, never a mixed one", () => {
    const home = tempDir("mend-secret-home-");
    const a = new Uint8Array(randomBytes(100 * 1024));
    const b = new Uint8Array(randomBytes(100 * 1024));
    const execsA = secretFilesExecs([{ path: ".kube/config", bytes: a }], "aaaa1111");
    const execsB = secretFilesExecs([{ path: ".kube/config", bytes: b }], "bbbb2222");
    // A first, B first, A rest, B rest, interleaved to the end.
    const order = [execsA[0], execsB[0]];
    for (let i = 1; i < Math.max(execsA.length, execsB.length); i++) {
      if (execsA[i] !== undefined) order.push(execsA[i]);
      if (execsB[i] !== undefined) order.push(execsB[i]);
    }
    const outcomes: Array<SecretFileOutcome> = [];
    for (const argv of order) {
      if (argv !== undefined) outcomes.push(...parseSecretFileOutcomes(run(home, argv)));
    }
    expect(outcomes).toEqual([
      { path: ".kube/config", outcome: "written" },
      { path: ".kube/config", outcome: "written" },
    ]);
    const final = fs.readFileSync(path.join(home, ".kube/config"));
    expect(final.byteLength).toBe(100 * 1024);
    expect(final.equals(Buffer.from(b))).toBe(true);
    expect(filesUnder(home)).toEqual([".kube/config"]);
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

  it("refuses a chunked file whose directory is a symlink, even with a staging file planted there", () => {
    const home = tempDir("mend-secret-home-");
    const worktree = tempDir("mend-secret-worktree-");
    fs.symlinkSync(worktree, path.join(home, ".kube"));
    // A staging file left where this delivery would stage, through the link (Astra review 1).
    fs.writeFileSync(path.join(worktree, `config${SECRET_FILE_PART_PREFIX}${STAMP}`), "");
    const bytes = new Uint8Array(randomBytes(120 * 1024));
    const outcomes = write(home, [{ path: ".kube/config", bytes }]);
    expect(outcomes).toEqual([
      { path: ".kube/config", outcome: "refused", reason: ".kube is a symlink" },
    ]);
    expect(filesUnder(worktree)).toEqual([`config${SECRET_FILE_PART_PREFIX}${STAMP}`]);
    expect(
      fs.readFileSync(path.join(worktree, `config${SECRET_FILE_PART_PREFIX}${STAMP}`)).byteLength,
    ).toBe(0);
  });

  it("a directory turned into a symlink between chunks takes no later chunk and no rename", () => {
    const home = tempDir("mend-secret-home-");
    const worktree = tempDir("mend-secret-worktree-");
    const bytes = new Uint8Array(randomBytes(120 * 1024));
    const execs = secretFilesExecs([{ path: ".kube/config", bytes }], STAMP);
    const outcomes: Array<SecretFileOutcome> = [];
    outcomes.push(...parseSecretFileOutcomes(run(home, execs[0] ?? [])));
    // The first chunk staged; now the directory becomes a link into the worktree.
    const staged = path.join(home, ".kube", `config${SECRET_FILE_PART_PREFIX}${STAMP}`);
    expect(fs.existsSync(staged)).toBe(true);
    fs.renameSync(path.join(home, ".kube"), path.join(home, ".kube-real"));
    fs.symlinkSync(worktree, path.join(home, ".kube"));
    for (const argv of execs.slice(1)) outcomes.push(...parseSecretFileOutcomes(run(home, argv)));
    expect(outcomes).toEqual([
      { path: ".kube/config", outcome: "refused", reason: ".kube is a symlink" },
    ]);
    expect(filesUnder(worktree)).toEqual([]);
    // The staged chunk stays where it was, under the renamed directory: never removed through the
    // link, and never reached by this delivery's cleanup either.
    run(home, secretFilesCleanupExec([".kube/config"], STAMP));
    expect(filesUnder(worktree)).toEqual([]);
    expect(
      fs.existsSync(path.join(home, ".kube-real", `config${SECRET_FILE_PART_PREFIX}${STAMP}`)),
    ).toBe(true);
  });

  it("cleans this delivery's staging files, and only this delivery's", () => {
    const home = tempDir("mend-secret-home-");
    const execs = secretFilesExecs(
      [{ path: ".kube/config", bytes: new Uint8Array(randomBytes(120 * 1024)) }],
      STAMP,
    );
    run(home, execs[0] ?? []);
    fs.writeFileSync(path.join(home, ".kube", `config${SECRET_FILE_PART_PREFIX}feedbeef`), "x");
    run(home, secretFilesCleanupExec([".kube/config"], STAMP));
    expect(filesUnder(home)).toEqual([`.kube/config${SECRET_FILE_PART_PREFIX}feedbeef`]);
  });

  it("removes a file an earlier delivery wrote, never through a symlink, and keeps the rest", () => {
    const home = tempDir("mend-secret-home-");
    const worktree = tempDir("mend-secret-worktree-");
    write(home, [utf8(".aws/credentials", "old"), utf8(".npmrc", "old")]);
    fs.writeFileSync(path.join(worktree, "keep.txt"), "repo file\n");
    fs.symlinkSync(worktree, path.join(home, ".kube"));
    fs.mkdirSync(path.join(home, ".dir"));
    const outcomes = parseSecretFileOutcomes(
      run(
        home,
        secretFilesRemoveExec([".aws/credentials", ".kube/keep.txt", ".dir", ".gone", ".npmrc"]),
      ),
    );
    expect(outcomes).toEqual([
      { path: ".aws/credentials", outcome: "removed" },
      { path: ".kube/keep.txt", outcome: "kept" },
      { path: ".dir", outcome: "kept" },
      { path: ".gone", outcome: "kept" },
      { path: ".npmrc", outcome: "removed" },
    ]);
    expect(fs.readFileSync(path.join(worktree, "keep.txt"), "utf8")).toBe("repo file\n");
    expect(filesUnder(home)).toEqual([".kube"]);
  });

  it("records what was delivered, 0600 under ~/.mend, and forgets it when nothing is", () => {
    const home = tempDir("mend-secret-home-");
    expect(parseSecretFilesDelivered(run(home, secretFilesDeliveredExec))).toEqual([]);
    run(home, secretFilesRecordExec([".aws/credentials", "-odd dir/x y"]));
    expect(mode(path.join(home, SECRET_FILES_DELIVERED))).toBe("600");
    expect(mode(path.join(home, ".mend"))).toBe("700");
    expect(parseSecretFilesDelivered(run(home, secretFilesDeliveredExec))).toEqual([
      ".aws/credentials",
      "-odd dir/x y",
    ]);
    run(home, secretFilesRecordExec([]));
    expect(fs.existsSync(path.join(home, SECRET_FILES_DELIVERED))).toBe(false);
    // A record someone else wrote with a captured path in it is not taken as delivered.
    fs.mkdirSync(path.join(home, ".mend"), { recursive: true });
    fs.writeFileSync(path.join(home, SECRET_FILES_DELIVERED), ".claude/x\n../etc\n.npmrc\n");
    expect(parseSecretFilesDelivered(run(home, secretFilesDeliveredExec))).toEqual([".npmrc"]);
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

  it("keeps a reason with the outcome separator in it whole, and folds one file's repeated refusal", () => {
    expect(parseSecretFileOutcomes("refused\ta · b\tits directory is really /x · y\n")).toEqual([
      { path: "a · b", outcome: "refused", reason: "its directory is really /x · y" },
    ]);
    expect(parseSecretFileOutcomes("written\t\nnonsense\n")).toEqual([]);
    expect(
      foldSecretFileOutcomes([
        { path: "a", outcome: "refused", reason: "r" },
        { path: "b", outcome: "written" },
        { path: "a", outcome: "refused", reason: "r" },
        { path: "a", outcome: "refused", reason: "other" },
      ]),
    ).toEqual([
      { path: "a", outcome: "refused", reason: "r" },
      { path: "b", outcome: "written" },
      { path: "a", outcome: "refused", reason: "other" },
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
    expect(validateSecretFilePath(SECRET_FILES_DELIVERED)).not.toBeNull();
    expect(validateSecretFilePath("../.aws/credentials")).not.toBeNull();
    expect(validateSecretFilePath("/root/.aws/credentials")).not.toBeNull();
    expect(validateSecretFilePath("~/.aws/credentials")).not.toBeNull();
    expect(validateSecretFilePath("a\tb")).not.toBeNull();
    expect(validateSecretFilePath(".aws/credentials")).toBeNull();
    expect(validateSecretFilePath(".kube/config")).toBeNull();
    expect(validateSecretFilePath(".npmrc")).toBeNull();
    // Unrelated dotfiles that happen to share a prefix are not caught.
    expect(validateSecretFilePath(".claude-other/x")).toBeNull();
  });

  it("appears in neither the executor's capture listing nor the co-located harvest, even behind a link an agent left in the harness home", async () => {
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
    // An agent in an earlier session left links in the harness home pointing at the secret file
    // (Astra review 2): one among the transcripts, one named like a transcript.
    fs.symlinkSync(
      path.join(home, ".aws", "credentials"),
      path.join(harnessHome, ".claude", "projects", "-workspace-repo", "notes.md"),
    );
    fs.symlinkSync(
      path.join(home, ".aws", "credentials"),
      path.join(harnessHome, ".claude", "projects", "-workspace-repo", "z.jsonl"),
    );

    // The workspace class sealantd ships (sealant-capture `roots.rs`): the worktree under `tree/`
    // and the harness root under `harness/`, links as links. Nothing else of the executor's disk
    // is a root.
    const stage = path.join(scratch, "stage");
    fs.cpSync(worktree, path.join(stage, "tree"), { recursive: true });
    fs.cpSync(harnessHome, path.join(stage, "harness"), {
      recursive: true,
      verbatimSymlinks: true,
    });
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
    const linked = listed.find((file) => file.path.endsWith("/z.jsonl"));
    expect(linked?.entry.kind).not.toBe("file");
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

    // The co-located harvest (engine.ts, the harvest): `cd $HOME; tar -czhf … -X <carried and
    // every symlink at or below a harvested path> <the harness's state paths that exist>`.
    // -h dereferences the relocation's links; the exclusion keeps it from dereferencing a link
    // an agent left below them.
    const shape = HARNESS_STATE["claude"];
    if (shape === undefined) throw new Error("claude shape");
    const present = shape.paths.filter((p) => fs.existsSync(path.join(home, p)));
    expect(present).toContain(".claude/projects");
    const archive = path.join(scratch, "harvest.tgz");
    const packed = spawnSync(
      "sh",
      [
        "-c",
        `X="$1"; shift; : > "$X"; find "$@" -type l 2>/dev/null | sed 's/[][*?\\\\]/\\\\&/g' >> "$X"; ` +
          `tar -czhf "$0" -X "$X" "$@"`,
        archive,
        path.join(scratch, "harvest.exclude"),
        ...present,
      ],
      { cwd: home, encoding: "utf8" },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const entries = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout.split("\n");
    expect(entries).toContain(".claude/projects/-workspace-repo/s.jsonl");
    expect(entries).not.toContain(".claude/projects/-workspace-repo/notes.md");
    expect(entries).not.toContain(".claude/projects/-workspace-repo/z.jsonl");
    expect(entries.filter((e) => e.includes(".aws") || e.includes(".kube"))).toEqual([]);
    const unpacked = path.join(scratch, "unpacked");
    fs.mkdirSync(unpacked);
    spawnSync("tar", ["-xzf", archive, "-C", unpacked]);
    const everything = filesUnder(unpacked)
      .map((file) => fs.readFileSync(path.join(unpacked, file), "latin1"))
      .join("");
    expect(everything).not.toContain("SECRET");
  });
});
