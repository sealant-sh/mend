import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "@mend/test-ci/effect-vitest";
import { Duration, Effect, Layer, Result } from "effect";

import {
  admitHandoff,
  HANDOFF_QUARANTINE_PREFIX,
  type HandoffRefusedError,
  parseBundleHeader,
  skippedFreshen,
  sweepHandoffQuarantines,
} from "../src/handoff.ts";
import { Store, StoreConfig } from "../src/store.ts";
import {
  buildHandoffBundle,
  damage,
  type HandoffWorld,
  makeHandoffWorld,
  makeMergedMainCheckout,
  sh,
  storeState,
} from "./handoff-fixture.ts";

const refusalMessage = (
  outcome: Result.Result<unknown, { readonly _tag: string; readonly message: string }>,
): string =>
  Result.isFailure(outcome) && outcome.failure._tag === "HandoffRefusedError"
    ? outcome.failure.message
    : "";

describe("Store.admitHandoff", () => {
  let world: HandoffWorld;
  let storeRoot: string;
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-handoff-"));
    world = makeHandoffWorld(tmp);
    storeRoot = path.join(tmp, "store-root");
  });
  afterEach(() => {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  });

  const admit = (
    bytes: Uint8Array,
    remoteEnv: Record<string, string> | null = null,
    fileBytes = 0,
  ) =>
    Effect.gen(function* () {
      const store = yield* Store;
      return yield* store
        .admitHandoff(world.storePath, "main", bytes, {
          freshen:
            remoteEnv === null
              ? Effect.succeed(skippedFreshen("no credential in this test"))
              : store.freshenBase(world.storePath, "main", remoteEnv),
          fileBytes,
        })
        .pipe(Effect.result);
    }).pipe(
      Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(storeRoot)))),
      Effect.runPromise,
    );

  const quarantines = () => {
    const tmp = path.join(storeRoot, "tmp");
    return fs.existsSync(tmp)
      ? fs.readdirSync(tmp).filter((entry) => entry.startsWith(HANDOFF_QUARANTINE_PREFIX))
      : [];
  };

  const expectRefusal = async (
    bytes: Uint8Array,
    reason: HandoffRefusedError["reason"],
    remoteEnv: Record<string, string> | null = null,
  ) => {
    const before = storeState(world.storePath);
    const outcome = await admit(bytes, remoteEnv);
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure._tag).toBe("HandoffRefusedError");
      if (outcome.failure._tag === "HandoffRefusedError") {
        expect(outcome.failure.reason).toBe(reason);
        expect(outcome.failure.message).toMatch(/· nothing was created$/);
      }
    }
    expect(storeState(world.storePath)).toEqual(before);
    expect(quarantines()).toEqual([]);
    return outcome;
  };

  it("admits the snapshot: the facts, the trees, the delta pack that closes with the base", async () => {
    const bundle = buildHandoffBundle(world.checkout);
    const before = storeState(world.storePath);
    const outcome = await admit(bundle.bytes);
    expect(Result.isSuccess(outcome)).toBe(true);
    if (!Result.isSuccess(outcome)) return;
    const admitted = outcome.success;
    expect(admitted).toMatchObject({
      head: bundle.head,
      index: bundle.index,
      snapshot: bundle.checkpoint,
      mergeBase: bundle.mergeBase,
      worktreeTree: bundle.worktreeTree,
      indexTree: bundle.indexTree,
      defaultBranch: "main",
      commitsAhead: 2,
      trailers: {
        machine: "dana-mbp",
        localBranch: "fix/login",
        cutAt: "2026-10-18T07:42:05.000Z",
        defaultTip: world.mainTip,
      },
    });
    expect(admitted.mergeBase).toBe(world.mainTip);
    expect(admitted.worktreeTree).not.toBe(admitted.indexTree);
    expect(storeState(world.storePath)).toEqual(before);
    expect(quarantines()).toEqual([]);
    const probe = path.join(world.tmp, "probe.git");
    sh(world.tmp, ["init", "-q", "--bare", probe]);
    fs.writeFileSync(
      path.join(probe, "objects", "info", "alternates"),
      `${path.join(world.storePath, "objects")}\n`,
    );
    sh(probe, ["index-pack", "--strict", "--stdin"], { input: admitted.deltaPack.pack });
    const closed = sh(probe, ["rev-list", "--objects", "--missing=error", bundle.checkpoint]);
    expect(closed).toContain(bundle.checkpoint);
    const inPack = sh(world.checkout, [
      "rev-list",
      "--objects",
      bundle.checkpoint,
      `^${bundle.mergeBase}`,
    ])
      .split("\n")
      .map((line) => line.split(" ")[0])
      .toSorted();
    const packedObjects = sh(probe, ["show-index"], { input: admitted.deltaPack.idx })
      .split("\n")
      .map((line) => line.split(" ")[1])
      .toSorted();
    expect(packedObjects).toEqual(inPack);
  });

  it("refuses bytes that are not a bundle as not-a-handoff, before any quarantine is made", async () => {
    await expectRefusal(new TextEncoder().encode("hello, not a bundle\n"), "not-a-handoff");
    expect(fs.existsSync(path.join(storeRoot, "tmp"))).toBe(false);
  });

  it("refuses a bundle with a second ref, or without a prerequisite, as not-a-handoff", async () => {
    sh(world.checkout, ["update-ref", "refs/heads/extra", "HEAD"]);
    const twoRefs = buildHandoffBundle(world.checkout, { extraRefs: ["refs/heads/extra"] });
    await expectRefusal(twoRefs.bytes, "not-a-handoff");
    const header = parseBundleHeader(twoRefs.bytes);
    expect(header?.refs.map((ref) => ref.name).toSorted()).toEqual([
      "refs/heads/extra",
      "refs/mend/handoff/snapshot",
    ]);
    const whole = buildHandoffBundle(world.checkout, { cut: { kind: "none" } });
    expect(parseBundleHeader(whole.bytes)?.prerequisites).toEqual([]);
    await expectRefusal(whole.bytes, "not-a-handoff");
  });

  it("refuses a torn pack as damaged", async () => {
    const bundle = buildHandoffBundle(world.checkout);
    const outcome = await expectRefusal(damage(bundle.bytes), "damaged");
    expect(refusalMessage(outcome)).toMatch(/git said: /);
  });

  it("refuses a large pack git stops reading at once as damaged, and the server process lives", async () => {
    const bundle = buildHandoffBundle(world.checkout);
    const header = parseBundleHeader(bundle.bytes);
    if (header === null) throw new Error("the fixture bundle has no header");
    const pack = Buffer.alloc(8 * 1024 * 1024, 0x41);
    pack.write("PACK", 0);
    pack.writeUInt32BE(99, 4);
    const upload = path.join(world.tmp, "large.bundle");
    fs.writeFileSync(upload, Buffer.concat([bundle.bytes.subarray(0, header.packStart), pack]));
    const script = `
      import * as fs from "node:fs";
      import { Effect, Layer, Result } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("effect")).href)};
      import { skippedFreshen } from ${JSON.stringify(new URL("../src/handoff.ts", import.meta.url).href)};
      import { Store, StoreConfig } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      const [storeRoot, storePath, upload] = process.argv.slice(1);
      const outcome = await Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.admitHandoff(storePath, "main", new Uint8Array(fs.readFileSync(upload)), {
          freshen: Effect.succeed(skippedFreshen("no credential in this test")),
          fileBytes: 0,
        });
      }).pipe(
        Effect.result,
        Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(storeRoot)))),
        Effect.runPromise,
      );
      process.stdout.write(JSON.stringify(Result.isFailure(outcome) ? outcome.failure : "admitted"));
    `;
    const ran = await new Promise<{ code: number | string | null; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          ["--input-type=module", "--eval", script, storeRoot, world.storePath, upload],
          { cwd: world.tmp, timeout: 60_000 },
          (error, stdout, stderr) =>
            resolve({ code: error === null ? 0 : (error.code ?? null), stdout, stderr }),
        );
      },
    );
    expect(ran.stderr).not.toMatch(/EPIPE/);
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toMatchObject({
      _tag: "HandoffRefusedError",
      reason: "damaged",
      message: expect.stringMatching(/git said: /),
    });
    expect(quarantines()).toEqual([]);
  });

  it.each([
    { tree: "a .git entry", entries: [{ name: ".git", content: "gitdir: /tmp/elsewhere\n" }] },
    {
      tree: "a .gitmodules whose url is an option",
      entries: [
        {
          name: ".gitmodules",
          content: '[submodule "x"]\n\tpath = x\n\turl = --upload-pack=touch /tmp/pwned\n',
        },
      ],
    },
  ])("refuses a snapshot whose tree holds $tree as damaged", async ({ entries }) => {
    const bundle = buildHandoffBundle(world.checkout, { hostileEntries: entries });
    const outcome = await expectRefusal(bundle.bytes, "damaged");
    expect(refusalMessage(outcome)).toMatch(/git said: /);
  });

  it("refuses a base the store has not seen as base-unknown, and admits it once a freshen brings it", async () => {
    fs.writeFileSync(path.join(world.origin, "later.txt"), "later\n");
    sh(world.origin, ["add", "-A"]);
    sh(world.origin, ["commit", "-q", "-m", "later"]);
    sh(world.checkout, ["fetch", "-q", "origin"]);
    sh(world.checkout, ["-c", "rebase.autoStash=true", "rebase", "-q", "origin/main"]);
    const bundle = buildHandoffBundle(world.checkout);
    expect(bundle.mergeBase).not.toBe(world.mainTip);
    await expectRefusal(bundle.bytes, "base-unknown");
    const before = storeState(world.storePath);
    const outcome = await admit(bundle.bytes, {});
    expect(Result.isSuccess(outcome)).toBe(true);
    const after = storeState(world.storePath);
    expect(after.refs).toContain(`${bundle.mergeBase} commit\trefs/remotes/origin/main`);
    expect(after.objects).not.toContain(bundle.checkpoint);
    expect(after.objects).not.toContain(bundle.index);
    expect(after.objects.length).toBeGreaterThan(before.objects.length);
  });

  it("refuses a default tip the store does not know as base-unknown, after its one freshen", async () => {
    sh(world.storePath, ["fetch", "-q", "origin", "main"]);
    const bundle = buildHandoffBundle(world.checkout, {
      defaultTip: "0123456789abcdef0123456789abcdef01234567",
      cut: { kind: "at", sha: world.mainTip },
    });
    await expectRefusal(bundle.bytes, "base-unknown", {});
  });

  it("refuses a default tip off the store's main as base-off-default-branch", async () => {
    sh(world.storePath, ["fetch", "-q", "origin", "main"]);
    const bundle = buildHandoffBundle(world.checkout, {
      defaultTip: world.sideTip,
      cut: { kind: "at", sha: world.mainRoot },
      mergeBaseTrailer: world.mainRoot,
    });
    await expectRefusal(bundle.bytes, "base-off-default-branch", {});
  });

  it("refuses a bundle whose base is not the merge base with its default tip as not-a-handoff", async () => {
    const bundle = buildHandoffBundle(world.checkout, {
      cut: { kind: "at", sha: world.mainRoot },
      mergeBaseTrailer: world.mainRoot,
    });
    expect(bundle.defaultTip).toBe(world.mainTip);
    const outcome = await expectRefusal(bundle.bytes, "not-a-handoff");
    expect(refusalMessage(outcome)).toMatch(/is not the merge base/);
  });

  it("refuses a bundle that was not cut at the base its trailer names as not-a-handoff", async () => {
    const bundle = buildHandoffBundle(world.checkout, { cut: { kind: "at", sha: world.mainRoot } });
    expect(bundle.mergeBase).toBe(world.mainTip);
    const outcome = await expectRefusal(bundle.bytes, "not-a-handoff");
    expect(refusalMessage(outcome)).toMatch(/was not cut at its base/);
  });

  it("admits a branch that merged main: the bundle names the fork point beside the merge base", async () => {
    const checkout = makeMergedMainCheckout(world);
    const bundle = buildHandoffBundle(checkout, { localBranch: "fix/merge" });
    expect(bundle.mergeBase).toBe(world.mainTip);
    expect(parseBundleHeader(bundle.bytes)?.prerequisites.toSorted()).toEqual(
      [world.mainTip, world.mainRoot].toSorted(),
    );
    const before = storeState(world.storePath);
    const outcome = await admit(bundle.bytes);
    expect(Result.isSuccess(outcome)).toBe(true);
    if (!Result.isSuccess(outcome)) return;
    expect(outcome.success).toMatchObject({
      head: bundle.head,
      mergeBase: world.mainTip,
      commitsAhead: 3,
      trailers: { localBranch: "fix/merge", mergeBase: world.mainTip },
    });
    expect(storeState(world.storePath)).toEqual(before);
    const probe = path.join(world.tmp, "probe-merged.git");
    sh(world.tmp, ["init", "-q", "--bare", probe]);
    fs.writeFileSync(
      path.join(probe, "objects", "info", "alternates"),
      `${path.join(world.storePath, "objects")}\n`,
    );
    sh(probe, ["index-pack", "--strict", "--stdin"], { input: outcome.success.deltaPack.pack });
    expect(sh(probe, ["rev-list", "--objects", "--missing=error", bundle.checkpoint])).toContain(
      bundle.checkpoint,
    );
  });

  it("words base-unknown from the freshen: not fetched, fetched and still unknown, or git's own words", async () => {
    sh(world.storePath, ["fetch", "-q", "origin", "main"]);
    const bundle = buildHandoffBundle(world.checkout, {
      defaultTip: "0123456789abcdef0123456789abcdef01234567",
      cut: { kind: "at", sha: world.mainTip },
    });
    const notFetched = await expectRefusal(bundle.bytes, "base-unknown");
    expect(refusalMessage(notFetched)).toMatch(
      /origin was not fetched · no credential in this test/,
    );
    expect(refusalMessage(notFetched)).not.toMatch(/push main/);
    const fetched = await expectRefusal(bundle.bytes, "base-unknown", {});
    expect(refusalMessage(fetched)).toMatch(
      /origin's main was fetched and it is still unknown · push main/,
    );
    sh(world.storePath, ["remote", "set-url", "origin", path.join(world.tmp, "no-such-origin")]);
    const failed = await expectRefusal(bundle.bytes, "base-unknown", {});
    expect(refusalMessage(failed)).toMatch(/this server could not fetch origin · git said: /);
    expect(refusalMessage(failed)).not.toMatch(/push main/);
  });

  it("refuses a blob new in W or I over the file budget, naming it, and admits under no budget", async () => {
    fs.mkdirSync(path.join(world.checkout, "assets"));
    fs.writeFileSync(path.join(world.checkout, "assets", "demo.bin"), Buffer.alloc(100 * 1024, 7));
    const bundle = buildHandoffBundle(world.checkout);
    const before = storeState(world.storePath);
    const refused = await admit(bundle.bytes, null, 64 * 1024);
    expect(Result.isFailure(refused)).toBe(true);
    if (Result.isFailure(refused)) {
      expect(refused.failure).toMatchObject({
        _tag: "HandoffFileOverBudgetError",
        path: "assets/demo.bin",
        bytes: 100 * 1024,
        limit: 64 * 1024,
      });
    }
    expect(storeState(world.storePath)).toEqual(before);
    expect(quarantines()).toEqual([]);
    expect(Result.isSuccess(await admit(bundle.bytes, null, 128 * 1024))).toBe(true);
    expect(Result.isSuccess(await admit(bundle.bytes, null, 0))).toBe(true);
  });

  it("ends a git call that outlives the timeout as a host failure, and removes the quarantine", async () => {
    const bundle = buildHandoffBundle(world.checkout);
    const tmp = path.join(storeRoot, "tmp");
    const outcome = await Effect.runPromise(
      admitHandoff({
        storePath: world.storePath,
        defaultBranch: "main",
        bundle: bundle.bytes,
        quarantineRoot: tmp,
        fileBytes: 0,
        defaultTip: Effect.succeed(world.mainTip),
        freshenDefault: Effect.succeed(skippedFreshen("none")),
        gitTimeout: Duration.zero,
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure._tag).toBe("GitError");
      if (outcome.failure._tag === "GitError") {
        expect(outcome.failure.stderr).toMatch(/did not finish within/);
      }
    }
    expect(quarantines()).toEqual([]);
  });

  it("refuses a snapshot that is a merge commit, or a root, as not-a-handoff", async () => {
    const merge = buildHandoffBundle(world.checkout, { shape: "merge" });
    const outcome = await expectRefusal(merge.bytes, "not-a-handoff");
    expect(refusalMessage(outcome)).toMatch(/exactly one parent/);
    const root = buildHandoffBundle(world.checkout, { shape: "root", cut: { kind: "none" } });
    await expectRefusal(root.bytes, "not-a-handoff");
  });

  it("refuses a snapshot whose message is not a handoff's as not-a-handoff", async () => {
    const bundle = buildHandoffBundle(world.checkout, { message: "wip\n" });
    const outcome = await expectRefusal(bundle.bytes, "not-a-handoff");
    expect(refusalMessage(outcome)).toMatch(/the subject is not "mend handoff"/);
  });

  it("admits a detached checkout with nothing ahead and nothing uncommitted: a held workspace at HEAD", async () => {
    const detached = path.join(world.tmp, "detached");
    sh(world.tmp, ["clone", "-q", world.origin, detached]);
    sh(detached, ["checkout", "-q", "--detach", "origin/main"]);
    const bundle = buildHandoffBundle(detached, { localBranch: null });
    const outcome = await admit(bundle.bytes);
    expect(Result.isSuccess(outcome)).toBe(true);
    if (!Result.isSuccess(outcome)) return;
    expect(outcome.success).toMatchObject({
      head: world.mainTip,
      mergeBase: world.mainTip,
      commitsAhead: 0,
      trailers: { localBranch: null },
    });
    expect(outcome.success.worktreeTree).toBe(outcome.success.indexTree);
  });
});

describe("sweepHandoffQuarantines", () => {
  it("removes quarantines older than an hour and keeps younger ones", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-handoff-sweep-"));
    const tmp = path.join(root, "tmp");
    const stale = path.join(tmp, `${HANDOFF_QUARANTINE_PREFIX}stale`);
    const fresh = path.join(tmp, `${HANDOFF_QUARANTINE_PREFIX}fresh`);
    const other = path.join(tmp, "base-pack-keep");
    for (const dir of [stale, fresh, other]) fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(other, old, old);
    const removed = await Effect.runPromise(sweepHandoffQuarantines(tmp, now));
    expect(removed).toEqual([stale]);
    expect(fs.readdirSync(tmp).toSorted()).toEqual([
      "base-pack-keep",
      `${HANDOFF_QUARANTINE_PREFIX}fresh`,
    ]);
    expect(
      await Effect.runPromise(sweepHandoffQuarantines(path.join(root, "absent"), now)),
    ).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.getuid?.() === 0)(
    "skips an entry gone before its stat and one it cannot remove, and sweeps the rest",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-handoff-sweep-"));
      const stale = path.join(root, `${HANDOFF_QUARANTINE_PREFIX}stale`);
      const locked = path.join(root, `${HANDOFF_QUARANTINE_PREFIX}locked`);
      const gone = path.join(root, `${HANDOFF_QUARANTINE_PREFIX}gone`);
      fs.mkdirSync(stale);
      fs.mkdirSync(path.join(locked, "inner"), { recursive: true });
      fs.writeFileSync(path.join(locked, "inner", "pack"), "bytes");
      fs.chmodSync(path.join(locked, "inner"), 0o500);
      fs.symlinkSync(path.join(root, "vanished"), gone);
      const now = Date.now();
      const old = new Date(now - 2 * 60 * 60 * 1000);
      for (const dir of [stale, locked]) fs.utimesSync(dir, old, old);
      const removed = await Effect.runPromise(sweepHandoffQuarantines(root, now));
      expect(removed).toEqual([stale]);
      expect(fs.existsSync(path.join(locked, "inner", "pack"))).toBe(true);
      fs.chmodSync(path.join(locked, "inner"), 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    },
  );
});
