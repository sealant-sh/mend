import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer, Result } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlobStore, BlobStoreFsLive } from "../src/blob-store.ts";
import {
  type CaptureManifest,
  captureKeys,
  packIdxKeyOf,
  sha256Hex,
  storedCaptureProblem,
} from "../src/captures.ts";
import {
  GitOpsRunner,
  GitOpsRunnerLive,
  parseLinePorcelain,
  parseLog,
  renderHead,
  renderPackedRefs,
  runnerCachePathOf,
} from "../src/runner.ts";
import { Store, StoreConfig } from "../src/store.ts";
import { buildManifest } from "./capture-fixture.ts";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
  GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
};
const sh = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
  execFileSync("git", [...args], { cwd, env: gitEnv, input })
    .toString("utf8")
    .replace(/\n$/, "");

/**
 * Pack the closure of `revs` (with `^neg` negatives for an incremental pack) the way ADR-0015
 * says a writer does: self-contained, never thin, `.idx` beside it, keyed by sha256 of the pack.
 */
const packRepo = (
  repo: string,
  keys: ReturnType<typeof captureKeys>,
  revs: ReadonlyArray<string>,
): { readonly key: string; readonly objects: ReadonlyMap<string, Uint8Array> } => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mend-pack-"));
  const name = sh(repo, ["pack-objects", "--revs", path.join(out, "p")], `${revs.join("\n")}\n`);
  const pack = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.pack`)));
  const idx = new Uint8Array(fs.readFileSync(path.join(out, `p-${name}.idx`)));
  fs.rmSync(out, { recursive: true, force: true });
  const key = keys.pack(sha256Hex(pack));
  return {
    key,
    objects: new Map([
      [key, pack],
      [packIdxKeyOf(key), idx],
    ]),
  };
};

const upload = (objects: ReadonlyMap<string, Uint8Array>) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    yield* Effect.forEach([...objects], ([key, bytes]) => blobs.put(key, bytes), {
      discard: true,
    });
  });

const gitSection = (
  packs: ReadonlyArray<string>,
  refs: Record<string, string>,
  head: string,
): CaptureManifest["sections"]["git"] => ({ packs, refs, head, fsck: "verified" });

describe("GitOpsRunner", () => {
  let scratch = "";
  let repo = "";
  let mainSha = "";
  let featSha = "";
  let baseSha = "";
  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-runner-"));
    repo = path.join(scratch, "repo");
    fs.mkdirSync(repo);
    sh(repo, ["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(repo, "keep.md"), "# keep\n");
    sh(repo, ["add", "."]);
    sh(repo, ["commit", "-q", "-m", "base"]);
    baseSha = sh(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
    sh(repo, ["commit", "-q", "-am", "main grows"]);
    mainSha = sh(repo, ["rev-parse", "HEAD"]);
    sh(repo, ["checkout", "-q", "-b", "feat", baseSha]);
    fs.writeFileSync(path.join(repo, "b.txt"), "feature\n");
    fs.rmSync(path.join(repo, "keep.md"));
    sh(repo, ["add", "-A"]);
    sh(repo, ["commit", "-q", "-m", "feat: add b, drop keep"]);
    featSha = sh(repo, ["rev-parse", "HEAD"]);
  });
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const storeRoot = () => path.join(scratch, "store");
  const layer = () =>
    GitOpsRunnerLive.pipe(
      Layer.provide(Store.layer),
      Layer.provideMerge(StoreConfig.layerFor(storeRoot())),
      Layer.provideMerge(BlobStoreFsLive(path.join(scratch, "blobs"))),
    );
  const run = <A, E>(effect: Effect.Effect<A, E, GitOpsRunner | BlobStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer())));

  it("installs the manifest's packs and answers every read exactly as git on the original", async () => {
    const keys = captureKeys("wt-r", 1);
    const packed = packRepo(repo, keys, ["refs/heads/main", "refs/heads/feat"]);
    const manifest = buildManifest({
      worktreeId: "wt-r",
      n: 1,
      parent: null,
      epoch: 1,
      git: gitSection(
        [packed.key],
        { "refs/heads/feat": featSha, "refs/mend/checkpoints/wt-r/0": featSha },
        "refs/heads/feat",
      ),
    }).manifest;
    const storeRefs = { "refs/heads/main": mainSha, "refs/remotes/origin/main": mainSha };
    const result = await run(
      Effect.gen(function* () {
        yield* upload(packed.objects);
        const runner = yield* GitOpsRunner;
        const cache = yield* runner.ensure({ projectId: "proj-a", manifest, storeRefs });
        const again = yield* runner.ensure({ projectId: "proj-a", manifest, storeRefs });
        return {
          cache,
          again,
          head: yield* runner.headSha(cache),
          diff: yield* runner.diffRange(cache, "refs/heads/main", "refs/heads/feat"),
          facts: yield* runner.diffFileFacts(cache, mainSha, "refs/heads/feat"),
          changed: yield* runner.changedFiles(cache, "refs/heads/main", "refs/heads/feat"),
          tree: yield* runner.listTreeFiles(cache, "refs/mend/checkpoints/wt-r/0", 100),
          branches: yield* runner.listBranches(cache),
          blame: yield* runner.blame(cache, "refs/heads/main", "a.txt"),
          log: yield* runner.log(cache, "refs/heads/feat"),
          logLimited: yield* runner.log(cache, "refs/heads/main", { limit: 1, path: "a.txt" }),
        };
      }),
    );
    expect(result.cache.path).toBe(runnerCachePathOf(storeRoot(), "proj-a"));
    expect(result.again.refs).toEqual(result.cache.refs);
    expect(result.head).toBe(featSha);
    expect(result.diff).toBe(sh(repo, ["diff", "--find-renames", mainSha, featSha]));
    expect(result.facts.map((fact) => [fact.newPath ?? fact.oldPath, fact.status])).toEqual([
      ["a.txt", "modified"],
      ["b.txt", "added"],
      ["keep.md", "deleted"],
    ]);
    expect(result.changed).toEqual([
      { path: "a.txt", additions: 0, deletions: 1 },
      { path: "b.txt", additions: 1, deletions: 0 },
      { path: "keep.md", additions: 0, deletions: 1 },
    ]);
    expect(result.tree).toEqual({ files: ["a.txt", "b.txt"], truncated: false });
    expect(result.branches.map((branch) => [branch.name, branch.sha, branch.isDefault])).toEqual(
      expect.arrayContaining([
        ["main", mainSha, false],
        ["feat", featSha, true],
      ]),
    );
    expect(result.blame.map((line) => [line.finalLine, line.sha, line.content])).toEqual([
      [1, baseSha, "one"],
      [2, baseSha, "two"],
      [3, mainSha, "three"],
    ]);
    expect(result.blame[0]?.author).toBe("fixture");
    expect(result.blame[0]?.summary).toBe("base");
    expect(result.log.map((entry) => [entry.sha, entry.subject])).toEqual([
      [featSha, "feat: add b, drop keep"],
      [baseSha, "base"],
    ]);
    expect(result.logLimited).toEqual([
      {
        sha: mainSha,
        author: "fixture",
        authoredAt: "2026-01-02T03:04:05Z",
        subject: "main grows",
      },
    ]);
    // Exactly one pack landed, verified, beside its index; the staging dir is gone.
    const packDir = path.join(result.cache.path, "objects", "pack");
    expect(fs.readdirSync(packDir).toSorted()).toEqual([
      `pack-${sha256Hex(packed.objects.get(packed.key) ?? new Uint8Array())}.idx`,
      `pack-${sha256Hex(packed.objects.get(packed.key) ?? new Uint8Array())}.pack`,
    ]);
    expect(
      fs
        .readdirSync(path.join(result.cache.path, "objects"))
        .some((n) => n.startsWith("incoming-")),
    ).toBe(false);
  });

  it("adds an incremental pack for a later capture and reads across both", async () => {
    const keys = captureKeys("wt-i", 1);
    const base = packRepo(repo, keys, ["refs/heads/feat"]);
    // A new commit on feat, packed against the previous tip as a negative.
    fs.writeFileSync(path.join(repo, "b.txt"), "feature\nmore\n");
    sh(repo, ["commit", "-q", "-am", "feat: more"]);
    const feat2 = sh(repo, ["rev-parse", "HEAD"]);
    const delta = packRepo(repo, keys, ["refs/heads/feat", `^${featSha}`]);
    const first = buildManifest({
      worktreeId: "wt-i",
      n: 1,
      parent: null,
      epoch: 1,
      git: gitSection([base.key], { "refs/heads/feat": featSha }, "refs/heads/feat"),
    }).manifest;
    const second = buildManifest({
      worktreeId: "wt-i",
      n: 2,
      parent: "x",
      epoch: 1,
      git: gitSection([base.key, delta.key], { "refs/heads/feat": feat2 }, "refs/heads/feat"),
    }).manifest;
    const result = await run(
      Effect.gen(function* () {
        yield* upload(base.objects);
        yield* upload(delta.objects);
        const runner = yield* GitOpsRunner;
        const c1 = yield* runner.ensure({ projectId: "proj-i", manifest: first, storeRefs: {} });
        const head1 = yield* runner.headSha(c1);
        const c2 = yield* runner.ensure({ projectId: "proj-i", manifest: second, storeRefs: {} });
        return {
          head1,
          head2: yield* runner.headSha(c2),
          diff: yield* runner.diffRange(c2, featSha, feat2),
          packs: fs
            .readdirSync(path.join(c2.path, "objects", "pack"))
            .filter((n) => n.endsWith(".pack")).length,
        };
      }),
    );
    expect(result.head1).toBe(featSha);
    expect(result.head2).toBe(feat2);
    expect(result.diff).toBe(sh(repo, ["diff", "--find-renames", featSha, feat2]));
    expect(result.packs).toBe(2);
  });

  it("2026-10-02: a seal's read-back reuses the pack the runner installed, and reads it again when its index changed", async () => {
    const keys = captureKeys("wt-proof", 1);
    const packed = packRepo(repo, keys, ["refs/heads/main"]);
    const manifest = buildManifest({
      worktreeId: "wt-proof",
      n: 1,
      parent: null,
      epoch: 1,
      git: gitSection([packed.key], { "refs/heads/main": mainSha }, "refs/heads/main"),
    }).manifest;
    const manifestBytes = new Uint8Array(Buffer.from(JSON.stringify(manifest)));
    const manifestKey = keys.manifest(sha256Hex(manifestBytes));
    // Whole reads of the pack: a copy down for `index-pack --verify`.
    const wholeReads: Array<string> = [];
    const counting = Layer.effect(
      BlobStore,
      Effect.map(BlobStore, (inner): typeof BlobStore.Service => ({
        ...inner,
        getStream: (key: string) => {
          if (key === packed.key) wholeReads.push(key);
          return inner.getStream(key);
        },
      })),
    ).pipe(Layer.provide(BlobStoreFsLive(path.join(scratch, "blobs-proof"))));
    const runnerLayer = GitOpsRunnerLive.pipe(
      Layer.provide(Store.layer),
      Layer.provideMerge(StoreConfig.layerFor(path.join(scratch, "store-proof"))),
      Layer.provideMerge(counting),
    );
    const runProof = <A, E>(effect: Effect.Effect<A, E, GitOpsRunner | BlobStore>) =>
      Effect.runPromise(effect.pipe(Effect.provide(runnerLayer)));
    const readBack = (sinceMs: number) =>
      Effect.gen(function* () {
        const proofs = { sinceMs, usedFromMs: Date.now() };
        const problem = yield* storedCaptureProblem(manifestKey, { proofs });
        return { problem, usedFromMs: proofs.usedFromMs };
      });
    const before = Date.now();
    const result = await runProof(
      Effect.gen(function* () {
        yield* upload(new Map([...packed.objects, [manifestKey, manifestBytes]]));
        const runner = yield* GitOpsRunner;
        yield* runner.ensure({ projectId: "proj-proof", manifest, storeRefs: {} });
        const installed = wholeReads.length;
        // Proven since before the install: the pack is not copied down again.
        const reused = yield* readBack(before);
        const afterReuse = wholeReads.length;
        // Nothing could replace it only since later than the install: copied down and verified.
        const late = yield* readBack(Date.now() + 1);
        const afterLate = wholeReads.length;
        // Another index stored beside it: the pack is checked against it in full, and refused.
        const blobs = yield* BlobStore;
        const idx = packed.objects.get(packIdxKeyOf(packed.key)) ?? new Uint8Array();
        const other = Buffer.from(idx);
        other[other.length - 1] = (other[other.length - 1] ?? 0) ^ 0xff;
        yield* blobs.put(packIdxKeyOf(packed.key), new Uint8Array(other));
        const changed = yield* readBack(before);
        const afterChanged = wholeReads.length;
        // A SHA-256 manifest over the same pack and the index as installed: the proof says what
        // SHA-1 `index-pack --verify` said, which is nothing about this pair (Astra review).
        yield* blobs.put(packIdxKeyOf(packed.key), idx);
        const sha256Manifest = buildManifest({
          worktreeId: "wt-proof",
          n: 2,
          parent: null,
          epoch: 1,
          git: {
            ...gitSection([packed.key], { "refs/heads/main": mainSha }, "refs/heads/main"),
            object_format: "sha256",
          },
        }).manifest;
        const sha256Bytes = new Uint8Array(Buffer.from(JSON.stringify(sha256Manifest)));
        const sha256Key = keys.manifest(sha256Hex(sha256Bytes));
        yield* blobs.put(sha256Key, sha256Bytes);
        const otherFormat = yield* storedCaptureProblem(sha256Key, {
          proofs: { sinceMs: before, usedFromMs: Date.now() },
        }).pipe(Effect.result);
        return {
          installed,
          reused,
          afterReuse,
          late,
          afterLate,
          changed,
          afterChanged,
          otherFormat,
          wholeReads,
        };
      }),
    );
    expect(result.installed).toBe(1);
    expect(result.reused.problem).toBeNull();
    expect(result.reused.usedFromMs).toBeLessThanOrEqual(Date.now());
    expect(result.reused.usedFromMs).toBeGreaterThanOrEqual(before);
    expect(result.afterReuse).toBe(1);
    expect(result.late.problem).toBeNull();
    expect(result.afterLate).toBe(2);
    expect(result.changed.problem).toMatch(/does not index|does not checksum|indexes another/);
    expect(result.afterChanged).toBe(3);
    // Not reused: the pack was copied down and checked as SHA-256, which git refuses.
    expect(Result.isFailure(result.otherFormat) || result.otherFormat.success !== null).toBe(true);
    expect(result.wholeReads.length).toBe(4);
  });

  it("refuses a pack whose bytes do not match its key, and one that fails index-pack", async () => {
    const keys = captureKeys("wt-bad", 1);
    const good = packRepo(repo, keys, ["refs/heads/main"]);
    const packBytes = good.objects.get(good.key) ?? new Uint8Array();
    const idxBytes = good.objects.get(packIdxKeyOf(good.key)) ?? new Uint8Array();
    // Wrong key for right bytes.
    const wrongKey = keys.pack("0".repeat(64));
    // Right key for corrupted bytes (the corruption is inside the object data).
    const corrupted = Buffer.from(packBytes);
    corrupted.writeUInt8(corrupted.readUInt8(20) ^ 0xff, 20);
    const corruptedKey = keys.pack(sha256Hex(corrupted));
    const objects = new Map<string, Uint8Array>([
      [wrongKey, packBytes],
      [packIdxKeyOf(wrongKey), idxBytes],
      [corruptedKey, new Uint8Array(corrupted)],
      [packIdxKeyOf(corruptedKey), idxBytes],
    ]);
    const manifestFor = (key: string) =>
      buildManifest({
        worktreeId: "wt-bad",
        n: 1,
        parent: null,
        epoch: 1,
        git: gitSection([key], { "refs/heads/main": mainSha }, "refs/heads/main"),
      }).manifest;
    const result = await run(
      Effect.gen(function* () {
        yield* upload(objects);
        const runner = yield* GitOpsRunner;
        const outcome = (key: string) =>
          runner.ensure({ projectId: "proj-bad", manifest: manifestFor(key), storeRefs: {} }).pipe(
            Effect.map(() => "ok"),
            Effect.catch((error) =>
              Effect.succeed(
                error._tag === "RunnerPackError" ? `${error._tag}: ${error.reason}` : error._tag,
              ),
            ),
          );
        return [yield* outcome(wrongKey), yield* outcome(corruptedKey)];
      }),
    );
    expect(result[0]).toMatch(/^RunnerPackError: pack bytes hash to/);
    expect(result[1]).toMatch(/^RunnerPackError: index-pack --verify/);
    const packDir = path.join(runnerCachePathOf(storeRoot(), "proj-bad"), "objects", "pack");
    expect(fs.existsSync(packDir) ? fs.readdirSync(packDir) : []).toEqual([]);
  });

  it("review 13 #1: a sound pack whose index-pack the Mend host could not finish (killed, out of disk) is the cache's failure, never the pack's, and installs on the next ensure", async () => {
    const keys = captureKeys("wt-host", 1);
    const good = packRepo(repo, keys, ["refs/heads/main"]);
    const manifest = buildManifest({
      worktreeId: "wt-host",
      n: 1,
      parent: null,
      epoch: 1,
      git: gitSection([good.key], { "refs/heads/main": mainSha }, "refs/heads/main"),
    }).manifest;
    const wrapper = fs.mkdtempSync(path.join(os.tmpdir(), "mend-host-git-"));
    const real = execFileSync("sh", ["-c", "command -v git"]).toString("utf8").trim();
    fs.writeFileSync(
      path.join(wrapper, "git"),
      [
        "#!/bin/sh",
        `if [ "$1" = "index-pack" ] && [ -e "${wrapper}/kill" ]; then rm -f "${wrapper}/kill"; kill -KILL $$; fi`,
        `if [ "$1" = "index-pack" ] && [ -e "${wrapper}/enospc" ]; then rm -f "${wrapper}/enospc"; echo "fatal: unable to create temporary file: No space left on device" >&2; exit 128; fi`,
        `exec "${fs.realpathSync(real)}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const realPath = process.env["PATH"] ?? "";
    const ensure = Effect.gen(function* () {
      yield* upload(good.objects);
      const runner = yield* GitOpsRunner;
      return yield* runner.ensure({ projectId: "proj-host", manifest, storeRefs: {} }).pipe(
        Effect.map(() => "ok"),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );
    });
    const outcomes: Array<string> = [];
    try {
      for (const fault of ["kill", "enospc"]) {
        fs.writeFileSync(path.join(wrapper, fault), "");
        process.env["PATH"] = `${wrapper}:${realPath}`;
        try {
          outcomes.push(await run(ensure));
        } finally {
          process.env["PATH"] = realPath;
        }
        expect(fs.existsSync(path.join(wrapper, fault))).toBe(false);
      }
      outcomes.push(await run(ensure));
    } finally {
      process.env["PATH"] = realPath;
      fs.rmSync(wrapper, { recursive: true, force: true });
    }
    // Before: `RunnerPackError` both times — which Mend records as a `failed` capture.
    expect(outcomes).toEqual(["RunnerCacheError", "RunnerCacheError", "ok"]);
  });
});

/** The key character sealantd escapes byte `byte` to (`tree.rs` `key_of`). */
const escape = (byte: number) => String.fromCodePoint(0x10_ff00 + byte);

describe("runner parsers", () => {
  it("renders packed-refs sorted with git's header and drops non-sha values", () => {
    expect(
      renderPackedRefs({
        "refs/heads/z": "b".repeat(40),
        "refs/heads/a": "a".repeat(40),
        "refs/heads/bad": "not-a-sha",
      }),
    ).toEqual(
      Buffer.from(
        `# pack-refs with: peeled fully-peeled sorted\n${"a".repeat(40)} refs/heads/a\n${"b".repeat(40)} refs/heads/z\n`,
      ),
    );
  });

  it("writes a ref name a capture escaped as the bytes it stands for, sorted by bytes (sealantd gitpack.rs)", () => {
    // `refs/heads/caf\xe9` and `refs/heads/\xff`: not UTF-8, so the manifest names them by key.
    const rendered = renderPackedRefs({
      [`refs/heads/caf${escape(0xe9)}`]: "c".repeat(40),
      [`refs/heads/${escape(0xff)}`]: "d".repeat(40),
      "refs/heads/zeta": "e".repeat(40),
      "refs/heads/bad\nline": "f".repeat(40),
    });
    // Compared as bytes whatever the type: what lands in the file.
    expect(Buffer.from(rendered)).toEqual(
      Buffer.concat([
        Buffer.from("# pack-refs with: peeled fully-peeled sorted\n"),
        Buffer.from(`${"c".repeat(40)} refs/heads/caf`),
        Buffer.from([0xe9, 0x0a]),
        Buffer.from(`${"e".repeat(40)} refs/heads/zeta\n`),
        Buffer.from(`${"d".repeat(40)} refs/heads/`),
        Buffer.from([0xff, 0x0a]),
      ]),
    );
    expect(renderHead(`refs/heads/caf${escape(0xe9)}`)).toEqual(
      Buffer.concat([Buffer.from("ref: refs/heads/caf"), Buffer.from([0xe9, 0x0a])]),
    );
    expect(renderHead("a".repeat(40))).toEqual(Buffer.from(`${"a".repeat(40)}\n`));
  });

  it("parses line-porcelain blame and tab-separated log output", () => {
    const sha = "c".repeat(40);
    const blame = parseLinePorcelain(
      [
        `${sha} 1 1 2`,
        "author Ada",
        "author-mail <ada@example.com>",
        "author-time 1700000000",
        "summary first",
        "filename a.txt",
        "\tline one",
        `${sha} 2 2`,
        "author Ada",
        "author-time 1700000000",
        "summary first",
        "\t\tindented",
      ].join("\n"),
    );
    expect(blame).toEqual([
      {
        sha,
        originalLine: 1,
        finalLine: 1,
        author: "Ada",
        authoredAt: "2023-11-14T22:13:20.000Z",
        summary: "first",
        content: "line one",
      },
      {
        sha,
        originalLine: 2,
        finalLine: 2,
        author: "Ada",
        authoredAt: "2023-11-14T22:13:20.000Z",
        summary: "first",
        content: "\tindented",
      },
    ]);
    expect(parseLog(`${sha}\tAda\t2026-01-01T00:00:00+00:00\tsubject\twith tab\n`)).toEqual([
      { sha, author: "Ada", authoredAt: "2026-01-01T00:00:00+00:00", subject: "subject\twith tab" },
    ]);
    expect(parseLog("")).toEqual([]);
  });
});
