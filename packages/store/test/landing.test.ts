import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlobStore, BlobStoreFsLive } from "../src/blob-store.ts";
import { captureKeys, packIdxKeyOf, sha256Hex } from "../src/captures.ts";
import { deniedLines, parsePushPorcelain, remoteWords } from "../src/landing.ts";
import { GitOpsRunner, GitOpsRunnerLive } from "../src/runner.ts";
import { Store, StoreConfig } from "../src/store.ts";
import { buildManifest } from "./capture-fixture.ts";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};
const sh = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
  execFileSync("git", [...args], { cwd, env: gitEnv, input, stdio: ["pipe", "pipe", "pipe"] })
    .toString("utf8")
    .replace(/\n$/, "");

const owner = { name: "Ada Owner", email: "ada@example.com" };
const BRANCH = "mend/fix-login";
const MESSAGE = "Fix the login redirect\n\nMend-Session: https://mend.test/sessions/s1\n";
const MB = 1024 * 1024;

/**
 * A bare origin with `main`, the project's bare store cloned from it the way `adopt` leaves it,
 * and one session worktree on `mend/fix-login`: the three places landing moves between.
 */
interface World {
  readonly tmp: string;
  readonly origin: string;
  readonly storePath: string;
  readonly worktree: string;
  readonly baseSha: string;
}

const makeWorld = (): World => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-landing-"));
  const origin = path.join(tmp, "origin.git");
  sh(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  sh(tmp, ["clone", "-q", origin, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "# fixture\n");
  fs.writeFileSync(path.join(seed, "app.ts"), "export const answer = 41\n");
  sh(seed, ["add", "-A"]);
  sh(seed, ["commit", "-q", "-m", "initial"]);
  sh(seed, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  const baseSha = sh(seed, ["rev-parse", "HEAD"]);
  const storePath = path.join(tmp, "store", "project", "repo.git");
  sh(tmp, ["clone", "-q", "--bare", origin, storePath]);
  sh(storePath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  return { tmp, origin, storePath, worktree: "", baseSha };
};

const storeLayer = (tmp: string) =>
  Store.layer.pipe(Layer.provide(StoreConfig.layerFor(path.join(tmp, "store"))));

/** What landing must leave alone in the worktree: its HEAD file, its index, its files. */
const worktreeState = (world: World) => {
  const gitDir = sh(world.worktree, ["rev-parse", "--absolute-git-dir"]);
  return {
    head: fs.readFileSync(path.join(gitDir, "HEAD"), "utf8"),
    index: fs.readFileSync(path.join(gitDir, "index")).toString("base64"),
    files: fs
      .readdirSync(world.worktree)
      .filter((name) => name !== ".git")
      .toSorted()
      .map((name) => [name, fs.readFileSync(path.join(world.worktree, name), "utf8")]),
  };
};

/** The scratch repositories bundles are written in, which must not outlive the call. */
const bundleScratches = () =>
  fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("mend-change-bundle-"));

describe("landing in the project store", () => {
  let world: World;
  beforeEach(async () => {
    const made = makeWorld();
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.createWorktree(
          made.storePath,
          { directory: "wt-1", branch: BRANCH },
          null,
          null,
        );
      }).pipe(Effect.provide(storeLayer(made.tmp))),
    );
    world = { ...made, worktree: created.path };
  });
  afterEach(() => {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Store>) =>
    Effect.runPromise(effect.pipe(Effect.provide(storeLayer(world.tmp))));

  const checkpoint = (index: number) =>
    Effect.gen(function* () {
      const store = yield* Store;
      return yield* store.checkpoint(world.worktree, "wt-1", index, null);
    });

  const land = (checkpointSha: string, expectedHead?: string) =>
    Effect.gen(function* () {
      const store = yield* Store;
      return yield* store.landingCommit(world.storePath, {
        branch: BRANCH,
        checkpoint: checkpointSha,
        author: owner,
        message: MESSAGE,
        expectedHead,
      });
    });

  const push = (sha: string) =>
    Effect.gen(function* () {
      const store = yield* Store;
      return yield* store.push(world.storePath, {
        remote: "origin",
        sha,
        remoteBranch: BRANCH,
        remoteEnv: {},
      });
    });

  const branchHead = () => sh(world.storePath, ["rev-parse", `refs/heads/${BRANCH}`]);
  const originHead = () =>
    sh(world.origin, ["for-each-ref", "--format=%(objectname)", `refs/heads/${BRANCH}`]);

  it("writes nothing when the agent committed everything", async () => {
    fs.writeFileSync(path.join(world.worktree, "app.ts"), "export const answer = 42\n");
    sh(world.worktree, ["commit", "-q", "-am", "agent: fix the answer"]);
    const agentCommit = sh(world.worktree, ["rev-parse", "HEAD"]);
    const before = worktreeState(world);
    const landed = await run(
      Effect.gen(function* () {
        const snapshot = yield* checkpoint(1);
        return yield* land(snapshot.sha);
      }),
    );
    expect(landed).toEqual({ head: agentCommit, written: null });
    expect(branchHead()).toBe(agentCommit);
    expect(worktreeState(world)).toEqual(before);
  });

  it("commits only the leftovers on the agent's commits, as the owner, leaving the worktree be", async () => {
    fs.writeFileSync(path.join(world.worktree, "app.ts"), "export const answer = 42\n");
    sh(world.worktree, ["commit", "-q", "-am", "agent: fix the answer"]);
    const agentCommit = sh(world.worktree, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(world.worktree, "README.md"), "# fixture\n\nMore.\n");
    fs.writeFileSync(path.join(world.worktree, "new.ts"), "export const fresh = true\n");
    const before = worktreeState(world);
    const { landed, snapshot } = await run(
      Effect.gen(function* () {
        const taken = yield* checkpoint(1);
        return { snapshot: taken, landed: yield* land(taken.sha) };
      }),
    );
    expect(landed.written).not.toBeNull();
    const written = landed.written;
    if (written === null) return;
    expect(landed.head).toBe(written.sha);
    expect(written.parent).toBe(agentCommit);
    expect(written.tree).toBe(sh(world.storePath, ["rev-parse", `${snapshot.sha}^{tree}`]));
    expect(branchHead()).toBe(written.sha);
    expect(
      sh(world.storePath, ["diff", "--name-only", agentCommit, written.sha]).split("\n"),
    ).toEqual(["README.md", "new.ts"]);
    expect(sh(world.storePath, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", written.sha])).toBe(
      "Ada Owner <ada@example.com>|Ada Owner <ada@example.com>",
    );
    expect(sh(world.storePath, ["log", "-1", "--format=%B", written.sha]).trimEnd()).toBe(
      MESSAGE.trimEnd(),
    );
    // The branch moved in the store; the worktree's HEAD file, index and files did not.
    expect(worktreeState(world)).toEqual(before);
  });

  it("commits the whole change on the base when the agent committed nothing", async () => {
    fs.writeFileSync(path.join(world.worktree, "app.ts"), "export const answer = 42\n");
    fs.writeFileSync(path.join(world.worktree, "new.ts"), "export const fresh = true\n");
    const landed = await run(
      Effect.gen(function* () {
        const snapshot = yield* checkpoint(1);
        return yield* land(snapshot.sha);
      }),
    );
    expect(landed.written?.parent).toBe(world.baseSha);
    expect(sh(world.storePath, ["diff", "--name-only", world.baseSha, branchHead()])).toBe(
      "app.ts\nnew.ts",
    );
    expect(sh(world.storePath, ["rev-list", "--count", `${world.baseSha}..${BRANCH}`])).toBe("1");
  });

  it("writes nothing when the branch moved past the head the caller observed", async () => {
    fs.writeFileSync(path.join(world.worktree, "new.ts"), "export const fresh = true\n");
    const error = await run(
      Effect.gen(function* () {
        const snapshot = yield* checkpoint(1);
        // The agent commits after the checkpoint was taken.
        sh(world.worktree, ["add", "-A"]);
        sh(world.worktree, ["commit", "-q", "-m", "agent: later"]);
        return yield* Effect.flip(land(snapshot.sha, world.baseSha));
      }),
    );
    expect(error._tag).toBe("LandingBranchMovedError");
    expect(branchHead()).toBe(sh(world.worktree, ["rev-parse", "HEAD"]));
  });

  it("pushes fast-forward, creates the branch, then updates it, and the probe sees it held", async () => {
    fs.writeFileSync(path.join(world.worktree, "new.ts"), "export const fresh = true\n");
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const absent = yield* store.probeRemote(world.storePath, {
          remote: "origin",
          remoteBranch: BRANCH,
          sha: BRANCH,
          remoteEnv: {},
        });
        const first = yield* land((yield* checkpoint(1)).sha);
        const created = yield* push(first.head);
        fs.writeFileSync(path.join(world.worktree, "more.ts"), "export const more = 1\n");
        const second = yield* land((yield* checkpoint(2)).sha);
        const updated = yield* push(second.head);
        const again = yield* push(second.head);
        const probe = yield* store.probeRemote(world.storePath, {
          remote: "origin",
          remoteBranch: BRANCH,
          sha: first.head,
          remoteEnv: {},
        });
        return { absent, first, second, created, updated, again, probe };
      }),
    );
    expect(result.absent).toEqual({
      remoteBranch: BRANCH,
      remoteSha: null,
      unseen: 0,
      ahead: null,
      holds: false,
    });
    expect(result.created).toEqual({
      remoteBranch: BRANCH,
      pushedSha: result.first.head,
      created: true,
      upToDate: false,
    });
    expect(result.second.written?.parent).toBe(result.first.head);
    expect(result.updated.created).toBe(false);
    expect(result.updated.upToDate).toBe(false);
    expect(result.again.upToDate).toBe(true);
    expect(originHead()).toBe(result.second.head);
    // The first landing's commit is on origin, and origin is one commit past it.
    expect(result.probe).toEqual({
      remoteBranch: BRANCH,
      remoteSha: result.second.head,
      unseen: 1,
      ahead: 0,
      holds: true,
    });
  });

  it("refuses to push over commits origin has and Mend lacks, and never forces", async () => {
    fs.writeFileSync(path.join(world.worktree, "new.ts"), "export const fresh = true\n");
    const first = await run(
      Effect.gen(function* () {
        const landed = yield* land((yield* checkpoint(1)).sha);
        yield* push(landed.head);
        return landed;
      }),
    );
    // A teammate pushes onto the landed branch.
    const teammate = path.join(world.tmp, "teammate");
    sh(world.tmp, ["clone", "-q", "-b", BRANCH, world.origin, teammate]);
    fs.writeFileSync(path.join(teammate, "theirs.ts"), "export const theirs = 1\n");
    sh(teammate, ["add", "-A"]);
    sh(teammate, ["commit", "-q", "-m", "teammate: theirs"]);
    sh(teammate, ["push", "-q", "origin", BRANCH]);
    const theirs = sh(teammate, ["rev-parse", "HEAD"]);

    fs.writeFileSync(path.join(world.worktree, "more.ts"), "export const more = 1\n");
    const { error, probe } = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const second = yield* land((yield* checkpoint(2)).sha);
        return {
          error: yield* Effect.flip(push(second.head)),
          probe: yield* store.probeRemote(world.storePath, {
            remote: "origin",
            remoteBranch: BRANCH,
            sha: second.head,
            remoteEnv: {},
          }),
        };
      }),
    );
    expect(error._tag).toBe("PushRefusedError");
    if (error._tag !== "PushRefusedError") return;
    expect(error.reason).toBe("diverged");
    expect(error.remoteSha).toBe(theirs);
    expect(error.unseen).toBe(1);
    expect(error.message).toMatch(/\[rejected\] \((fetch first|non-fast-forward)\)/);
    expect(originHead()).toBe(theirs);
    expect(probe).toEqual({
      remoteBranch: BRANCH,
      remoteSha: theirs,
      unseen: 1,
      ahead: 1,
      holds: false,
    });
    expect(first.written).not.toBeNull();
  });

  it("surfaces a protected-branch refusal in the remote's own words", async () => {
    const hook = path.join(world.origin, "hooks", "pre-receive");
    fs.writeFileSync(
      hook,
      [
        "#!/bin/sh",
        "while read old new ref; do",
        '  case "$ref" in refs/heads/mend/*)',
        '    echo "error: GH006: Protected branch update failed for $ref." >&2',
        '    echo "error: Changes must be made through a pull request." >&2',
        "    exit 1;;",
        "  esac",
        "done",
        "",
      ].join("\n"),
    );
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(world.worktree, "new.ts"), "export const fresh = true\n");
    const error = await run(
      Effect.gen(function* () {
        const landed = yield* land((yield* checkpoint(1)).sha);
        return yield* Effect.flip(push(landed.head));
      }),
    );
    expect(error._tag).toBe("PushRefusedError");
    if (error._tag !== "PushRefusedError") return;
    expect(error.reason).toBe("rejected");
    expect(error.message).toBe(
      [
        `error: GH006: Protected branch update failed for refs/heads/${BRANCH}.`,
        "error: Changes must be made through a pull request.",
        "[remote rejected] (pre-receive hook declined)",
      ].join("\n"),
    );
    expect(originHead()).toBe("");
  });

  it("leaves a remote it cannot reach as a git failure, not a refusal", async () => {
    const error = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* Effect.flip(
          store.push(world.storePath, {
            remote: path.join(world.tmp, "missing.git"),
            sha: world.baseSha,
            remoteBranch: BRANCH,
            remoteEnv: {},
          }),
        );
      }),
    );
    expect(error._tag).toBe("GitError");
  });

  it("refuses a branch name git would not accept", async () => {
    const error = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* Effect.flip(
          store.push(world.storePath, {
            remote: "origin",
            sha: world.baseSha,
            remoteBranch: "bad..name",
            remoteEnv: {},
          }),
        );
      }),
    );
    expect(error._tag).toBe("InvalidBranchError");
  });

  it("bundles base..branch for a checkout that fetches it, without adding a ref", async () => {
    fs.writeFileSync(path.join(world.worktree, "app.ts"), "export const answer = 42\n");
    fs.writeFileSync(path.join(world.worktree, "new.ts"), "export const fresh = true\n");
    const refs = () => sh(world.storePath, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const { landed, bundle, snapshot, refsBefore } = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const taken = yield* checkpoint(1);
        const commit = yield* land(taken.sha);
        const refsBeforeBundle = refs();
        return {
          snapshot: taken,
          landed: commit,
          refsBefore: refsBeforeBundle,
          bundle: yield* store.bundle(world.storePath, {
            base: world.baseSha,
            tip: `refs/heads/${BRANCH}`,
            branch: BRANCH,
            limitBytes: MB,
          }),
        };
      }),
    );
    expect(refs()).toBe(refsBefore);
    expect(bundle.commits).toBe(1);
    expect(bundle.tip).toBe(landed.head);
    expect(bundle.base).toBe(world.baseSha);
    // A person's own checkout of the same repository pulls it.
    const checkout = path.join(world.tmp, "checkout");
    sh(world.tmp, ["clone", "-q", world.origin, checkout]);
    const file = path.join(world.tmp, "change.bundle");
    fs.writeFileSync(file, bundle.bytes);
    sh(checkout, ["bundle", "verify", "-q", file]);
    sh(checkout, ["fetch", "-q", file, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
    expect(sh(checkout, ["rev-parse", BRANCH])).toBe(landed.head);
    expect(sh(checkout, ["rev-parse", `${BRANCH}^{tree}`])).toBe(
      sh(world.storePath, ["rev-parse", `${snapshot.sha}^{tree}`]),
    );
    // Nothing was pushed.
    expect(originHead()).toBe("");
  });

  it("answers a bundle over the limit with its size, and an empty range as empty", async () => {
    fs.writeFileSync(path.join(world.worktree, "new.ts"), "export const fresh = true\n");
    const scratchesBefore = bundleScratches();
    const { tooLarge, empty } = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* land((yield* checkpoint(1)).sha);
        return {
          tooLarge: yield* Effect.flip(
            store.bundle(world.storePath, {
              base: world.baseSha,
              tip: BRANCH,
              branch: BRANCH,
              limitBytes: 16,
            }),
          ),
          empty: yield* Effect.flip(
            store.bundle(world.storePath, {
              base: world.baseSha,
              tip: world.baseSha,
              branch: BRANCH,
              limitBytes: MB,
            }),
          ),
        };
      }),
    );
    expect(tooLarge._tag).toBe("BundleTooLargeError");
    if (tooLarge._tag === "BundleTooLargeError") {
      expect(tooLarge.limit).toBe(16);
      expect(tooLarge.size).toBeGreaterThan(16);
    }
    expect(empty._tag).toBe("BundleEmptyError");
    // The scratch repository the bundle was written in is gone.
    expect(bundleScratches()).toEqual(scratchesBefore);
  });
});

describe("landing from a runner cache", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-landing-runner-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const layer = () =>
    GitOpsRunnerLive.pipe(
      Layer.provide(Store.layer),
      Layer.provideMerge(StoreConfig.layerFor(path.join(tmp, "store"))),
      Layer.provideMerge(BlobStoreFsLive(path.join(tmp, "blobs"))),
    );

  it("commits the leftovers, packs the commit, pushes it and bundles it from the cache", async () => {
    // The executor's repository: the base, one agent commit, and a checkpoint with leftovers.
    const origin = path.join(tmp, "origin.git");
    sh(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    const executor = path.join(tmp, "executor");
    sh(tmp, ["init", "-q", "-b", "main", executor]);
    fs.writeFileSync(path.join(executor, "app.ts"), "export const answer = 41\n");
    sh(executor, ["add", "-A"]);
    sh(executor, ["commit", "-q", "-m", "initial"]);
    const baseSha = sh(executor, ["rev-parse", "HEAD"]);
    sh(executor, ["push", "-q", origin, "main"]);
    sh(executor, ["checkout", "-q", "-b", BRANCH]);
    fs.writeFileSync(path.join(executor, "app.ts"), "export const answer = 42\n");
    sh(executor, ["commit", "-q", "-am", "agent: fix the answer"]);
    const agentCommit = sh(executor, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(executor, "new.ts"), "export const fresh = true\n");
    const index = path.join(tmp, "checkpoint-index");
    const indexed = { ...gitEnv, GIT_INDEX_FILE: index };
    execFileSync("git", ["add", "-A"], { cwd: executor, env: indexed });
    const tree = execFileSync("git", ["write-tree"], { cwd: executor, env: indexed })
      .toString()
      .trim();
    const checkpointSha = sh(executor, ["commit-tree", tree, "-m", "mend checkpoint 1"]);
    sh(executor, ["update-ref", "refs/mend/checkpoints/wt-r/1", checkpointSha]);
    const unchangedSha = sh(executor, [
      "commit-tree",
      `${agentCommit}^{tree}`,
      "-m",
      "mend checkpoint 0",
    ]);
    sh(executor, ["update-ref", "refs/mend/checkpoints/wt-r/0", unchangedSha]);

    const keys = captureKeys("wt-r", 1);
    const packDir = fs.mkdtempSync(path.join(tmp, "pack-"));
    const name = sh(
      executor,
      ["pack-objects", "--revs", path.join(packDir, "p")],
      "refs/heads/main\nrefs/heads/mend/fix-login\nrefs/mend/checkpoints/wt-r/0\nrefs/mend/checkpoints/wt-r/1\n",
    );
    const pack = new Uint8Array(fs.readFileSync(path.join(packDir, `p-${name}.pack`)));
    const idx = new Uint8Array(fs.readFileSync(path.join(packDir, `p-${name}.idx`)));
    const packKey = keys.pack(sha256Hex(pack));
    const manifest = buildManifest({
      worktreeId: "wt-r",
      n: 1,
      parent: null,
      epoch: 1,
      git: {
        packs: [packKey],
        refs: {
          [`refs/heads/${BRANCH}`]: agentCommit,
          "refs/mend/checkpoints/wt-r/0": unchangedSha,
          "refs/mend/checkpoints/wt-r/1": checkpointSha,
        },
        head: `refs/heads/${BRANCH}`,
        fsck: "verified",
      },
    }).manifest;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = yield* BlobStore;
        yield* blobs.put(packKey, pack);
        yield* blobs.put(packIdxKeyOf(packKey), idx);
        const runner = yield* GitOpsRunner;
        const cache = yield* runner.ensure({
          projectId: "proj-r",
          manifest,
          storeRefs: { "refs/heads/main": baseSha },
        });
        const nothing = yield* runner.landingCommit(cache, {
          parent: `refs/heads/${BRANCH}`,
          checkpoint: "refs/mend/checkpoints/wt-r/0",
          author: owner,
          message: MESSAGE,
        });
        const landed = yield* runner.landingCommit(cache, {
          parent: `refs/heads/${BRANCH}`,
          checkpoint: "refs/mend/checkpoints/wt-r/1",
          author: owner,
          message: MESSAGE,
        });
        const pushed = yield* runner.push(cache, {
          remote: origin,
          sha: landed.head,
          remoteBranch: BRANCH,
          remoteEnv: {},
        });
        const probe = yield* runner.probeRemote(cache, {
          remote: origin,
          remoteBranch: BRANCH,
          sha: landed.head,
          remoteEnv: {},
        });
        const bundle = yield* runner.bundle(cache, {
          base: "refs/heads/main",
          tip: landed.head,
          branch: BRANCH,
          limitBytes: MB,
        });
        return { cache, nothing, landed, pushed, probe, bundle };
      }).pipe(Effect.provide(layer())),
    );

    expect(result.nothing).toEqual({ head: agentCommit, written: null });
    const written = result.landed.written;
    expect(written).not.toBeNull();
    if (written === null) return;
    expect(written.parent).toBe(agentCommit);
    expect(written.tree).toBe(tree);
    expect(written.derived.sha).toBe(written.sha);
    expect(written.derived.packSha256).toBe(sha256Hex(written.derived.pack));
    expect(sh(result.cache.path, ["log", "-1", "--format=%an <%ae>", written.sha])).toBe(
      "Ada Owner <ada@example.com>",
    );
    // The cache's refs were not moved: they are the manifest's, rewritten on every ensure.
    expect(sh(result.cache.path, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(agentCommit);
    expect(result.pushed.created).toBe(true);
    expect(sh(origin, ["rev-parse", `refs/heads/${BRANCH}`])).toBe(written.sha);
    expect(result.probe.holds).toBe(true);
    expect(result.probe.unseen).toBe(0);
    expect(result.bundle.commits).toBe(2);

    const checkout = path.join(tmp, "checkout");
    sh(tmp, ["clone", "-q", "--single-branch", "-b", "main", origin, checkout]);
    const file = path.join(tmp, "change.bundle");
    fs.writeFileSync(file, result.bundle.bytes);
    sh(checkout, ["fetch", "-q", file, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
    expect(sh(checkout, ["rev-parse", `${BRANCH}^{tree}`])).toBe(tree);
  });
});

describe("landing parsers", () => {
  it("reads push --porcelain ref lines and the remote's own lines", () => {
    expect(
      parsePushPorcelain(
        [
          "To /tmp/origin.git",
          "*\t3f2a1c0:refs/heads/mend/a\t[new branch]",
          "!\t91bd2e4:refs/heads/mend/b\t[rejected] (fetch first)",
          "Done",
        ].join("\n"),
      ),
    ).toEqual([
      { flag: "*", to: "refs/heads/mend/a", summary: "[new branch]" },
      { flag: "!", to: "refs/heads/mend/b", summary: "[rejected] (fetch first)" },
    ]);
    expect(
      remoteWords(
        "remote: error: GH006: Protected branch update failed.\nremote: \nTo github.com:o/r.git\n",
      ),
    ).toEqual(["error: GH006: Protected branch update failed."]);
  });

  it("reads a push the credential may not write as denied, and a refused key as neither", () => {
    expect(
      deniedLines(
        "ERROR: Permission to acme/app.git denied to ada.\nfatal: Could not read from remote repository.\n",
      ),
    ).toEqual(["ERROR: Permission to acme/app.git denied to ada."]);
    expect(
      deniedLines("remote: You are not allowed to push code to this project.\nfatal: …\n"),
    ).toEqual(["You are not allowed to push code to this project."]);
    expect(
      deniedLines("git@github.com: Permission denied (publickey).\nfatal: Could not read\n"),
    ).toEqual([]);
  });
});
